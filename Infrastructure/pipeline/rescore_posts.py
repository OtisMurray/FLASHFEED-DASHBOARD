"""One-time script: clear all sentiment fields and re-score every post."""

import logging
import sys
from pathlib import Path

# Ensure project root is on sys.path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from scrapers.db import get_client, get_collection
from processing.sentiment_engine import process_unscored_posts

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(name)-30s  %(levelname)-8s  %(message)s",
)
log = logging.getLogger(__name__)


def main() -> None:
    client = get_client()
    try:
        collection = get_collection(client)

        total = collection.count_documents({})
        log.info("Total posts in DB: %d", total)

        # Unset sentiment fields on all posts so they get re-scored
        result = collection.update_many(
            {},
            {"$unset": {
                "sentiment_score": "",
                "sentiment_method": "",
                "sentiment_signals": "",
            }},
        )
        log.info("Cleared sentiment fields on %d posts", result.modified_count)

        # Re-score all posts with updated engine (VADER fallback)
        processed = process_unscored_posts(collection)
        log.info("Re-scored %d posts", processed)

    finally:
        client.close()


if __name__ == "__main__":
    main()
