"""
Bluesky social adapter
──────────────────────
A real, second social source that mirrors how the Stocktwits (Yosef) path works,
so the social panel and the Social page's platform tabs become multi-source.

Design mirrors yosef_adapter:
  • Per-ticker rolling-window metrics (sentiment + message density) with the SAME
    shape as yosef_adapter.social_metrics_by_ticker, so the UI treats both sources
    identically: {TICKER: {"sentiment": float[-1,1]|None, "density": int,
    "bull": int, "bear": int}}.
  • Stored in its OWN MongoDB collection (sentiment_scout.bluesky_messages) so
    Bluesky is distinguishable and the existing Stocktwits store is untouched.
  • Sentiment is scored with VADER (nltk) — the same lexicon FeedFlash already
    uses — no model call, no extra heavy dependency.

Credentials come from the gitignored credentials store (or BLUESKY_HANDLE /
BLUESKY_APP_PASSWORD env). With no credentials the source disables cleanly:
every function is a graceful no-op and is_configured() is False, so the UI shows
"not configured" rather than errors or fabricated values.
"""

import logging
import os
import time
from datetime import datetime, timedelta, timezone

import credentials_store

logger = logging.getLogger("bluesky_adapter")

# Mongo location is env-driven (MONGO_URI), same as the other social paths.
_MONGO_URI = os.environ.get("MONGO_URI", "mongodb://localhost:27017")
_DB_NAME   = "sentiment_scout"
_COL_NAME  = "bluesky_messages"     # separate from stocktwits.messages — never merged

PLATFORM = "bluesky"

# Ingestion budget — Bluesky's searchPosts is rate-limited, so cap the per-cycle
# ticker count and sleep politely between queries (mirrors the Yosef cadence).
SCRAPE_UNIVERSE_LIMIT = 15
SEARCH_LIMIT_PER_TICKER = 25
_POLITE_SLEEP_SEC = 1.0

# VADER thresholds (nltk's standard cutoffs) → Bullish/Bearish/Neutral labels,
# so the (bull-bear)/(bull+bear) aggregate matches the Stocktwits formula.
_POS_CUTOFF = 0.05
_NEG_CUTOFF = -0.05


# ─── CREDENTIALS / CONFIG ─────────────────────────────────────────────────────

def is_configured() -> bool:
    """True only when both a handle and an app password are available."""
    handle, app_pw = credentials_store.get_bluesky_credentials()
    return bool(handle and app_pw)


def status() -> dict:
    """Small status blob for the UI: configured flag + (non-secret) handle."""
    handle, app_pw = credentials_store.get_bluesky_credentials()
    return {"platform": PLATFORM, "configured": bool(handle and app_pw),
            "handle": handle or None}


# ─── SENTIMENT (VADER, lazily initialised) ────────────────────────────────────

_vader = None


def _get_vader():
    """Lazily build the VADER analyzer (downloads the lexicon once if missing),
    mirroring FeedFlash's integrated_processor. None if nltk is unavailable."""
    global _vader
    if _vader is not None:
        return _vader
    try:
        import nltk
        try:
            nltk.data.find("sentiment/vader_lexicon.zip")
        except LookupError:
            nltk.download("vader_lexicon", quiet=True)
        from nltk.sentiment.vader import SentimentIntensityAnalyzer
        _vader = SentimentIntensityAnalyzer()
    except Exception as exc:
        logger.warning("[bluesky] VADER unavailable: %s", exc)
        _vader = None
    return _vader


def _label(text: str):
    """(label, compound) for one post. label ∈ {Bullish,Bearish,Neutral} or None
    when VADER is unavailable — mirrors Stocktwits' Bullish/Bearish tagging."""
    v = _get_vader()
    if v is None or not text:
        return None, None
    compound = v.polarity_scores(text)["compound"]
    if compound >= _POS_CUTOFF:
        return "Bullish", compound
    if compound <= _NEG_CUTOFF:
        return "Bearish", compound
    return "Neutral", compound


# ─── MONGO ────────────────────────────────────────────────────────────────────

def _get_collection():
    """The bluesky_messages collection, or None if MongoDB/pymongo is unavailable."""
    try:
        from pymongo import MongoClient
    except ImportError:
        return None
    try:
        client = MongoClient(_MONGO_URI, serverSelectionTimeoutMS=2000)
        client.server_info()
        col = client[_DB_NAME][_COL_NAME]
        col.create_index("ticker")
        col.create_index("created_at_dt")
        return col
    except Exception as exc:
        logger.info("[bluesky] MongoDB unavailable (%s): %s", _MONGO_URI, exc)
        return None


# ─── METRICS (mirrors yosef_adapter.social_metrics_by_ticker) ─────────────────

def _window_aggregates(col, start_utc, ticker=None) -> dict:
    """bull/bear/total counts + sentiment_score = (bull-bear)/(bull+bear) per
    ticker over the window — identical formula to the Stocktwits aggregate."""
    match = {"created_at_dt": {"$gte": start_utc},
             "ticker": {"$exists": True, "$ne": None}}
    if ticker:
        match["ticker"] = ticker.upper()
    pipeline = [
        {"$match": match},
        {"$group": {
            "_id": "$ticker",
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
    """Per-ticker Bluesky sentiment + density over a rolling window, in the SAME
    shape as yosef_adapter.social_metrics_by_ticker:
    {TICKER: {"sentiment": float[-1,1]|None, "density": int, "bull": int,
    "bear": int}}. {} if not configured or MongoDB is down — so the panel reads
    as a clean null, never a fabricated value."""
    if not is_configured():
        return {}
    col = _get_collection()
    if col is None:
        return {}
    try:
        start_utc = datetime.now(timezone.utc) - timedelta(hours=window_hours)
        agg = _window_aggregates(col, start_utc)
    except Exception as exc:
        logger.warning("[bluesky] metrics error: %s", exc)
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
    return out


def fetch_bluesky_posts(ticker: str = None, limit: int = 50,
                        window_minutes: int = 72 * 60) -> list:
    """Recent stored Bluesky posts for the Social feed, newest first. [] if not
    configured or MongoDB is down."""
    if not is_configured():
        return []
    col = _get_collection()
    if col is None:
        return []
    try:
        start_utc = datetime.now(timezone.utc) - timedelta(minutes=window_minutes)
        query = {"created_at_dt": {"$gte": start_utc}}
        if ticker:
            query["ticker"] = ticker.upper()
        cursor = col.find(query).sort("created_at_dt", -1).limit(limit)
        out = []
        for doc in cursor:
            ts = doc.get("created_at")
            if not ts and isinstance(doc.get("created_at_dt"), datetime):
                ts = doc["created_at_dt"].isoformat()
            out.append({
                "ticker":      doc.get("ticker"),
                "text":        doc.get("text"),
                "sentiment":   doc.get("sentiment") or "",
                "compound":    doc.get("compound"),
                "timestamp":   ts,
                "author":      doc.get("author"),
                "url":         doc.get("url"),
                "platform":    PLATFORM,
            })
        return out
    except Exception as exc:
        logger.warning("[bluesky] post query error: %s", exc)
        return []


# ─── INGESTION (called by the dashboard scheduler) ────────────────────────────

def _screener_social_universe(limit: int = SCRAPE_UNIVERSE_LIMIT) -> list:
    """Tickers to query Bluesky for — reuse Yosef's screener-movers universe so
    both social sources track the same tickers on screen."""
    try:
        import yosef_adapter
        return yosef_adapter.screener_social_universe(limit=limit)
    except Exception:
        return ["TSLA", "NVDA", "AAPL", "AMD"][:limit]


def _post_created_dt(record) -> datetime:
    """Parse a post record's created_at into a UTC datetime; now() on failure."""
    raw = getattr(record, "created_at", None) or getattr(record, "createdAt", None)
    if isinstance(raw, str):
        try:
            return datetime.fromisoformat(raw.replace("Z", "+00:00")).astimezone(timezone.utc)
        except Exception:
            pass
    return datetime.now(timezone.utc)


def run_bluesky_scraper(tickers: list = None,
                        limit_per_ticker: int = SEARCH_LIMIT_PER_TICKER) -> bool:
    """One ingestion cycle: authenticate with the Bluesky app password, search the
    screener's current tickers for cashtag mentions ($TICKER), score each post with
    VADER, and upsert into the bluesky_messages collection (deduped by post URI).

    Designed for APScheduler — never raises. Cleanly returns False (a no-op) when
    not configured, when atproto isn't installed, or when MongoDB is down, so the
    dashboard stays up and nothing is fabricated."""
    handle, app_pw = credentials_store.get_bluesky_credentials()
    if not (handle and app_pw):
        logger.info("[bluesky] not configured — skipping ingestion")
        return False
    try:
        from atproto import Client
    except ImportError:
        logger.warning("[bluesky] atproto not installed — skipping ingestion")
        return False
    col = _get_collection()
    if col is None:
        logger.info("[bluesky] MongoDB unavailable — skipping ingestion")
        return False

    try:
        client = Client()
        client.login(handle, app_pw)
    except Exception as exc:
        logger.warning("[bluesky] login failed: %s", exc)
        return False

    universe = [t.upper() for t in (tickers or _screener_social_universe()) if t]
    total_new = 0
    for t in universe:
        try:
            resp = client.app.bsky.feed.search_posts(
                params={"q": f"${t}", "limit": limit_per_ticker})
            posts = getattr(resp, "posts", []) or []
        except Exception as exc:
            logger.info("[bluesky] search failed for %s: %s", t, exc)
            time.sleep(_POLITE_SLEEP_SEC)
            continue
        for p in posts:
            try:
                rec = getattr(p, "record", None)
                text = getattr(rec, "text", "") if rec else ""
                if not text:
                    continue
                label, compound = _label(text)
                uri = getattr(p, "uri", None) or f"{t}-{getattr(p, 'cid', '')}"
                author = getattr(getattr(p, "author", None), "handle", None)
                created_dt = _post_created_dt(rec)
                doc = {
                    "_id":           uri,
                    "ticker":        t,
                    "text":          text,
                    "sentiment":     label,
                    "compound":      compound,
                    "author":        author,
                    "url":           f"https://bsky.app/profile/{author}" if author else None,
                    "created_at":    created_dt.isoformat(),
                    "created_at_dt": created_dt,
                    "platform":      PLATFORM,
                }
                col.replace_one({"_id": uri}, doc, upsert=True)
                total_new += 1
            except Exception:
                continue
        time.sleep(_POLITE_SLEEP_SEC)   # rate-limit courtesy between tickers

    logger.info("[bluesky] ingestion cycle: upserted %s posts across %s tickers",
                total_new, len(universe))
    print(f"  [bluesky] upserted {total_new} posts across {len(universe)} tickers")
    return True
