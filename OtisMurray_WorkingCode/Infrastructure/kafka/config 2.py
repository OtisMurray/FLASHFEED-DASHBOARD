import os
from dotenv import load_dotenv

load_dotenv()

# ── Kafka ─────────────────────────────────────────────────────────────────────
KAFKA_BOOTSTRAP_SERVERS = os.getenv("KAFKA_BOOTSTRAP_SERVERS", "localhost:9092")
KAFKA_TOPIC             = os.getenv("KAFKA_TOPIC", "flashfeed-events")
KAFKA_GROUP_ID          = os.getenv("KAFKA_GROUP_ID", "flashfeed-consumer-group")

# ── Redis (in-memory / RAM layer) ─────────────────────────────────────────────
REDIS_HOST         = os.getenv("REDIS_HOST", "localhost")
REDIS_PORT         = int(os.getenv("REDIS_PORT", 6379))
REDIS_TTL          = int(os.getenv("REDIS_TTL", 3600))   # seconds
REDIS_FEED_MAX     = int(os.getenv("REDIS_FEED_MAX", 100))

# ── MongoDB (persistent / disk layer) ─────────────────────────────────────────
MONGODB_URI        = os.getenv("MONGODB_URI", "mongodb://localhost:27017")
MONGODB_DB         = os.getenv("MONGODB_DB", "flashfeed")
MONGODB_COLLECTION = os.getenv("MONGODB_COLLECTION", "events")
