"""
mongo_rt.py

Core MongoDB backend utilities for the IST495 Market Intelligence Dashboard.

This file:
- handles MongoDB connections
- parses dashboard time windows
- filters clean Stocktwits messages
- aggregates ticker sentiment and message density
- builds rolling-window timeline data
- detects active rumors and rumor direction
- loads latest Finviz screener snapshots
- classifies traditional vs rumor/social sources

Only comments were added here; backend logic is unchanged.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Optional, Tuple
from urllib.parse import urlparse

import pandas as pd
from pymongo import MongoClient

try:
    from zoneinfo import ZoneInfo
except Exception:
    from backports.zoneinfo import ZoneInfo

# Eastern Time is used throughout the dashboard because the project
# focuses on U.S. market trading activity and trading-day windows.
ET = ZoneInfo("America/New_York")

# Keyword cues used to detect whether a message encourages
# users to buy into a ticker or remain bullish.
BUY_IN_CUES = (
    "buy", "loading", "load up", "adding", "added", "accumulate", "bullish",
    "breakout", "squeeze", "moon", "rip", "runner", "approval", "partnership",
    "contract", "deal", "acquisition", "merger", "news coming", "news soon",
    "upside", "bounce", "rebound", "calls", "covering", "entry", "undervalued",
    "gap up", "momentum", "watching", "reversal"
)
# Keyword cues used to detect whether a message encourages
# users to buy into a ticker or remain bullish.
LEAVE_CUES = (
    "sell", "selling", "exit", "get out", "leave", "dump", "rug", "rug pull",
    "offering", "dilution", "reverse split", "delist", "bankruptcy", "fraud",
    "bearish", "puts", "short", "collapse", "downside", "take profit",
    "profit taking", "bad news", "halt", "scam", "avoid", "cut losses"
)

# Keyword cues suggesting bearish sentiment, exits,
# selling pressure, or leaving a ticker position.
@dataclass(frozen=True)
class MongoCfg:
    uri: str = "mongodb://localhost:27017"
    db: str = "stocktwits"
    messages_col: str = "messages"

# Create a MongoDB client connection using the configured URI.
def _client(cfg: MongoCfg) -> MongoClient:
    return MongoClient(cfg.uri)

# Convert dashboard ET date strings into timezone-aware datetime objects.
def _parse_et_string(dt_str: str) -> datetime:
    dt = datetime.strptime(dt_str.strip(), "%Y-%m-%d %H:%M")
    return dt.replace(tzinfo=ET)

# Build yesterday-only windows used by historical dashboard presets.
def _yesterday_window_et(start_hour: int = 0, start_minute: int = 1) -> tuple[datetime, datetime]:
    now_et = datetime.now(ET)
    y = now_et - timedelta(days=1)

    start_et = y.replace(
        hour=start_hour,
        minute=start_minute,
        second=0,
        microsecond=0,
    )

    end_et = y.replace(
        hour=23,
        minute=59,
        second=59,
        microsecond=0,
    )

    return start_et.astimezone(timezone.utc), end_et.astimezone(timezone.utc)

# Convert dashboard window selections into UTC start/end timestamps
# used by MongoDB queries and graph aggregations.
def parse_window(
    mode: str,
    last_n: int = 30,
    unit: str = "minutes",
    start_et: Optional[str] = None,
    end_et: Optional[str] = None,
) -> Tuple[datetime, datetime]:
    """
    Supported modes:
    - last_n: rolling window ending at current time
    - custom_et: exact ET start/end strings
    - yesterday_0001: yesterday 12:01 AM ET to 11:59:59 PM ET
    - yesterday_4am: yesterday 4:00 AM ET to 11:59:59 PM ET
    - all_time: used by Live Dashboard only
    """
    now_utc = datetime.now(timezone.utc)
    mode = (mode or "").strip().lower()
    unit = (unit or "").strip().lower()

    if mode == "last_n":
        n = int(last_n)

        if unit in ("minute", "minutes", "min", "m"):
            start_utc = now_utc - timedelta(minutes=n)
        elif unit in ("hour", "hours", "hr", "hrs", "h"):
            start_utc = now_utc - timedelta(hours=n)
        elif unit in ("day", "days", "d"):
            start_utc = now_utc - timedelta(days=n)
        elif unit in ("week", "weeks", "w"):
            start_utc = now_utc - timedelta(weeks=n)
        else:
            raise ValueError("unit must be one of: minutes, hours, days, weeks")

        return start_utc, now_utc

    if mode == "custom_et":
        if not start_et or not end_et:
            raise ValueError('custom_et requires start_et and end_et strings like "YYYY-MM-DD HH:MM"')

        start_et_dt = _parse_et_string(start_et)
        end_et_dt = _parse_et_string(end_et)

        if end_et_dt <= start_et_dt:
            raise ValueError("custom_et: end_et must be after start_et")

        return start_et_dt.astimezone(timezone.utc), end_et_dt.astimezone(timezone.utc)

    if mode == "yesterday_0001":
        return _yesterday_window_et(start_hour=0, start_minute=1)

    if mode == "yesterday_4am":
        return _yesterday_window_et(start_hour=4, start_minute=0)

    if mode == "all_time":
        return datetime(2000, 1, 1, tzinfo=timezone.utc), now_utc

    raise ValueError("mode must be one of: last_n, custom_et, yesterday_0001, yesterday_4am, all_time")

# Build a MongoDB filter that removes:
# - low-quality posts
# - spam
# - exact duplicates
# while restricting results to the selected ticker and time range.
def _clean_message_match(start_utc: datetime, end_utc: datetime, ticker: Optional[str] = None) -> dict:
    match = {
        "created_at_dt": {"$gte": start_utc, "$lt": end_utc},
        "stream_symbol": {"$exists": True, "$ne": None},
        "$and": [
            {
                "$or": [
                    {"is_low_quality": {"$exists": False}},
                    {"is_low_quality": False},
                ]
            },
            {
                "$or": [
                    {"is_spam": {"$exists": False}},
                    {"is_spam": False},
                ]
            },
            {
                "$or": [
                    {"is_duplicate_exact": {"$exists": False}},
                    {"is_duplicate_exact": False},
                ]
            },
        ],
    }

    if ticker:
        match["stream_symbol"] = (ticker or "").strip().upper()

    return match

# Convert UTC timestamps into ET trading-day boundaries.
def _day_bounds_from_utc(end_utc: datetime) -> tuple[datetime, datetime]:
    end_et = end_utc.astimezone(ET)
    day_start_et = end_et.replace(hour=0, minute=0, second=0, microsecond=0)
    next_day_et = day_start_et + timedelta(days=1)
    return day_start_et.astimezone(timezone.utc), next_day_et.astimezone(timezone.utc)

# Rule-based rumor classifier.
# Determines whether a message suggests buying in or leaving a ticker.
def classify_rumor_direction(post: str, sentiment: Optional[str] = None) -> Optional[str]:
    text = (post or "").lower()
    buy_score = sum(cue in text for cue in BUY_IN_CUES)
    leave_score = sum(cue in text for cue in LEAVE_CUES)

    sent = (sentiment or "").lower()
    if sent == "bullish":
        buy_score += 1
    elif sent == "bearish":
        leave_score += 1

    if buy_score == 0 and leave_score == 0:
        return None
    if buy_score > leave_score:
        return "Buy-In"
    if leave_score > buy_score:
        return "Leave"
    if sent == "bullish":
        return "Buy-In"
    if sent == "bearish":
        return "Leave"
    return None

# Return one active rumor for a ticker within the selected time range.
# Prioritizes rumor-flagged posts, then falls back to keyword detection.
def get_active_rumor_for_ticker(
    cfg: MongoCfg,
    ticker: str,
    start_utc: datetime,
    end_utc: datetime,
) -> dict:
    col = _client(cfg)[cfg.db][cfg.messages_col]
    ticker = (ticker or "").strip().upper()

    def _pick(match: dict) -> Optional[dict]:
        cur = col.find(
            match,
            {
                "_id": 0,
                "created_at_dt": 1,
                "author": 1,
                "sentiment": 1,
                "post": 1,
                "link": 1,
                "rumor_flag": 1,
                "rumor_reason": 1,
                "source_type": 1,
            },
        ).sort("created_at_dt", -1).limit(150)

        rows = list(cur)

        for row in rows:
            direction = classify_rumor_direction(row.get("post", ""), row.get("sentiment"))
            if direction is None:
                continue

            dt = pd.to_datetime(row.get("created_at_dt"), utc=True, errors="coerce")
            dt_et = dt.tz_convert(ET) if pd.notna(dt) else None

            return {
                "stream_symbol": ticker,
                "active_rumor": row.get("post", ""),
                "rumor_direction": direction,
                "rumor_time_et": dt_et,
                "rumor_time_label": dt_et.strftime("%b %d, %I:%M %p ET") if dt_et is not None else "",
                "rumor_author": row.get("author", ""),
                "rumor_link": row.get("link", ""),
                "rumor_reason": row.get("rumor_reason", ""),
            }

        return None

    # First prioritize rumor-flagged messages inside selected window.
    window_match = _clean_message_match(start_utc, end_utc, ticker)
    window_match["rumor_flag"] = True

    picked = _pick(window_match)
    if picked:
        return picked

    # Then try any message in selected window that has buy/leave language.
    fallback_match = _clean_message_match(start_utc, end_utc, ticker)
    picked = _pick(fallback_match)
    if picked:
        return picked

    return {
        "stream_symbol": ticker,
        "active_rumor": "",
        "rumor_direction": "",
        "rumor_time_et": None,
        "rumor_time_label": "",
        "rumor_author": "",
        "rumor_link": "",
        "rumor_reason": "",
    }

# Build one active-rumor row for every ticker shown on the dashboard.
def get_active_rumors_for_tickers(
    cfg: MongoCfg,
    tickers: list[str],
    start_utc: datetime,
    end_utc: datetime,
) -> pd.DataFrame:
    rows = [
        get_active_rumor_for_ticker(cfg, ticker, start_utc, end_utc)
        for ticker in tickers
    ]

    if not rows:
        return pd.DataFrame(
            columns=[
                "stream_symbol",
                "active_rumor",
                "rumor_direction",
                "rumor_time_et",
                "rumor_time_label",
                "rumor_author",
                "rumor_link",
                "rumor_reason",
            ]
        )

    return pd.DataFrame(rows)

# Main ticker-level aggregation used by the Live Dashboard.
# Computes:
# - total posts
# - bullish/bearish counts
# - source counts
# - rumor counts
# - sentiment score
# - message density
def agg_ticker_summary(
    cfg: MongoCfg,
    start_utc: datetime,
    end_utc: datetime,
    limit: int = 50000,
) -> pd.DataFrame:
    col = _client(cfg)[cfg.db][cfg.messages_col]
    window_minutes = max(1e-9, (end_utc - start_utc).total_seconds() / 60.0)
# MongoDB aggregation pipeline groups messages by ticker symbol
# and calculates summary metrics used in dashboard tables and charts.
    pipeline = [
        {"$match": _clean_message_match(start_utc, end_utc)},
        {
            "$group": {
                "_id": "$stream_symbol",
                "total_posts": {"$sum": 1},
                "bullish": {"$sum": {"$cond": [{"$eq": ["$sentiment", "Bullish"]}, 1, 0]}},
                "bearish": {"$sum": {"$cond": [{"$eq": ["$sentiment", "Bearish"]}, 1, 0]}},
                "unlabeled": {
                    "$sum": {
                        "$cond": [
                            {
                                "$or": [
                                    {"$eq": ["$sentiment", None]},
                                    {"$eq": ["$sentiment", "null"]},
                                    {"$eq": ["$sentiment", ""]},
                                    {"$eq": [{"$type": "$sentiment"}, "missing"]},
                                ]
                            },
                            1,
                            0,
                        ]
                    }
                },
                "traditional_posts": {"$sum": {"$cond": [{"$eq": ["$source_type", "Traditional"]}, 1, 0]}},
                "social_posts": {"$sum": {"$cond": [{"$eq": ["$source_type", "Rumor/Social"]}, 1, 0]}},
                "rumor_posts": {"$sum": {"$cond": [{"$eq": ["$rumor_flag", True]}, 1, 0]}},
            }
        },
        {
            "$project": {
                "_id": 0,
                "stream_symbol": "$_id",
                "total_posts": 1,
                "bullish": 1,
                "bearish": 1,
                "unlabeled": 1,
                "traditional_posts": 1,
                "social_posts": 1,
                "rumor_posts": 1,
                "sentiment_score": {
                    "$cond": [
                        {"$gt": [{"$add": ["$bullish", "$bearish"]}, 0]},
                        {
                            "$divide": [
                                {"$subtract": ["$bullish", "$bearish"]},
                                {"$add": ["$bullish", "$bearish"]},
                            ]
                        },
                        0,
                    ]
                },
            }
        },
        {"$limit": int(limit)},
    ]

    rows = list(col.aggregate(pipeline, allowDiskUse=True))
    df = pd.DataFrame(rows)

    if df.empty:
        return pd.DataFrame(
            columns=[
                "stream_symbol",
                "total_posts",
                "bullish",
                "bearish",
                "unlabeled",
                "traditional_posts",
                "social_posts",
                "rumor_posts",
                "sentiment_score",
                "density_per_min",
            ]
        )

    df["density_per_min"] = df["total_posts"] / window_minutes

    numeric_cols = [
        "total_posts",
        "bullish",
        "bearish",
        "unlabeled",
        "traditional_posts",
        "social_posts",
        "rumor_posts",
        "sentiment_score",
        "density_per_min",
    ]

    for c in numeric_cols:
        if c in df.columns:
            df[c] = pd.to_numeric(df[c], errors="coerce").fillna(0)

    return df

# Aggregate ticker messages into rolling time buckets
# used for timeline graphs and rolling-window overlays.
def agg_time_buckets_for_ticker(
    cfg: MongoCfg,
    ticker: str,
    start_utc: datetime,
    end_utc: datetime,
    bucket_minutes: int = 5,
) -> pd.DataFrame:
    col = _client(cfg)[cfg.db][cfg.messages_col]
    ticker = (ticker or "").strip().upper()
    bucket_minutes = max(1, int(bucket_minutes))
# Convert rolling-window size into milliseconds for MongoDB bucketing.
    bucket_ms = int(bucket_minutes * 60_000)

    pipeline = [
        {"$match": _clean_message_match(start_utc, end_utc, ticker)},
        {
            "$group": {
                "_id": {
                    "$toDate": {
                        "$subtract": [
                            {"$toLong": "$created_at_dt"},
                            {"$mod": [{"$toLong": "$created_at_dt"}, bucket_ms]},
                        ]
                    }
                },
                "total_posts": {"$sum": 1},
                "bullish": {"$sum": {"$cond": [{"$eq": ["$sentiment", "Bullish"]}, 1, 0]}},
                "bearish": {"$sum": {"$cond": [{"$eq": ["$sentiment", "Bearish"]}, 1, 0]}},
                "traditional_posts": {"$sum": {"$cond": [{"$eq": ["$source_type", "Traditional"]}, 1, 0]}},
                "social_posts": {"$sum": {"$cond": [{"$eq": ["$source_type", "Rumor/Social"]}, 1, 0]}},
                "rumor_posts": {"$sum": {"$cond": [{"$eq": ["$rumor_flag", True]}, 1, 0]}},
            }
        },
        {
            "$project": {
                "_id": 0,
                "bucket_start_utc": "$_id",
                "total_posts": 1,
                "bullish": 1,
                "bearish": 1,
                "traditional_posts": 1,
                "social_posts": 1,
                "rumor_posts": 1,
                "sentiment_score": {
                    "$cond": [
                        {"$gt": [{"$add": ["$bullish", "$bearish"]}, 0]},
                        {
                            "$divide": [
                                {"$subtract": ["$bullish", "$bearish"]},
                                {"$add": ["$bullish", "$bearish"]},
                            ]
                        },
                        0,
                    ]
                },
            }
        },
        {"$sort": {"bucket_start_utc": 1}},
    ]

    rows = list(col.aggregate(pipeline, allowDiskUse=True))
    df = pd.DataFrame(rows)

    if df.empty:
        return pd.DataFrame(
            columns=[
                "bucket_start_utc",
                "bucket_start_et",
                "total_posts",
                "bullish",
                "bearish",
                "traditional_posts",
                "social_posts",
                "rumor_posts",
                "sentiment_score",
                "density_per_min",
            ]
        )

    df["bucket_start_utc"] = pd.to_datetime(df["bucket_start_utc"], utc=True, errors="coerce")
    df["bucket_start_et"] = df["bucket_start_utc"].dt.tz_convert(ET)
    df["density_per_min"] = df["total_posts"] / bucket_minutes

    numeric_cols = [
        "total_posts",
        "bullish",
        "bearish",
        "traditional_posts",
        "social_posts",
        "rumor_posts",
        "sentiment_score",
        "density_per_min",
    ]

    for c in numeric_cols:
        if c in df.columns:
            df[c] = pd.to_numeric(df[c], errors="coerce").fillna(0)

    return df

# Retrieve latest clean messages for ticker detail tables.
# Messages can later be split into traditional vs rumor/social views.
def get_latest_messages(
    cfg: MongoCfg,
    ticker: str,
    start_utc: datetime,
    end_utc: datetime,
    limit: int = 200,
) -> pd.DataFrame:
    col = _client(cfg)[cfg.db][cfg.messages_col]
    ticker = (ticker or "").strip().upper()

    cur = col.find(
        _clean_message_match(start_utc, end_utc, ticker),
        {
            "_id": 0,
            "created_at_dt": 1,
            "author": 1,
            "sentiment": 1,
            "post": 1,
            "link": 1,
            "source_type": 1,
            "rumor_flag": 1,
            "rumor_reason": 1,
        },
    ).sort("created_at_dt", -1).limit(int(limit))

    rows = list(cur)
    df = pd.DataFrame(rows)

    if df.empty:
        return pd.DataFrame(
            columns=[
                "created_at_et",
                "author",
                "sentiment",
                "source_type",
                "rumor_flag",
                "rumor_reason",
                "post",
                "link",
            ]
        )

    df["created_at_dt"] = pd.to_datetime(df["created_at_dt"], utc=True, errors="coerce")
    df["created_at_et"] = df["created_at_dt"].dt.tz_convert(ET)

    keep_cols = [
        "created_at_et",
        "author",
        "sentiment",
        "source_type",
        "rumor_flag",
        "rumor_reason",
        "post",
        "link",
    ]

    keep_cols = [c for c in keep_cols if c in df.columns]

    return df[keep_cols]

# Return one summary dictionary for the selected ticker
# used in the ticker detail metric cards.
def ticker_summary(
    cfg: MongoCfg,
    ticker: str,
    start_utc: datetime,
    end_utc: datetime,
) -> dict:
    ticker = (ticker or "").strip().upper()
    df = agg_ticker_summary(cfg, start_utc, end_utc)

    if df.empty or "stream_symbol" not in df.columns:
        return {
            "ticker": ticker,
            "total_posts": 0,
            "bullish": 0,
            "bearish": 0,
            "unlabeled": 0,
            "traditional_posts": 0,
            "social_posts": 0,
            "rumor_posts": 0,
            "sentiment_score": 0.0,
            "density_per_min": 0.0,
        }

    row = df[df["stream_symbol"].astype(str).str.upper() == ticker]

    if row.empty:
        return {
            "ticker": ticker,
            "total_posts": 0,
            "bullish": 0,
            "bearish": 0,
            "unlabeled": 0,
            "traditional_posts": 0,
            "social_posts": 0,
            "rumor_posts": 0,
            "sentiment_score": 0.0,
            "density_per_min": 0.0,
        }

    out = row.iloc[0].to_dict()
    out["ticker"] = ticker
    return out

# Regular expression used to extract URLs from Stocktwits posts.
URL_RE = re.compile(r"(https?://[^\s\]\)<>\"']+)", re.IGNORECASE)
# Trusted traditional/financial news domains used to distinguish
# mainstream news sources from rumor/social sources.
TRADITIONAL_DOMAINS = {
    "reuters.com",
    "bloomberg.com",
    "wsj.com",
    "ft.com",
    "cnbc.com",
    "marketwatch.com",
    "finance.yahoo.com",
    "seekingalpha.com",
    "investing.com",
    "sec.gov",
    "nasdaq.com",
    "nytimes.com",
    "apnews.com",
    "theverge.com",
    "techcrunch.com",
    "businesswire.com",
    "globenewswire.com",
    "prnewswire.com",
}

# Extract and clean URLs from Stocktwits message text.
def extract_urls(text: str) -> list[str]:
    if not text:
        return []

    urls = URL_RE.findall(text)
    cleaned = []

    for u in urls:
        u = u.strip().rstrip(".,;:!?)\"]'")
        cleaned.append(u)

    out = []
    seen = set()

    for u in cleaned:
        if u not in seen:
            seen.add(u)
            out.append(u)

    return out

# Extract normalized domain names from URLs.
def domain_of(url: str) -> str:
    try:
        host = urlparse(url).netloc.lower()
        if host.startswith("www."):
            host = host[4:]
        return host
    except Exception:
        return ""

# Classify a domain as:
# - Traditional
# - Rumor/Social
# - No link
def classify_domain(domain: str) -> str:
    if not domain:
        return "No link"

    for d in TRADITIONAL_DOMAINS:
        if domain == d or domain.endswith("." + d):
            return "Traditional"

    return "Rumor/Social"

# Load the latest Finviz screener snapshot from MongoDB.
# This provides market context for dashboard ticker tables.
def load_latest_finviz(
    mongo_uri: str = "mongodb://localhost:27017/",
    mongo_db: str = "ist495",
    mongo_collection: str = "finviz_elite",
) -> pd.DataFrame:
    client = MongoClient(mongo_uri)
    db = client[mongo_db]
    col = db[mongo_collection]

    data = list(col.find({}, {"_id": 0}))
    if not data:
        return pd.DataFrame()

    df = pd.DataFrame(data)

    if "stream_symbol" in df.columns:
        df["stream_symbol"] = df["stream_symbol"].astype(str).str.strip().str.upper()

    return df