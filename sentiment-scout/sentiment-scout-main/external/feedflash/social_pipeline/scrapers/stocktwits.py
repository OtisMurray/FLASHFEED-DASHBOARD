"""
Stocktwits scraper — fetches recent posts for a list of tickers
from the Stocktwits public API (no auth required for basic reads).

API endpoint: https://api.stocktwits.com/api/2/streams/symbol/{TICKER}.json
Returns up to 30 posts per ticker per request.

Usage:
    from scrapers.stocktwits import scrape_tickers
    posts = scrape_tickers(["AAPL", "TSLA", "NVDA"])
"""

from __future__ import annotations

import hashlib
import logging
import re
import time
from typing import Optional

import requests

log = logging.getLogger(__name__)

BASE_URL   = "https://api.stocktwits.com/api/2/streams/symbol/{ticker}.json"
HEADERS    = {"User-Agent": "Mozilla/5.0 FlashFeed/1.0"}
DELAY      = 1.2   # seconds between ticker requests (rate limit: ~200/hr unauthenticated)
TIMEOUT    = 15


def _post_id(ticker: str, msg_id) -> str:
    return hashlib.sha1(f"{ticker}:{msg_id}".encode()).hexdigest()[:16]


def _strip_html(text: str) -> str:
    return re.sub(r"<[^>]+>", "", text or "").strip()


def scrape_ticker(ticker: str, session: Optional[requests.Session] = None) -> list[dict]:
    """
    Fetch the most recent posts for one ticker.
    Returns normalized post dicts.
    """
    req = session or requests
    url = BASE_URL.format(ticker=ticker.upper())

    try:
        resp = req.get(url, headers=HEADERS, timeout=TIMEOUT)
        if resp.status_code == 429:
            log.warning("Stocktwits rate-limited on %s — sleeping 60s", ticker)
            time.sleep(60)
            return []
        if resp.status_code != 200:
            log.warning("Stocktwits %s → HTTP %d", ticker, resp.status_code)
            return []
        data = resp.json()
    except Exception as exc:
        log.warning("Stocktwits fetch failed for %s: %s", ticker, exc)
        return []

    messages = data.get("messages", [])
    now = int(time.time())
    posts = []

    for msg in messages:
        body = _strip_html(msg.get("body", ""))
        if not body:
            continue

        # Stocktwits provides sentiment as {"basic": "Bullish"} or None
        st_sentiment = None
        entities = msg.get("entities") or {}
        sentiment_obj = entities.get("sentiment") or msg.get("sentiment")
        if isinstance(sentiment_obj, dict):
            raw = (sentiment_obj.get("basic") or "").lower()
            if raw == "bullish":
                st_sentiment = "bullish"
            elif raw == "bearish":
                st_sentiment = "bearish"

        # Parse created_at → unix timestamp
        created_ts = now
        raw_ts = msg.get("created_at", "")
        if raw_ts:
            from datetime import datetime, timezone
            try:
                created_ts = int(
                    datetime.strptime(raw_ts, "%Y-%m-%dT%H:%M:%SZ")
                    .replace(tzinfo=timezone.utc)
                    .timestamp()
                )
            except Exception:
                pass

        user = msg.get("user") or {}
        posts.append({
            "id":         _post_id(ticker, msg.get("id", body)),
            "ticker":     ticker.upper(),
            "body":       body[:1000],
            "author":     user.get("username", ""),
            "sentiment":  st_sentiment,
            "created_at": created_ts,
            "fetched_at": now,
        })

    return posts


def scrape_tickers(
    tickers: list[str],
    *,
    session: Optional[requests.Session] = None,
    delay: float = DELAY,
) -> list[dict]:
    """Scrape multiple tickers. Returns combined list of posts."""
    all_posts: list[dict] = []
    sess = session or requests.Session()
    sess.headers.update(HEADERS)

    for i, ticker in enumerate(tickers):
        log.info("Stocktwits [%d/%d] %s", i + 1, len(tickers), ticker)
        posts = scrape_ticker(ticker, sess)
        log.info("  → %d posts", len(posts))
        all_posts.extend(posts)
        if i < len(tickers) - 1:
            time.sleep(delay)

    return all_posts
