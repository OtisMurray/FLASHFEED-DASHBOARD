"""
health.py — cheap, read-only health snapshot for the Settings status panel.

Surfaces per-component OK / stale / down so source breakage is visible at a
glance instead of via an empty dashboard. Deliberately lightweight:

  • Each data/social/news source is judged from data ALREADY stored (a MAX
    timestamp + a COUNT) — sources are never re-polled here.
  • The Finviz token is the one live probe (a single cheap export call), and it
    is cached briefly so a polling panel cannot hammer Finviz.

Additive and off the data path: this module only reads. It imports the adapter
modules solely to reuse their store-path constants / DB finders (read-only) and
credentials_store for the Finviz probe. Removing this file changes no behaviour.

Status vocabulary:
  ok     — data is present and recent (or, for Finviz, auth succeeds now)
  stale  — data exists but the newest item is older than the component's window
  down   — the store is unreachable / there is no data (or Finviz auth fails)
  off    — the source is intentionally not configured (grey, not an alarm)
"""

import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path

import credentials_store

_REPO_ROOT = Path(__file__).resolve().parent
_DB_PATH = _REPO_ROOT / "sentiment_screener.db"

# Recency windows (seconds): a component WITH data older than this is "stale".
# Tuned to each source's cadence — the social/news jobs run every 5–10 min, SEC
# filings are sparse, and the main screener pipeline is run on demand.
_STALE_AFTER = {
    "tradingview": 3 * 3600,
    "feedflash":   3 * 3600,
    "sec":         12 * 3600,
    "social":      1 * 3600,
    "pipeline":    24 * 3600,
}

# Finviz probe cache — keeps a polling panel from hammering Finviz.
_FINVIZ_TTL = 60
_finviz_cache = {"ts": 0.0, "result": None}


# ─── time helpers ─────────────────────────────────────────────────────────────

def _to_dt(value):
    """Best-effort parse of a stored timestamp (ISO string or datetime) to an
    aware UTC datetime. Naive values are assumed UTC. None on failure."""
    if value is None:
        return None
    if isinstance(value, datetime):
        dt = value
    else:
        s = str(value).strip()
        if not s:
            return None
        try:
            dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        except ValueError:
            return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _age_seconds(value):
    dt = _to_dt(value)
    if dt is None:
        return None
    return (datetime.now(timezone.utc) - dt).total_seconds()


def _humanize(seconds):
    if seconds is None:
        return "unknown"
    s = int(max(0, seconds))
    if s < 90:
        return f"{s}s ago"
    if s < 5400:
        return f"{s // 60}m ago"
    if s < 172800:
        return f"{s // 3600}h ago"
    return f"{s // 86400}d ago"


def _iso(value):
    dt = _to_dt(value)
    return dt.isoformat() if dt else None


def _classify(last, count, kind, store_ok=True):
    """Shared rule for data-backed sources: down if the store is unreachable or
    empty, stale if the newest item is older than the window, else ok."""
    if not store_ok:
        return "down", "store unreachable"
    if not count or last is None:
        return "down", "no data stored"
    age = _age_seconds(last)
    window = _STALE_AFTER.get(kind, 2 * 3600)
    if age is None:
        return "stale", "no usable timestamp"
    if age > window:
        return "stale", f"last item {_humanize(age)}"
    return "ok", f"last item {_humanize(age)}"


def _component(key, label, group, status, detail, last=None, count=None, extra=None):
    c = {"key": key, "label": label, "group": group, "status": status,
         "detail": detail, "last_success": _iso(last), "count": count}
    if extra:
        c.update(extra)
    return c


# ─── SQLite probes (read-only) ────────────────────────────────────────────────

def _sqlite_one(db_path, sql):
    """Run a single-row query against a SQLite file read-only. Returns the row
    tuple, or None if the file/query is unavailable (treated as 'store down')."""
    try:
        if not Path(db_path).exists():
            return None
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=3)
        try:
            return conn.execute(sql).fetchone()
        finally:
            conn.close()
    except sqlite3.Error:
        return None


# ─── per-component checks ─────────────────────────────────────────────────────

def _finviz(refresh=False):
    now = time.time()
    if not refresh and _finviz_cache["result"] is not None \
            and now - _finviz_cache["ts"] < _FINVIZ_TTL:
        v = _finviz_cache["result"]
    else:
        v = credentials_store.validate_finviz_token()
        _finviz_cache.update({"ts": now, "result": v})
    status = "ok" if v.get("ok") else "down"
    return _component("finviz", "Finviz token", "Data feed", status,
                      v.get("message", ""), count=v.get("rows"),
                      extra={"probe": True, "http_status": v.get("status")})


def _sec_edgar():
    row = _sqlite_one(_DB_PATH,
                      "SELECT COUNT(*), MAX(fetched_at) FROM rss_items "
                      "WHERE source LIKE 'SEC%'")
    count, last = (row or (None, None))
    status, detail = _classify(last, count, "sec", store_ok=row is not None)
    return _component("sec_edgar", "SEC EDGAR 8-K", "News", status, detail, last, count)


def _feedflash():
    try:
        import priyanshu_adapter
        db = priyanshu_adapter._find_db()
    except Exception:
        db = None
    if db is None:
        return _component("feedflash", "FeedFlash (structured)", "News",
                          "down", "feedflash.db not found")
    row = _sqlite_one(db, "SELECT COUNT(*), MAX(COALESCE(`datetime`, "
                          "publish_date, fetched_date)) FROM articles")
    count, last = (row or (None, None))
    status, detail = _classify(last, count, "feedflash", store_ok=row is not None)
    return _component("feedflash", "FeedFlash (structured)", "News", status, detail, last, count)


def _tradingview():
    try:
        import tradingview_adapter
        store = tradingview_adapter.STORE_PATH
    except Exception:
        store = None
    if not store or not Path(store).exists():
        return _component("tradingview", "TradingView", "News",
                          "down", "store not present yet")
    row = _sqlite_one(store, "SELECT COUNT(*), MAX(COALESCE(published_at, "
                             "fetched_at)) FROM tv_news")
    count, last = (row or (None, None))
    status, detail = _classify(last, count, "tradingview", store_ok=row is not None)
    return _component("tradingview", "TradingView", "News", status, detail, last, count)


def _mongo_recency(db_name, col_name, ts_field="created_at_dt"):
    """(count, newest_ts, reachable) for a Mongo collection — cheap, 2s timeout.
    reachable=False when pymongo/Mongo is unavailable so the caller marks 'down'."""
    try:
        from pymongo import MongoClient
        import os
        uri = os.environ.get("MONGO_URI", "mongodb://localhost:27017")
        client = MongoClient(uri, serverSelectionTimeoutMS=2000)
        client.server_info()
        col = client[db_name][col_name]
        count = col.estimated_document_count()
        newest = list(col.find({ts_field: {"$exists": True}}).sort(ts_field, -1).limit(1))
        last = newest[0].get(ts_field) if newest else None
        client.close()
        return count, last, True
    except Exception:
        return None, None, False


def _social(key, label, db_name, col_name, configured=True):
    if not configured:
        return _component(key, label, "Social", "off", "not configured",
                          extra={"configured": False})
    count, last, reachable = _mongo_recency(db_name, col_name)
    status, detail = _classify(last, count, "social", store_ok=reachable)
    return _component(key, label, "Social", status, detail, last, count,
                      extra={"configured": True})


def _bluesky():
    try:
        import bluesky_adapter
        configured = bluesky_adapter.is_configured()
    except Exception:
        configured = True
    return _social("bluesky", "Bluesky", "sentiment_scout", "bluesky_messages", configured)


def _stocktwits():
    # Stocktwits ingestion (Yosef) runs unconditionally — no credentials gate.
    return _social("stocktwits", "Stocktwits", "stocktwits", "messages", True)


def _pipeline():
    runs = _sqlite_one(_DB_PATH, "SELECT COUNT(*), MAX(run_timestamp) FROM screener_runs")
    pick = _sqlite_one(_DB_PATH, "SELECT MAX(created_at) FROM ticker_insights")
    run_count, last_run = (runs or (None, None))
    last_pick = pick[0] if pick else None
    status, detail = _classify(last_run, run_count, "pipeline", store_ok=runs is not None)
    return _component("pipeline", "Screener pipeline", "Pipeline", status, detail,
                      last_run, run_count,
                      extra={"last_pick": _iso(last_pick)})


# ─── public API ───────────────────────────────────────────────────────────────

def collect(refresh=False) -> dict:
    """Full health snapshot. `refresh=True` bypasses the Finviz probe cache.
    Overall is 'ok' only when every non-off component is ok, else 'degraded'."""
    components = [
        _finviz(refresh=refresh),
        _sec_edgar(),
        _feedflash(),
        _tradingview(),
        _bluesky(),
        _stocktwits(),
        _pipeline(),
    ]
    bad = [c for c in components if c["status"] in ("stale", "down")]
    overall = "ok" if not bad else "degraded"
    return {
        "overall": overall,
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "components": components,
        "summary": {
            "ok":    sum(1 for c in components if c["status"] == "ok"),
            "stale": sum(1 for c in components if c["status"] == "stale"),
            "down":  sum(1 for c in components if c["status"] == "down"),
            "off":   sum(1 for c in components if c["status"] == "off"),
        },
    }
