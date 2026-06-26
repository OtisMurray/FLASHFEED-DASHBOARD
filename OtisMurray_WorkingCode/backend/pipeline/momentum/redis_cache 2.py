"""D11: Redis cache layer for rolling window results.

Pushes computed window data to Redis for fast dashboard reads.
All functions accept ``None`` as the client and return gracefully,
so callers never need to guard against a missing connection.
"""

from __future__ import annotations

import logging
from datetime import datetime

import redis as redis_lib

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Key helpers
# ---------------------------------------------------------------------------


def window_key(ticker: str, window_minutes: int) -> str:
    """Return the Redis key for a specific ticker/window pair."""
    return f"window:{ticker}:{window_minutes}"


def format_window_for_redis(doc: dict) -> dict[str, str]:
    """Convert a MongoDB rolling-window document to Redis hash fields.

    All values are stringified so they can be stored in a Redis hash.
    Datetime objects are converted to ISO format.
    """
    fields: dict[str, str] = {}
    for key in (
        "avg_sentiment",
        "message_count",
        "bullish_count",
        "bearish_count",
        "neutral_count",
        "window_start",
        "window_end",
        "computed_at",
        "ticker",
        "window_minutes",
    ):
        val = doc.get(key)
        if val is None:
            continue
        if isinstance(val, datetime):
            fields[key] = val.isoformat()
        else:
            fields[key] = str(val)
    return fields


# ---------------------------------------------------------------------------
# Connection
# ---------------------------------------------------------------------------


def get_redis_client(url: str) -> redis_lib.Redis | None:
    """Connect to Redis at *url* and return the client, or ``None`` on failure."""
    if not url:
        return None
    try:
        client = redis_lib.Redis.from_url(url, decode_responses=True)
        client.ping()
        log.info("Connected to Redis")
        return client
    except Exception:
        log.warning("Failed to connect to Redis — skipping cache sync", exc_info=True)
        return None


# ---------------------------------------------------------------------------
# Write
# ---------------------------------------------------------------------------


def sync_windows_to_redis(
    client: redis_lib.Redis | None,
    docs: list[dict],
    ttl: int = 14400,
) -> int:
    """Push all rolling-window documents to Redis.

    Returns the number of window hashes written.
    """
    if client is None or not docs:
        return 0

    pipe = client.pipeline()
    count = 0

    active_tickers: dict[str, float] = {}

    for doc in docs:
        ticker = doc.get("ticker")
        minutes = doc.get("window_minutes")
        if not ticker or minutes is None:
            continue

        fields = format_window_for_redis(doc)
        if not fields:
            continue

        key = window_key(ticker, minutes)
        pipe.delete(key)
        pipe.hset(key, mapping=fields)
        pipe.expire(key, ttl)
        count += 1

        # 60-minute windows populate the active_tickers sorted set
        if minutes == 60:
            active_tickers[ticker] = float(doc.get("message_count", 0))

    # Active tickers sorted set
    if active_tickers:
        pipe.delete("active_tickers")
        for tkr, score in active_tickers.items():
            pipe.zadd("active_tickers", {tkr: score})
        pipe.expire("active_tickers", ttl)

    # Record sync timestamp
    pipe.set("pipeline:last_sync", datetime.utcnow().isoformat())

    pipe.execute()
    log.info("Synced %d window(s) to Redis", count)
    return count


# ---------------------------------------------------------------------------
# Read
# ---------------------------------------------------------------------------


def get_window_from_redis(
    client: redis_lib.Redis | None,
    ticker: str,
    window_minutes: int,
) -> dict | None:
    """Read a single window hash from Redis. Returns ``None`` if missing."""
    if client is None:
        return None
    key = window_key(ticker, window_minutes)
    data = client.hgetall(key)
    return data if data else None


def get_active_tickers_from_redis(
    client: redis_lib.Redis | None,
    limit: int = 50,
) -> list[tuple[str, float]]:
    """Return active tickers sorted by 60-minute message count (descending)."""
    if client is None:
        return []
    results = client.zrevrange("active_tickers", 0, limit - 1, withscores=True)
    return results
