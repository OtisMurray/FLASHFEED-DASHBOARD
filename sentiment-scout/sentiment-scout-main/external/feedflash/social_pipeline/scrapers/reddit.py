"""Core Reddit scraper — fetches new posts from target subreddits via
old.reddit.com JSON endpoints using curl_cffi to bypass TLS fingerprinting.

Usage::

    python -m scrapers.reddit
"""

from __future__ import annotations

import hashlib
import logging
import random
import signal
import sys
import threading
from datetime import datetime, timezone
from typing import Any

from curl_cffi.requests import Session

from scrapers.config import (
    BASE_URL,
    CYCLE_DELAY,
    DELAY_BETWEEN_SUBS,
    DELAY_JITTER,
    IMPERSONATE,
    MAX_BACKOFF,
    POSTS_PER_REQUEST,
    REQUEST_TIMEOUT,
    SUBREDDITS,
)
from scrapers.db import get_client, get_collection, upsert_posts

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Custom exceptions
# ---------------------------------------------------------------------------

class RateLimitError(Exception):
    """Raised when Reddit returns HTTP 429 (Too Many Requests)."""


class PrivateSubredditError(Exception):
    """Raised when Reddit returns HTTP 403 (private/quarantined subreddit)."""


class SubredditNotFoundError(Exception):
    """Raised when Reddit returns HTTP 404 (subreddit does not exist)."""


# ---------------------------------------------------------------------------
# Graceful shutdown machinery
# ---------------------------------------------------------------------------

_shutdown_event = threading.Event()


def _handle_signal(signum: int, _frame: Any) -> None:
    """Signal handler for SIGINT/SIGTERM — sets the shutdown event."""
    sig_name = signal.Signals(signum).name
    log.info("Received %s — initiating graceful shutdown", sig_name)
    _shutdown_event.set()


# ---------------------------------------------------------------------------
# Fetch helpers
# ---------------------------------------------------------------------------

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)


def fetch_subreddit_posts(
    subreddit: str,
    session: Session,
    after: str | None = None,
) -> tuple[list[dict], str | None]:
    """Fetch one page of new posts from *subreddit*.

    Returns ``(children, after_token)`` where *children* is the raw list of
    Reddit "thing" dicts and *after_token* is the pagination cursor (or
    ``None`` if there are no more pages).

    Raises:
        RateLimitError: on HTTP 429
        PrivateSubredditError: on HTTP 403
    """
    url = (
        f"{BASE_URL}/r/{subreddit}/new.json"
        f"?limit={POSTS_PER_REQUEST}&raw_json=1"
    )
    if after:
        url += f"&after={after}"

    log.debug("GET %s", url)

    response = session.get(
        url,
        timeout=REQUEST_TIMEOUT,
        impersonate=IMPERSONATE,
        headers={"User-Agent": USER_AGENT},
    )

    if response.status_code == 429:
        raise RateLimitError(
            f"Rate limited (429) on r/{subreddit}"
        )

    if response.status_code == 403:
        raise PrivateSubredditError(
            f"Forbidden (403) on r/{subreddit} — likely private or quarantined"
        )

    if response.status_code == 404:
        raise SubredditNotFoundError(
            f"Not found (404) on r/{subreddit} — subreddit may not exist"
        )

    response.raise_for_status()

    payload = response.json()
    data = payload.get("data", {})
    children = data.get("children", [])
    after_token = data.get("after")

    log.info(
        "r/%s — fetched %d post(s), after=%s",
        subreddit,
        len(children),
        after_token,
    )
    return children, after_token


# ---------------------------------------------------------------------------
# Post normalisation
# ---------------------------------------------------------------------------

def is_deleted(data: dict) -> bool:
    """Return ``True`` if the post appears deleted or removed.

    Checks for the ``[deleted]`` author sentinel and empty / ``[removed]``
    selftext body.
    """
    author = data.get("author", "")
    selftext = data.get("selftext", "")

    if author in ("[deleted]", "[removed]"):
        return True
    if selftext in ("[removed]", "[deleted]"):
        return True
    if not author:
        return True

    return False


def _content_hash(title: str, text: str) -> str:
    """SHA-256 hex digest of *title* + *text*."""
    combined = (title or "") + "\x00" + (text or "")
    return hashlib.sha256(combined.encode("utf-8")).hexdigest()


def normalize_post(raw_child: dict, subreddit: str) -> dict | None:
    """Convert a single Reddit JSON "thing" into the shared post schema.

    Returns ``None`` for deleted / removed posts so callers can simply
    filter with a list comprehension.
    """
    data: dict = raw_child.get("data", {})

    if is_deleted(data):
        return None

    title = data.get("title", "")
    text = data.get("selftext", "")
    permalink = data.get("permalink", "")
    created_utc = data.get("created_utc", 0)

    return {
        "id": data.get("name", ""),                     # fullname e.g. "t3_abc123"
        "source": "reddit",
        "subreddit": subreddit,
        "author": data.get("author", ""),
        "title": title,
        "text": text,
        "url": f"https://www.reddit.com{permalink}" if permalink else "",
        "score": data.get("score", 0),
        "num_comments": data.get("num_comments", 0),
        "published_at": datetime.fromtimestamp(created_utc, tz=timezone.utc),
        "detected_at": datetime.now(tz=timezone.utc),
        "content_hash": _content_hash(title, text),
    }


# ---------------------------------------------------------------------------
# Scrape cycle
# ---------------------------------------------------------------------------

def scrape_cycle(
    collection: Any,
    subreddits: list[str],
    session: Session,
) -> int:
    """Execute one full pass through all *subreddits*.

    Returns the total number of newly inserted posts across all subreddits.

    Implements escalating backoff when three or more consecutive 429 errors
    occur: the backoff duration doubles each time, capped at
    ``MAX_BACKOFF`` seconds.
    """
    total_inserted = 0
    consecutive_429s = 0
    backoff = DELAY_BETWEEN_SUBS  # starting backoff on rate-limit streaks

    for idx, subreddit in enumerate(subreddits):
        if _shutdown_event.is_set():
            log.info("Shutdown requested — aborting cycle at sub %d/%d", idx, len(subreddits))
            break

        try:
            children, _after = fetch_subreddit_posts(subreddit, session)

            # Reset consecutive 429 counter on success.
            consecutive_429s = 0
            backoff = DELAY_BETWEEN_SUBS

            posts = [
                p for child in children
                if (p := normalize_post(child, subreddit)) is not None
            ]

            if posts:
                inserted = upsert_posts(collection, posts)
                total_inserted += inserted
            else:
                log.debug("r/%s — no valid posts after normalisation", subreddit)

        except RateLimitError:
            consecutive_429s += 1
            log.warning(
                "r/%s — rate limited (consecutive 429s: %d)",
                subreddit,
                consecutive_429s,
            )

            if consecutive_429s >= 3:
                backoff = min(backoff * 2, MAX_BACKOFF)
                log.warning(
                    "Escalating backoff to %.1fs after %d consecutive 429s",
                    backoff,
                    consecutive_429s,
                )

            # Sleep for the (possibly escalated) backoff period.
            log.info("Backing off for %.1fs", backoff)
            if _shutdown_event.wait(timeout=backoff):
                log.info("Shutdown during backoff — aborting cycle")
                break
            continue  # skip the normal inter-sub delay

        except PrivateSubredditError:
            log.warning("r/%s — private or quarantined, skipping", subreddit)

        except SubredditNotFoundError:
            log.warning("r/%s — does not exist (404), skipping", subreddit)

        except Exception:
            log.exception("r/%s — unexpected error", subreddit)

        # Jittered delay between subreddits (skip after last one).
        if idx < len(subreddits) - 1 and not _shutdown_event.is_set():
            jitter = random.uniform(*DELAY_JITTER)
            delay = DELAY_BETWEEN_SUBS + jitter
            log.debug("Sleeping %.2fs before next subreddit", delay)
            if _shutdown_event.wait(timeout=delay):
                log.info("Shutdown during inter-sub delay")
                break

    log.info("Cycle complete — %d new post(s) inserted", total_inserted)
    return total_inserted


# ---------------------------------------------------------------------------
# Continuous run loop
# ---------------------------------------------------------------------------

def run(collection: Any) -> None:
    """Run scrape cycles continuously until a shutdown signal is received."""
    signal.signal(signal.SIGINT, _handle_signal)
    signal.signal(signal.SIGTERM, _handle_signal)

    log.info("Starting continuous scrape loop (SIGINT/SIGTERM to stop)")

    with Session() as session:
        while not _shutdown_event.is_set():
            try:
                scrape_cycle(collection, SUBREDDITS, session)
            except Exception:
                log.exception("Unhandled error in scrape cycle")

            if _shutdown_event.is_set():
                break

            cycle_sleep = random.randint(*CYCLE_DELAY)
            log.info("Cycle done — sleeping %ds before next cycle", cycle_sleep)
            if _shutdown_event.wait(timeout=cycle_sleep):
                break

    log.info("Scraper shut down cleanly")


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

def main() -> None:
    """Configure logging, connect to MongoDB, and start the scraper."""
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    log.info("Initialising Reddit scraper")

    try:
        client = get_client()
        collection = get_collection(client)
    except Exception:
        log.exception("Failed to connect to MongoDB — exiting")
        sys.exit(1)

    try:
        run(collection)
    finally:
        client.close()
        log.info("MongoDB connection closed")


if __name__ == "__main__":
    main()
