"""
DROP-IN REPLACEMENT for social_pipeline/scrapers/db.py
=======================================================

WHAT THIS FIXES:
  The original db.py is a shim that routes posts into SQLite via a
  temporary 'db_sqlite' module.  That means scraped posts never reach
  MongoDB — so the production dashboard shows 0 articles.

  This file replaces it completely.  It writes posts to:
    1. MongoDB (ds440.posts)  — persistent source of truth
    2. Kafka topic            — so consumer.py can fan out to Redis

HOW TO INSTALL:
  1. Copy this file to: social_pipeline/scrapers/db.py
     (overwrite the original)
  2. Make sure your .env has:
       MONGO_URI=mongodb://localhost:27017  (or your Atlas URI)
       MONGO_DB=ds440
       MONGO_COLLECTION=posts
       KAFKA_BOOTSTRAP_SERVERS=localhost:9092   (or your broker)

Everything else in your project (reddit.py, bluesky.py, run_pipeline.py)
calls get_client(), get_collection(), and upsert_posts() — all of those
still work exactly the same way, they just now go to real MongoDB.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any

from dotenv import load_dotenv
from pymongo import MongoClient, UpdateOne
from pymongo.errors import BulkWriteError

# ── Try to import Kafka producer (optional — scraping still works without it) ──
try:
    from confluent_kafka import Producer as KafkaProducer
    _KAFKA_AVAILABLE = True
except ImportError:
    _KAFKA_AVAILABLE = False

load_dotenv()

log = logging.getLogger(__name__)

# ── Config ────────────────────────────────────────────────────────────────────
MONGO_URI        = os.getenv("MONGO_URI", "mongodb://localhost:27017")
MONGO_DB         = os.getenv("MONGO_DB", "ds440")
MONGO_COLLECTION = os.getenv("MONGO_COLLECTION", "posts")
KAFKA_SERVERS    = os.getenv("KAFKA_BOOTSTRAP_SERVERS", "localhost:9092")
KAFKA_TOPIC      = os.getenv("KAFKA_TOPIC", "flashfeed-events")

# ── Singletons ────────────────────────────────────────────────────────────────
_mongo_client: MongoClient | None = None
_kafka_producer = None


# ── MongoDB helpers ───────────────────────────────────────────────────────────

def get_client() -> MongoClient:
    """Return a cached MongoClient."""
    global _mongo_client
    if _mongo_client is None:
        _mongo_client = MongoClient(MONGO_URI, serverSelectionTimeoutMS=5_000)
        log.info("Connected to MongoDB at %s/%s", MONGO_URI, MONGO_DB)
    return _mongo_client


def get_collection(client: MongoClient | None = None):
    """Return the posts collection."""
    if client is None:
        client = get_client()
    return client[MONGO_DB][MONGO_COLLECTION]


def _ensure_indexes(collection) -> None:
    """Create indexes once on first use."""
    collection.create_index("id", unique=True, sparse=True)
    collection.create_index("source")
    collection.create_index("publish_date")
    collection.create_index("ticker", sparse=True)


# ── Kafka helper ──────────────────────────────────────────────────────────────

def _get_kafka_producer():
    """Return a cached Kafka producer, or None if Kafka isn't available."""
    global _kafka_producer
    if not _KAFKA_AVAILABLE:
        return None
    if _kafka_producer is None:
        try:
            _kafka_producer = KafkaProducer({
                "bootstrap.servers": KAFKA_SERVERS,
                "linger.ms": 10,
                "acks": "1",
            })
            log.info("Kafka producer connected to %s", KAFKA_SERVERS)
        except Exception as exc:
            log.warning("Kafka not available (%s) — skipping event publishing", exc)
    return _kafka_producer


def _publish_to_kafka(posts: list[dict]) -> None:
    """Fire-and-forget: publish each post to the Kafka topic."""
    producer = _get_kafka_producer()
    if producer is None:
        return
    for post in posts:
        try:
            producer.produce(
                topic=KAFKA_TOPIC,
                key=str(post.get("id", "")).encode(),
                value=json.dumps(post, default=str).encode(),
            )
        except Exception as exc:
            log.debug("Kafka produce error: %s", exc)
    producer.poll(0)


# ── Main write function ───────────────────────────────────────────────────────

def upsert_posts(collection_or_engine, posts: list[dict[str, Any]]) -> int:
    """
    Write posts to MongoDB (upsert on 'id') and publish to Kafka.

    Accepts the collection directly OR the legacy engine argument from the
    old SQLite shim — it will resolve to the real collection either way.
    """
    if not posts:
        return 0

    # Resolve collection — callers may pass the old engine object
    try:
        collection = get_collection()
    except Exception as exc:
        log.error("MongoDB unavailable: %s", exc)
        return 0

    _ensure_indexes(collection)

    # Build upsert operations
    ops = []
    for post in posts:
        post_id = str(post.get("id", ""))
        if not post_id:
            continue
        ops.append(UpdateOne(
            {"id": post_id},
            {"$set": post},
            upsert=True,
        ))

    if not ops:
        return 0

    # Write to MongoDB
    written = 0
    try:
        result = collection.bulk_write(ops, ordered=False)
        written = result.upserted_count + result.modified_count
        log.info("MongoDB: %d upserted, %d modified", result.upserted_count, result.modified_count)
    except BulkWriteError as bwe:
        written = bwe.details.get("nUpserted", 0) + bwe.details.get("nModified", 0)
        log.warning("Bulk write partial: %d succeeded", written)

    # Publish to Kafka (non-blocking, best-effort)
    _publish_to_kafka(posts)

    return len(posts)
