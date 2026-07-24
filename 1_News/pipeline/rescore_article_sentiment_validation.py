"""Backfill deterministic financial sentiment fields on stored articles."""

from __future__ import annotations

import os
import time
from datetime import datetime, timezone

from pymongo import MongoClient, UpdateOne

from sentiment_utils import classify_financial_event, score_financial_sentiment, signed_sentiment_score


MONGODB_URI = os.getenv("MONGODB_URI", "mongodb://localhost:27017/feedflash")
DB_NAME = os.getenv("MONGODB_DB", os.getenv("MONGO_DB", "feedflash"))
BATCH_SIZE = max(50, int(os.getenv("ARTICLE_RESCORE_BATCH_SIZE", "500")))
LIMIT = max(0, int(os.getenv("ARTICLE_RESCORE_LIMIT", "0")))
WINDOW_DAYS = max(0, int(os.getenv("ARTICLE_RESCORE_WINDOW_DAYS", "30")))
METHOD = "shared_financial_phrase_v4"


def _time_filter() -> dict:
    if WINDOW_DAYS <= 0:
        return {}
    since_sec = int(time.time()) - WINDOW_DAYS * 86400
    since_dt = datetime.fromtimestamp(since_sec, tz=timezone.utc)
    return {
        "$or": [
            {"publish_date": {"$gte": since_sec}},
            {"fetched_date": {"$gte": since_sec}},
            {"detected_at": {"$gte": since_sec}},
            {"fetched_at": {"$gte": since_sec}},
            {"createdAt": {"$gte": since_dt}},
            {"created_at": {"$gte": since_dt}},
        ]
    }


def _body(doc: dict) -> str:
    parts = [
        str(doc.get("summary") or ""),
        str(doc.get("content") or ""),
        str(doc.get("description") or ""),
    ]
    return " ".join(part.strip() for part in parts if part.strip())


def main() -> None:
    client = MongoClient(MONGODB_URI)
    db = client[DB_NAME]
    articles = db.articles

    projection = {
        "title": 1,
        "content": 1,
        "description": 1,
        "summary": 1,
    }
    cursor = articles.find(_time_filter(), projection=projection).sort(
        [("publish_date", -1), ("fetched_date", -1), ("detected_at", -1)]
    )
    if LIMIT:
        cursor = cursor.limit(LIMIT)

    updates: list[UpdateOne] = []
    scanned = changed = 0
    now = int(time.time())
    for doc in cursor:
        title = str(doc.get("title") or "").strip()
        body = _body(doc)
        if not title and not body:
            continue
        label, confidence = score_financial_sentiment(title, body)
        event_type, event_score, event_reason = classify_financial_event(title, body)
        score = signed_sentiment_score(label, confidence)
        scanned += 1
        updates.append(UpdateOne(
            {"_id": doc["_id"]},
            {"$set": {
                "sentiment": label,
                "ml_confidence": confidence,
                "sentiment_score": score,
                "sentiment_method": METHOD,
                "sentiment_at": now if label != "neutral" else None,
                "event_type": event_type,
                "event_score": event_score,
                "sentiment_reason": event_reason,
            }},
        ))

        if len(updates) >= BATCH_SIZE:
            result = articles.bulk_write(updates, ordered=False)
            changed += result.modified_count + result.upserted_count
            updates = []

    if updates:
        result = articles.bulk_write(updates, ordered=False)
        changed += result.modified_count + result.upserted_count

    print(f"Article sentiment validation {METHOD}: scanned={scanned} changed={changed} window_days={WINDOW_DAYS} limit={LIMIT or 'all'}")
    client.close()


if __name__ == "__main__":
    main()
