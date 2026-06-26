"""
Best-effort Kafka publisher for fetched news/social rows.

This is intentionally additive: MongoDB writes remain the source of truth, and
fetchers keep succeeding if Kafka is down or confluent-kafka is unavailable.
When enabled with KAFKA_PUBLISH_NEWS=true, the Kafka consumer can fan these
events into Redis so the dashboard has a hot RAM feed per ticker.
"""

from __future__ import annotations

import hashlib
import os
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

_MAX_TICKERS_PER_ARTICLE = max(1, int(os.getenv("KAFKA_NEWS_MAX_TICKERS", "500")))
_PRODUCER = None


def _to_iso(value) -> str:
    if value is None or value == "":
        return datetime.now(timezone.utc).isoformat()
    try:
        n = float(value)
        if n > 1e12:
            n /= 1000.0
        return datetime.fromtimestamp(n, tz=timezone.utc).isoformat()
    except (TypeError, ValueError):
        pass
    text = str(value).strip().replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(text).astimezone(timezone.utc).isoformat()
    except ValueError:
        return datetime.now(timezone.utc).isoformat()


def _sentiment_score(doc: dict) -> float:
    label = str(doc.get("sentiment", "")).lower()
    if "bull" in label or "positive" in label:
        direction = 1.0
    elif "bear" in label or "negative" in label:
        direction = -1.0
    else:
        direction = 0.0
    try:
        confidence = float(doc.get("ml_confidence", 0) or 0)
    except (TypeError, ValueError):
        confidence = 0.0
    return round(direction * confidence, 4) if confidence else direction


def _tickers(doc: dict) -> list[str]:
    raw_values = []
    if isinstance(doc.get("tickers"), list):
        raw_values.extend(doc.get("tickers") or [])
    if isinstance(doc.get("tickers_mentioned"), list):
        raw_values.extend(doc.get("tickers_mentioned") or [])
    raw_values.extend(str(doc.get("ticker", "") or "").split(","))

    seen: set[str] = set()
    out: list[str] = []
    for value in raw_values:
        ticker = str(value or "").strip().upper()
        if not ticker or ticker in seen:
            continue
        seen.add(ticker)
        out.append(ticker)
        if len(out) >= _MAX_TICKERS_PER_ARTICLE:
            break
    return out


def article_to_event_dict(doc: dict, ticker: str) -> dict:
    url = str(doc.get("url", "") or "")
    title = str(doc.get("title", "") or "")
    seed = url or doc.get("article_id") or title
    event_id = "news:" + hashlib.sha1(f"{seed}:{ticker}".encode("utf-8")).hexdigest()[:16]
    return {
        "event_id": event_id,
        "user_id": ticker,
        "event_type": "news",
        "timestamp": _to_iso(doc.get("publish_date") or doc.get("fetched_date") or doc.get("detected_at")),
        "payload": {
            "ticker": ticker,
            "title": title,
            "source": doc.get("source", ""),
            "url": url,
            "sentiment": doc.get("sentiment", "neutral"),
            "sentiment_score": _sentiment_score(doc),
            "event_type": doc.get("event_type", "general_news"),
            "company": doc.get("company", ""),
            "category": doc.get("category", ""),
            "publish_date": doc.get("publish_date"),
            "detected_at": doc.get("detected_at"),
        },
    }


def social_to_event_dict(doc: dict, ticker: str) -> dict:
    sid = str(doc.get("id") or doc.get("url") or doc.get("_id") or "")
    event_id = "social:" + hashlib.sha1(f"{sid}:{ticker}".encode("utf-8")).hexdigest()[:16]
    text = doc.get("text") or doc.get("content") or doc.get("title") or ""
    try:
        score = float(doc.get("sentiment_score"))
    except (TypeError, ValueError):
        score = _sentiment_score(doc)
    return {
        "event_id": event_id,
        "user_id": ticker,
        "event_type": "social",
        "timestamp": _to_iso(doc.get("created_at") or doc.get("timestamp") or doc.get("fetched_at")),
        "payload": {
            "ticker": ticker,
            "platform": doc.get("platform", "Social"),
            "author": doc.get("author", ""),
            "text": str(text)[:1000],
            "url": doc.get("url", ""),
            "sentiment": doc.get("sentiment", "neutral"),
            "sentiment_score": round(score, 4),
            "message_density": doc.get("message_density"),
            "source": doc.get("source", doc.get("platform", "")),
        },
    }


def _get_producer():
    global _PRODUCER
    if _PRODUCER is None:
        from producer import FlashFeedProducer

        _PRODUCER = FlashFeedProducer()
    return _PRODUCER


def _article_events(docs):
    from models import FeedEvent

    for doc in docs or []:
        for ticker in _tickers(doc):
            yield FeedEvent(**article_to_event_dict(doc, ticker))


def _social_events(docs):
    from models import FeedEvent

    for doc in docs or []:
        for ticker in _tickers(doc):
            yield FeedEvent(**social_to_event_dict(doc, ticker))


def publish_articles(docs) -> int:
    events = list(_article_events(docs))
    if not events:
        return 0
    producer = _get_producer()
    for event in events:
        producer.send(event)
    producer.flush(5)
    return len(events)


def publish_social(docs) -> int:
    events = list(_social_events(docs))
    if not events:
        return 0
    producer = _get_producer()
    for event in events:
        producer.send(event)
    producer.flush(5)
    return len(events)


if __name__ == "__main__":
    sample = {
        "url": "https://example.com/story",
        "ticker": "AAPL,MSFT",
        "title": "Sample story",
        "source": "Smoke Test",
        "sentiment": "bullish",
        "ml_confidence": 0.8,
        "publish_date": 1749900000,
    }
    for ticker in _tickers(sample):
        print(article_to_event_dict(sample, ticker))
