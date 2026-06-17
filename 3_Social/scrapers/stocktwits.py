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


def _sentiment_to_score(sentiment_str: str | None) -> float | None:
    """Convert StockTwits sentiment string to numeric score for rolling_windows pipeline."""
    if not sentiment_str:
        return None
    s = sentiment_str.lower().strip()
    if s in ('bullish', 'positive', 'up'):
        return 0.5
    elif s in ('bearish', 'negative', 'down'):
        return -0.5
    return 0.0


def scrape_ticker(ticker: str, session: Optional[requests.Session] = None) -> list[dict]:
    """
    Fetch the most recent posts for one ticker.
    Returns posts in the normalized format the backend pipeline expects:
    {id, tickers_mentioned, text, published_at, sentiment_score, is_duplicate, source}
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
        st_sentiment_str = None
        entities = msg.get("entities") or {}
        sentiment_obj = entities.get("sentiment") or msg.get("sentiment")
        if isinstance(sentiment_obj, dict):
            raw = (sentiment_obj.get("basic") or "").lower()
            if raw in ("bullish", "bearish"):
                st_sentiment_str = raw

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

        # Normalize sentiment to score
        sentiment_score = _sentiment_to_score(st_sentiment_str)

        posts.append({
            "id":               _post_id(ticker, msg.get("id", body)),
            "tickers_mentioned": [ticker.upper()],
            "text":             body[:1000],
            "body":             body[:1000],
            "ticker":           ticker.upper(),
            "published_at":     created_ts,
            "created_at":       created_ts,
            "fetched_at":       now,
            "sentiment_score":  sentiment_score,
            "sentiment":        st_sentiment_str,
            "is_duplicate":     False,
            "source":           "stocktwits",
            "platform":         "stocktwits",
            "author":           user.get("username", ""),
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
