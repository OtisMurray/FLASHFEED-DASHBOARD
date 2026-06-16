from dataclasses import dataclass, asdict, field
from datetime import datetime, timezone
import json
import uuid


@dataclass
class FeedEvent:
    """
    A single FlashFeed event flowing through the pipeline.

    Adjust the fields to match your actual FlashFeed data model.
    The key requirement is that every event has:
      - a unique event_id  (used as the Redis key and MongoDB dedup key)
      - a user_id         (used to partition in Kafka and bucket in Redis)
    """
    event_id:   str
    user_id:    str
    event_type: str          # e.g. "post", "like", "comment", "share"
    payload:    dict         # whatever data is specific to the event type
    timestamp:  str          # ISO-8601 UTC string

    # ── Constructors ──────────────────────────────────────────────────────────

    @classmethod
    def create(cls, user_id: str, event_type: str, payload: dict) -> "FeedEvent":
        """Convenience constructor — auto-generates id and timestamp."""
        return cls(
            event_id=str(uuid.uuid4()),
            user_id=user_id,
            event_type=event_type,
            payload=payload,
            timestamp=datetime.now(timezone.utc).isoformat(),
        )

    # ── Serialisation ─────────────────────────────────────────────────────────

    def to_json(self) -> str:
        """Kafka wire format (value bytes)."""
        return json.dumps(asdict(self))

    def to_dict(self) -> dict:
        """For MongoDB documents."""
        return asdict(self)

    def to_redis_hash(self) -> dict:
        """
        Redis hset requires all values to be strings/bytes/numbers.
        We JSON-encode the nested payload dict.
        """
        d = asdict(self)
        d["payload"] = json.dumps(d["payload"])
        return d

    @classmethod
    def from_json(cls, raw: str) -> "FeedEvent":
        """Deserialise a Kafka message value."""
        data = json.loads(raw)
        return cls(**data)

    @classmethod
    def from_redis_hash(cls, h: dict) -> "FeedEvent":
        """Re-inflate a Redis hash back into a FeedEvent."""
        h = dict(h)
        h["payload"] = json.loads(h.get("payload", "{}"))
        return cls(**h)
