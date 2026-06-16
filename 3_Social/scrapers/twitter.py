"""
Twitter/X Scraper — Phase 2
Uses ntscraper (no API key needed) to pull tweets from watched financial accounts.
Ingests into the shared MongoDB posts collection with source="twitter".

Usage:
  python scrapers/twitter.py              # one-shot
  python scrapers/twitter.py --loop 300   # loop every 5 minutes

Requirements:
  pip install ntscraper

Environment:
  MONGO_URI  — MongoDB connection string
  MONGO_DB   — Database name (default: flashfeed)
  POSTGRES_DSN — PostgreSQL DSN (for loading watched_accounts)
"""

from __future__ import annotations

import hashlib
import logging
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from scrapers.db import get_client, get_collection

log = logging.getLogger(__name__)

# ── Default handles (fallback if rss_sources DB table doesn't exist yet) ─────
DEFAULT_HANDLES = [
    "Benzinga", "CNBC", "unusual_whales", "ewhispers",
    "DeItaone", "FirstSquawk", "LiveSquawk", "MarketWatch",
    "WSJ", "Reuters", "Investingcom", "StockMKTNewz",
    "realwillmeade", "zerohedge", "BreakingMarkets",
]


def _load_handles_from_db() -> list[str]:
    """Load enabled Twitter handles from the watched_accounts PostgreSQL table."""
    dsn = os.environ.get("POSTGRES_DSN")
    if not dsn:
        return DEFAULT_HANDLES

    try:
        import psycopg
        with psycopg.connect(dsn) as conn:
            rows = conn.execute(
                "SELECT handle FROM watched_accounts WHERE platform = 'twitter' AND enabled = TRUE"
            ).fetchall()
        if rows:
            handles = [r[0] for r in rows]
            log.info("Loaded %d Twitter handles from DB", len(handles))
            return handles
    except Exception as exc:
        log.debug("Could not load handles from DB (%s); using defaults", exc)
    return DEFAULT_HANDLES


def _tweet_id(handle: str, text: str) -> str:
    return hashlib.sha1(f"twitter:{handle}:{text[:100]}".encode()).hexdigest()[:16]


def _scrape_handle(handle: str) -> list[dict]:
    """Scrape recent tweets from a single handle.

    Tries curl-impersonate first (no API key, no Nitter dependency),
    then falls back to ntscraper if available.
    """
    # Primary: curl_cffi impersonation
    try:
        from scrapers.twitter_curl import scrape_handle as curl_scrape
        results = curl_scrape(handle, count=20)
        if results:
            return results
        log.debug("curl_cffi returned no tweets for @%s, trying ntscraper", handle)
    except Exception as exc:
        log.debug("curl_cffi scrape failed for @%s: %s", handle, exc)

    # Fallback: ntscraper (Nitter)
    try:
        from ntscraper import Nitter
    except ImportError:
        log.error("ntscraper not installed — run: pip install ntscraper")
        return []

    scraper = Nitter(log_level=logging.WARNING)
    posts = []

    try:
        tweets = scraper.get_tweets(handle, mode="user", number=20)
        for tweet in tweets.get("tweets", []):
            text = tweet.get("text", "").strip()
            if not text:
                continue

            # Parse the date if available
            published_at: Optional[datetime] = None
            date_str = tweet.get("date", "")
            if date_str:
                try:
                    # ntscraper returns dates like "Mar 29, 2026 · 12:30 PM UTC"
                    published_at = datetime.strptime(
                        date_str.split("·")[0].strip(), "%b %d, %Y"
                    ).replace(tzinfo=timezone.utc)
                except Exception:
                    published_at = datetime.now(timezone.utc)
            else:
                published_at = datetime.now(timezone.utc)

            posts.append({
                "id": _tweet_id(handle, text),
                "source": "twitter",
                "author": f"@{handle}",
                "title": text[:200],
                "text": text,
                "url": tweet.get("link", f"https://x.com/{handle}"),
                "published_at": published_at,
                "scraped_at": datetime.now(timezone.utc),
                "tickers_mentioned": [],    # will be filled by pipeline Stage 1
                "is_processed": False,
                "is_scored": False,
                "is_duplicate": False,
                "is_rumor": False,
            })

        log.info("@%-20s  %d tweets fetched", handle, len(posts))
    except Exception as exc:
        log.warning("@%-20s  SKIP  %s", handle, exc)

    return posts


def scrape_cycle(collection, handles: Optional[list[str]] = None) -> int:
    """Execute one full pass through all handles. Returns number of new posts."""
    if handles is None:
        handles = _load_handles_from_db()

    total = 0
    for handle in handles:
        tweets = _scrape_handle(handle)
        if not tweets:
            continue

        # Bulk upsert using the same pattern as reddit/bluesky scrapers
        from scrapers.db import bulk_upsert
        inserted = bulk_upsert(collection, tweets)
        total += inserted
        time.sleep(2)  # be polite — avoid Nitter rate limits

    return total


def main() -> None:
    import argparse

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s  %(levelname)-8s  %(message)s",
    )

    parser = argparse.ArgumentParser(description="Scrape Twitter/X via Nitter")
    parser.add_argument("--loop", type=int, default=0, help="Loop interval in seconds (0=one-shot)")
    args = parser.parse_args()

    client = get_client()
    collection = get_collection(client)

    try:
        while True:
            handles = _load_handles_from_db()
            log.info("Starting Twitter scrape for %d handles", len(handles))
            new = scrape_cycle(collection, handles)
            log.info("Twitter scrape complete — %d new posts", new)

            if args.loop <= 0:
                break
            log.info("Sleeping %ds…", args.loop)
            time.sleep(args.loop)
    finally:
        client.close()


if __name__ == "__main__":
    main()
