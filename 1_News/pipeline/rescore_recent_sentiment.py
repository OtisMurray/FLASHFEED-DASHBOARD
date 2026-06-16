#!/usr/bin/env python3
"""Rescore recent Mongo articles/social posts with the shared sentiment scorer."""

from __future__ import annotations

import os
import time

from pymongo import MongoClient, UpdateOne

from sentiment_utils import classify_financial_event, score_financial_sentiment, score_social_sentiment


MONGODB_URI = os.getenv("MONGODB_URI", "mongodb://localhost:27017/feedflash")
DB_NAME = os.getenv("MONGODB_DB", os.getenv("MONGO_DB", "feedflash"))
DAYS = int(os.getenv("RESCORE_SENTIMENT_DAYS", "3"))
LIMIT = int(os.getenv("RESCORE_SENTIMENT_LIMIT", "5000"))


def recent_filter() -> dict:
    cutoff = int(time.time()) - DAYS * 86_400
    return {
        "$or": [
            {"publish_date": {"$gte": cutoff}},
            {"fetched_date": {"$gte": cutoff}},
            {"detected_at": {"$gte": cutoff}},
            {"fetched_at": {"$gte": cutoff}},
            {"timestamp": {"$gte": cutoff}},
            {"created_at": {"$gte": cutoff}},
        ]
    }


def rescore_articles(db) -> int:
    ops = []
    cursor = db.articles.find(
        recent_filter(),
        {"_id": 1, "title": 1, "content": 1},
        limit=LIMIT,
    )
    now = int(time.time())
    for doc in cursor:
        title = doc.get("title", "")
        content = doc.get("content", "")
        label, confidence = score_financial_sentiment(title, content)
        event_type, event_score, event_reason = classify_financial_event(title, content)
        ops.append(UpdateOne(
            {"_id": doc["_id"]},
            {"$set": {
                "sentiment": label,
                "ml_confidence": confidence,
                "sentiment_score": confidence if label == "bullish" else -confidence if label == "bearish" else 0,
                "sentiment_method": "shared_financial_phrase_v2",
                "sentiment_at": now if label != "neutral" else None,
                "event_type": event_type,
                "event_score": event_score,
                "sentiment_reason": event_reason,
            }},
        ))
    if not ops:
        return 0
    result = db.articles.bulk_write(ops, ordered=False)
    return result.modified_count


def rescore_socials(db) -> int:
    ops = []
    cursor = db.socials.find(
        recent_filter(),
        {"_id": 1, "title": 1, "text": 1, "content": 1, "sentiment": 1, "platform": 1},
        limit=LIMIT,
    )
    now = int(time.time())
    for doc in cursor:
        platform = str(doc.get("platform") or "").lower()
        current = str(doc.get("sentiment") or "").lower()
        if "stocktwits" in platform and current in {"bullish", "bearish"}:
            score = 1.0 if current == "bullish" else -1.0
            label = current
        else:
            text = doc.get("text") or doc.get("title") or doc.get("content") or ""
            label, score = score_social_sentiment(text)
        ops.append(UpdateOne(
            {"_id": doc["_id"]},
            {"$set": {
                "sentiment": label,
                "sentiment_score": score,
                "sentiment_method": "shared_financial_phrase_v2",
                "sentiment_at": now if label != "neutral" else None,
            }},
        ))
    if not ops:
        return 0
    result = db.socials.bulk_write(ops, ordered=False)
    return result.modified_count


def main() -> None:
    client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=5000)
    db = client[DB_NAME]
    article_count = rescore_articles(db)
    social_count = rescore_socials(db)
    print(f"rescored articles={article_count} socials={social_count} days={DAYS}")
    client.close()


if __name__ == "__main__":
    main()
