"""D6: Rolling Window Calculator.

Computes aggregate sentiment stats per ticker per time window.  Excludes
duplicate posts and posts without a sentiment score.  Stores results in
MongoDB collection ``rolling_windows``, upserting by ``(ticker, window_minutes)``.
"""

from __future__ import annotations

import argparse
import logging
from datetime import datetime, timedelta, timezone

from pymongo.collection import Collection

from scrapers.config import ROLLING_WINDOW_SIZES

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Pure computation
# ---------------------------------------------------------------------------

def compute_window_stats(posts: list[dict]) -> dict:
    """Compute aggregate sentiment stats from a list of scored posts.

    Returns a dict with ``avg_sentiment``, ``message_count``,
    ``bullish_count`` (score > 0.2), ``bearish_count`` (score < -0.2),
    and ``neutral_count``.
    """
    if not posts:
        return {
            "avg_sentiment": 0.0,
            "message_count": 0,
            "bullish_count": 0,
            "bearish_count": 0,
            "neutral_count": 0,
        }

    scores = [p["sentiment_score"] for p in posts]
    avg = sum(scores) / len(scores)

    bullish = sum(1 for s in scores if s > 0.2)
    bearish = sum(1 for s in scores if s < -0.2)
    neutral = len(scores) - bullish - bearish

    return {
        "avg_sentiment": round(avg, 4),
        "message_count": len(scores),
        "bullish_count": bullish,
        "bearish_count": bearish,
        "neutral_count": neutral,
    }


# ---------------------------------------------------------------------------
# Ticker discovery
# ---------------------------------------------------------------------------

def get_active_tickers(collection: Collection, since: datetime) -> list[str]:
    """Return distinct tickers that appear in posts since *since*.

    Only considers non-duplicate posts with a sentiment score.
    """
    pipeline = [
        {
            "$match": {
                "published_at": {"$gte": since},
                "is_duplicate": {"$ne": True},
                "sentiment_score": {"$exists": True},
                "tickers_mentioned": {"$exists": True, "$ne": []},
            }
        },
        {"$unwind": "$tickers_mentioned"},
        {"$group": {"_id": "$tickers_mentioned"}},
        {"$sort": {"_id": 1}},
    ]
    return [doc["_id"] for doc in collection.aggregate(pipeline)]


# ---------------------------------------------------------------------------
# Window computation
# ---------------------------------------------------------------------------

def compute_rolling_window(
    collection: Collection,
    ticker: str,
    window_minutes: int,
    now: datetime,
) -> dict | None:
    """Compute a single rolling window for *ticker*.

    Returns the window document or ``None`` if no qualifying posts exist.
    """
    window_start = now - timedelta(minutes=window_minutes)

    cursor = collection.find({
        "published_at": {"$gte": window_start, "$lte": now},
        "tickers_mentioned": ticker,
        "is_duplicate": {"$ne": True},
        "sentiment_score": {"$exists": True},
    })

    posts = list(cursor)
    if not posts:
        return None

    stats = compute_window_stats(posts)
    stats.update({
        "ticker": ticker,
        "window_minutes": window_minutes,
        "window_start": window_start,
        "window_end": now,
        "computed_at": now,
    })
    return stats


def compute_all_windows(
    posts_coll: Collection,
    windows_coll: Collection,
    now: datetime | None = None,
) -> int:
    """Compute rolling windows for all active tickers and window sizes.

    Upserts results into *windows_coll* by ``(ticker, window_minutes)``.
    Returns the number of windows written.
    """
    if now is None:
        now = datetime.now(timezone.utc)

    # Look back to the longest window to find active tickers
    max_window = max(ROLLING_WINDOW_SIZES)
    since = now - timedelta(minutes=max_window)

    tickers = get_active_tickers(posts_coll, since)
    log.info("Found %d active ticker(s)", len(tickers))

    count = 0
    for ticker in tickers:
        for window_minutes in ROLLING_WINDOW_SIZES:
            result = compute_rolling_window(
                posts_coll, ticker, window_minutes, now,
            )
            if result is None:
                continue

            windows_coll.update_one(
                {"ticker": ticker, "window_minutes": window_minutes},
                {"$set": result},
                upsert=True,
            )
            count += 1

    log.info("Computed %d rolling window(s)", count)
    return count


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

def main() -> None:
    """Compute rolling windows for all active tickers."""
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s  %(name)-30s  %(levelname)-8s  %(message)s",
    )

    parser = argparse.ArgumentParser(description="Compute rolling sentiment windows")
    parser.add_argument(
        "--as-of",
        type=str,
        default=None,
        help="Compute as-of this UTC datetime (ISO format). Defaults to now.",
    )
    args = parser.parse_args()

    if args.as_of:
        now = datetime.fromisoformat(args.as_of).replace(tzinfo=timezone.utc)
    else:
        now = datetime.now(timezone.utc)

    from scrapers.db import get_client
    from scrapers.config import MONGO_DB, MONGO_COLLECTION, ROLLING_WINDOWS_COLLECTION

    client = get_client()
    try:
        db = client[MONGO_DB]
        posts_coll = db[MONGO_COLLECTION]
        windows_coll = db[ROLLING_WINDOWS_COLLECTION]

        total = posts_coll.count_documents({})
        scored = posts_coll.count_documents({"sentiment_score": {"$exists": True}})
        log.info("Posts in DB: %d total, %d scored", total, scored)

        count = compute_all_windows(posts_coll, windows_coll, now)
        log.info("Done — %d window(s) computed", count)

        # ---- D11: Sync to Redis and PostgreSQL ----
        from scrapers.config import REDIS_URL, POSTGRES_DSN

        all_windows = list(windows_coll.find({}, {"_id": 0}))

        if REDIS_URL:
            from processing.redis_cache import get_redis_client, sync_windows_to_redis
            redis_client = get_redis_client(REDIS_URL)
            if redis_client:
                sync_windows_to_redis(redis_client, all_windows)
                redis_client.close()
        else:
            log.info("REDIS_URL not set — skipping Redis sync")

        # ---- yfinance enrichment ----
        try:
            from processing.yfinance_enricher import enrich_active_tickers
            from scrapers.config import FINVIZ_COLLECTION
            finviz_coll = db[FINVIZ_COLLECTION]
            enrich_active_tickers(windows_coll, finviz_coll)
        except Exception:
            log.warning("yfinance enrichment failed — skipping", exc_info=True)

        if POSTGRES_DSN:
            from processing.pg_store import get_pg_connection, ensure_schema, append_windows_to_pg
            pg_conn = get_pg_connection(POSTGRES_DSN)
            if pg_conn:
                ensure_schema(pg_conn)
                append_windows_to_pg(pg_conn, all_windows)
                pg_conn.close()
        else:
            log.info("POSTGRES_DSN not set — skipping PostgreSQL sync")
    finally:
        client.close()


if __name__ == "__main__":
    main()
