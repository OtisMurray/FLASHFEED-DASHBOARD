"""
Shared social resting store
───────────────────────────
One walk-once-then-persist path over StockTwits, backed by MongoDB
(sentiment_scout.social_history) with an in-memory fallback. Used by both:

  • the Charts tab — background walk with a live progress count (ensure_job +
    read_doc, non-blocking), then instant store reads; and
  • the correlation engine — a synchronous get_messages() that blocks until
    data is available (the Analyze action already blocks).

Both share the same store, so charting a ticker and then opening Correlation
for the same ticker/day reuses the stored history with no second walk. A walk
in progress is deduplicated through a single job registry.

This module imports nothing from dashboard/correlation_engine, so either may
import it without a cycle.
"""

import os
import threading
import time
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from curl_cffi import requests as cffi_requests

EDT = ZoneInfo("America/New_York")
WIN_START_H = 4                   # 04:00 ET session start (research window)
WIN_END_H   = 20                  # 20:00 ET session end

_DB   = "sentiment_scout"
_COLL = "social_history"

# Optional seed hook: dashboard sets this to fall back to its ticker_insights
# snapshots when a live walk returns nothing. Signature: (ticker, date_str) ->
# [(naive_et_dt, sentiment|None)]. Left None for standalone/engine use.
seed_fn = None


def social_window(date_str: str):
    y, m, d = (int(x) for x in date_str.split("-"))
    return (datetime(y, m, d, WIN_START_H, 0, 0),
            datetime(y, m, d, WIN_END_H,   0, 0))


# ─── STOCKTWITS WALK ──────────────────────────────────────────────────────────

def walk_stocktwits(ticker: str, date_str: str, max_pages: int = 120,
                    progress_cb=None, stop_at_id: int | None = None):
    """Paginated StockTwits stream walk for one ticker/day — the research
    scripts' pagination (limit 30, max=<last id>, impersonated chrome session,
    polite sleeps) ported out of Colab.

    Returns (collected, complete, newest_id):
      collected = [(naive_et_dt, sentiment|None, id_str)] within 04:00–20:00 ET
      complete  = reached 04:00 ET within the page cap (False = partial)
      newest_id = max StockTwits id seen (int) or None
    progress_cb(n) is called after each page with the running collected count.
    stop_at_id: incremental mode — stop once a message id <= stop_at_id appears
                (everything older is already persisted)."""
    naive_start, naive_end = social_window(date_str)
    win_start = naive_start.replace(tzinfo=EDT)
    win_end   = naive_end.replace(tzinfo=EDT)
    api_url = f"https://api.stocktwits.com/api/2/streams/symbol/{ticker}.json"
    headers = {
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": f"https://stocktwits.com/symbol/{ticker}",
        "Origin": "https://stocktwits.com",
    }

    def _parse(ts_str):
        return datetime.fromisoformat(ts_str.replace("Z", "+00:00"))

    session = cffi_requests.Session()
    collected, max_id, complete, newest_id = [], None, False, None
    for _ in range(max_pages):
        params = {"limit": 30}
        if max_id is not None:
            params["max"] = max_id
        try:
            resp = session.get(api_url, headers=headers, params=params,
                               timeout=30, impersonate="chrome136")
            resp.raise_for_status()
            data = resp.json()
        except Exception:
            break
        messages = data.get("messages", [])
        if not messages:
            complete = True
            break
        for m in messages:                       # track the highest id seen
            try:
                mid = int(m["id"])
                if newest_id is None or mid > newest_id:
                    newest_id = mid
            except Exception:
                pass
        last_dt = _parse(messages[-1]["created_at"]).astimezone(EDT)
        if last_dt > win_end:        # page entirely after the window — keep walking back
            max_id = messages[-1]["id"]
            if progress_cb:
                progress_cb(len(collected))
            time.sleep(0.5)
            continue
        stop = False
        for msg in messages:
            try:
                mid = int(msg["id"])
            except Exception:
                mid = None
            if stop_at_id is not None and mid is not None and mid <= stop_at_id:
                stop = True                       # reached already-stored territory
                break
            msg_et = _parse(msg["created_at"]).astimezone(EDT)
            if msg_et > win_end:
                continue
            if win_start <= msg_et <= win_end:
                raw = (msg.get("entities") or {}).get("sentiment")
                collected.append((msg_et.replace(tzinfo=None),
                                  raw.get("basic") if raw else None, str(msg["id"])))
            elif msg_et < win_start:
                stop = complete = True
                break
        if progress_cb:
            progress_cb(len(collected))
        if stop:
            break
        max_id = messages[-1]["id"]
        time.sleep(1.0)
    return collected, complete, newest_id


# ─── MONGODB STORE (with in-memory fallback) ──────────────────────────────────

_mongo = {"coll": None, "checked": 0.0}
_mongo_lock = threading.Lock()
_mem: dict = {}                   # in-memory fallback doc store when Mongo is down


def collection():
    """The social_history collection, or None if Mongo is unreachable. Cached;
    re-probed at most every 30s after a failure so callers never hang on a dead
    Mongo."""
    with _mongo_lock:
        if _mongo["coll"] is not None:
            return _mongo["coll"]
        if time.time() - _mongo["checked"] < 30:
            return None
        _mongo["checked"] = time.time()
        try:
            from pymongo import MongoClient
            client = MongoClient(os.environ.get("MONGO_URI", "mongodb://localhost:27017"),
                                 serverSelectionTimeoutMS=1500)
            client.admin.command("ping")
            coll = client[_DB][_COLL]
            coll.create_index("ticker")
            _mongo["coll"] = coll
            return coll
        except Exception as exc:
            print(f"  [social-store] MongoDB unavailable: {exc}")
            return None


def make_doc(ticker, date_str, collected, complete, newest_id):
    return {
        "_id":       f"{ticker}|{date_str}",
        "ticker":    ticker,
        "day":       date_str,
        "messages":  [{"id": c[2], "ts": c[0].isoformat(), "sent": c[1]} for c in collected],
        "complete":  bool(complete),
        "newest_id": str(newest_id) if newest_id else None,
        "msg_count": len(collected),
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }


def read_doc(key):
    """Resting-store lookup: Mongo first, in-memory fallback second."""
    coll = collection()
    if coll is not None:
        try:
            doc = coll.find_one({"_id": key})
            if doc is not None:
                return doc
        except Exception as exc:
            print(f"  [social-store] read failed {key}: {exc}")
    return _mem.get(key)


def save_doc(doc):
    _mem[doc["_id"]] = doc
    coll = collection()
    if coll is not None:
        try:
            coll.replace_one({"_id": doc["_id"]}, doc, upsert=True)
        except Exception as exc:
            print(f"  [social-store] save failed {doc['_id']}: {exc}")


def docs_to_msgs(message_docs):
    """Stored message docs -> [(naive_et_dt, sentiment|None)]."""
    out = []
    for m in message_docs or []:
        try:
            dt = datetime.fromisoformat(m["ts"])
        except Exception:
            continue
        out.append((dt, m.get("sent")))
    return out


def incremental_update(ticker, date_str, doc):
    """Append only messages newer than the stored newest_id (current-day
    top-up). Mutates and re-persists doc. Returns the count of new messages."""
    newest = doc.get("newest_id")
    stop_at = int(newest) if newest and str(newest).isdigit() else None
    fresh, complete, top_id = walk_stocktwits(ticker, date_str, max_pages=25,
                                              stop_at_id=stop_at)
    if not fresh:
        return 0
    existing = {m["id"] for m in doc["messages"]}
    fresh = [c for c in fresh if c[2] not in existing]
    if not fresh:
        return 0
    doc["messages"].extend(
        {"id": c[2], "ts": c[0].isoformat(), "sent": c[1]} for c in fresh)
    doc["msg_count"] = len(doc["messages"])
    if top_id:
        doc["newest_id"] = str(top_id)
    doc["complete"] = bool(doc.get("complete") or complete)
    doc["updated_at"] = datetime.now(timezone.utc).isoformat()
    save_doc(doc)
    return len(fresh)


# ─── WALK JOBS (single registry, dedupes concurrent walks for one key) ────────

_jobs: dict = {}                  # key -> {count, done, error, complete}
_jobs_lock = threading.Lock()


def _job_progress(key, n):
    with _jobs_lock:
        if key in _jobs:
            _jobs[key]["count"] = n


def _run_walk(ticker, date_str, key):
    try:
        collected, complete, newest_id = walk_stocktwits(
            ticker, date_str, progress_cb=lambda n: _job_progress(key, n))
        # Seed from the dashboard's stored snapshots if the live walk got nothing
        # (dead token / rate limit) so a quiet ticker still shows what we have.
        if not collected and seed_fn:
            try:
                seed = seed_fn(ticker, date_str)
            except Exception:
                seed = None
            if seed:
                collected = [(dt, sent, f"seed-{i}") for i, (dt, sent) in enumerate(seed)]
                complete = True
        doc = make_doc(ticker, date_str, collected, complete, newest_id)
        save_doc(doc)
        with _jobs_lock:
            _jobs[key].update(count=len(collected), done=True, complete=complete)
    except Exception as exc:
        print(f"  [social-store] walk failed {key}: {exc}")
        with _jobs_lock:
            _jobs[key].update(done=True, error=str(exc))


def ensure_job(ticker, date_str, key):
    """Start a background walk for key if one isn't already tracked; return the
    job dict ({count, done, error, complete})."""
    with _jobs_lock:
        job = _jobs.get(key)
        if job is not None:
            return job
        _jobs[key] = {"count": 0, "done": False, "error": None, "complete": False}
    threading.Thread(target=_run_walk, args=(ticker, date_str, key),
                     daemon=True).start()
    return _jobs[key]


def clear_job(key):
    with _jobs_lock:
        _jobs.pop(key, None)


def get_messages(ticker, date_str, today=None, wait_timeout=180):
    """Synchronous shared accessor (used by the correlation engine).

    Store hit  -> serve immediately (incremental top-up first when date==today).
    Store miss -> run the walk-once-then-persist path (deduped through the job
                  registry, so it reuses any in-flight Charts walk) and block
                  until it finishes, then serve.

    Returns (msgs, doc) where msgs = [(naive_et_dt, sentiment|None)] over the
    full 04:00–20:00 ET day. (msgs, None) if the walk errored."""
    key = f"{ticker}|{date_str}"
    doc = read_doc(key)
    if doc is None:
        job = ensure_job(ticker, date_str, key)
        deadline = time.time() + wait_timeout
        while not job.get("done") and time.time() < deadline:
            time.sleep(0.3)
        if job.get("error"):
            clear_job(key)        # let a later request retry
            return [], None
        doc = read_doc(key)
        if doc is None:
            return [], None
    elif today is not None and date_str == today:
        try:
            incremental_update(ticker, date_str, doc)
        except Exception as exc:
            print(f"  [social-store] incremental error {key}: {exc}")
    return docs_to_msgs(doc.get("messages")), doc
