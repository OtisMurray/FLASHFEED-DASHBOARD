"""
bridge.py — Bridges C++ SQLite output into MongoDB
====================================================

The C++ FeedFlash app writes news articles to a local SQLite file.
This script reads from that SQLite file and copies everything into MongoDB
so the dashboard can see the data.

HOW TO USE:
  1. Set SQLITE_PATH to wherever feedflash.db lives
     (usually "data/feedflash.db" from the project root)
  2. Set MONGO_URI to your MongoDB connection string
  3. Run:  python bridge.py

It syncs every 30 seconds by default. Keep it running alongside the C++ app.
You do NOT need to modify any C++ code.

WHAT IT DOES EACH CYCLE:
  - Opens the SQLite file (read-only so it doesn't conflict with C++)
  - Reads all tables and all rows
  - Upserts them into MongoDB (safe to run repeatedly — won't create duplicates)
"""

import sqlite3
import time
import os
import logging
from datetime import datetime, timezone

from pymongo import MongoClient, UpdateOne
from pymongo.errors import BulkWriteError
from dotenv import load_dotenv

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
)
log = logging.getLogger("bridge")

# ── Config ────────────────────────────────────────────────────────────────────

# Path to the SQLite file the C++ app writes to.
# Run the C++ app first to confirm the exact path; common locations:
SQLITE_PATH = os.getenv("SQLITE_PATH", "data/feedflash.db")

# Your MongoDB connection string
MONGO_URI   = os.getenv("MONGO_URI", "mongodb://localhost:27017")
MONGO_DB    = os.getenv("MONGO_DB", "feedflash")

# How often to sync (seconds)
SYNC_INTERVAL = int(os.getenv("BRIDGE_INTERVAL", "30"))

# ── Helpers ───────────────────────────────────────────────────────────────────

def _open_sqlite_readonly(path: str) -> sqlite3.Connection:
    """Open SQLite in read-only mode so the bridge never corrupts the C++ database."""
    uri = f"file:{path}?mode=ro"
    conn = sqlite3.connect(uri, uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def _get_table_names(conn: sqlite3.Connection) -> list[str]:
    rows = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).fetchall()
    return [r[0] for r in rows]


def _id_field(doc: dict) -> str | None:
    """Try common primary key field names."""
    for field in ("id", "article_id", "url", "link", "guid"):
        if doc.get(field):
            return str(doc[field])
    return None


# ── Core sync ─────────────────────────────────────────────────────────────────

def sync_once(mongo_client: MongoClient) -> dict:
    """
    Read everything from SQLite and upsert into MongoDB.
    Returns a summary of what was written.
    """
    if not os.path.exists(SQLITE_PATH):
        log.warning("SQLite file not found: %s — is the C++ app running?", SQLITE_PATH)
        return {}

    summary = {}

    try:
        conn = _open_sqlite_readonly(SQLITE_PATH)
    except Exception as exc:
        log.error("Could not open SQLite: %s", exc)
        return {}

    tables = _get_table_names(conn)
    log.info("Tables in SQLite: %s", tables)

    for table in tables:
        try:
            rows = conn.execute(f"SELECT * FROM {table}").fetchall()
        except Exception as exc:
            log.warning("Could not read table %s: %s", table, exc)
            continue

        if not rows:
            continue

        collection = mongo_client[MONGO_DB][table]
        ops = []

        for row in rows:
            doc = dict(row)

            # Add metadata so you can tell this came from the C++ bridge
            doc["_bridge_source"] = "cpp_app"
            doc["_bridge_synced_at"] = datetime.now(timezone.utc).isoformat()

            doc_id = _id_field(doc)
            if not doc_id:
                # No recognisable ID field — use the whole doc hash as key
                import hashlib, json
                doc_id = hashlib.md5(
                    json.dumps(doc, sort_keys=True, default=str).encode()
                ).hexdigest()

            ops.append(UpdateOne(
                {"_bridge_id": doc_id},
                {"$set": {**doc, "_bridge_id": doc_id}},
                upsert=True,
            ))

        if not ops:
            continue

        try:
            result = collection.bulk_write(ops, ordered=False)
            n = result.upserted_count + result.modified_count
            summary[table] = n
            log.info("%-20s  %4d upserted  %4d modified", table, result.upserted_count, result.modified_count)
        except BulkWriteError as bwe:
            log.warning("Partial write on %s: %s", table, bwe.details.get("writeErrors", [])[:3])

    conn.close()
    return summary


# ── Main loop ─────────────────────────────────────────────────────────────────

def main():
    log.info("Bridge starting — SQLite: %s → MongoDB: %s/%s", SQLITE_PATH, MONGO_URI, MONGO_DB)
    log.info("Syncing every %ds. Press Ctrl+C to stop.", SYNC_INTERVAL)

    mongo = MongoClient(MONGO_URI, serverSelectionTimeoutMS=5_000)

    # Quick connectivity check
    try:
        mongo.admin.command("ping")
        log.info("MongoDB connected.")
    except Exception as exc:
        log.error("Cannot reach MongoDB: %s", exc)
        return

    cycle = 0
    while True:
        cycle += 1
        log.info("── Cycle %d ──", cycle)
        try:
            summary = sync_once(mongo)
            if summary:
                total = sum(summary.values())
                log.info("Cycle %d done — %d records synced across %d table(s)", cycle, total, len(summary))
            else:
                log.info("Cycle %d — nothing to sync yet.", cycle)
        except Exception as exc:
            log.error("Cycle %d failed: %s", cycle, exc, exc_info=True)

        time.sleep(SYNC_INTERVAL)


if __name__ == "__main__":
    main()
