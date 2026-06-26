"""
FlashFeed consumer pipeline
────────────────────────────
Kafka topic  →  batch read  →  Redis (RAM, hot data)
                            →  MongoDB (disk, persistent)

Kafka offset is committed ONLY after both stores succeed, so no event is
ever silently dropped on a crash or restart.
"""
import json
import logging
from datetime import datetime, timezone

import redis as redis_lib
from confluent_kafka import Consumer, KafkaError
from pymongo import MongoClient, UpdateOne, DESCENDING

from config import (
    KAFKA_BOOTSTRAP_SERVERS, KAFKA_TOPIC, KAFKA_GROUP_ID,
    REDIS_HOST, REDIS_PORT, REDIS_TTL, REDIS_FEED_MAX,
    MONGODB_URI, MONGODB_DB, MONGODB_COLLECTION,
)
from models import FeedEvent

logger = logging.getLogger(__name__)


class FlashFeedConsumer:
    """
    Consumes events from Kafka and fans them out to Redis and MongoDB.

    Redis data model
    ────────────────
    Hash  "event:{event_id}"  → all event fields (TTL = REDIS_TTL seconds)
    ZSet  "feed:{user_id}"    → {event_id: unix_timestamp_score}
          • ordered by time, newest first via ZREVRANGE
          • trimmed to the most recent REDIS_FEED_MAX events per user
          • same TTL as the hash

    MongoDB data model
    ──────────────────
    Collection  "events"
    Indexes: event_id (unique), user_id, timestamp DESC
    Writes are upserts keyed on event_id — idempotent if a message is
    redelivered.
    """

    # ── Init ──────────────────────────────────────────────────────────────────

    def __init__(self):
        # Kafka consumer
        self._consumer = Consumer({
            "bootstrap.servers": KAFKA_BOOTSTRAP_SERVERS,
            "group.id": KAFKA_GROUP_ID,
            "auto.offset.reset": "earliest",
            # Manual commits — we commit only after a successful write to
            # both Redis and MongoDB.
            "enable.auto.commit": False,
            # Fetch up to 10 MB per partition per request for throughput.
            "fetch.max.bytes": 10_485_760,
        })

        # Redis connection (thread-safe pool under the hood)
        self._redis = redis_lib.Redis(
            host=REDIS_HOST,
            port=REDIS_PORT,
            decode_responses=True,
            socket_timeout=5,
            socket_connect_timeout=5,
        )

        # MongoDB connection
        self._mongo_client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=5_000)
        self._collection = self._mongo_client[MONGODB_DB][MONGODB_COLLECTION]
        self._setup_mongo_indexes()

    def _setup_mongo_indexes(self) -> None:
        self._collection.create_index("event_id", unique=True)
        self._collection.create_index("user_id")
        self._collection.create_index([("timestamp", DESCENDING)])
        logger.info("MongoDB indexes ready.")

    # ── Redis writes ──────────────────────────────────────────────────────────

    def _write_to_redis(self, events: list[FeedEvent]) -> None:
        """
        Batch-write all events to Redis using a single pipeline.

        Pipeline sends all commands to Redis in one round-trip, so latency
        stays flat whether you're writing 1 event or 1 000.
        """
        pipe = self._redis.pipeline(transaction=False)

        for e in events:
            # 1. Store the full event as a flat hash (payload JSON-encoded).
            pipe.hset(f"event:{e.event_id}", mapping=e.to_redis_hash())
            pipe.expire(f"event:{e.event_id}", REDIS_TTL)

            # 2. Add to the user's feed sorted set, scored by timestamp.
            score = datetime.fromisoformat(e.timestamp).timestamp()
            pipe.zadd(f"feed:{e.user_id}", {e.event_id: score})
            pipe.expire(f"feed:{e.user_id}", REDIS_TTL)

            # 3. Trim to the most recent REDIS_FEED_MAX events per user.
            #    ZREMRANGEBYRANK removes the oldest entries (rank 0 … N-MAX-1).
            pipe.zremrangebyrank(f"feed:{e.user_id}", 0, -(REDIS_FEED_MAX + 1))

        pipe.execute()
        logger.info("Redis: wrote %d events.", len(events))

    # ── MongoDB writes ────────────────────────────────────────────────────────

    def _write_to_mongo(self, events: list[FeedEvent]) -> None:
        """
        Bulk-upsert all events in a single MongoDB round-trip.

        ordered=False lets MongoDB continue on individual document errors
        (e.g. a duplicate key on retry) instead of aborting the whole batch.
        """
        ops = [
            UpdateOne(
                {"event_id": e.event_id},
                {"$set": e.to_dict()},
                upsert=True,
            )
            for e in events
        ]
        result = self._collection.bulk_write(ops, ordered=False)
        logger.info(
            "MongoDB: upserted=%d modified=%d",
            result.upserted_count, result.modified_count,
        )

    # ── Main loop ─────────────────────────────────────────────────────────────

    def run(self, batch_size: int = 50) -> None:
        """
        Poll Kafka in batches of `batch_size` messages, write to both stores,
        then commit. Runs until KeyboardInterrupt or a fatal Kafka error.
        """
        self._consumer.subscribe([KAFKA_TOPIC])
        logger.info("Consuming from topic '%s' (group '%s')…", KAFKA_TOPIC, KAFKA_GROUP_ID)

        try:
            while True:
                # consume() blocks up to 1 second if the topic is quiet.
                raw_messages = self._consumer.consume(
                    num_messages=batch_size, timeout=1.0
                )
                if not raw_messages:
                    continue

                # ── Parse ──────────────────────────────────────────────────────
                events: list[FeedEvent] = []
                for msg in raw_messages:
                    if msg.error():
                        code = msg.error().code()
                        if code != KafkaError._PARTITION_EOF:
                            logger.error("Kafka error: %s", msg.error())
                        continue
                    try:
                        events.append(FeedEvent.from_json(msg.value().decode()))
                    except Exception as exc:
                        logger.error("Failed to parse message: %s", exc)

                if not events:
                    continue

                # ── Write to both stores, then commit ─────────────────────────
                try:
                    self._write_to_redis(events)
                    self._write_to_mongo(events)
                    # Commit after BOTH writes succeed — safe replay if we crash.
                    self._consumer.commit(asynchronous=False)
                    logger.info("Batch of %d committed.", len(events))

                except Exception as exc:
                    # Don't commit — Kafka will redeliver this batch on restart.
                    logger.error("Write error (batch NOT committed): %s", exc, exc_info=True)

        except KeyboardInterrupt:
            logger.info("Shutting down consumer…")
        finally:
            self._consumer.close()
            self._mongo_client.close()

    # ── Read path (cache-aside) ───────────────────────────────────────────────

    def get_user_feed(self, user_id: str, limit: int = 20) -> list[dict]:
        """
        Fetch the latest `limit` events for a user.

        Cache-aside pattern:
          1. Try Redis first (microseconds, data lives in RAM).
          2. On a cold-start cache miss, fall back to MongoDB and return raw dicts.

        Call this from your FlashFeed API layer, not from the consumer loop.
        """
        # Step 1 — Redis fast path (newest first via ZREVRANGE)
        event_ids = self._redis.zrevrange(f"feed:{user_id}", 0, limit - 1)
        if event_ids:
            pipe = self._redis.pipeline(transaction=False)
            for eid in event_ids:
                pipe.hgetall(f"event:{eid}")
            results = pipe.execute()
            # Deserialise payload back to dict
            feed = []
            for h in results:
                if h:
                    h["payload"] = json.loads(h.get("payload", "{}"))
                    feed.append(h)
            logger.debug("Redis hit for user %s (%d events).", user_id, len(feed))
            return feed

        # Step 2 — MongoDB fallback (milliseconds)
        logger.info("Cache miss for user %s — reading from MongoDB.", user_id)
        return list(
            self._collection
            .find({"user_id": user_id}, {"_id": 0})
            .sort("timestamp", DESCENDING)
            .limit(limit)
        )


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s  %(levelname)-8s  %(name)s  %(message)s",
    )
    consumer = FlashFeedConsumer()
    consumer.run(batch_size=50)
