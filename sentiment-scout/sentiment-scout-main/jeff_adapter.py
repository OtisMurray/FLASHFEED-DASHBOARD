"""
Jeff IBKR adapter: reads scanner configurations from MongoDB IBKR_DB.market_scanners.
NOTE: Jeff's app stores scanner *configurations* in Mongo; live ticker data comes
from the IBKR TWS API in real time and is not persisted to MongoDB.
We surface the saved scanner configs so the dashboard can show what scans are running.
"""

import os

# Mongo location is env-driven (MONGO_URI) so a deployed host can point at Atlas;
# defaults to the local daemon so local dev is unchanged.
_MONGO_URI = os.environ.get("MONGO_URI", "mongodb://localhost:27017")
_DB_NAME   = "IBKR_DB"
_COL_NAME  = "market_scanners"


def fetch_jeff_scanner_data() -> list:
    """
    Fetch IBKR market scanner configurations from Jeff's MongoDB.
    Returns [] with a clear log if MongoDB is unavailable or pymongo is missing.
    """
    try:
        from pymongo import MongoClient
        from pymongo.errors import ServerSelectionTimeoutError, ConnectionFailure
    except ImportError:
        print("  [jeff] pymongo not installed — returning []")
        return []

    try:
        client = MongoClient(_MONGO_URI, serverSelectionTimeoutMS=2000)
        client.server_info()

        col  = client[_DB_NAME][_COL_NAME]
        docs = list(col.find({}, {"_id": 0}))

        out = []
        for doc in docs:
            scanner_details = doc.get("scanner_details") or {}
            tags = doc.get("tags") or []
            out.append({
                "display_name":  doc.get("display_name", ""),
                "req_id":        doc.get("req_id"),
                "scan_code":     scanner_details.get("scanCode", ""),
                "instrument":    scanner_details.get("instrument", "STK"),
                "location_code": scanner_details.get("locationCode", "STK.US.MAJOR"),
                "tags": [
                    {"tag": t.get("tag", ""), "value": t.get("value", "")}
                    for t in tags
                ],
            })

        print(f"  [jeff] fetched {len(out)} scanner configs from MongoDB")
        return out

    except Exception as exc:
        print(f"  [jeff] MongoDB unavailable ({_MONGO_URI}): {exc} — returning []")
        return []
