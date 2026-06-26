"""Tests for scrapers.bluesky — Bluesky scraper core logic.

atproto Client calls are mocked via ``unittest.mock``; database interactions
use ``mongomock`` through the ``mongo_collection`` fixture from conftest.py.
"""

from __future__ import annotations

import hashlib
import threading
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

import pytest

from scrapers.bluesky import (
    _url_from_uri,
    normalize_post,
    scrape_cycle,
    search_posts,
    get_account_posts,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _content_hash(title: str, text: str) -> str:
    """Mirror the hashing logic in scrapers.bluesky._content_hash."""
    combined = (title or "") + "\x00" + (text or "")
    return hashlib.sha256(combined.encode("utf-8")).hexdigest()


def _mock_post_view(
    uri: str = "at://did:plc:abc123/app.bsky.feed.post/rkey1",
    handle: str = "testuser.bsky.social",
    text: str = "$TSLA to the moon",
    like_count: int = 10,
    reply_count: int = 3,
    created_at: str = "2024-01-15T12:00:00Z",
) -> MagicMock:
    """Build a mock atproto PostView object."""
    post = MagicMock()
    post.uri = uri
    post.like_count = like_count
    post.reply_count = reply_count

    post.author = MagicMock()
    post.author.handle = handle

    post.record = MagicMock()
    post.record.text = text
    post.record.created_at = created_at

    return post


def _mock_feed_view_post(post_view: MagicMock) -> MagicMock:
    """Wrap a PostView in a FeedViewPost (as returned by get_author_feed)."""
    fvp = MagicMock()
    fvp.post = post_view
    return fvp


# ---------------------------------------------------------------------------
# _url_from_uri tests
# ---------------------------------------------------------------------------

class TestUrlFromUri:
    """Tests for AT URI → bsky.app URL conversion."""

    def test_standard_uri(self):
        uri = "at://did:plc:abc123/app.bsky.feed.post/rkey1"
        assert _url_from_uri(uri, "user.bsky.social") == (
            "https://bsky.app/profile/user.bsky.social/post/rkey1"
        )

    def test_malformed_uri_no_slash(self):
        assert _url_from_uri("noslash", "user.bsky.social") == ""


# ---------------------------------------------------------------------------
# normalize_post tests
# ---------------------------------------------------------------------------

class TestNormalizePost:
    """Tests for the normalize_post function."""

    def test_happy_path_all_fields(self):
        """All expected fields are present and correctly mapped."""
        pv = _mock_post_view()
        result = normalize_post(pv)

        assert result is not None
        assert result["id"] == "at://did:plc:abc123/app.bsky.feed.post/rkey1"
        assert result["source"] == "bluesky"
        assert result["subreddit"] == ""
        assert result["author"] == "testuser.bsky.social"
        assert result["title"] == ""
        assert result["text"] == "$TSLA to the moon"
        assert result["url"] == "https://bsky.app/profile/testuser.bsky.social/post/rkey1"
        assert result["score"] == 10
        assert result["num_comments"] == 3
        assert isinstance(result["published_at"], datetime)
        assert result["published_at"].tzinfo is not None
        assert isinstance(result["detected_at"], datetime)
        assert result["content_hash"] == _content_hash("", "$TSLA to the moon")

    def test_empty_text_returns_none(self):
        """Posts with empty text are filtered out."""
        pv = _mock_post_view(text="")
        assert normalize_post(pv) is None

    def test_whitespace_only_text_returns_none(self):
        """Posts with whitespace-only text are filtered out."""
        pv = _mock_post_view(text="   \n  ")
        assert normalize_post(pv) is None

    def test_none_record_returns_none(self):
        """Posts with no record attribute are filtered out."""
        pv = MagicMock()
        pv.record = None
        assert normalize_post(pv) is None

    def test_missing_like_count_defaults_to_zero(self):
        """None like_count defaults to 0."""
        pv = _mock_post_view(like_count=None)
        result = normalize_post(pv)
        assert result is not None
        assert result["score"] == 0

    def test_missing_reply_count_defaults_to_zero(self):
        """None reply_count defaults to 0."""
        pv = _mock_post_view(reply_count=None)
        result = normalize_post(pv)
        assert result is not None
        assert result["num_comments"] == 0

    def test_url_construction_from_uri(self):
        """URL is correctly built from the AT URI."""
        pv = _mock_post_view(
            uri="at://did:plc:xyz/app.bsky.feed.post/mykey",
            handle="finance.bsky.social",
        )
        result = normalize_post(pv)
        assert result is not None
        assert result["url"] == "https://bsky.app/profile/finance.bsky.social/post/mykey"


# ---------------------------------------------------------------------------
# search_posts tests
# ---------------------------------------------------------------------------

class TestSearchPosts:
    """Tests for the search_posts function."""

    def test_success_returns_posts_and_cursor(self):
        """Successful search returns posts list and cursor."""
        mock_client = MagicMock()
        mock_response = MagicMock()
        mock_response.posts = [_mock_post_view(), _mock_post_view(uri="at://did:plc:abc/app.bsky.feed.post/rk2")]
        mock_response.cursor = "next_page_token"
        mock_client.app.bsky.feed.search_posts.return_value = mock_response

        posts, cursor = search_posts(mock_client, "$TSLA")

        assert len(posts) == 2
        assert cursor == "next_page_token"
        mock_client.app.bsky.feed.search_posts.assert_called_once()

    def test_empty_results(self):
        """Empty search returns empty list and None cursor."""
        mock_client = MagicMock()
        mock_response = MagicMock()
        mock_response.posts = []
        mock_response.cursor = None
        mock_client.app.bsky.feed.search_posts.return_value = mock_response

        posts, cursor = search_posts(mock_client, "$OBSCURE")

        assert posts == []
        assert cursor is None

    def test_none_posts_returns_empty_list(self):
        """If posts field is None, returns empty list."""
        mock_client = MagicMock()
        mock_response = MagicMock()
        mock_response.posts = None
        mock_response.cursor = None
        mock_client.app.bsky.feed.search_posts.return_value = mock_response

        posts, cursor = search_posts(mock_client, "$TSLA")

        assert posts == []

    def test_cursor_passed_to_params(self):
        """Cursor parameter is forwarded to the API call."""
        mock_client = MagicMock()
        mock_response = MagicMock()
        mock_response.posts = []
        mock_response.cursor = None
        mock_client.app.bsky.feed.search_posts.return_value = mock_response

        search_posts(mock_client, "$AAPL", cursor="page2")

        call_params = mock_client.app.bsky.feed.search_posts.call_args[0][0]
        assert call_params["cursor"] == "page2"


# ---------------------------------------------------------------------------
# get_account_posts tests
# ---------------------------------------------------------------------------

class TestGetAccountPosts:
    """Tests for the get_account_posts function."""

    def test_success_returns_posts(self):
        """Successful fetch returns extracted PostView objects."""
        pv1 = _mock_post_view(handle="finance.bsky.social")
        pv2 = _mock_post_view(uri="at://did:plc:abc/app.bsky.feed.post/rk2", handle="finance.bsky.social")
        mock_client = MagicMock()
        mock_response = MagicMock()
        mock_response.feed = [_mock_feed_view_post(pv1), _mock_feed_view_post(pv2)]
        mock_response.cursor = "acct_cursor"
        mock_client.app.bsky.feed.get_author_feed.return_value = mock_response

        posts, cursor = get_account_posts(mock_client, "finance.bsky.social")

        assert len(posts) == 2
        assert cursor == "acct_cursor"

    def test_empty_feed(self):
        """Empty feed returns empty list."""
        mock_client = MagicMock()
        mock_response = MagicMock()
        mock_response.feed = []
        mock_response.cursor = None
        mock_client.app.bsky.feed.get_author_feed.return_value = mock_response

        posts, cursor = get_account_posts(mock_client, "nobody.bsky.social")

        assert posts == []
        assert cursor is None

    def test_none_feed_returns_empty_list(self):
        """If feed field is None, returns empty list."""
        mock_client = MagicMock()
        mock_response = MagicMock()
        mock_response.feed = None
        mock_response.cursor = None
        mock_client.app.bsky.feed.get_author_feed.return_value = mock_response

        posts, cursor = get_account_posts(mock_client, "nobody.bsky.social")

        assert posts == []


# ---------------------------------------------------------------------------
# scrape_cycle integration tests
# ---------------------------------------------------------------------------

class TestScrapeCycle:
    """Integration tests for scrape_cycle using mocked API + mongomock."""

    @patch("scrapers.bluesky.BLUESKY_DELAY_BETWEEN_QUERIES", 0)
    @patch("scrapers.bluesky.BLUESKY_SEARCH_QUERIES", ["$TSLA", "$AAPL"])
    @patch("scrapers.bluesky.BLUESKY_ACCOUNTS", [])
    @patch("scrapers.bluesky._shutdown_event", threading.Event())
    def test_searches_all_queries_and_inserts(self, mongo_collection):
        """Posts from multiple search queries are fetched and inserted."""
        pv1 = _mock_post_view(uri="at://did:plc:a/app.bsky.feed.post/tsla1", text="$TSLA moon")
        pv2 = _mock_post_view(uri="at://did:plc:a/app.bsky.feed.post/aapl1", text="$AAPL buy")

        call_count = 0

        def mock_search(client, query, cursor=None):
            nonlocal call_count
            call_count += 1
            if "$TSLA" in query:
                return [pv1], None
            return [pv2], None

        mock_client = MagicMock()

        with patch("scrapers.bluesky.search_posts", side_effect=mock_search):
            total = scrape_cycle(mongo_collection, mock_client)

        assert total == 2
        assert mongo_collection.count_documents({}) == 2
        assert call_count == 2

    @patch("scrapers.bluesky.BLUESKY_DELAY_BETWEEN_QUERIES", 0)
    @patch("scrapers.bluesky.BLUESKY_SEARCH_QUERIES", ["$TSLA"])
    @patch("scrapers.bluesky.BLUESKY_ACCOUNTS", [])
    @patch("scrapers.bluesky._shutdown_event", threading.Event())
    def test_dedup_across_cycles(self, mongo_collection):
        """Running two cycles with the same posts does not duplicate them."""
        pv = _mock_post_view(uri="at://did:plc:a/app.bsky.feed.post/same1", text="Same post")

        def mock_search(client, query, cursor=None):
            return [pv], None

        mock_client = MagicMock()

        with patch("scrapers.bluesky.search_posts", side_effect=mock_search):
            first = scrape_cycle(mongo_collection, mock_client)

        with patch("scrapers.bluesky.search_posts", side_effect=mock_search):
            second = scrape_cycle(mongo_collection, mock_client)

        assert first == 1
        assert second == 0
        assert mongo_collection.count_documents({}) == 1

    @patch("scrapers.bluesky.BLUESKY_DELAY_BETWEEN_QUERIES", 0)
    @patch("scrapers.bluesky.BLUESKY_SEARCH_QUERIES", ["$TSLA"])
    @patch("scrapers.bluesky.BLUESKY_ACCOUNTS", [])
    def test_shutdown_event_aborts_cycle(self, mongo_collection):
        """Setting the shutdown event stops the cycle early."""
        shutdown = threading.Event()
        shutdown.set()

        mock_client = MagicMock()

        with patch("scrapers.bluesky._shutdown_event", shutdown):
            total = scrape_cycle(mongo_collection, mock_client)

        assert total == 0
        assert mongo_collection.count_documents({}) == 0

    @patch("scrapers.bluesky.BLUESKY_DELAY_BETWEEN_QUERIES", 0)
    @patch("scrapers.bluesky.BLUESKY_SEARCH_QUERIES", ["$FAIL", "$OK"])
    @patch("scrapers.bluesky.BLUESKY_ACCOUNTS", [])
    @patch("scrapers.bluesky._shutdown_event", threading.Event())
    def test_query_error_continues_to_next(self, mongo_collection):
        """An error on one query doesn't prevent scraping the next."""
        pv = _mock_post_view(uri="at://did:plc:a/app.bsky.feed.post/ok1", text="Good post")

        def mock_search(client, query, cursor=None):
            if "$FAIL" in query:
                raise RuntimeError("Network error")
            return [pv], None

        mock_client = MagicMock()

        with patch("scrapers.bluesky.search_posts", side_effect=mock_search):
            total = scrape_cycle(mongo_collection, mock_client)

        assert total == 1
        assert mongo_collection.count_documents({}) == 1

    @patch("scrapers.bluesky.BLUESKY_DELAY_BETWEEN_QUERIES", 0)
    @patch("scrapers.bluesky.BLUESKY_SEARCH_QUERIES", [])
    @patch("scrapers.bluesky.BLUESKY_ACCOUNTS", ["finance.bsky.social"])
    @patch("scrapers.bluesky._shutdown_event", threading.Event())
    def test_account_monitoring(self, mongo_collection):
        """Posts from monitored accounts are fetched and inserted."""
        pv = _mock_post_view(
            uri="at://did:plc:a/app.bsky.feed.post/acct1",
            handle="finance.bsky.social",
            text="Market update",
        )

        def mock_get_acct(client, handle):
            return [pv], None

        mock_client = MagicMock()

        with patch("scrapers.bluesky.get_account_posts", side_effect=mock_get_acct):
            total = scrape_cycle(mongo_collection, mock_client)

        assert total == 1
        assert mongo_collection.count_documents({"source": "bluesky"}) == 1

    @patch("scrapers.bluesky.BLUESKY_DELAY_BETWEEN_QUERIES", 0)
    @patch("scrapers.bluesky.BLUESKY_SEARCH_QUERIES", ["$TSLA"])
    @patch("scrapers.bluesky.BLUESKY_ACCOUNTS", [])
    @patch("scrapers.bluesky._shutdown_event", threading.Event())
    def test_empty_text_posts_filtered(self, mongo_collection):
        """Posts with empty text are filtered out during normalisation."""
        pv_good = _mock_post_view(uri="at://did:plc:a/app.bsky.feed.post/g1", text="Real post")
        pv_empty = _mock_post_view(uri="at://did:plc:a/app.bsky.feed.post/e1", text="")

        def mock_search(client, query, cursor=None):
            return [pv_good, pv_empty], None

        mock_client = MagicMock()

        with patch("scrapers.bluesky.search_posts", side_effect=mock_search):
            total = scrape_cycle(mongo_collection, mock_client)

        assert total == 1
        assert mongo_collection.count_documents({}) == 1
