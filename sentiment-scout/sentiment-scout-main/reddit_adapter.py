"""
Reddit social adapter
─────────────────────
The third real social source, mirroring bluesky_adapter / the Stocktwits (Yosef)
path so the social panel and the Social page's platform tabs are multi-source.

Design mirrors bluesky_adapter exactly:
  • Per-ticker rolling-window metrics (sentiment + message density) with the SAME
    shape the other sources use: {TICKER: {"sentiment": float[-1,1]|None,
    "density": int, "bull": int, "bear": int}}.
  • Stored in its OWN MongoDB collection (sentiment_scout.reddit_messages) so
    Reddit is distinguishable; Stocktwits and Bluesky are untouched, never merged.
  • Sentiment is scored with VADER (nltk) — the same lexicon FeedFlash/Bluesky
    use — no model call, no extra heavy dependency.

Credentials are app-only OAuth (client id + secret + user agent) from the
gitignored credentials store (or REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET /
REDDIT_USER_AGENT env). With no credentials the source disables cleanly: every
function is a graceful no-op and is_configured() is False, so the UI shows
"not configured" rather than errors or fabricated values.
"""

import logging
import os
import re
import time
from datetime import datetime, timedelta, timezone

import credentials_store

logger = logging.getLogger("reddit_adapter")

# Mongo location is env-driven (MONGO_URI), same as the other social paths.
_MONGO_URI = os.environ.get("MONGO_URI", "mongodb://localhost:27017")
_DB_NAME   = "sentiment_scout"
_COL_NAME  = "reddit_messages"      # separate collection — never merged

PLATFORM = "reddit"

# Finance subreddits searched per ticker.
SUBREDDITS = ["wallstreetbets", "stocks", "investing"]

# Ingestion budget — Reddit's API is rate-limited (~60 req/min OAuth), so cap the
# per-cycle ticker count and sleep politely between queries.
SCRAPE_UNIVERSE_LIMIT = 12
SEARCH_LIMIT_PER_TICKER = 25         # results per subreddit search
_POLITE_SLEEP_SEC = 1.0
_SEARCH_WINDOW_HOURS = 72            # only keep posts newer than this

# VADER thresholds (nltk's standard cutoffs) → Bullish/Bearish/Neutral labels,
# so the (bull-bear)/(bull+bear) aggregate matches the other sources' formula.
_POS_CUTOFF = 0.05
_NEG_CUTOFF = -0.05


# ─── CREDENTIALS / CONFIG ─────────────────────────────────────────────────────

def is_configured() -> bool:
    """True only when a client id and secret are available."""
    cid, secret, _ = credentials_store.get_reddit_credentials()
    return bool(cid and secret)


def status() -> dict:
    """Small status blob for the UI: configured flag (no secret echoed)."""
    cid, secret, _ = credentials_store.get_reddit_credentials()
    return {"platform": PLATFORM, "configured": bool(cid and secret)}


# ─── SENTIMENT (VADER, lazily initialised) ────────────────────────────────────

_vader = None


def _get_vader():
    """Lazily build the VADER analyzer (downloads the lexicon once if missing),
    mirroring FeedFlash/Bluesky. None if nltk is unavailable."""
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
        logger.warning("[reddit] VADER unavailable: %s", exc)
        _vader = None
    return _vader


def _label(text: str):
    """(label, compound) for one post/comment. label ∈ {Bullish,Bearish,Neutral}
    or None when VADER is unavailable."""
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
    """The reddit_messages collection, or None if MongoDB/pymongo is unavailable."""
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
        logger.info("[reddit] MongoDB unavailable (%s): %s", _MONGO_URI, exc)
        return None


# ─── METRICS (mirrors bluesky_adapter / yosef_adapter) ────────────────────────

def _window_aggregates(col, start_utc, ticker=None) -> dict:
    """bull/bear/total counts + sentiment_score = (bull-bear)/(bull+bear) per
    ticker over the window — identical formula to the other social sources."""
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
    """Per-ticker Reddit sentiment + density over a rolling window, in the SAME
    shape as the other social sources:
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
        logger.warning("[reddit] metrics error: %s", exc)
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


def fetch_reddit_posts(ticker: str = None, limit: int = 50,
                       window_minutes: int = 72 * 60) -> list:
    """Recent stored Reddit posts/comments for the Social feed, newest first. []
    if not configured or MongoDB is down."""
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
                "subreddit":   doc.get("subreddit"),
                "platform":    PLATFORM,
            })
        return out
    except Exception as exc:
        logger.warning("[reddit] post query error: %s", exc)
        return []


# ─── INGESTION (called by the dashboard scheduler) ────────────────────────────

def _screener_social_universe(limit: int = SCRAPE_UNIVERSE_LIMIT) -> list:
    """Tickers to query Reddit for — reuse Yosef's screener-movers universe so all
    social sources track the same tickers on screen."""
    try:
        import yosef_adapter
        return yosef_adapter.screener_social_universe(limit=limit)
    except Exception:
        return ["TSLA", "NVDA", "AAPL", "AMD"][:limit]


def _mentions(text: str, ticker: str) -> bool:
    """True if text mentions the ticker as a cashtag ($TICK) or a bare uppercase
    word-boundary symbol — avoids matching common English words by requiring the
    exact upper-case token."""
    if not text:
        return False
    if re.search(rf"\${re.escape(ticker)}\b", text, re.IGNORECASE):
        return True
    return re.search(rf"(?<![A-Za-z0-9]){re.escape(ticker)}(?![A-Za-z0-9])", text) is not None


def run_reddit_scraper(tickers: list = None,
                       limit_per_ticker: int = SEARCH_LIMIT_PER_TICKER) -> bool:
    """One ingestion cycle: authenticate app-only OAuth (read-only), search the
    finance subreddits for each screener ticker's cashtag/symbol mentions, score
    each matching post with VADER, and upsert into the reddit_messages collection
    (deduped by submission id).

    Designed for APScheduler — never raises. Cleanly returns False (a no-op) when
    not configured, when praw isn't installed, or when MongoDB is down, so the
    dashboard stays up and nothing is fabricated."""
    cid, secret, ua = credentials_store.get_reddit_credentials()
    if not (cid and secret):
        logger.info("[reddit] not configured — skipping ingestion")
        return False
    try:
        import praw
    except ImportError:
        logger.warning("[reddit] praw not installed — skipping ingestion")
        return False
    col = _get_collection()
    if col is None:
        logger.info("[reddit] MongoDB unavailable — skipping ingestion")
        return False

    try:
        reddit = praw.Reddit(client_id=cid, client_secret=secret, user_agent=ua,
                             check_for_async=False)
        reddit.read_only = True
    except Exception as exc:
        logger.warning("[reddit] auth failed: %s", exc)
        return False

    universe = [t.upper() for t in (tickers or _screener_social_universe()) if t]
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=_SEARCH_WINDOW_HOURS)).timestamp()
    subs = "+".join(SUBREDDITS)
    total_new = 0
    for t in universe:
        try:
            results = reddit.subreddit(subs).search(
                f"${t} OR {t}", sort="new", time_filter="week", limit=limit_per_ticker)
            for sub in results:
                try:
                    title = getattr(sub, "title", "") or ""
                    body = getattr(sub, "selftext", "") or ""
                    text = (title + " " + body).strip()
                    if not _mentions(text, t):
                        continue
                    created = getattr(sub, "created_utc", None)
                    if created and created < cutoff:
                        continue
                    label, compound = _label(text)
                    sid = getattr(sub, "id", None) or getattr(sub, "name", "")
                    created_dt = (datetime.fromtimestamp(created, tz=timezone.utc)
                                  if created else datetime.now(timezone.utc))
                    author = str(getattr(sub, "author", "") or "") or None
                    permalink = getattr(sub, "permalink", None)
                    doc = {
                        "_id":           f"reddit-{sid}-{t}",
                        "ticker":        t,
                        "text":          text[:2000],
                        "sentiment":     label,
                        "compound":      compound,
                        "author":        author,
                        "subreddit":     str(getattr(sub, "subreddit", "") or ""),
                        "url":           f"https://reddit.com{permalink}" if permalink else None,
                        "created_at":    created_dt.isoformat(),
                        "created_at_dt": created_dt,
                        "platform":      PLATFORM,
                    }
                    col.replace_one({"_id": doc["_id"]}, doc, upsert=True)
                    total_new += 1
                except Exception:
                    continue
        except Exception as exc:
            logger.info("[reddit] search failed for %s: %s", t, exc)
        time.sleep(_POLITE_SLEEP_SEC)   # rate-limit courtesy between tickers

    logger.info("[reddit] ingestion cycle: upserted %s posts across %s tickers",
                total_new, len(universe))
    print(f"  [reddit] upserted {total_new} posts across {len(universe)} tickers")
    return True
