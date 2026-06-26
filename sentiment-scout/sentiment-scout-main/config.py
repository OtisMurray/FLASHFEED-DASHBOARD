"""
Central configuration / secrets loader.

Loads the gitignored .env next to this file into os.environ (existing env wins),
then exposes secrets via require_env() — which fails loudly when a key is missing
rather than falling back to a baked-in value.

Imported by the modules that need the Finviz token / OpenRouter key, so .env is
loaded regardless of import order (dashboard.py imports correlation_engine and
multicap_screener before its own dotenv load, and the screener modules also run
standalone).
"""
import os
from pathlib import Path

_ENV_FILE = Path(__file__).resolve().parent / ".env"


def _load_dotenv():
    """Minimal .env loader (no dependency). Existing environment variables win."""
    if not _ENV_FILE.exists():
        return
    for line in _ENV_FILE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


_load_dotenv()


def require_env(name: str) -> str:
    """Return os.environ[name], or raise a clear error if missing/empty.

    No hardcoded fallback — a missing secret fails loudly so it can never silently
    revert to a baked-in key committed to source."""
    val = os.environ.get(name)
    if not val:
        raise RuntimeError(
            f"Required environment variable {name!r} is not set. "
            f"Add it to {_ENV_FILE} (copy .env.example and fill it in). "
            f"There is no baked-in fallback."
        )
    return val


def get_finviz_token() -> str:
    """Live Finviz Elite token, resolved at call time.

    Single dynamic accessor every Finviz caller (chart, screener, multicap,
    correlation) reads, so a token saved in Settings takes effect with no
    restart. Resolution order, read fresh on every call:

      1. the encrypted credentials store (Settings → Credentials), if set;
      2. otherwise the .env / os.environ FINVIZ_TOKEN (the persisted default).

    Raises (via require_env) only when neither is set, preserving the
    fail-loud contract — no baked-in fallback is ever introduced."""
    try:
        import credentials_store  # local import: keeps config import-light & avoids cycles
        tok = credentials_store.get(credentials_store.FINVIZ_TOKEN_KEY)
        if tok and tok.strip():
            return tok.strip()
    except Exception:
        # Store unavailable/unreadable — fall back to the .env value below.
        pass
    return require_env("FINVIZ_TOKEN")
