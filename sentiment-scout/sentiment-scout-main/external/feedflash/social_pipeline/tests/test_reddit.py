"""Tests for scrapers.reddit — Reddit scraper core logic.

HTTP calls are mocked via ``unittest.mock``; database interactions use
``mongomock`` through the ``mongo_collection`` fixture from conftest.py.
"""

from __future__ import annotations

import hashlib
import threading
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

import pytest
from curl_cffi.requests.errors import RequestsError

from scrapers.reddit import (
    PrivateSubredditError,
    RateLimitError,
    fetch_subreddit_posts,
    normalize_post,
    scrape_cycle,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _raw_child(
    name: str = "t3_abc123",
    author: str = "testuser",
    title: str = "YOLO GME",
    selftext: str = "Diamond hands forever",
    permalink: str = "/r/wallstreetbets/comments/abc123/yolo_gme/",
    score: int = 42,
    num_comments: int = 7,
    created_utc: float = 1700000000.0,
) -> dict:
    """Build a raw Reddit 'thing' dict as returned by the JSON endpoint."""
    return {
        "kind": "t3",
        "data": {
            "name": name,
            "author": author,
            "title": title,
            "selftext": selftext,
            "permalink": permalink,
            "score": score,
            "num_comments": num_comments,
            "created_utc": created_utc,
        },
    }


def _mock_response(status_code: int = 200, json_data: dict | None = None):
    """Return a MagicMock that quacks like a curl_cffi Response."""
    resp = MagicMock()
    resp.status_code = status_code
    resp.json.return_value = json_data or {}
    resp.raise_for_status = MagicMock()
    return resp


def _content_hash(title: str, text: str) -> str:
    """Mirror the hashing logic in scrapers.reddit._content_hash."""
    combined = (title or "") + "\x00" + (text or "")
    return hashlib.sha256(combined.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# normalize_post tests
# ---------------------------------------------------------------------------

class TestNormalizePost:
    """Tests for the normalize_post function."""

    def test_happy_path_all_fields(self):
        """All expected fields are present and correctly mapped."""
        child = _raw_child()
        result = normalize_post(child, "wallstreetbets")

        assert result is not None
        assert result["id"] == "t3_abc123"
        assert result["source"] == "reddit"
        assert result["subreddit"] == "wallstreetbets"
        assert result["author"] == "testuser"
        assert result["title"] == "YOLO GME"
        assert result["text"] == "Diamond hands forever"
        assert result["url"] == "https://www.reddit.com/r/wallstreetbets/comments/abc123/yolo_gme/"
        assert result["score"] == 42
        assert result["num_comments"] == 7
        assert isinstance(result["published_at"], datetime)
        assert result["published_at"].tzinfo == timezone.utc
        assert isinstance(result["detected_at"], datetime)
        assert result["content_hash"] == _content_hash("YOLO GME", "Diamond hands forever")

    def test_filters_deleted_author(self):
        """Posts with author '[deleted]' are filtered out (returns None)."""
        child = _raw_child(author="[deleted]")
        assert normalize_post(child, "stocks") is None

    def test_filters_removed_author(self):
        """Posts with author '[removed]' are filtered out."""
        child = _raw_child(author="[removed]")
        assert normalize_post(child, "stocks") is None

    def test_filters_removed_selftext(self):
        """Posts with selftext '[removed]' are filtered out."""
        child = _raw_child(selftext="[removed]")
        assert normalize_post(child, "stocks") is None

    def test_filters_deleted_selftext(self):
        """Posts with selftext '[deleted]' are filtered out."""
        child = _raw_child(selftext="[deleted]")
        assert normalize_post(child, "stocks") is None

    def test_filters_empty_author(self):
        """Posts with an empty author string are filtered out."""
        child = _raw_child(author="")
        assert normalize_post(child, "stocks") is None

    def test_handles_missing_optional_fields(self):
        """Missing optional fields fall back to sensible defaults."""
        # Minimal child with only author and name (enough to pass is_deleted).
        child = {
            "kind": "t3",
            "data": {
                "name": "t3_minimal",
                "author": "someuser",
            },
        }
        result = normalize_post(child, "pennystocks")

        assert result is not None
        assert result["id"] == "t3_minimal"
        assert result["title"] == ""
        assert result["text"] == ""
        assert result["url"] == ""
        assert result["score"] == 0
        assert result["num_comments"] == 0
        # created_utc defaults to 0 -> epoch
        assert result["published_at"] == datetime.fromtimestamp(0, tz=timezone.utc)

    def test_empty_data_dict_is_filtered(self):
        """A child with an empty data dict is treated as deleted (empty author)."""
        child = {"kind": "t3", "data": {}}
        assert normalize_post(child, "stocks") is None


# ---------------------------------------------------------------------------
# fetch_subreddit_posts tests
# ---------------------------------------------------------------------------

class TestFetchSubredditPosts:
    """Tests for the fetch_subreddit_posts function."""

    def test_success_200_correct_parsing(self):
        """A 200 response is parsed into (children, after_token)."""
        children_data = [_raw_child(name=f"t3_{i}") for i in range(3)]
        json_payload = {
            "data": {
                "children": children_data,
                "after": "t3_nextpage",
            }
        }
        session = MagicMock()
        session.get.return_value = _mock_response(200, json_payload)

        children, after = fetch_subreddit_posts("wallstreetbets", session)

        assert len(children) == 3
        assert after == "t3_nextpage"
        session.get.assert_called_once()

    def test_429_raises_rate_limit_error(self):
        """HTTP 429 triggers a RateLimitError."""
        session = MagicMock()
        session.get.return_value = _mock_response(429)

        with pytest.raises(RateLimitError):
            fetch_subreddit_posts("wallstreetbets", session)

    def test_403_raises_private_subreddit_error(self):
        """HTTP 403 triggers a PrivateSubredditError."""
        session = MagicMock()
        session.get.return_value = _mock_response(403)

        with pytest.raises(PrivateSubredditError):
            fetch_subreddit_posts("someprivatesub", session)

    def test_network_error_propagates(self):
        """A curl_cffi RequestsError propagates to the caller."""
        session = MagicMock()
        session.get.side_effect = RequestsError("Connection refused")

        with pytest.raises(RequestsError):
            fetch_subreddit_posts("stocks", session)

    def test_pagination_after_param(self):
        """When an 'after' token is provided, it is appended to the URL."""
        json_payload = {"data": {"children": [], "after": None}}
        session = MagicMock()
        session.get.return_value = _mock_response(200, json_payload)

        fetch_subreddit_posts("stocks", session, after="t3_page2")

        called_url = session.get.call_args[0][0]
        assert "&after=t3_page2" in called_url


# ---------------------------------------------------------------------------
# scrape_cycle integration tests
# ---------------------------------------------------------------------------

class TestScrapeCycle:
    """Integration tests for scrape_cycle using mocked HTTP + mongomock."""

    @patch("scrapers.reddit.DELAY_JITTER", (0, 0))
    @patch("scrapers.reddit.DELAY_BETWEEN_SUBS", 0)
    @patch("scrapers.reddit._shutdown_event", threading.Event())
    def test_inserts_posts_from_multiple_subreddits(self, mongo_collection):
        """Posts from multiple subreddits are fetched, normalized, and inserted."""
        subreddits = ["sub1", "sub2"]

        def mock_fetch(subreddit, session, after=None):
            children = [
                _raw_child(name=f"t3_{subreddit}_1", author="user1"),
                _raw_child(name=f"t3_{subreddit}_2", author="user2"),
            ]
            return children, None

        session = MagicMock()

        with patch("scrapers.reddit.fetch_subreddit_posts", side_effect=mock_fetch):
            total = scrape_cycle(mongo_collection, subreddits, session)

        assert total == 4
        assert mongo_collection.count_documents({}) == 4

    @patch("scrapers.reddit.DELAY_JITTER", (0, 0))
    @patch("scrapers.reddit.DELAY_BETWEEN_SUBS", 0)
    @patch("scrapers.reddit._shutdown_event", threading.Event())
    def test_dedup_across_cycles(self, mongo_collection):
        """Running two cycles with the same posts does not duplicate them."""
        subreddits = ["sub1"]
        children = [_raw_child(name="t3_same1"), _raw_child(name="t3_same2")]

        def mock_fetch(subreddit, session, after=None):
            return children, None

        session = MagicMock()

        with patch("scrapers.reddit.fetch_subreddit_posts", side_effect=mock_fetch):
            first = scrape_cycle(mongo_collection, subreddits, session)

        with patch("scrapers.reddit.fetch_subreddit_posts", side_effect=mock_fetch):
            second = scrape_cycle(mongo_collection, subreddits, session)

        assert first == 2
        assert second == 0
        assert mongo_collection.count_documents({}) == 2

    @patch("scrapers.reddit.DELAY_JITTER", (0, 0))
    @patch("scrapers.reddit.DELAY_BETWEEN_SUBS", 0)
    @patch("scrapers.reddit._shutdown_event", threading.Event())
    def test_rate_limit_skips_subreddit_continues(self, mongo_collection):
        """A 429 on one subreddit does not prevent scraping the next one."""
        subreddits = ["ratelimited_sub", "ok_sub"]
        call_count = 0

        def mock_fetch(subreddit, session, after=None):
            nonlocal call_count
            call_count += 1
            if subreddit == "ratelimited_sub":
                raise RateLimitError("429")
            return [_raw_child(name="t3_ok1")], None

        session = MagicMock()

        with patch("scrapers.reddit.fetch_subreddit_posts", side_effect=mock_fetch):
            total = scrape_cycle(mongo_collection, subreddits, session)

        assert total == 1
        assert mongo_collection.count_documents({}) == 1

    @patch("scrapers.reddit.DELAY_JITTER", (0, 0))
    @patch("scrapers.reddit.DELAY_BETWEEN_SUBS", 0)
    @patch("scrapers.reddit._shutdown_event", threading.Event())
    def test_private_subreddit_skipped(self, mongo_collection):
        """A 403 (private sub) is gracefully skipped."""
        subreddits = ["private_sub", "open_sub"]

        def mock_fetch(subreddit, session, after=None):
            if subreddit == "private_sub":
                raise PrivateSubredditError("403")
            return [_raw_child(name="t3_open1")], None

        session = MagicMock()

        with patch("scrapers.reddit.fetch_subreddit_posts", side_effect=mock_fetch):
            total = scrape_cycle(mongo_collection, subreddits, session)

        assert total == 1

    @patch("scrapers.reddit.DELAY_JITTER", (0, 0))
    @patch("scrapers.reddit.DELAY_BETWEEN_SUBS", 0)
    def test_shutdown_event_aborts_cycle(self, mongo_collection):
        """Setting the shutdown event stops the cycle early."""
        shutdown = threading.Event()
        shutdown.set()  # Already set before cycle starts.

        subreddits = ["sub1", "sub2", "sub3"]
        session = MagicMock()

        with patch("scrapers.reddit._shutdown_event", shutdown):
            total = scrape_cycle(mongo_collection, subreddits, session)

        # No posts should have been fetched because shutdown was immediate.
        assert total == 0
        assert mongo_collection.count_documents({}) == 0

    @patch("scrapers.reddit.DELAY_JITTER", (0, 0))
    @patch("scrapers.reddit.DELAY_BETWEEN_SUBS", 0)
    @patch("scrapers.reddit._shutdown_event", threading.Event())
    def test_deleted_posts_filtered_during_cycle(self, mongo_collection):
        """Deleted/removed posts are filtered out by normalize_post inside scrape_cycle."""
        subreddits = ["sub1"]

        def mock_fetch(subreddit, session, after=None):
            children = [
                _raw_child(name="t3_good", author="realuser"),
                _raw_child(name="t3_del", author="[deleted]"),
                _raw_child(name="t3_rem", selftext="[removed]"),
            ]
            return children, None

        session = MagicMock()

        with patch("scrapers.reddit.fetch_subreddit_posts", side_effect=mock_fetch):
            total = scrape_cycle(mongo_collection, subreddits, session)

        # Only the non-deleted post should be inserted.
        assert total == 1
        assert mongo_collection.count_documents({}) == 1

    @patch("scrapers.reddit.DELAY_JITTER", (0, 0))
    @patch("scrapers.reddit.DELAY_BETWEEN_SUBS", 0)
    @patch("scrapers.reddit._shutdown_event", threading.Event())
    def test_unexpected_error_logged_and_continues(self, mongo_collection):
        """An unexpected exception on one sub does not crash the whole cycle."""
        subreddits = ["broken_sub", "good_sub"]

        def mock_fetch(subreddit, session, after=None):
            if subreddit == "broken_sub":
                raise RuntimeError("Something unexpected")
            return [_raw_child(name="t3_good_post")], None

        session = MagicMock()

        with patch("scrapers.reddit.fetch_subreddit_posts", side_effect=mock_fetch):
            total = scrape_cycle(mongo_collection, subreddits, session)

        assert total == 1
