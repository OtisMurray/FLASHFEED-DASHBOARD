"""
News sentiment sync — Stage 7 of the pipeline.

Reads RSS article sentiment from PostgreSQL (articles table), aggregates
per-ticker scores, and pushes them to Redis under the key:
    news_sentiment:{TICKER}

This makes structured news sentiment available to the Vercel screener
alongside the existing social sentiment data.

Redis hash fields per ticker:
    avg_sentiment  — weighted mean of ml_confidence × direction [-1,+1]
    bullish_count  — number of bullish articles
    bearish_count  — number of bearish articles
    neutral_count  — number of neutral articles
    total_count    — total articles with sentiment
    updated_at     — ISO timestamp

TTL: 4 hours (same as social windows)
"""

from __future__ import annotations

import logging
import time
from datetime import datetime, timezone
from typing import Optional

log = logging.getLogger(__name__)

# How far back to look for articles (seconds)
LOOKBACK_SECONDS = 24 * 3600   # 24 hours


def sync_news_sentiment_to_redis(
    postgres_dsn: str,
    redis_client,
    lookback: int = LOOKBACK_SECONDS,
) -> int:
    """
    Aggregate article sentiment per ticker and push to Redis.
    Returns the number of tickers synced.
    """
    import psycopg

    cutoff = int(time.time()) - lookback

    with psycopg.connect(postgres_dsn) as conn:
        rows = conn.execute(
            """
            SELECT
                unnest(string_to_array(ticker, ',')) AS t,
                sentiment,
                ml_confidence
            FROM articles
            WHERE sentiment IS NOT NULL
              AND ticker IS NOT NULL
              AND ticker != ''
              AND COALESCE(publish_date, fetched_date) >= %s
            """,
            (cutoff,),
        ).fetchall()

    if not rows:
        log.info("No scored articles with tickers in the last %dh", lookback // 3600)
        return 0

    # Aggregate per ticker
    from collections import defaultdict
    ticker_data: dict[str, dict] = defaultdict(lambda: {
        "bullish": 0, "bearish": 0, "neutral": 0,
        "score_sum": 0.0, "count": 0,
    })

    for ticker_raw, sentiment, confidence in rows:
        ticker = (ticker_raw or "").strip().upper()
        if not ticker:
            continue

        td = ticker_data[ticker]
        td[sentiment] = td.get(sentiment, 0) + 1
        td["count"] += 1

        # Direction-weighted score: bullish=+1, bearish=-1, neutral=0
        direction = 1.0 if sentiment == "bullish" else (-1.0 if sentiment == "bearish" else 0.0)
        weight = float(confidence) if confidence is not None else 0.5
        td["score_sum"] += direction * weight

    now_iso = datetime.now(timezone.utc).isoformat()
    synced = 0

    for ticker, td in ticker_data.items():
        if td["count"] == 0:
            continue
        avg = round(td["score_sum"] / td["count"], 4)

        try:
            key = f"news_sentiment:{ticker}"
            redis_client.hset(key, mapping={
                "avg_sentiment": str(avg),
                "bullish_count": str(td["bullish"]),
                "bearish_count": str(td["bearish"]),
                "neutral_count": str(td["neutral"]),
                "total_count":   str(td["count"]),
                "updated_at":    now_iso,
            })
            redis_client.expire(key, 4 * 3600)
            synced += 1
        except Exception as exc:
            log.warning("Redis write failed for %s: %s", ticker, exc)

    log.info("News sentiment sync complete — %d tickers pushed to Redis", synced)
    return synced
