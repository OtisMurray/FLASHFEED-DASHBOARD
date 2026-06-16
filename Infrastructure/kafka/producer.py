import logging
from confluent_kafka import Producer

from config import KAFKA_BOOTSTRAP_SERVERS, KAFKA_TOPIC
from models import FeedEvent

logger = logging.getLogger(__name__)


class FlashFeedProducer:
    """
    Wraps confluent-kafka's Producer.

    Usage:
        producer = FlashFeedProducer()
        event = FeedEvent.create(user_id="u123", event_type="post", payload={...})
        producer.send(event)
        producer.flush()          # call once before shutdown
    """

    def __init__(self):
        self._producer = Producer({
            "bootstrap.servers": KAFKA_BOOTSTRAP_SERVERS,

            # ── Reliability ───────────────────────────────────────────────────
            # "all" = wait for leader + all in-sync replicas to ack.
            # Drop to "1" (leader only) if you need lower latency and can
            # tolerate very rare message loss on broker crash.
            "acks": "all",
            "retries": 5,
            "retry.backoff.ms": 200,

            # ── Throughput ────────────────────────────────────────────────────
            # Batch messages for up to 10 ms before sending.
            # Raises latency slightly but dramatically improves throughput.
            "linger.ms": 10,
            "batch.size": 65536,    # 64 KB per batch

            # ── Compression (saves network + Kafka disk) ───────────────────────
            "compression.type": "lz4",
        })

    # ── Delivery callback ─────────────────────────────────────────────────────

    @staticmethod
    def _on_delivery(err, msg):
        if err:
            logger.error("Delivery failed | topic=%s error=%s", msg.topic(), err)
        else:
            logger.debug(
                "Delivered | topic=%s partition=%d offset=%d",
                msg.topic(), msg.partition(), msg.offset(),
            )

    # ── Public API ────────────────────────────────────────────────────────────

    def send(self, event: FeedEvent) -> None:
        """
        Publish one event to Kafka.

        Partitioned by user_id so that all events for the same user land on
        the same partition → guaranteed ordering per user.
        """
        self._producer.produce(
            topic=KAFKA_TOPIC,
            key=event.user_id.encode(),     # partition key
            value=event.to_json().encode(),
            callback=self._on_delivery,
        )
        # Non-blocking poll to fire any pending delivery callbacks.
        self._producer.poll(0)

    def flush(self, timeout: float = 10.0) -> None:
        """Block until all in-flight messages are delivered or timeout expires."""
        remaining = self._producer.flush(timeout)
        if remaining:
            logger.warning("%d message(s) not delivered before flush timeout", remaining)


# ── Quick smoke-test ──────────────────────────────────────────────────────────

if __name__ == "__main__":
    import time
    logging.basicConfig(level=logging.INFO)

    producer = FlashFeedProducer()

    for i in range(5):
        event = FeedEvent.create(
            user_id=f"user_{i % 3}",          # 3 simulated users
            event_type="post",
            payload={"title": f"Post #{i}", "body": "Hello FlashFeed!"},
        )
        producer.send(event)
        logger.info("Queued event_id=%s user_id=%s", event.event_id, event.user_id)
        time.sleep(0.1)

    producer.flush()
    logger.info("Done.")
