#!/usr/bin/env python3
"""
correlation_tracker.py — Fetch stock prices around article publish time and
compare the sentiment prediction to actual price movement.

Usage: python3 correlation_tracker.py <path/to/feedflash.db>

Columns written back to articles:
  price_at             REAL  — price at the time the article was published
  price_after_1h       REAL  — price 1 hour later
  price_after_24h      REAL  — price 24 hours later
  prediction_correct_1h  INTEGER  — 1 if correct, 0 if wrong
  prediction_correct_24h INTEGER  — 1 if correct, 0 if wrong

Accuracy rule:
  bullish  → correct if price_after > price_at
  bearish  → correct if price_after < price_at
  neutral  → always marked 1 (no directional prediction)
"""

import sys
import sqlite3
import time
import datetime
from typing import Optional

try:
    import yfinance as yf
except ImportError:
    print("ERROR: yfinance not installed. Run: pip3 install yfinance")
    sys.exit(1)


# ── Helpers ────────────────────────────────────────────────────────────────────

def _fetch_bars(ticker: str, ts: int, window_minutes: int = 70) -> "Optional[object]":
    """Fetch 1-minute bars covering `ts` ± some window. Returns DataFrame or None."""
    try:
        dt    = datetime.datetime.fromtimestamp(ts, tz=datetime.timezone.utc)
        start = dt - datetime.timedelta(minutes=5)
        end   = dt + datetime.timedelta(minutes=window_minutes)
        hist  = yf.Ticker(ticker).history(start=start, end=end, interval="1m", auto_adjust=True)
        if hist.empty:
            return None
        hist.index = hist.index.tz_convert("UTC")
        return hist
    except Exception as e:
        print(f"  WARN fetch_bars {ticker}: {e}")
        return None


def _nearest_price(hist, ts: int) -> Optional[float]:
    """Return Close price from bar nearest to `ts` (max 90-min tolerance)."""
    if hist is None or hist.empty:
        return None
    dt      = datetime.datetime.fromtimestamp(ts, tz=datetime.timezone.utc)
    idx     = abs(hist.index - dt)
    closest = hist.index[idx.argmin()]
    if idx.min().total_seconds() > 5400:  # >90 min away → no data
        return None
    price = float(hist.loc[closest, "Close"])
    return price if price > 0 else None


def _get_price_at(ticker: str, ts: int) -> Optional[float]:
    """Return the closing price of the 1-minute bar closest to `ts`."""
    hist = _fetch_bars(ticker, ts, window_minutes=70)
    return _nearest_price(hist, ts)


def _get_price_after(ticker: str, ts: int, offset_seconds: int) -> Optional[float]:
    """Return price `offset_seconds` after `ts`; fetches a fresh window."""
    target = ts + offset_seconds
    hist = _fetch_bars(ticker, target, window_minutes=30)
    return _nearest_price(hist, target)


def _is_correct(sentiment: str, price_at: float, price_after: float) -> int:
    """1 = prediction correct, 0 = wrong."""
    if sentiment == "neutral":
        return 1
    change = price_after - price_at
    if sentiment == "bullish":
        return 1 if change > 0 else 0
    if sentiment == "bearish":
        return 1 if change < 0 else 0
    return 1  # unknown label


# ── Main ───────────────────────────────────────────────────────────────────────

def run(db_path: str, batch: int = 50, delay: float = 1.5):
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row

    # Rows that need price data (have ticker + sentiment, no price_at yet)
    rows = con.execute("""
        SELECT id, ticker, sentiment, publish_date, fetched_date
        FROM articles
        WHERE ticker IS NOT NULL
          AND ticker != ''
          AND length(ticker) <= 5
          AND instr(ticker, ',') = 0
          AND sentiment IN ('bullish', 'bearish', 'neutral')
          AND price_at IS NULL
        ORDER BY publish_date DESC
        LIMIT ?
    """, (batch,)).fetchall()

    if not rows:
        print("Nothing to process — all articles already have price data.")
        con.close()
        return

    print(f"Processing {len(rows)} articles …")
    updated = 0
    skipped = 0

    for row in rows:
        article_id = row["id"]
        ticker     = row["ticker"].split(",")[0].strip().upper()  # first ticker if multiple
        sentiment  = row["sentiment"]
        ts         = row["publish_date"] or row["fetched_date"]

        if not ts or not ticker:
            skipped += 1
            continue

        # Skip articles older than 30 days (yfinance intraday data only covers ~60 days)
        age_days = (time.time() - ts) / 86400
        if age_days > 30:
            # Mark as N/A by storing -1 so we skip them next time too
            con.execute("""
                UPDATE articles SET price_at = -1 WHERE id = ?
            """, (article_id,))
            skipped += 1
            continue

        print(f"  {ticker:6s} | {sentiment:7s} | {datetime.datetime.fromtimestamp(ts).strftime('%Y-%m-%d %H:%M')}", end=" … ", flush=True)

        price_at = _get_price_at(ticker, ts)
        if price_at is None:
            print("no price data")
            con.execute("UPDATE articles SET price_at = -1 WHERE id = ?", (article_id,))
            skipped += 1
            time.sleep(delay)
            continue

        price_1h  = _get_price_after(ticker, ts, 3600)
        price_24h = _get_price_after(ticker, ts, 86400)

        correct_1h  = _is_correct(sentiment, price_at, price_1h)  if price_1h  else None
        correct_24h = _is_correct(sentiment, price_at, price_24h) if price_24h else None

        move_1h  = f"{(price_1h  - price_at) / price_at * 100:+.2f}%" if price_1h  else "—"
        move_24h = f"{(price_24h - price_at) / price_at * 100:+.2f}%" if price_24h else "—"

        print(f"${price_at:.2f} | 1h:{move_1h} {'✓' if correct_1h else '✗'} | 24h:{move_24h} {'✓' if correct_24h else '✗'}")

        con.execute("""
            UPDATE articles SET
              price_at             = ?,
              price_after_1h       = ?,
              price_after_24h      = ?,
              prediction_correct_1h  = ?,
              prediction_correct_24h = ?
            WHERE id = ?
        """, (price_at, price_1h, price_24h, correct_1h, correct_24h, article_id))

        updated += 1
        con.commit()
        time.sleep(delay)  # rate-limit yfinance calls

    con.commit()
    con.close()

    # Print summary
    total_with_data = updated
    print(f"\nDone. Updated={updated}, Skipped={skipped}")

    # Overall accuracy (from entire DB, not just this batch)
    con2 = sqlite3.connect(db_path)
    stats = con2.execute("""
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN prediction_correct_1h  = 1 THEN 1 ELSE 0 END) as ok_1h,
          SUM(CASE WHEN prediction_correct_24h = 1 THEN 1 ELSE 0 END) as ok_24h
        FROM articles
        WHERE prediction_correct_1h IS NOT NULL
    """).fetchone()
    con2.close()

    if stats and stats[0] > 0:
        total = stats[0]
        print(f"\nOverall accuracy ({total} articles with price data):")
        print(f"  1h  prediction: {stats[1]}/{total} = {stats[1]/total*100:.1f}% correct")
        print(f"  24h prediction: {stats[2]}/{total} = {stats[2]/total*100:.1f}% correct")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(f"Usage: python3 {sys.argv[0]} <path/to/feedflash.db> [batch_size]")
        sys.exit(1)
    db   = sys.argv[1]
    size = int(sys.argv[2]) if len(sys.argv) > 2 else 50
    run(db, batch=size)
