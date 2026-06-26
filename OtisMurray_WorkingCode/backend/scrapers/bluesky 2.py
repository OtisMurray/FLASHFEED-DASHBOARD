"""Core Bluesky scraper — searches for cashtag mentions and monitors finance
accounts via the AT Protocol using the ``atproto`` Python SDK.

Usage::

    python -m scrapers.bluesky
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

from atproto import Client
from atproto_client.exceptions import (
    BadRequestError,
    NetworkError,
    UnauthorizedError,
)

from scrapers.config import (
    BLUESKY_ACCOUNTS,
    BLUESKY_APP_PASSWORD,
    BLUESKY_CYCLE_DELAY,
    BLUESKY_DELAY_BETWEEN_QUERIES,
    BLUESKY_HANDLE,
    BLUESKY_POSTS_PER_REQUEST,
    BLUESKY_SEARCH_QUERIES,
)
from scrapers.db import get_client, get_collection, upsert_posts

log = logging.getLogger(__name__)

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
# Authentication
# ---------------------------------------------------------------------------

def create_client(handle: str = BLUESKY_HANDLE,
                  app_password: str = BLUESKY_APP_PASSWORD) -> Client:
    """Create and authenticate an atproto Client.

    Raises on auth failure so the caller can decide whether to retry or exit.
    """
    client = Client()
    log.info("Authenticating with Bluesky as %s", handle)
    client.login(handle, app_password)
    log.info("Bluesky authentication successful")
    return client


# ---------------------------------------------------------------------------
# Search / fetch helpers
# ---------------------------------------------------------------------------

def search_posts(
    client: Client,
    query: str,
    cursor: str | None = None,
) -> tuple[list, str | None]:
    """Search Bluesky for posts matching *query*.

    Returns ``(posts, next_cursor)`` where *posts* is a list of PostView
    objects and *next_cursor* is the pagination cursor (or ``None``).
    """
    params: dict[str, Any] = {
        "q": query,
        "limit": BLUESKY_POSTS_PER_REQUEST,
        "sort": "latest",
    }
    if cursor:
        params["cursor"] = cursor

    response = client.app.bsky.feed.search_posts(params)
    posts = response.posts or []
    next_cursor = response.cursor

    log.info("Search '%s' — fetched %d post(s), cursor=%s", query, len(posts), next_cursor)
    return posts, next_cursor


def get_account_posts(
    client: Client,
    handle: str,
) -> tuple[list, str | None]:
    """Fetch recent posts from a specific Bluesky account.

    Returns ``(posts, cursor)``.
    """
    params: dict[str, Any] = {
        "actor": handle,
        "limit": BLUESKY_POSTS_PER_REQUEST,
    }

    response = client.app.bsky.feed.get_author_feed(params)
    # get_author_feed returns FeedViewPost objects; extract the .post (PostView)
    posts = [item.post for item in (response.feed or [])]
    next_cursor = response.cursor

    log.info("Account @%s — fetched %d post(s)", handle, len(posts))
    return posts, next_cursor


# ---------------------------------------------------------------------------
# Post normalisation
# ---------------------------------------------------------------------------

def _content_hash(title: str, text: str) -> str:
    """SHA-256 hex digest of *title* + *text* (matches Reddit pattern)."""
    combined = (title or "") + "\x00" + (text or "")
    return hashlib.sha256(combined.encode("utf-8")).hexdigest()


def _url_from_uri(uri: str, handle: str) -> str:
    """Construct a bsky.app URL from an AT Protocol URI.

    URI format: ``at://did:plc:.../app.bsky.feed.post/rkey``
    URL format: ``https://bsky.app/profile/{handle}/post/{rkey}``
    """
    parts = uri.rsplit("/", 1)
    if len(parts) == 2:
        rkey = parts[1]
        return f"https://bsky.app/profile/{handle}/post/{rkey}"
    return ""


def normalize_post(post_view: Any) -> dict | None:
    """Convert an atproto PostView into the shared post schema.

    Returns ``None`` for posts with empty/missing text.
    """
    record = getattr(post_view, "record", None)
    if record is None:
        return None

    text = getattr(record, "text", None) or ""
    if not text.strip():
        return None

    author = getattr(post_view.author, "handle", "") if post_view.author else ""
    uri = getattr(post_view, "uri", "")

    created_at_str = getattr(record, "created_at", None) or ""
    if created_at_str:
        # ISO 8601 with optional timezone
        try:
            published_at = datetime.fromisoformat(created_at_str.replace("Z", "+00:00"))
        except (ValueError, AttributeError):
            published_at = datetime.now(tz=timezone.utc)
    else:
        published_at = datetime.now(tz=timezone.utc)

    return {
        "id": uri,
        "source": "bluesky",
        "subreddit": "",
        "author": author,
        "title": "",
        "text": text,
        "url": _url_from_uri(uri, author),
        "score": getattr(post_view, "like_count", 0) or 0,
        "num_comments": getattr(post_view, "reply_count", 0) or 0,
        "published_at": published_at,
        "detected_at": datetime.now(tz=timezone.utc),
        "content_hash": _content_hash("", text),
    }


# ---------------------------------------------------------------------------
# Scrape cycle
# ---------------------------------------------------------------------------

def scrape_cycle(collection: Any, client: Client) -> int:
    """Execute one full pass: search all queries + monitor all accounts.

    Returns the total number of newly inserted posts.
    """
    total_inserted = 0

    # --- Cashtag searches ---
    for idx, query in enumerate(BLUESKY_SEARCH_QUERIES):
        if _shutdown_event.is_set():
            log.info("Shutdown requested — aborting at query %d/%d", idx, len(BLUESKY_SEARCH_QUERIES))
            return total_inserted

        try:
            raw_posts, _cursor = search_posts(client, query)
            posts = [p for pv in raw_posts if (p := normalize_post(pv)) is not None]

            if posts:
                inserted = upsert_posts(collection, posts)
                total_inserted += inserted
            else:
                log.debug("Search '%s' — no valid posts after normalisation", query)

        except Exception:
            log.exception("Search '%s' — error", query)

        # Jittered delay between queries
        if idx < len(BLUESKY_SEARCH_QUERIES) - 1 and not _shutdown_event.is_set():
            delay = BLUESKY_DELAY_BETWEEN_QUERIES + random.uniform(0, 0.5)
            if _shutdown_event.wait(timeout=delay):
                break

    # --- Account monitoring ---
    for idx, handle in enumerate(BLUESKY_ACCOUNTS):
        if _shutdown_event.is_set():
            log.info("Shutdown requested — aborting at account %d/%d", idx, len(BLUESKY_ACCOUNTS))
            return total_inserted

        try:
            raw_posts, _cursor = get_account_posts(client, handle)
            posts = [p for pv in raw_posts if (p := normalize_post(pv)) is not None]

            if posts:
                inserted = upsert_posts(collection, posts)
                total_inserted += inserted

        except Exception:
            log.exception("Account @%s — error", handle)

        # Jittered delay between accounts
        if idx < len(BLUESKY_ACCOUNTS) - 1 and not _shutdown_event.is_set():
            delay = BLUESKY_DELAY_BETWEEN_QUERIES + random.uniform(0, 0.5)
            if _shutdown_event.wait(timeout=delay):
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

    log.info("Starting continuous Bluesky scrape loop (SIGINT/SIGTERM to stop)")

    client = create_client()

    while not _shutdown_event.is_set():
        try:
            scrape_cycle(collection, client)
        except UnauthorizedError:
            log.warning("Auth token expired — re-authenticating")
            try:
                client = create_client()
            except Exception:
                log.exception("Re-authentication failed — exiting loop")
                break
        except Exception:
            log.exception("Unhandled error in scrape cycle")

        if _shutdown_event.is_set():
            break

        cycle_sleep = random.randint(*BLUESKY_CYCLE_DELAY)
        log.info("Cycle done — sleeping %ds before next cycle", cycle_sleep)
        if _shutdown_event.wait(timeout=cycle_sleep):
            break

    log.info("Bluesky scraper shut down cleanly")


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

    log.info("Initialising Bluesky scraper")

    if not BLUESKY_HANDLE or not BLUESKY_APP_PASSWORD:
        log.error("BLUESKY_HANDLE and BLUESKY_APP_PASSWORD must be set in .env")
        sys.exit(1)

    try:
        mongo_client = get_client()
        collection = get_collection(mongo_client)
    except Exception:
        log.exception("Failed to connect to MongoDB — exiting")
        sys.exit(1)

    try:
        run(collection)
    finally:
        mongo_client.close()
        log.info("MongoDB connection closed")


if __name__ == "__main__":
    main()
