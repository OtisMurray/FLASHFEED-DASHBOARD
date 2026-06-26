"""
Credentials store (Settings → Credentials)
───────────────────────────────────────────
Secure-at-rest storage for the data-source / brokerage credentials the Settings
page collects (Finviz, TradingView, TD, IB). Design goals, consistent with the
.env / config.py approach already in place:

  • Stored ONLY in the gitignored runtime dir (var/), never in tracked source and
    never committed. var/ is gitignored, and the files are chmod 0600.
  • Secret fields (the Finviz token + the brokerage passwords) are encrypted at
    rest with Fernet (AES-128-CBC + HMAC). The key lives in var/.cred_key (also
    gitignored, 0600). Limitation, stated honestly: the key sits next to the
    ciphertext, so this protects against accidental exposure — a committed file, an
    iCloud sync, a shoulder-surf of the JSON — NOT against an attacker who already
    has read access to var/. It is not an HSM/KMS; that is out of scope here.
  • Secrets are NEVER echoed back to the client in plaintext (masked to last-4)
    and NEVER logged.
  • The Finviz token feeds the SAME config the app reads (config.FINVIZ_TOKEN):
    saving it updates os.environ and the live module tokens, so the running app
    picks it up with no restart and nothing is re-hardcoded.

This module imports nothing heavy at top level and is safe to import early.
"""

import json
import os
import stat
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent
# Runtime dir is VAR_ROOT (default repo/var) so a deployed host can mount a
# persistent volume there; defaults keep local dev unchanged.
_VAR_DIR = Path(os.environ.get("VAR_ROOT", str(_REPO_ROOT / "var")))
CRED_PATH = Path(os.environ.get("CREDENTIALS_FILE", str(_VAR_DIR / "credentials.json")))
_KEY_PATH = Path(os.environ.get("CREDENTIALS_KEY", str(_VAR_DIR / ".cred_key")))

# Field schema — the single source of truth for the UI and the store. `secret`
# fields are encrypted at rest and masked on read; `required` marks the Finviz
# token the app actually uses (everything else is for the future broker work).
FIELDS = [
    # group, key, label, secret, required
    {"group": "Finviz",      "key": "finviz_url",        "label": "Finviz URL",         "secret": False, "required": False},
    {"group": "Finviz",      "key": "finviz_token",      "label": "Finviz API Token",   "secret": True,  "required": True},
    {"group": "TradingView", "key": "tradingview_url",   "label": "TradingView URL",    "secret": False, "required": False},
    {"group": "TradingView", "key": "tradingview_login", "label": "TradingView Login",  "secret": False, "required": False},
    {"group": "TradingView", "key": "tradingview_password", "label": "TradingView Password", "secret": True, "required": False},
    {"group": "TD",          "key": "td_url",            "label": "TD URL",             "secret": False, "required": False},
    {"group": "TD",          "key": "td_login",          "label": "TD Login",           "secret": False, "required": False},
    {"group": "TD",          "key": "td_password",       "label": "TD Password",        "secret": True,  "required": False},
    {"group": "IB",          "key": "ib_url",            "label": "IB URL",             "secret": False, "required": False},
    {"group": "IB",          "key": "ib_login",          "label": "IB Login",           "secret": False, "required": False},
    {"group": "IB",          "key": "ib_password",       "label": "IB Password",        "secret": True,  "required": False},
    # Bluesky social source — handle + app password (NOT the account password).
    # Create an app password at bsky.app → Settings → App Passwords.
    {"group": "Bluesky",     "key": "bluesky_handle",       "label": "Bluesky Handle (e.g. you.bsky.social)", "secret": False, "required": False},
    {"group": "Bluesky",     "key": "bluesky_app_password", "label": "Bluesky App Password",                  "secret": True,  "required": False},
    # Reddit social source — app-only OAuth (script app at reddit.com/prefs/apps).
    {"group": "Reddit",      "key": "reddit_client_id",     "label": "Reddit Client ID",                      "secret": False, "required": False},
    {"group": "Reddit",      "key": "reddit_client_secret", "label": "Reddit Client Secret",                  "secret": True,  "required": False},
    {"group": "Reddit",      "key": "reddit_user_agent",    "label": "Reddit User Agent",                     "secret": False, "required": False},
]
_BY_KEY = {f["key"]: f for f in FIELDS}
_SECRET_KEYS = {f["key"] for f in FIELDS if f["secret"]}
# Secret keys that, when saved, update a live app config value.
FINVIZ_TOKEN_KEY = "finviz_token"


# ─── encryption ──────────────────────────────────────────────────────────────

def _fernet():
    """Return a Fernet instance, generating + persisting a 0600 key on first use.
    None if the cryptography lib is unavailable (then values are stored plaintext
    in the gitignored store, and that limitation is surfaced via encrypted=False)."""
    try:
        from cryptography.fernet import Fernet
    except Exception:
        return None
    try:
        _VAR_DIR.mkdir(parents=True, exist_ok=True)
        if _KEY_PATH.exists():
            key = _KEY_PATH.read_bytes().strip()
        else:
            key = Fernet.generate_key()
            _KEY_PATH.write_bytes(key)
            _chmod_600(_KEY_PATH)
        return Fernet(key)
    except Exception:
        return None


def _chmod_600(path: Path):
    try:
        os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)  # 0600 — owner read/write only
    except OSError:
        pass


def encryption_available() -> bool:
    return _fernet() is not None


_ENC_PREFIX = "enc:v1:"


def _encrypt(value: str) -> str:
    f = _fernet()
    if f is None or value is None:
        return value
    return _ENC_PREFIX + f.encrypt(value.encode("utf-8")).decode("ascii")


def _decrypt(value: str) -> str:
    if not isinstance(value, str) or not value.startswith(_ENC_PREFIX):
        return value
    f = _fernet()
    if f is None:
        return ""
    try:
        return f.decrypt(value[len(_ENC_PREFIX):].encode("ascii")).decode("utf-8")
    except Exception:
        return ""


# ─── raw read / write ────────────────────────────────────────────────────────

def _read_raw() -> dict:
    """The on-disk dict (secrets still encrypted). {} if absent/unreadable."""
    if not CRED_PATH.exists():
        return {}
    try:
        return json.loads(CRED_PATH.read_text(encoding="utf-8")) or {}
    except Exception:
        return {}


def _write_raw(data: dict):
    _VAR_DIR.mkdir(parents=True, exist_ok=True)
    CRED_PATH.write_text(json.dumps(data, indent=2), encoding="utf-8")
    _chmod_600(CRED_PATH)


def get(key: str):
    """Decrypted plaintext value for one field, or None. Server-side use only —
    never return this to the client for a secret field."""
    raw = _read_raw().get(key)
    if raw is None:
        return None
    return _decrypt(raw) if key in _SECRET_KEYS else raw


# ─── public API ──────────────────────────────────────────────────────────────

def _mask(value: str) -> str:
    """Last-4 mask for display, e.g. '••••-21727bee8722' -> '••••8722'."""
    if not value:
        return ""
    tail = value[-4:]
    return "••••" + tail


def masked_view() -> dict:
    """Client-safe view: the field schema plus, per field, whether a value is set
    and (for secrets) only its last-4 mask. NEVER includes a plaintext secret."""
    raw = _read_raw()
    fields = []
    for f in FIELDS:
        k = f["key"]
        present = bool(raw.get(k))
        if f["secret"]:
            display = _mask(_decrypt(raw[k])) if present else ""
            value = ""                       # never send the plaintext secret
        else:
            display = raw.get(k, "") or ""
            value = display                  # non-secret: safe to echo for editing
        fields.append({**f, "set": present, "display": display, "value": value})
    return {
        "fields": fields,
        "encrypted": encryption_available(),
        "store_path": str(CRED_PATH.relative_to(_REPO_ROOT)) if str(CRED_PATH).startswith(str(_REPO_ROOT)) else str(CRED_PATH),
        "note": ("Secrets are encrypted at rest (Fernet) in a gitignored runtime file."
                 if encryption_available() else
                 "cryptography unavailable — secrets stored in the gitignored runtime "
                 "file as plaintext (limitation). Install 'cryptography' to encrypt."),
    }


def save(updates: dict) -> dict:
    """Merge non-empty submitted values into the store (a blank field is a no-op,
    so the user need not re-type a masked secret to save the rest). Secret fields
    are encrypted at rest. Saving the Finviz token also updates the running config.
    Returns the masked_view(). Never logs values."""
    raw = _read_raw()
    changed = []
    for f in FIELDS:
        k = f["key"]
        if k not in (updates or {}):
            continue
        val = updates.get(k)
        if val is None:
            continue
        val = str(val).strip()
        if val == "":
            continue                          # blank = leave existing value untouched
        raw[k] = _encrypt(val) if f["secret"] else val
        changed.append(k)
    _write_raw(raw)

    # Side-effect: a saved Finviz token feeds the same config the app reads.
    if FINVIZ_TOKEN_KEY in changed:
        apply_finviz_token(_decrypt(raw[FINVIZ_TOKEN_KEY]))

    return masked_view()


def apply_finviz_token(token: str) -> bool:
    """Mirror a UI-saved token into os.environ so it also becomes the .env-level
    fallback for this process. The authoritative path is config.get_finviz_token(),
    which every Finviz caller reads fresh at call time (chart / screener / multicap
    / correlation), so a saved token takes effect immediately with no restart and
    nothing is re-hardcoded. Never logs the token."""
    if not token:
        return False
    os.environ["FINVIZ_TOKEN"] = token
    return True


def validate_finviz_token(token: str = None) -> dict:
    """Lightweight liveness check: one small Finviz Elite export call to confirm a
    token is accepted. Uses the given token, else the live config value. Returns
    {"ok", "status", "rows", "message"} for the UI ("valid, N rows" / "rejected,
    401"). Best-effort and never raises; never logs the token."""
    try:
        import config
        tok = (token or config.get_finviz_token() or "").strip()
    except Exception:
        tok = (token or "").strip()
    if not tok:
        return {"ok": False, "status": None, "rows": 0, "message": "No Finviz token set."}
    # Mega-cap export is small and reliably non-empty — enough to prove auth.
    url = "https://elite.finviz.com/export?v=111&f=cap_mega&auth=" + tok
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/csv,text/plain,*/*",
        "Referer": "https://finviz.com/",
    }
    try:
        from curl_cffi import requests as cffi_requests
        resp = cffi_requests.get(url, headers=headers, impersonate="chrome124", timeout=20)
    except Exception as exc:
        return {"ok": False, "status": None, "rows": 0,
                "message": f"Could not reach Finviz ({exc.__class__.__name__})."}
    code = resp.status_code
    if code in (401, 403):
        return {"ok": False, "status": code, "rows": 0,
                "message": f"Rejected (HTTP {code}) — token invalid or expired."}
    if code == 429:
        return {"ok": False, "status": 429, "rows": 0,
                "message": "Rate-limited (HTTP 429) — token looks valid; retry to confirm row count."}
    body = resp.text or ""
    if code != 200 or body.lstrip().startswith("<"):
        return {"ok": False, "status": code, "rows": 0,
                "message": f"Unexpected response (HTTP {code}) — token may be invalid."}
    rows = max(0, sum(1 for ln in body.splitlines() if ln.strip()) - 1)  # minus CSV header
    return {"ok": True, "status": 200, "rows": rows, "message": f"Valid — {rows} rows."}


def get_bluesky_credentials() -> tuple:
    """(handle, app_password) for the Bluesky source. Prefers the gitignored
    credentials store; falls back to the BLUESKY_HANDLE / BLUESKY_APP_PASSWORD env
    vars. Returns (None, None) when not configured so the source disables cleanly."""
    handle = get("bluesky_handle") or os.environ.get("BLUESKY_HANDLE")
    app_pw = get("bluesky_app_password") or os.environ.get("BLUESKY_APP_PASSWORD")
    handle = (handle or "").strip() or None
    app_pw = (app_pw or "").strip() or None
    if handle and app_pw:
        return handle, app_pw
    return None, None


def get_reddit_credentials() -> tuple:
    """(client_id, client_secret, user_agent) for the Reddit source. Prefers the
    gitignored credentials store; falls back to the REDDIT_CLIENT_ID /
    REDDIT_CLIENT_SECRET / REDDIT_USER_AGENT env vars. A sensible default user
    agent is used when only the id+secret are given. Returns (None, None, None)
    when id or secret is missing so the source disables cleanly."""
    cid = get("reddit_client_id") or os.environ.get("REDDIT_CLIENT_ID")
    secret = get("reddit_client_secret") or os.environ.get("REDDIT_CLIENT_SECRET")
    ua = get("reddit_user_agent") or os.environ.get("REDDIT_USER_AGENT")
    cid = (cid or "").strip() or None
    secret = (secret or "").strip() or None
    ua = (ua or "").strip() or None
    if cid and secret:
        return cid, secret, (ua or "sentiment-scout/1.0 (app-only)")
    return None, None, None


def apply_persisted_finviz_token():
    """On startup, if a Finviz token was saved via the UI, re-apply it so it
    survives restarts and feeds config without being re-hardcoded anywhere."""
    tok = get(FINVIZ_TOKEN_KEY)
    if tok:
        apply_finviz_token(tok)
