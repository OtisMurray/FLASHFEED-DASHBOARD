"""Tests for processing.pg_store (D11)."""

from datetime import datetime, timezone
from unittest.mock import MagicMock, call

from processing.pg_store import append_windows_to_pg


def _make_doc(ticker="TSLA", minutes=5):
    now = datetime(2026, 3, 27, 12, 0, 0, tzinfo=timezone.utc)
    return {
        "ticker": ticker,
        "window_minutes": minutes,
        "avg_sentiment": 0.42,
        "message_count": 10,
        "bullish_count": 6,
        "bearish_count": 2,
        "neutral_count": 2,
        "window_start": now,
        "window_end": now,
        "computed_at": now,
    }


class TestAppendWindowsToPg:
    def test_basic_insert(self):
        conn = MagicMock()
        cursor = MagicMock()
        conn.cursor.return_value = cursor

        docs = [_make_doc("TSLA", 5)]
        count = append_windows_to_pg(conn, docs)

        assert count == 1
        cursor.executemany.assert_called_once()
        sql, params = cursor.executemany.call_args[0]
        assert "INSERT INTO window_history" in sql
        assert len(params) == 1

    def test_none_conn_returns_zero(self):
        assert append_windows_to_pg(None, [_make_doc()]) == 0

    def test_empty_docs_returns_zero(self):
        conn = MagicMock()
        assert append_windows_to_pg(conn, []) == 0

    def test_skips_docs_without_ticker(self):
        conn = MagicMock()
        cursor = MagicMock()
        conn.cursor.return_value = cursor

        docs = [{"window_minutes": 5, "avg_sentiment": 0.1}]
        count = append_windows_to_pg(conn, docs)
        assert count == 0

    def test_row_values_correct(self):
        conn = MagicMock()
        cursor = MagicMock()
        conn.cursor.return_value = cursor

        doc = _make_doc("AAPL", 15)
        append_windows_to_pg(conn, [doc])

        _, params = cursor.executemany.call_args[0]
        row = params[0]
        assert row["ticker"] == "AAPL"
        assert row["window_minutes"] == 15
        assert row["avg_sentiment"] == 0.42
        assert row["message_count"] == 10
