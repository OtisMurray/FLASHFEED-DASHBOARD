"""D12: End-to-end pipeline orchestrator.

Runs the full processing pipeline on a loop:

    1. Ticker extraction   (D3) — tag unprocessed posts with tickers
    2. Dedup/spam filter    (D4) — flag near-duplicate posts
    3. Sentiment scoring    (D5) — score unscored posts
    4. Rolling windows      (D6) — compute aggregate stats per ticker/window
    5. Redis sync           (D11) — push windows + active tickers to Redis
    6. PostgreSQL sync      (D11) — append window snapshots for history charts

Repeats every 60 seconds (configurable via --interval).
Scrapers (D1/D2) run separately — this script processes whatever they've ingested.
"""

from __future__ import annotations

import argparse
import logging
import signal
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

# Ensure project root is on sys.path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from scrapers.config import (
    MONGO_DB,
    MONGO_COLLECTION,
    ROLLING_WINDOWS_COLLECTION,
    REDIS_URL,
    POSTGRES_DSN,
    SUBREDDITS,
    IB_ENABLED,
)
from scrapers.db import get_client, get_collection
from processing.ticker_extraction import process_untagged_posts
from processing.dedup_filter import process_unfiltered_posts
from processing.sentiment_engine import process_unscored_posts
from processing.rolling_windows import compute_all_windows
from processing.redis_cache import get_redis_client

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(name)-30s  %(levelname)-8s  %(message)s",
)
log = logging.getLogger("pipeline")

# ---------------------------------------------------------------------------
# Graceful shutdown
# ---------------------------------------------------------------------------

_shutdown = False


def _handle_signal(signum: int, frame) -> None:
    global _shutdown
    log.info("Received signal %d — shutting down after current cycle", signum)
    _shutdown = True


signal.signal(signal.SIGINT, _handle_signal)
signal.signal(signal.SIGTERM, _handle_signal)


# ---------------------------------------------------------------------------
# Pipeline status helper
# ---------------------------------------------------------------------------


def set_pipeline_status(redis_client, status, stage="", cycle=0, stage_num=0):
    """Write current pipeline status to Redis for the dashboard banner."""
    if redis_client is None:
        return
    redis_client.hset("pipeline:status", mapping={
        "status": status,
        "stage": stage,
        "stage_num": str(stage_num),
        "total_stages": "8",
        "cycle": str(cycle),
        "updated_at": datetime.now(timezone.utc).isoformat(),
    })


# ---------------------------------------------------------------------------
# Pipeline stages
# ---------------------------------------------------------------------------


def run_once(posts_coll, windows_coll, redis_client=None, cycle_num=0) -> dict:
    """Run all pipeline stages once. Returns a summary dict."""
    now = datetime.now(timezone.utc)
    summary: dict = {"timestamp": now.isoformat()}

    # Stage 1: Ticker extraction
    set_pipeline_status(redis_client, "running", "Ticker extraction (1/6)", cycle_num, 1)
    log.info("=== Stage 1: Ticker extraction ===")
    summary["tickers_processed"] = process_untagged_posts(posts_coll)

    # Stage 2: Dedup/spam filter
    set_pipeline_status(redis_client, "running", "Dedup/spam filter (2/6)", cycle_num, 2)
    log.info("=== Stage 2: Dedup/spam filter ===")
    summary["dedup_processed"] = process_unfiltered_posts(posts_coll)

    # Stage 3: Sentiment scoring
    set_pipeline_status(redis_client, "running", "Sentiment scoring (3/6)", cycle_num, 3)
    log.info("=== Stage 3: Sentiment scoring ===")
    summary["sentiment_processed"] = process_unscored_posts(posts_coll)

    # Stage 4: Rolling windows
    set_pipeline_status(redis_client, "running", "Rolling windows (4/6)", cycle_num, 4)
    log.info("=== Stage 4: Rolling windows ===")
    summary["windows_computed"] = compute_all_windows(posts_coll, windows_coll, now)

    # Stage 5: Redis sync
    set_pipeline_status(redis_client, "running", "Redis sync (5/6)", cycle_num, 5)
    log.info("=== Stage 5: Redis sync ===")
    all_windows = list(windows_coll.find({}, {"_id": 0}))

    if redis_client:
        from processing.redis_cache import sync_windows_to_redis

        summary["redis_synced"] = sync_windows_to_redis(redis_client, all_windows)
    elif REDIS_URL:
        from processing.redis_cache import sync_windows_to_redis

        tmp_client = get_redis_client(REDIS_URL)
        if tmp_client:
            summary["redis_synced"] = sync_windows_to_redis(tmp_client, all_windows)
            tmp_client.close()
        else:
            summary["redis_synced"] = 0
            log.warning("Redis connection failed — skipped")
    else:
        summary["redis_synced"] = 0
        log.info("REDIS_URL not set — skipping Redis sync")

    # Stage 6: PostgreSQL sync
    set_pipeline_status(redis_client, "running", "PostgreSQL sync (6/6)", cycle_num, 6)
    log.info("=== Stage 6: PostgreSQL sync ===")
    if POSTGRES_DSN:
        from processing.pg_store import get_pg_connection, ensure_schema, append_windows_to_pg

        pg_conn = get_pg_connection(POSTGRES_DSN)
        if pg_conn:
            ensure_schema(pg_conn)
            summary["pg_synced"] = append_windows_to_pg(pg_conn, all_windows)
            pg_conn.close()
        else:
            summary["pg_synced"] = 0
            log.warning("PostgreSQL connection failed — skipped")
    else:
        summary["pg_synced"] = 0
        log.info("POSTGRES_DSN not set — skipping PostgreSQL sync")

    # Stage 7: Cross-source dedup
    set_pipeline_status(redis_client, "running", "Cross-source dedup (7/8)", cycle_num, 7)
    log.info("=== Stage 7: Cross-source dedup ===")
    try:
        from processing.data_quality import cross_source_dedup
        summary["cross_dedup"] = cross_source_dedup(posts_coll)
    except Exception:
        log.warning("Cross-source dedup failed — continuing", exc_info=True)
        summary["cross_dedup"] = 0

    # Stage 8: Rumor detection
    set_pipeline_status(redis_client, "running", "Rumor detection (8/8)", cycle_num, 8)
    log.info("=== Stage 8: Rumor detection ===")
    try:
        from processing.data_quality import detect_rumors
        summary["rumors_flagged"] = detect_rumors(posts_coll)
    except Exception:
        log.warning("Rumor detection failed — continuing", exc_info=True)
        summary["rumors_flagged"] = 0

    set_pipeline_status(redis_client, "idle", "Waiting for next cycle", cycle_num, 0)
    return summary


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------


def run_scrapers(collection) -> None:
    """Run one cycle of Reddit and Bluesky scraping."""
    # Reddit scrape (one cycle)
    log.info("=== Reddit scrape ===")
    try:
        from curl_cffi.requests import Session
        from scrapers.reddit import scrape_cycle as reddit_cycle

        with Session() as session:
            reddit_cycle(collection, SUBREDDITS, session)
    except Exception:
        log.warning("Reddit scrape failed — continuing", exc_info=True)

    # Bluesky scrape (one cycle)
    from scrapers.config import BLUESKY_HANDLE, BLUESKY_APP_PASSWORD

    if BLUESKY_HANDLE and BLUESKY_APP_PASSWORD:
        log.info("=== Bluesky scrape ===")
        try:
            from scrapers.bluesky import create_client as bsky_create_client
            from scrapers.bluesky import scrape_cycle as bsky_cycle

            bsky = bsky_create_client()
            bsky_cycle(collection, bsky)
        except Exception:
            log.warning("Bluesky scrape failed — continuing", exc_info=True)
    else:
        log.info("Bluesky credentials not set — skipping")

    # Twitter / X scrape (one cycle via ntscraper)
    log.info("=== Twitter/X scrape ===")
    try:
        from scrapers.twitter import scrape_cycle as twitter_cycle
        twitter_cycle(collection)
    except ImportError:
        log.info("ntscraper not installed — skipping Twitter scrape")
    except Exception:
        log.warning("Twitter scrape failed — continuing", exc_info=True)

    # IB News scrape — only runs when TWS/Gateway is reachable locally.
    # IB_ENABLED=false by default so this is a no-op in GitHub Actions CI.
    if IB_ENABLED:
        log.info("=== IB News scrape ===")
        try:
            from scrapers.ib_news import IBConnectionError, scrape_cycle as ib_news_cycle

            ib_redis = None
            if REDIS_URL:
                try:
                    from processing.redis_cache import get_redis_client
                    ib_redis = get_redis_client(REDIS_URL)
                except Exception:
                    pass
            try:
                ib_news_cycle(collection, ib_redis)
            except IBConnectionError as exc:
                log.warning("IB TWS not reachable (%s) — skipping IB news scrape", exc)
            finally:
                if ib_redis:
                    try:
                        ib_redis.close()
                    except Exception:
                        pass
        except ImportError:
            log.info("ib_insync not installed — skipping IB news scrape (pip install ib_insync)")
        except Exception:
            log.warning("IB news scrape failed — continuing", exc_info=True)
    else:
        log.debug("IB_ENABLED=false — skipping IB news scrape")


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the full processing pipeline")
    parser.add_argument(
        "--interval",
        type=int,
        default=60,
        help="Seconds between pipeline cycles (default: 60)",
    )
    parser.add_argument(
        "--once",
        action="store_true",
        help="Run one cycle and exit (no loop)",
    )
    parser.add_argument(
        "--scrape",
        action="store_true",
        help="Run Reddit + Bluesky scrapers before processing",
    )
    args = parser.parse_args()

    # Persistent Redis client for status updates
    pipeline_redis = get_redis_client(REDIS_URL) if REDIS_URL else None

    client = get_client()
    try:
        db = client[MONGO_DB]
        posts_coll = get_collection(client)
        windows_coll = db[ROLLING_WINDOWS_COLLECTION]

        total = posts_coll.count_documents({})
        log.info("Pipeline starting — %d posts in MongoDB", total)

        cycle = 0
        while not _shutdown:
            cycle += 1
            log.info("━━━ Cycle %d ━━━", cycle)
            t0 = time.time()

            # Run scrapers if requested
            if args.scrape:
                run_scrapers(posts_coll)

            try:
                summary = run_once(posts_coll, windows_coll, pipeline_redis, cycle)
                elapsed = round(time.time() - t0, 1)
                log.info(
                    "Cycle %d complete in %.1fs — tickers:%d dedup:%d sentiment:%d windows:%d redis:%d pg:%d",
                    cycle,
                    elapsed,
                    summary.get("tickers_processed", 0),
                    summary.get("dedup_processed", 0),
                    summary.get("sentiment_processed", 0),
                    summary.get("windows_computed", 0),
                    summary.get("redis_synced", 0),
                    summary.get("pg_synced", 0),
                )
            except Exception:
                log.exception("Cycle %d failed — will retry next cycle", cycle)

            if args.once or _shutdown:
                break

            log.info("Sleeping %ds until next cycle…", args.interval)
            for _ in range(args.interval):
                if _shutdown:
                    break
                time.sleep(1)
    finally:
        if pipeline_redis:
            pipeline_redis.close()
        client.close()
        log.info("Pipeline shut down")


if __name__ == "__main__":
    main()
