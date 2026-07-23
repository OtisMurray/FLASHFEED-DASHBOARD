"""
Finviz Elite auto-auth (curl-impersonate login → session cookie) — standalone
─────────────────────────────────────────────────────────────────────────────
Self-healing Finviz authentication for the chart-service, with NO dependency on
sentiment-scout. Ported from sentiment-scout/finviz_auth.py and adapted so the
service authenticates on its own when deployed alone (e.g. Railway).

Background: the Finviz Elite *export token* (`quote_export?...&auth=<uuid>`) is
dynamic — it rotates every day or two and the stale one returns HTTP 401
"Invalid export API token". Finviz's redesigned site no longer exposes that
token in any page or API response, so it can't be scraped. It CAN, however, be
made irrelevant: a logged-in `.ASPXAUTH` session cookie authorises the very same
export endpoints on its own — verified, a request with an all-zeros token but a
valid cookie returns full data. The "remember me" cookie is long-lived (~30d).

So this module logs into Finviz Elite once (curl_cffi Chrome impersonation,
credentials from the environment), persists the session cookies, and hands them
to every Finviz caller. Callers may omit the rotating token entirely because the
cookie authorizes the export endpoints; on a 401 they call refresh() to silently
re-login. The user never has to touch a rotating token again.

Credentials come from ENV VARS — the deployment mechanism on Railway/containers:
    FINVIZ_LOGIN     Finviz Elite account email
    FINVIZ_PASSWORD  Finviz Elite account password
They are never logged and never on a command line.

Cookie persistence: a 0600 JSON file under VAR_ROOT (default: <this dir>/var).
On an ephemeral container filesystem the file lives only for the container's
life — that's fine: a cold start simply logs in again. Point VAR_ROOT at a
mounted volume if you want the cookie to survive redeploys.

Concurrency: refresh() takes a cross-process file lock and debounces, so a burst
of 401s from several chart requests triggers exactly one login.

CLI:
    python3 finviz_auth.py --refresh    # force a login + persist cookies
    python3 finviz_auth.py --check      # prove the cookie fetches export data
"""

from __future__ import annotations

import json
import os
import stat
import sys
import time
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent
# Runtime dir is VAR_ROOT (default <chart-service>/var) so a deployed host can
# mount a persistent volume there; defaults keep local dev unchanged.
_VAR_DIR = Path(os.environ.get("VAR_ROOT", str(_REPO_ROOT / "var")))
_COOKIE_PATH = _VAR_DIR / ".finviz_cookies.json"
_LOCK_PATH = _VAR_DIR / ".finviz_refresh.lock"

# Adopt a peer's just-completed login instead of starting our own, if it landed
# within this window — collapses a 401 stampede into a single login.
REFRESH_DEBOUNCE_S = 60
_LOCK_WAIT_S = 45
# Refresh proactively once the cookie is within this margin of its expiry.
_EXPIRY_MARGIN_S = 3600

_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
_HEADERS = {
    "User-Agent": _UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://finviz.com/",
}
# The cookie Finviz sets on a successful login; its presence == authenticated.
_AUTH_COOKIE = ".ASPXAUTH"


class FinvizAuthError(RuntimeError):
    """Raised when a session cannot be established (bad creds / Finviz down /
    login flow changed). Message is safe to log — never contains secrets."""


# ─── credentials (environment only) ───────────────────────────────────────────

def _get_login():
    """Finviz login from the environment. Returns (email, password) or (None,
    None). FINVIZ_LOGIN / FINVIZ_PASSWORD are the canonical names; FINVIZ_EMAIL
    is accepted as an alias for the email."""
    email = (os.environ.get("FINVIZ_LOGIN")
             or os.environ.get("FINVIZ_EMAIL") or "").strip()
    pw = os.environ.get("FINVIZ_PASSWORD") or ""
    if email and pw:
        return email, pw
    return None, None


def have_login() -> bool:
    """True when Finviz login credentials are configured in the environment."""
    email, pw = _get_login()
    return bool(email and pw)


# ─── login ────────────────────────────────────────────────────────────────────

def _login() -> dict:
    """Log into Finviz Elite and return the session cookies as a name→value dict.
    Raises FinvizAuthError on failure. Verified flow: GET /login then
    /login-email (seeds the antiforgery cookie), POST /login_submit, which
    redirects to elite.finviz.com and sets `.ASPXAUTH`."""
    email, password = _get_login()
    if not (email and password):
        raise FinvizAuthError(
            "No Finviz login configured — set FINVIZ_LOGIN and FINVIZ_PASSWORD")
    try:
        from curl_cffi import requests as cffi
    except Exception as exc:                        # pragma: no cover
        raise FinvizAuthError(f"curl_cffi unavailable: {exc.__class__.__name__}")

    s = cffi.Session()
    try:
        s.get("https://finviz.com/login", headers=_HEADERS,
              impersonate="chrome124", timeout=25)
        s.get("https://finviz.com/login-email?remember=true", headers=_HEADERS,
              impersonate="chrome124", timeout=25)
        resp = s.post(
            "https://finviz.com/login_submit",
            headers={**_HEADERS,
                     "Content-Type": "application/x-www-form-urlencoded",
                     "Origin": "https://finviz.com",
                     "Referer": "https://finviz.com/login-email?remember=true"},
            data={"email": email, "password": password, "remember": "true"},
            impersonate="chrome124", timeout=25, allow_redirects=True,
        )
        if resp.status_code >= 500:
            raise FinvizAuthError(f"Finviz login returned HTTP {resp.status_code}")

        cookies = {c.name: c.value for c in s.cookies.jar}
        if _AUTH_COOKIE not in cookies:
            raise FinvizAuthError(
                "Finviz login failed (no auth cookie) — email/password rejected")

        # Prove the cookie actually authorises an export before we trust it.
        expires = None
        for c in s.cookies.jar:
            if c.name == _AUTH_COOKIE:
                expires = c.expires
        if not _cookie_session_works(s):
            raise FinvizAuthError(
                "Logged in but the session did not authorise an export")
        return {"cookies": cookies, "expires": expires, "saved": time.time()}
    finally:
        try:
            s.close()
        except Exception:
            pass


def _cookie_session_works(session) -> bool:
    """One tiny authenticated export to confirm the cookie is accepted."""
    try:
        r = session.get(
            "https://elite.finviz.com/export.ashx?v=111&t=AAPL",
            headers=_HEADERS, impersonate="chrome124", timeout=20)
    except Exception:
        return False
    first_line = (r.text or "").lstrip().splitlines()[0] if (r.text or "").strip() else ""
    return r.status_code == 200 and '"Ticker"' in first_line and len((r.text or "").splitlines()) >= 2


# ─── cookie persistence ───────────────────────────────────────────────────────

def _persist_cookies(payload: dict):
    _VAR_DIR.mkdir(parents=True, exist_ok=True)
    _COOKIE_PATH.write_text(json.dumps(payload), encoding="utf-8")
    try:
        _COOKIE_PATH.chmod(stat.S_IRUSR | stat.S_IWUSR)   # 0600
    except OSError:
        pass


def _load_payload() -> dict | None:
    try:
        return json.loads(_COOKIE_PATH.read_text(encoding="utf-8"))
    except Exception:
        return None


def have_fresh_cookies() -> bool:
    """True if a stored cookie exists and is not past (or near) its expiry."""
    p = _load_payload()
    if not p or not p.get("cookies", {}).get(_AUTH_COOKIE):
        return False
    exp = p.get("expires")
    if exp and time.time() > (exp - _EXPIRY_MARGIN_S):
        return False
    return True


def load_cookies_into(session, auto_login: bool = True) -> bool:
    """Attach stored Finviz cookies to a caller's curl_cffi session so its
    existing export requests authenticate. If none are stored/fresh and
    auto_login is set, performs a login first. Returns True if cookies were
    attached. Never raises for the auto-login path — returns False instead."""
    if not have_fresh_cookies() and auto_login:
        try:
            refresh()
        except FinvizAuthError:
            return False
    p = _load_payload()
    cookies = (p or {}).get("cookies") or {}
    if not cookies:
        return False
    for name, value in cookies.items():
        try:
            session.cookies.set(name, value, domain=".finviz.com")
        except Exception:
            # Some curl_cffi versions want a plain mapping update.
            try:
                session.cookies.update({name: value})
            except Exception:
                pass
    return True


# ─── refresh (locked + debounced) ─────────────────────────────────────────────

def refresh(force: bool = False) -> dict:
    """Log in and persist fresh session cookies. Collapses concurrent callers via
    a file lock + debounce. Returns the cookie payload. Raises FinvizAuthError if
    a session cannot be established."""
    requested_at = time.time()
    if not force and have_fresh_cookies():
        p = _load_payload()
        if p and time.time() - p.get("saved", 0) < REFRESH_DEBOUNCE_S:
            return p

    import fcntl
    _VAR_DIR.mkdir(parents=True, exist_ok=True)
    lock_fd = os.open(str(_LOCK_PATH), os.O_CREAT | os.O_RDWR, 0o600)
    try:
        deadline = time.time() + _LOCK_WAIT_S
        while True:
            try:
                fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError:
                if time.time() > deadline:
                    raise FinvizAuthError("Timed out waiting for a peer login")
                time.sleep(0.5)

        # A peer may have just logged in while we waited — adopt it.
        p = _load_payload()
        peer_just_refreshed = p and p.get("cookies", {}).get(_AUTH_COOKIE) \
            and float(p.get("saved", 0)) >= requested_at
        recently_refreshed = p and p.get("cookies", {}).get(_AUTH_COOKIE) \
            and time.time() - float(p.get("saved", 0)) < REFRESH_DEBOUNCE_S
        if peer_just_refreshed or (not force and recently_refreshed):
            return p

        payload = _login()                # may raise FinvizAuthError
        _persist_cookies(payload)
        return payload
    finally:
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_UN)
        except Exception:
            pass
        os.close(lock_fd)


# ─── CLI ──────────────────────────────────────────────────────────────────────

def _cli_refresh():
    if not have_login():
        print("No Finviz login configured — set FINVIZ_LOGIN and "
              "FINVIZ_PASSWORD in the environment.", file=sys.stderr)
        return 2
    try:
        p = refresh(force=True)
    except FinvizAuthError as exc:
        print(f"Login failed: {exc}", file=sys.stderr)
        return 1
    exp = p.get("expires")
    when = time.strftime("%Y-%m-%d %H:%M", time.localtime(exp)) if exp else "session"
    print(f"OK — logged in, cookies persisted (valid until {when}).")
    return 0


def _cli_check():
    try:
        from curl_cffi import requests as cffi
    except Exception as exc:
        print(f"curl_cffi unavailable: {exc.__class__.__name__}", file=sys.stderr)
        return 1
    s = cffi.Session()
    if not load_cookies_into(s):
        print("No Finviz session available (login not configured or failed).",
              file=sys.stderr)
        return 1
    try:
        r = s.get("https://elite.finviz.com/export.ashx?v=111&t=AAPL",
                  headers=_HEADERS, impersonate="chrome124", timeout=20)
    except Exception as exc:
        print(f"Cookie check failed: {exc.__class__.__name__}", file=sys.stderr)
        return 1
    first_line = (r.text or "").lstrip().splitlines()[0] if (r.text or "").strip() else ""
    ok = r.status_code == 200 and '"Ticker"' in first_line and len((r.text or "").splitlines()) >= 2
    rows = max(0, len((r.text or "").strip().splitlines()) - 1)
    print(f"cookie session: {'WORKS' if ok else 'FAILED'} (HTTP {r.status_code}, {rows} rows)")
    return 0 if ok else 1


if __name__ == "__main__":
    arg = sys.argv[1] if len(sys.argv) > 1 else "--check"
    sys.exit({"--refresh": _cli_refresh,
              "--check": _cli_check}.get(arg, _cli_check)())
