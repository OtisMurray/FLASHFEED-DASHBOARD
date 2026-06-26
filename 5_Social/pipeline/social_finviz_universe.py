import os
import re
from pymongo import MongoClient

MONGODB_URI = os.getenv("MONGODB_URI", "mongodb://localhost:27017/feedflash")
DB_NAME = os.getenv("MONGODB_DB", os.getenv("MONGO_DB", "feedflash"))

BLOCKED_TICKERS = {
    "AI", "CEO", "CFO", "IPO", "ETF", "SEC", "FDA", "USA", "USD",
    "THE", "FOR", "ARE", "YOU", "CAN", "HAS", "NEW", "NOW",
    "ON", "OFF", "SC", "US", "IT"
}

def mongo_db():
    client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=5000)
    return client, client[DB_NAME]

def load_finviz_top_gainers(db, limit=None):
    limit = int(limit or os.getenv("SOCIAL_TOP_GAINERS_LIMIT", "10"))

    query = {
        "ticker": {"$exists": True, "$nin": ["", None]},
        "price": {"$gt": 0},
        "exchange": {"$in": ["NASDAQ", "NYSE", "AMEX"]},
        "quote_source": "finviz_elite_screener",
        "$or": [
            {"change_pct": {"$gt": 0}},
            {"change_percent": {"$gt": 0}}
        ]
    }

    rows = list(
        db.screeners.find(query, {
            "ticker": 1,
            "change_pct": 1,
            "change_percent": 1,
            "rel_volume": 1,
            "volume": 1,
            "price": 1,
            "exchange": 1,
            "quote_source": 1
        })
        .sort([
            ("change_pct", -1),
            ("change_percent", -1),
            ("rel_volume", -1),
            ("volume", -1)
        ])
        .limit(limit * 5)
    )

    tickers = []
    seen = set()

    for row in rows:
        ticker = str(row.get("ticker") or "").upper().strip()

        if not re.fullmatch(r"[A-Z][A-Z0-9]{0,5}", ticker):
            continue
        if ticker in BLOCKED_TICKERS:
            continue
        if "." in ticker or "-" in ticker:
            continue
        if ticker in seen:
            continue

        tickers.append(ticker)
        seen.add(ticker)

        if len(tickers) >= limit:
            break

    return tickers
