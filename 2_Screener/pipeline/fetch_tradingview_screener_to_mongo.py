#!/usr/bin/env python3
"""Fetch TradingView scanner numeric rows into MongoDB screeners."""

from __future__ import annotations

import math
import os
import re
import time
from datetime import datetime, timezone

from dotenv import load_dotenv
from pymongo import MongoClient, UpdateOne

try:
    from curl_cffi import requests as http_requests
except Exception:
    import requests as http_requests

try:
    import sys
    from pathlib import Path
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "1_News" / "pipeline"))
    from source_status import record_source_status
except Exception:
    def record_source_status(*_args, **_kwargs):
        return None

load_dotenv()

MONGODB_URI = os.getenv("MONGODB_URI", "mongodb://localhost:27017/feedflash")
DB_NAME = os.getenv("MONGODB_DB", os.getenv("MONGO_DB", "feedflash"))
MONGO_TIMEOUT_MS = int(os.getenv("MONGO_SERVER_SELECTION_TIMEOUT_MS", "3000"))
LIMIT = int(os.getenv("TRADINGVIEW_SCREENER_LIMIT", "3000"))
TIMEOUT = int(os.getenv("TRADINGVIEW_SCREENER_TIMEOUT", "20"))

URL = "https://scanner.tradingview.com/america/scan"
HEADERS = {
    "User-Agent": "Mozilla/5.0 Chrome/124 Safari/537.36",
    "Accept": "application/json,text/plain,*/*",
    "Content-Type": "application/json",
    "Origin": "https://www.tradingview.com",
    "Referer": "https://www.tradingview.com/",
}
COLUMNS = [
    "name", "description", "exchange", "sector", "industry",
    "close", "change", "change_abs", "volume", "relative_volume_10d_calc",
    "market_cap_basic", "premarket_change", "premarket_change_abs",
    "postmarket_change", "postmarket_change_abs", "RSI",
]


def _num(value):
    if value is None:
        return None
    try:
        n = float(value)
    except Exception:
        return None
    return n if math.isfinite(n) else None


def _request_payload() -> dict:
    return {
        "filter": [
            {"left": "volume", "operation": "greater", "right": 10000},
            {"left": "exchange", "operation": "in_range", "right": ["NASDAQ", "NYSE", "AMEX"]},
        ],
        "options": {"lang": "en"},
        "markets": ["america"],
        "symbols": {"query": {"types": ["stock", "dr"]}, "tickers": []},
        "columns": COLUMNS,
        "sort": {"sortBy": "volume", "sortOrder": "desc"},
        "range": [0, LIMIT],
    }


def main() -> None:
    client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=MONGO_TIMEOUT_MS)
    db = client[DB_NAME]
    try:
        try:
            resp = http_requests.post(URL, headers=HEADERS, json=_request_payload(), impersonate="chrome124", timeout=TIMEOUT)
        except TypeError:
            resp = http_requests.post(URL, headers=HEADERS, json=_request_payload(), timeout=TIMEOUT)
        resp.raise_for_status()
        payload = resp.json()
    except Exception as exc:
        print(f"TradingView screener import skipped — {exc}")
        record_source_status(db, "TradingView Numeric Screener", "error", detail=str(exc), source_type="numeric_screener")
        client.close()
        return

    now = datetime.now(timezone.utc)
    now_ts = int(time.time())
    rows = []
    for item in payload.get("data", []):
        data = dict(zip(COLUMNS, item.get("d", [])))
        ticker = str(data.get("name") or "").upper().strip()
        if not re.fullmatch(r"[A-Z][A-Z0-9.-]{0,5}", ticker):
            continue
        price = _num(data.get("close"))
        change_pct = _num(data.get("change"))
        rows.append({
            "ticker": ticker,
            "company": data.get("description") or "",
            "exchange": data.get("exchange") or "",
            "sector": data.get("sector") or None,
            "industry": data.get("industry") or None,
            "price": round(price, 4) if price is not None else None,
            "change_pct": round(change_pct, 4) if change_pct is not None else None,
            "change_percent": round(change_pct, 4) if change_pct is not None else None,
            "change": _num(data.get("change_abs")),
            "volume": int(_num(data.get("volume")) or 0) or None,
            "rel_volume": _num(data.get("relative_volume_10d_calc")),
            "market_cap": _num(data.get("market_cap_basic")),
            "premarket_change_pct": _num(data.get("premarket_change")),
            "premarket_change": _num(data.get("premarket_change_abs")),
            "postmarket_change_pct": _num(data.get("postmarket_change")),
            "postmarket_change": _num(data.get("postmarket_change_abs")),
            "rsi": _num(data.get("RSI")),
            "quote_source": "tradingview_numeric_screener",
            "quote_status": "priced" if price is not None else "screened",
            "quote_updated_at": now_ts,
            "tradingview_seen_at": now,
            "source": "TradingView Numeric Screener",
        })

    if rows:
        result = db.screeners.bulk_write([
            UpdateOne({"ticker": row["ticker"]}, {"$set": {k: v for k, v in row.items() if v is not None}}, upsert=True)
            for row in rows
        ], ordered=False)
        updated = result.modified_count + result.upserted_count
    else:
        updated = 0

    record_source_status(db, "TradingView Numeric Screener", "working", count=len(rows), source_type="numeric_screener")
    print(f"TradingView screener import complete — {len(rows)} rows, {updated} updated")
    client.close()


if __name__ == "__main__":
    main()
