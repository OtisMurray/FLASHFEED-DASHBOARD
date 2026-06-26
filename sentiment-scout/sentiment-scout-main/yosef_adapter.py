"""
Yosef Stocktwits adapter: reads messages from MongoDB (his IST495 pipeline).
Fails gracefully if MongoDB is unavailable.

Field mapping (Yosef's stocktwits.messages document -> dashboard fields):
    stream_symbol   -> ticker
    post            -> message_text
    created_at      -> timestamp           (ISO string; created_at_dt is the datetime)
    sentiment       -> per-message tag     ("Bullish"/"Bearish"/None)
    (window agg)    -> sentiment_score     ((bull-bear)/(bull+bear) over window, his formula)
    (window agg)    -> bull_count / bear_count / total_messages
    (window agg)    -> rolling_window_score (sentiment_score over the rolling window)
Missing fields fall back to None.

Databases (from src/mongo/mongo_rt.py and src/scraper/scrape_finviz_tickers_curl_mongo.py):
    stocktwits.messages   — scraped Stocktwits posts
    stocktwits.state      — per-ticker since-id cursors
    ist495.finviz_elite   — latest Finviz screener snapshot
"""

import csv
import logging
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

logger = logging.getLogger("yosef_adapter")

# Mongo location is env-driven (MONGO_URI) so a deployed host can point at Atlas;
# defaults to the local daemon so local dev is unchanged.
_MONGO_URI = os.environ.get("MONGO_URI", "mongodb://localhost:27017")
_DB_NAME   = "stocktwits"
_COL_NAME  = "messages"

# Yosef's scraper codebase is vendored into the repo at external/yosef. The CODE
# default is repo-relative (this file lives at the repo root), so a fresh clone is
# self-contained with no ~/dev present. The WRITABLE ticker CSV must not churn the
# tracked external/ tree, so it defaults into the gitignored var/ runtime dir.
# Override with the YOSEF_ROOT / YOSEF_FINVIZ_CSV env vars. The scraper writes to
# MongoDB (not the repo), so nothing hardcodes a transient path.
_REPO_ROOT   = Path(__file__).resolve().parent
# Runtime/writable data lives under VAR_ROOT (default repo/var) so a deployed host
# can mount a persistent volume there; defaults keep local dev unchanged.
_VAR_ROOT    = Path(os.environ.get("VAR_ROOT", str(_REPO_ROOT / "var")))
YOSEF_ROOT   = Path(os.environ.get("YOSEF_ROOT", str(_REPO_ROOT / "external" / "yosef")))
SCRAPER_PATH = YOSEF_ROOT / "src" / "scraper" / "scrape_finviz_tickers_curl_mongo.py"
FINVIZ_CSV   = os.environ.get(
    "YOSEF_FINVIZ_CSV", str(_VAR_ROOT / "yosef" / "yosef_finviz_input.csv"))
SCRAPER_TIMEOUT_SEC = 120

# The Stocktwits scrape is one API call + a 0.8–1.5s polite sleep PER ticker, so
# the cycle time scales with the list length — the bundled 108-ticker CSV blew the
# 120s budget. We REPLACE that fixed list each cycle with the live screener movers
# (capped tight), plus a small baseline of reliably-active Stocktwits names so the
# social column/panel never goes fully empty when the small-cap movers are quiet.
SOCIAL_UNIVERSE_LIMIT = 20            # ~20 tickers ≈ 30–45s/cycle, well under 120s
_SOCIAL_BASELINE = ["TSLA", "NVDA", "AAPL", "AMD"]  # high-chatter continuity names

# Yosef's clean-message filter (mongo_rt.py _clean_message_match)
_CLEAN_FILTER = [
    {"$or": [{"is_low_quality": {"$exists": False}}, {"is_low_quality": False}]},
    {"$or": [{"is_spam": {"$exists": False}}, {"is_spam": False}]},
    {"$or": [{"is_duplicate_exact": {"$exists": False}}, {"is_duplicate_exact": False}]},
]

# Rumor cue lists copied from Yosef's mongo_rt.py (classify_rumor_direction)
_BUY_IN_CUES = (
    "buy", "loading", "load up", "adding", "added", "accumulate", "bullish",
    "breakout", "squeeze", "moon", "rip", "runner", "approval", "partnership",
    "contract", "deal", "acquisition", "merger", "news coming", "news soon",
    "upside", "bounce", "rebound", "calls", "covering", "entry", "undervalued",
    "gap up", "momentum", "watching", "reversal",
)
_LEAVE_CUES = (
    "sell", "selling", "exit", "get out", "leave", "dump", "rug", "rug pull",
    "offering", "dilution", "reverse split", "delist", "bankruptcy", "fraud",
    "bearish", "puts", "short", "collapse", "downside", "take profit",
    "profit taking", "bad news", "halt", "scam", "avoid", "cut losses",
)


def classify_rumor_direction(post: str, sentiment: str) -> str | None:
    """Yosef's cue-based rumor classifier (mongo_rt.py classify_rumor_direction).
    Returns "Buy-In", "Leave", or None when no cue language is present."""
    text = (post or "").lower()
    buy = sum(c in text for c in _BUY_IN_CUES)
    leave = sum(c in text for c in _LEAVE_CUES)
    sent = (sentiment or "").lower()
    if sent == "bullish":
        buy += 1
    elif sent == "bearish":
        leave += 1
    if buy == 0 and leave == 0:
        return None
    if buy > leave:
        return "Buy-In"
    if leave > buy:
        return "Leave"
    return {"bullish": "Buy-In", "bearish": "Leave"}.get(sent)


def _get_collection():
    """Return the messages collection, or None if MongoDB is unreachable."""
    try:
        from pymongo import MongoClient
    except ImportError:
        print("  [yosef] pymongo not installed — returning []")
        return None
    try:
        client = MongoClient(_MONGO_URI, serverSelectionTimeoutMS=2000)
        client.server_info()  # raises on connection failure
        return client[_DB_NAME][_COL_NAME]
    except Exception as exc:
        print(f"  [yosef] MongoDB unavailable ({_MONGO_URI}): {exc} — returning []")
        return None


def _window_aggregates(col, start_utc, ticker=None) -> dict:
    """
    Per-ticker rolling-window aggregates using Yosef's agg_ticker_summary
    pipeline: bull/bear/total counts and sentiment_score = (bull-bear)/(bull+bear).
    Returns {ticker: {bull, bear, total, score}}.
    """
    match = {"created_at_dt": {"$gte": start_utc},
             "stream_symbol": {"$exists": True, "$ne": None},
             "$and": _CLEAN_FILTER}
    if ticker:
        match["stream_symbol"] = ticker.upper()
    pipeline = [
        {"$match": match},
        {"$group": {
            "_id": "$stream_symbol",
            "total": {"$sum": 1},
            "bull": {"$sum": {"$cond": [{"$eq": ["$sentiment", "Bullish"]}, 1, 0]}},
            "bear": {"$sum": {"$cond": [{"$eq": ["$sentiment", "Bearish"]}, 1, 0]}},
        }},
    ]
    out = {}
    for row in col.aggregate(pipeline):
        tagged = row["bull"] + row["bear"]
        score = round((row["bull"] - row["bear"]) / tagged, 4) if tagged else 0.0
        out[row["_id"]] = {"bull": row["bull"], "bear": row["bear"],
                           "total": row["total"], "score": score}
    return out


def social_metrics_by_ticker(window_hours: int = 72) -> dict:
    """Per-ticker Stocktwits message sentiment and density over a rolling window,
    for the React Screener's two social columns.

    Reuses Yosef's _window_aggregates pipeline. Returns
    {TICKER: {"sentiment": float[-1,1]|None, "density": int, "bull": int,
    "bear": int}} where sentiment = (bull-bear)/(bull+bear) — None when no posts
    carry a Bullish/Bearish tag, so the column reads as a true null (not a fake
    0). density = total clean messages in the window. {} if MongoDB is down.
    """
    col = _get_collection()
    if col is None:
        return {}
    try:
        start_utc = datetime.now(timezone.utc) - timedelta(hours=window_hours)
        agg = _window_aggregates(col, start_utc)
    except Exception as exc:
        print(f"  [yosef] social metrics error: {exc} — returning {{}}")
        return {}

    out = {}
    for sym, a in agg.items():
        if not sym:
            continue
        tagged = a["bull"] + a["bear"]
        out[sym.upper()] = {
            "sentiment": a["score"] if tagged else None,
            "density":   a["total"],
            "bull":      a["bull"],
            "bear":      a["bear"],
        }
    print(f"  [yosef] social metrics for {len(out)} tickers ({window_hours}h window)")
    return out


def fetch_yosef_social(ticker: str = None, limit: int = 50,
                       window_minutes: int = 60) -> list:
    """
    Fetch latest clean messages from Yosef's MongoDB with per-ticker
    rolling-window sentiment attached. Returns [] if MongoDB is unavailable.
    """
    col = _get_collection()
    if col is None:
        return []

    try:
        start_utc = datetime.now(timezone.utc) - timedelta(minutes=window_minutes)
        agg = _window_aggregates(col, start_utc, ticker)

        query = {"$and": _CLEAN_FILTER}
        if ticker:
            query["stream_symbol"] = ticker.upper()

        cursor = (col.find(query)
                     .sort("created_at_dt", -1)
                     .limit(limit))

        out = []
        for doc in cursor:
            sym = doc.get("stream_symbol")
            win = agg.get(sym, {})
            ts = doc.get("created_at") or (
                doc["created_at_dt"].isoformat() if isinstance(doc.get("created_at_dt"), datetime) else None
            )
            # Classify rumor direction once per message and persist the label
            # on the document so it is stored, not recomputed ad hoc.
            rumor_direction = doc.get("rumor_direction")
            if "rumor_direction" not in doc:
                rumor_direction = classify_rumor_direction(doc.get("post"), doc.get("sentiment"))
                try:
                    col.update_one({"_id": doc["_id"]},
                                   {"$set": {"rumor_direction": rumor_direction}})
                except Exception:
                    pass  # read-only Mongo still gets the computed label in the response
            out.append({
                # Canonical fields (exact mapping per schema audit)
                "ticker":               sym,
                "message_text":         doc.get("post"),
                "sentiment_score":      win.get("score"),
                "bull_count":           win.get("bull"),
                "bear_count":           win.get("bear"),
                "total_messages":       win.get("total"),
                "timestamp":            ts,
                "rolling_window_score": win.get("score"),
                "window_minutes":       window_minutes,
                # Legacy keys the existing Social tab JS reads
                "author":      doc.get("author"),
                "text":        doc.get("post"),
                "sentiment":   doc.get("sentiment") or "",
                "source_type": doc.get("source_type"),
                "rumor_flag":  doc.get("rumor_flag"),
                "rumor_direction": rumor_direction,
                "platform":    "Stocktwits",
            })

        print(f"  [yosef] fetched {len(out)} messages from MongoDB "
              f"({len(agg)} tickers in {window_minutes}m window)")
        return out

    except Exception as exc:
        print(f"  [yosef] query error: {exc} — returning []")
        return []


def fetch_yosef_rumor_detection(tickers: list = None, limit_per_ticker: int = 150,
                                window_minutes: int = 24 * 60) -> list:
    """
    Port of Yosef's get_active_rumor_for_ticker (mongo_rt.py). There is no
    separate rumor collection — rumors are derived from messages via the
    rumor_flag field plus buy-in/leave keyword classification.
    Returns one active-rumor row per ticker (empty fields if none found).
    """
    col = _get_collection()
    if col is None:
        return []

    try:
        start_utc = datetime.now(timezone.utc) - timedelta(minutes=window_minutes)

        if not tickers:
            tickers = col.distinct(
                "stream_symbol",
                {"created_at_dt": {"$gte": start_utc}},
            )

        _classify = classify_rumor_direction

        out = []
        for t in tickers:
            t = (t or "").strip().upper()
            base = {"stream_symbol": t,
                    "created_at_dt": {"$gte": start_utc},
                    "$and": _CLEAN_FILTER}
            row_out = {"ticker": t, "active_rumor": None, "rumor_direction": None,
                       "rumor_time": None, "rumor_author": None, "rumor_reason": None}
            # Pass 1: rumor-flagged messages; pass 2: any message with cue language
            for extra in ({"rumor_flag": True}, {}):
                cur = (col.find({**base, **extra}, {"_id": 0})
                          .sort("created_at_dt", -1).limit(limit_per_ticker))
                hit = None
                for doc in cur:
                    direction = _classify(doc.get("post"), doc.get("sentiment"))
                    if direction:
                        hit = (doc, direction)
                        break
                if hit:
                    doc, direction = hit
                    dt = doc.get("created_at_dt")
                    row_out.update({
                        "active_rumor":    doc.get("post"),
                        "rumor_direction": direction,
                        "rumor_time":      dt.isoformat() if isinstance(dt, datetime) else None,
                        "rumor_author":    doc.get("author"),
                        "rumor_reason":    doc.get("rumor_reason"),
                    })
                    break
            out.append(row_out)

        found = sum(1 for r in out if r["active_rumor"])
        print(f"  [yosef] rumor detection: {found}/{len(out)} tickers with active rumors")
        return out

    except Exception as exc:
        print(f"  [yosef] rumor query error: {exc} — returning []")
        return []


# ─── SCRAPER RUNNER (called by the dashboard scheduler) ──────────────────────

def screener_social_universe(limit: int = SOCIAL_UNIVERSE_LIMIT) -> list:
    """The tickers the Stocktwits scraper should pull each cycle: the top movers
    from the latest multicap screener run (ranked by |% change|, then volume),
    unioned with a small baseline of reliably-active names, capped at `limit`.
    Pure DB read of the multicap table — no Finviz call. Mirrors
    priyanshu_adapter.screener_news_universe. Falls back to the baseline if the
    screener table is empty/unreadable."""
    def _n(x):
        try:
            return abs(float(str(x).replace("%", "").replace(",", "").strip()))
        except (TypeError, ValueError):
            return 0.0
    try:
        import multicap_screener
        rows = [r for r in multicap_screener.get_latest_multicap(limit=500)
                if r.get("status") != "dropped" and r.get("ticker")]
        rows.sort(key=lambda r: (_n(r.get("change_pct")), _n(r.get("volume"))), reverse=True)
        movers = [r["ticker"].upper() for r in rows]
    except Exception as exc:
        logger.warning("[yosef] could not read screener universe: %s", exc)
        movers = []
    # Baseline first so the high-chatter continuity names survive the cap; movers
    # fill the rest. De-dup preserves order. Total is capped tight for the budget.
    seen, out = set(), []
    for t in _SOCIAL_BASELINE + movers:
        if t and t not in seen:
            seen.add(t)
            out.append(t)
        if len(out) >= limit:
            break
    return out


def _write_yosef_csv(tickers: list) -> bool:
    """Write the scraper's input CSV (the gitignored YOSEF_FINVIZ_CSV path the
    scraper already reads via --finviz_csv). Only the `Ticker` column is read by
    the scraper; we write it alone. No vendored change needed."""
    try:
        os.makedirs(os.path.dirname(FINVIZ_CSV), exist_ok=True)
        with open(FINVIZ_CSV, "w", newline="") as fh:
            w = csv.writer(fh)
            w.writerow(["Ticker"])
            for t in tickers:
                w.writerow([t])
        return True
    except Exception as exc:
        logger.error("[yosef] could not write ticker CSV %s: %s", FINVIZ_CSV, exc)
        return False


def run_yosef_scrapers(tickers: list = None) -> bool:
    """
    Run one cycle of Yosef's Stocktwits scraper (--once) against the live screener
    universe. Designed for APScheduler: never raises — errors and timeouts are
    logged and swallowed so the dashboard stays up. A timeout is expected with
    large ticker lists; documents inserted before the kill are kept (the scraper
    persists per-ticker as it goes).

    The input CSV is REFRESHED each cycle with the current screener movers (capped
    at SOCIAL_UNIVERSE_LIMIT), replacing the bundled fixed list — so social data
    tracks the tickers on screen and the cycle stays under the 120s budget. This
    scrapes Stocktwits' public API, not the Finviz token. Pass `tickers` to override.
    """
    if not SCRAPER_PATH.exists():
        logger.warning("[yosef] scraper missing: %s", SCRAPER_PATH)
        return False

    universe = [t.upper() for t in (tickers or screener_social_universe()) if t]
    if not _write_yosef_csv(universe):
        return False
    print(f"  [yosef] social universe ({len(universe)}): {', '.join(universe[:12])}"
          f"{'…' if len(universe) > 12 else ''}")

    try:
        result = subprocess.run(
            [sys.executable, str(SCRAPER_PATH), "--finviz_csv", FINVIZ_CSV, "--once"],
            cwd=str(YOSEF_ROOT),
            capture_output=True,
            text=True,
            timeout=SCRAPER_TIMEOUT_SEC,
        )
        if result.returncode != 0:
            logger.error("[yosef] scraper exited %s: %s",
                         result.returncode, (result.stderr or "")[-300:])
            return False
        print("  [yosef] scraper cycle OK")
        return True
    except subprocess.TimeoutExpired:
        logger.warning("[yosef] scraper timed out after %ss — partial cycle stored",
                       SCRAPER_TIMEOUT_SEC)
        return False
    except Exception as exc:
        logger.error("[yosef] scraper failed: %s", exc)
        return False
