"""D11: PostgreSQL persistence for rolling window history.

Appends computed window snapshots to ``window_history`` so D9 can
render historical sentiment charts.  All functions accept ``None``
as the connection and return gracefully.
"""

from __future__ import annotations

import logging

import psycopg

log = logging.getLogger(__name__)

_CREATE_TABLE = """\
CREATE TABLE IF NOT EXISTS window_history (
    id             BIGSERIAL PRIMARY KEY,
    ticker         VARCHAR(10)  NOT NULL,
    window_minutes SMALLINT     NOT NULL,
    avg_sentiment  REAL         NOT NULL,
    message_count  INTEGER      NOT NULL,
    bullish_count  INTEGER      NOT NULL,
    bearish_count  INTEGER      NOT NULL,
    neutral_count  INTEGER      NOT NULL,
    window_start   TIMESTAMPTZ  NOT NULL,
    window_end     TIMESTAMPTZ  NOT NULL,
    computed_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
"""

_CREATE_INDEX = """\
CREATE INDEX IF NOT EXISTS idx_wh_ticker_window_computed
    ON window_history (ticker, window_minutes, computed_at DESC);
"""

_INSERT = """\
INSERT INTO window_history
    (ticker, window_minutes, avg_sentiment, message_count,
     bullish_count, bearish_count, neutral_count,
     window_start, window_end, computed_at)
VALUES
    (%(ticker)s, %(window_minutes)s, %(avg_sentiment)s, %(message_count)s,
     %(bullish_count)s, %(bearish_count)s, %(neutral_count)s,
     %(window_start)s, %(window_end)s, %(computed_at)s)
"""

_SELECT_HISTORY = """\
SELECT ticker, window_minutes, avg_sentiment, message_count,
       bullish_count, bearish_count, neutral_count,
       window_start, window_end, computed_at
  FROM window_history
 WHERE ticker = %(ticker)s
   AND window_minutes = %(window_minutes)s
   AND computed_at >= NOW() - INTERVAL '%(hours)s hours'
 ORDER BY computed_at DESC
"""


# ---------------------------------------------------------------------------
# Connection
# ---------------------------------------------------------------------------


def get_pg_connection(dsn: str) -> psycopg.Connection | None:
    """Connect to PostgreSQL at *dsn* and return the connection, or ``None``."""
    if not dsn:
        return None
    try:
        conn = psycopg.connect(dsn, autocommit=True)
        conn.execute("SELECT 1")
        log.info("Connected to PostgreSQL")
        return conn
    except Exception:
        log.warning("Failed to connect to PostgreSQL — skipping history sync", exc_info=True)
        return None


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------


def ensure_schema(conn: psycopg.Connection | None) -> None:
    """Create the ``window_history`` table and index if they don't exist."""
    if conn is None:
        return
    conn.execute(_CREATE_TABLE)
    conn.execute(_CREATE_INDEX)
    log.info("PostgreSQL schema ensured")


# ---------------------------------------------------------------------------
# Write
# ---------------------------------------------------------------------------


def append_windows_to_pg(conn: psycopg.Connection | None, docs: list[dict]) -> int:
    """Insert rolling-window documents into ``window_history``.

    Returns the number of rows inserted.
    """
    if conn is None or not docs:
        return 0

    rows = []
    for doc in docs:
        if not doc.get("ticker"):
            continue
        rows.append({
            "ticker": doc["ticker"],
            "window_minutes": doc["window_minutes"],
            "avg_sentiment": doc["avg_sentiment"],
            "message_count": doc["message_count"],
            "bullish_count": doc["bullish_count"],
            "bearish_count": doc["bearish_count"],
            "neutral_count": doc["neutral_count"],
            "window_start": doc["window_start"],
            "window_end": doc["window_end"],
            "computed_at": doc["computed_at"],
        })

    if not rows:
        return 0

    cur = conn.cursor()
    cur.executemany(_INSERT, rows)
    log.info("Appended %d row(s) to window_history", len(rows))
    return len(rows)


# ---------------------------------------------------------------------------
# Read (for D9)
# ---------------------------------------------------------------------------


def get_ticker_history(
    conn: psycopg.Connection | None,
    ticker: str,
    window_minutes: int,
    hours: int = 24,
) -> list[dict]:
    """Return recent window history for a ticker. For D9 charts."""
    if conn is None:
        return []
    cur = conn.execute(
        "SELECT ticker, window_minutes, avg_sentiment, message_count, "
        "bullish_count, bearish_count, neutral_count, "
        "window_start, window_end, computed_at "
        "FROM window_history "
        "WHERE ticker = %s AND window_minutes = %s "
        "AND computed_at >= NOW() - make_interval(hours => %s) "
        "ORDER BY computed_at DESC",
        (ticker, window_minutes, hours),
    )
    cols = [
        "ticker", "window_minutes", "avg_sentiment", "message_count",
        "bullish_count", "bearish_count", "neutral_count",
        "window_start", "window_end", "computed_at",
    ]
    return [dict(zip(cols, row)) for row in cur.fetchall()]
