#!/usr/bin/env python3
"""IBKR broker-news connector placeholder.

Jeff's IBKR code shows the correct API path: reqNewsProviders,
reqHistoricalNews, and reqNewsArticle through TWS/Gateway. This script records
source health until a live IB Gateway/TWS session is configured.
"""

from __future__ import annotations

import os

from dotenv import load_dotenv
from pymongo import MongoClient

from source_status import record_source_status

load_dotenv()

MONGODB_URI = os.getenv("MONGODB_URI", "mongodb://localhost:27017/feedflash")
DB_NAME = os.getenv("MONGODB_DB", os.getenv("MONGO_DB", "feedflash"))
MONGO_TIMEOUT_MS = int(os.getenv("MONGO_SERVER_SELECTION_TIMEOUT_MS", "3000"))


def main() -> None:
    client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=MONGO_TIMEOUT_MS)
    db = client[DB_NAME]
    enabled = os.getenv("IBKR_ENABLE_NEWS", "").lower() in {"1", "true", "yes"}
    if not enabled:
        msg = "IBKR_ENABLE_NEWS not set; requires running TWS/IB Gateway and market-news permissions"
        print(f"Interactive Brokers News import skipped — {msg}")
        record_source_status(db, "Interactive Brokers News", "broker_api_pending", detail=msg, source_type="broker_news")
        record_source_status(db, "Dow Jones Newswires", "licensed_feed_required", detail="Can be sourced through IBKR if the account has DJNL/news permissions", source_type="structured_news")
        client.close()
        return

    msg = "IBKR news enabled but live TWS/Gateway adapter is not wired in this runtime"
    print(f"Interactive Brokers News import skipped — {msg}")
    record_source_status(db, "Interactive Brokers News", "broker_adapter_required", detail=msg, source_type="broker_news")
    client.close()


if __name__ == "__main__":
    main()
