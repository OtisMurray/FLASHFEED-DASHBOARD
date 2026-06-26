"""Tests for processing.redis_cache (D11)."""

from datetime import datetime, timezone

import fakeredis
import pytest

from processing.redis_cache import (
    format_window_for_redis,
    get_active_tickers_from_redis,
    get_window_from_redis,
    sync_windows_to_redis,
    window_key,
)


@pytest.fixture()
def fake_redis():
    return fakeredis.FakeRedis(decode_responses=True)


# -- sample data -----------------------------------------------------------

def _make_doc(ticker="TSLA", minutes=5, count=10, sentiment=0.42):
    now = datetime(2026, 3, 27, 12, 0, 0, tzinfo=timezone.utc)
    return {
        "ticker": ticker,
        "window_minutes": minutes,
        "avg_sentiment": sentiment,
        "message_count": count,
        "bullish_count": 6,
        "bearish_count": 2,
        "neutral_count": 2,
        "window_start": now,
        "window_end": now,
        "computed_at": now,
    }


# ===========================================================================
# TestWindowKey
# ===========================================================================

class TestWindowKey:
    def test_basic(self):
        assert window_key("TSLA", 5) == "window:TSLA:5"

    def test_60_minute(self):
        assert window_key("AAPL", 60) == "window:AAPL:60"


# ===========================================================================
# TestFormatWindowForRedis
# ===========================================================================

class TestFormatWindowForRedis:
    def test_all_fields(self):
        doc = _make_doc()
        result = format_window_for_redis(doc)
        assert result["ticker"] == "TSLA"
        assert result["avg_sentiment"] == "0.42"
        assert result["message_count"] == "10"
        assert "window_start" in result

    def test_empty_doc(self):
        assert format_window_for_redis({}) == {}

    def test_missing_optional_fields(self):
        doc = {"ticker": "GME", "avg_sentiment": 0.1}
        result = format_window_for_redis(doc)
        assert result["ticker"] == "GME"
        assert "message_count" not in result


# ===========================================================================
# TestSyncWindowsToRedis
# ===========================================================================

class TestSyncWindowsToRedis:
    def test_basic_sync(self, fake_redis):
        docs = [_make_doc("TSLA", 5), _make_doc("AAPL", 5)]
        count = sync_windows_to_redis(fake_redis, docs)
        assert count == 2

    def test_hash_fields_correct(self, fake_redis):
        docs = [_make_doc("TSLA", 5)]
        sync_windows_to_redis(fake_redis, docs)
        data = fake_redis.hgetall("window:TSLA:5")
        assert data["ticker"] == "TSLA"
        assert data["avg_sentiment"] == "0.42"
        assert data["message_count"] == "10"

    def test_active_tickers_from_60m(self, fake_redis):
        docs = [_make_doc("TSLA", 60, count=20), _make_doc("AAPL", 60, count=5)]
        sync_windows_to_redis(fake_redis, docs)
        members = fake_redis.zrevrange("active_tickers", 0, -1, withscores=True)
        assert len(members) == 2
        # TSLA should be first (higher count)
        assert members[0][0] == "TSLA"

    def test_ttl_set(self, fake_redis):
        docs = [_make_doc("TSLA", 5)]
        sync_windows_to_redis(fake_redis, docs, ttl=1800)
        ttl = fake_redis.ttl("window:TSLA:5")
        assert 0 < ttl <= 1800

    def test_none_client_returns_zero(self):
        assert sync_windows_to_redis(None, [_make_doc()]) == 0

    def test_empty_docs(self, fake_redis):
        assert sync_windows_to_redis(fake_redis, []) == 0


# ===========================================================================
# TestGetWindowFromRedis
# ===========================================================================

class TestGetWindowFromRedis:
    def test_round_trip(self, fake_redis):
        docs = [_make_doc("TSLA", 5)]
        sync_windows_to_redis(fake_redis, docs)
        result = get_window_from_redis(fake_redis, "TSLA", 5)
        assert result is not None
        assert result["ticker"] == "TSLA"

    def test_missing_key_returns_none(self, fake_redis):
        assert get_window_from_redis(fake_redis, "ZZZZ", 5) is None

    def test_none_client_returns_none(self):
        assert get_window_from_redis(None, "TSLA", 5) is None


# ===========================================================================
# TestGetActiveTickersFromRedis
# ===========================================================================

class TestGetActiveTickersFromRedis:
    def test_sorted_by_score(self, fake_redis):
        docs = [
            _make_doc("TSLA", 60, count=20),
            _make_doc("AAPL", 60, count=50),
            _make_doc("GME", 60, count=10),
        ]
        sync_windows_to_redis(fake_redis, docs)
        result = get_active_tickers_from_redis(fake_redis)
        assert result[0][0] == "AAPL"
        assert result[1][0] == "TSLA"
        assert result[2][0] == "GME"

    def test_respects_limit(self, fake_redis):
        docs = [
            _make_doc("TSLA", 60, count=20),
            _make_doc("AAPL", 60, count=50),
            _make_doc("GME", 60, count=10),
        ]
        sync_windows_to_redis(fake_redis, docs)
        result = get_active_tickers_from_redis(fake_redis, limit=2)
        assert len(result) == 2

    def test_none_client_returns_empty(self):
        assert get_active_tickers_from_redis(None) == []
