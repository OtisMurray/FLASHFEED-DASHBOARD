"""Tests for D6: Rolling Window Calculator."""

from datetime import datetime, timedelta, timezone

import mongomock
import pytest

from processing.rolling_windows import (
    compute_window_stats,
    compute_rolling_window,
    compute_all_windows,
    get_active_tickers,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

NOW = datetime(2026, 3, 27, 12, 0, 0, tzinfo=timezone.utc)


def _post(ticker, score, minutes_ago, dup=False, _id=None):
    """Build a minimal post document for testing."""
    doc = {
        "title": f"{ticker} post",
        "text": "",
        "tickers_mentioned": [ticker],
        "sentiment_score": score,
        "is_duplicate": dup,
        "published_at": NOW - timedelta(minutes=minutes_ago),
        "source": "reddit",
        "author": "testuser",
    }
    if _id is not None:
        doc["_id"] = _id
    return doc


# ---------------------------------------------------------------------------
# TestComputeWindowStats
# ---------------------------------------------------------------------------

class TestComputeWindowStats:
    def test_empty(self):
        stats = compute_window_stats([])
        assert stats["message_count"] == 0
        assert stats["avg_sentiment"] == 0.0

    def test_single_post(self):
        stats = compute_window_stats([{"sentiment_score": 0.5}])
        assert stats["message_count"] == 1
        assert stats["avg_sentiment"] == 0.5
        assert stats["bullish_count"] == 1
        assert stats["bearish_count"] == 0

    def test_multiple_posts_avg(self):
        posts = [
            {"sentiment_score": 0.6},
            {"sentiment_score": 0.4},
            {"sentiment_score": -0.2},
        ]
        stats = compute_window_stats(posts)
        assert stats["message_count"] == 3
        expected_avg = round((0.6 + 0.4 + (-0.2)) / 3, 4)
        assert stats["avg_sentiment"] == pytest.approx(expected_avg, abs=0.001)

    def test_bullish_bearish_neutral_counts(self):
        posts = [
            {"sentiment_score": 0.5},   # bullish
            {"sentiment_score": -0.5},   # bearish
            {"sentiment_score": 0.1},    # neutral
            {"sentiment_score": 0.0},    # neutral
            {"sentiment_score": -0.1},   # neutral
        ]
        stats = compute_window_stats(posts)
        assert stats["bullish_count"] == 1
        assert stats["bearish_count"] == 1
        assert stats["neutral_count"] == 3

    def test_counts_sum_to_total(self):
        posts = [{"sentiment_score": s} for s in [0.8, -0.9, 0.0, 0.3, -0.4]]
        stats = compute_window_stats(posts)
        total = stats["bullish_count"] + stats["bearish_count"] + stats["neutral_count"]
        assert total == stats["message_count"]


# ---------------------------------------------------------------------------
# TestComputeRollingWindow
# ---------------------------------------------------------------------------

class TestComputeRollingWindow:
    @pytest.fixture()
    def collection(self):
        client = mongomock.MongoClient()
        return client["ds440_test"]["posts"]

    def test_basic_window(self, collection):
        collection.insert_many([
            _post("TSLA", 0.5, 2, _id="p1"),
            _post("TSLA", 0.3, 4, _id="p2"),
        ])
        result = compute_rolling_window(collection, "TSLA", 5, NOW)
        assert result is not None
        assert result["message_count"] == 2
        assert result["ticker"] == "TSLA"

    def test_excludes_old_posts(self, collection):
        collection.insert_many([
            _post("TSLA", 0.5, 2, _id="p1"),   # within 5m
            _post("TSLA", 0.3, 10, _id="p2"),  # outside 5m
        ])
        result = compute_rolling_window(collection, "TSLA", 5, NOW)
        assert result is not None
        assert result["message_count"] == 1

    def test_excludes_duplicates(self, collection):
        collection.insert_many([
            _post("TSLA", 0.5, 2, _id="p1"),
            _post("TSLA", 0.3, 3, dup=True, _id="p2"),
        ])
        result = compute_rolling_window(collection, "TSLA", 5, NOW)
        assert result is not None
        assert result["message_count"] == 1

    def test_excludes_unscored(self, collection):
        collection.insert_one(_post("TSLA", 0.5, 2, _id="p1"))
        # Insert a post without sentiment_score
        collection.insert_one({
            "_id": "p2",
            "title": "TSLA post",
            "text": "",
            "tickers_mentioned": ["TSLA"],
            "is_duplicate": False,
            "published_at": NOW - timedelta(minutes=3),
        })
        result = compute_rolling_window(collection, "TSLA", 5, NOW)
        assert result is not None
        assert result["message_count"] == 1

    def test_ticker_filtering(self, collection):
        collection.insert_many([
            _post("TSLA", 0.5, 2, _id="p1"),
            _post("AAPL", 0.3, 2, _id="p2"),
        ])
        result = compute_rolling_window(collection, "TSLA", 5, NOW)
        assert result is not None
        assert result["message_count"] == 1

    def test_empty_window(self, collection):
        # No posts at all
        result = compute_rolling_window(collection, "TSLA", 5, NOW)
        assert result is None


# ---------------------------------------------------------------------------
# TestComputeAllWindows
# ---------------------------------------------------------------------------

class TestComputeAllWindows:
    @pytest.fixture()
    def collections(self):
        client = mongomock.MongoClient()
        posts = client["ds440_test"]["posts"]
        windows = client["ds440_test"]["rolling_windows"]
        return posts, windows

    def test_basic_run(self, collections):
        posts_coll, windows_coll = collections
        posts_coll.insert_many([
            _post("TSLA", 0.5, 2, _id="p1"),
            _post("TSLA", 0.3, 4, _id="p2"),
        ])
        count = compute_all_windows(posts_coll, windows_coll, NOW)
        assert count > 0
        assert windows_coll.count_documents({}) > 0

    def test_upsert_overwrites(self, collections):
        posts_coll, windows_coll = collections
        posts_coll.insert_many([
            _post("TSLA", 0.5, 2, _id="p1"),
        ])
        compute_all_windows(posts_coll, windows_coll, NOW)
        first_count = windows_coll.count_documents({})

        # Run again — should upsert, not duplicate
        compute_all_windows(posts_coll, windows_coll, NOW)
        assert windows_coll.count_documents({}) == first_count

    def test_correct_count(self, collections):
        posts_coll, windows_coll = collections
        posts_coll.insert_many([
            _post("TSLA", 0.5, 2, _id="p1"),
        ])
        count = compute_all_windows(posts_coll, windows_coll, NOW)
        # The post is 2 min ago, so it fits in windows: 3, 5, 10, 15, 30, 60
        # (not 1m because 2 min ago > 1 min window)
        assert count >= 1


# ---------------------------------------------------------------------------
# TestGetActiveTickers
# ---------------------------------------------------------------------------

class TestGetActiveTickers:
    @pytest.fixture()
    def collection(self):
        client = mongomock.MongoClient()
        return client["ds440_test"]["posts"]

    def test_finds_tickers(self, collection):
        collection.insert_many([
            _post("TSLA", 0.5, 2, _id="p1"),
            _post("AAPL", 0.3, 3, _id="p2"),
        ])
        since = NOW - timedelta(minutes=60)
        tickers = get_active_tickers(collection, since)
        assert "TSLA" in tickers
        assert "AAPL" in tickers

    def test_excludes_duplicates(self, collection):
        collection.insert_one(_post("TSLA", 0.5, 2, dup=True, _id="p1"))
        since = NOW - timedelta(minutes=60)
        tickers = get_active_tickers(collection, since)
        assert "TSLA" not in tickers


# ---------------------------------------------------------------------------
# TestRealWorldExamples
# ---------------------------------------------------------------------------

class TestRealWorldExamples:
    def test_high_density_ticker(self):
        """Many posts for one ticker should produce valid stats."""
        posts = [{"sentiment_score": 0.3 + (i * 0.01)} for i in range(50)]
        stats = compute_window_stats(posts)
        assert stats["message_count"] == 50
        assert -1.0 <= stats["avg_sentiment"] <= 1.0
        total = stats["bullish_count"] + stats["bearish_count"] + stats["neutral_count"]
        assert total == 50

    def test_mixed_tickers_independent(self):
        """Different tickers should produce independent windows."""
        client = mongomock.MongoClient()
        posts_coll = client["ds440_test"]["posts"]
        windows_coll = client["ds440_test"]["rolling_windows"]

        posts_coll.insert_many([
            _post("TSLA", 0.8, 2, _id="p1"),
            _post("AAPL", -0.5, 2, _id="p2"),
        ])

        compute_all_windows(posts_coll, windows_coll, NOW)

        tsla_5m = windows_coll.find_one({"ticker": "TSLA", "window_minutes": 5})
        aapl_5m = windows_coll.find_one({"ticker": "AAPL", "window_minutes": 5})

        assert tsla_5m is not None
        assert aapl_5m is not None
        assert tsla_5m["avg_sentiment"] > 0
        assert aapl_5m["avg_sentiment"] < 0
