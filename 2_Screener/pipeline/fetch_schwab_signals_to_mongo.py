#!/usr/bin/env python3
"""Schwab/TD Ameritrade connector placeholder for movers/quotes/news."""

from __future__ import annotations

import os

from dotenv import load_dotenv
from pymongo import MongoClient

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "1_News" / "pipeline"))
from source_status import record_source_status

load_dotenv()

MONGODB_URI = os.getenv("MONGODB_URI", "mongodb://localhost:27017/feedflash")
DB_NAME = os.getenv("MONGODB_DB", os.getenv("MONGO_DB", "feedflash"))
MONGO_TIMEOUT_MS = int(os.getenv("MONGO_SERVER_SELECTION_TIMEOUT_MS", "3000"))


def main() -> None:
    client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=MONGO_TIMEOUT_MS)
    db = client[DB_NAME]
    has_token = bool(os.getenv("SCHWAB_ACCESS_TOKEN"))
    if not has_token:
        msg = "SCHWAB_ACCESS_TOKEN not set; OAuth flow required before quotes/movers/news can run"
        print(f"Schwab import skipped — {msg}")
        record_source_status(db, "Schwab News", "broker_api_pending", detail=msg, source_type="broker_news")
        record_source_status(db, "Schwab Movers", "broker_api_pending", detail=msg, source_type="broker_screener")
        client.close()
        return

    msg = "Schwab token present but connector is not activated in this runtime"
    print(f"Schwab import skipped — {msg}")
    record_source_status(db, "Schwab News", "broker_adapter_required", detail=msg, source_type="broker_news")
    record_source_status(db, "Schwab Movers", "broker_adapter_required", detail=msg, source_type="broker_screener")
    client.close()


if __name__ == "__main__":
    main()
