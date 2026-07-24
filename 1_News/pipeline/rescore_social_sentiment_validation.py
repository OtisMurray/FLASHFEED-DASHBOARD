"""Backfill continuous validated sentiment fields on stored social posts."""

from __future__ import annotations

import os
import time
from datetime import datetime, timezone

from pymongo import MongoClient, UpdateOne

from sentiment_utils import audit_social_sentiment


MONGODB_URI = os.getenv("MONGODB_URI", "mongodb://localhost:27017/feedflash")
DB_NAME = os.getenv("MONGODB_DB", os.getenv("MONGO_DB", "feedflash"))
BATCH_SIZE = max(50, int(os.getenv("SOCIAL_RESCORE_BATCH_SIZE", "500")))
LIMIT = max(0, int(os.getenv("SOCIAL_RESCORE_LIMIT", "0")))
WINDOW_DAYS = max(0, int(os.getenv("SOCIAL_RESCORE_WINDOW_DAYS", "30")))
METHOD = "financial_social_validation_v1"


def _text(doc: dict) -> str:
    return str(doc.get("text") or doc.get("content") or doc.get("title") or "").strip()


def _source_sentiment(doc: dict) -> tuple[str | None, float | None]:
    source_label = doc.get("source_sentiment")
    source_score = doc.get("source_sentiment_score")
    platform = str(doc.get("platform") or doc.get("source") or "").lower()
    current_label = str(doc.get("sentiment") or "").lower()
    if not source_label and "stocktwits" in platform and current_label in {"bullish", "bearish", "neutral"}:
        source_label = current_label
    if source_score is None and source_label:
        source_score = 0.58 if str(source_label).lower() == "bullish" else -0.58 if str(source_label).lower() == "bearish" else 0.0
    try:
        source_score = float(source_score) if source_score is not None else None
    except (TypeError, ValueError):
        source_score = None
    return (str(source_label).lower() if source_label else None), source_score


def _time_filter() -> dict:
    if WINDOW_DAYS <= 0:
        return {}
    since_sec = int(time.time()) - WINDOW_DAYS * 86400
    since_dt = datetime.fromtimestamp(since_sec, tz=timezone.utc)
    return {
        "$or": [
            {"created_at": {"$gte": since_sec}},
            {"timestamp": {"$gte": since_sec}},
            {"fetched_at": {"$gte": since_sec}},
            {"createdAt": {"$gte": since_dt}},
            {"created_at": {"$gte": since_dt}},
        ]
    }


def main() -> None:
    client = MongoClient(MONGODB_URI)
    db = client[DB_NAME]
    socials = db.socials

    query = _time_filter()
    projection = {
        "text": 1,
        "content": 1,
        "title": 1,
        "platform": 1,
        "source": 1,
        "sentiment": 1,
        "sentiment_score": 1,
        "source_sentiment": 1,
        "source_sentiment_score": 1,
    }
    cursor = socials.find(query, projection=projection).sort([("fetched_at", -1), ("created_at", -1)])
    if LIMIT:
        cursor = cursor.limit(LIMIT)

    updates: list[UpdateOne] = []
    scanned = changed = 0
    for doc in cursor:
        body = _text(doc)
        if not body:
            continue
        source_label, source_score = _source_sentiment(doc)
        audit = audit_social_sentiment(body, source_sentiment=source_label, source_score=source_score)
        scanned += 1
        update = {
            "sentiment": audit["label"],
            "sentiment_score": audit["score"],
            "sentiment_validation": audit,
        }
        if source_label:
            update["source_sentiment"] = source_label
            update["source_sentiment_score"] = source_score
        updates.append(UpdateOne({"_id": doc["_id"]}, {"$set": update}))

        if len(updates) >= BATCH_SIZE:
            result = socials.bulk_write(updates, ordered=False)
            changed += result.modified_count + result.upserted_count
            updates = []

    if updates:
        result = socials.bulk_write(updates, ordered=False)
        changed += result.modified_count + result.upserted_count

    print(f"Social sentiment validation {METHOD}: scanned={scanned} changed={changed} window_days={WINDOW_DAYS} limit={LIMIT or 'all'}")


if __name__ == "__main__":
    main()
