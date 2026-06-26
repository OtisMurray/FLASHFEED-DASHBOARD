#!/usr/bin/env python3
from __future__ import annotations

import csv
import math
import os
import re
import time
from datetime import datetime, timezone
from pathlib import Path

from pymongo import MongoClient, UpdateOne


def num(value):
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value) if math.isfinite(float(value)) else None

    text = str(value).strip().replace(",", "").replace("$", "").replace("%", "")
    if not text or text in {"-", "--", "N/A", "NA"}:
        return None

    mult = 1.0
    suffix = text[-1:].upper()
    if suffix in {"K", "M", "B", "T"}:
        mult = {"K": 1e3, "M": 1e6, "B": 1e9, "T": 1e12}[suffix]
        text = text[:-1]

    try:
        return float(text) * mult
    except Exception:
        return None


def integer(value):
    n = num(value)
    return int(n) if n is not None else None


def col(row, *names):
    lower = {str(k).strip().lower(): v for k, v in row.items()}
    for name in names:
        value = lower.get(name.lower())
        if value is not None and str(value).strip():
            return str(value).strip()
    return ""


def tier_from_market_cap(market_cap):
    if market_cap is None:
        return "unknown"

    # Finviz market cap parser returns raw dollars when values are B/M/K.
    if market_cap >= 200_000_000_000:
        return "mega"
    if market_cap >= 10_000_000_000:
        return "large"
    if market_cap >= 2_000_000_000:
        return "mid"
    if market_cap >= 300_000_000:
        return "small"
    if market_cap >= 50_000_000:
        return "micro"
    return "nano"


def latest_csv():
    downloads = Path.home() / "Downloads"
    candidates = sorted(
        downloads.glob("*.csv"),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )

    for path in candidates:
        name = path.name.lower()
        if "finviz" in name or "screener" in name or "export" in name:
            return path

    return candidates[0] if candidates else None


def main():
    path = latest_csv()
    if not path:
        print("No CSV found in Downloads.")
        print("Download a Finviz Export CSV first, then run again.")
        return

    print(f"Using CSV: {path}")

    mongo_uri = os.getenv("MONGODB_URI", "mongodb://localhost:27017/feedflash")
    db_name = os.getenv("MONGODB_DB", os.getenv("MONGO_DB", "feedflash"))

    client = MongoClient(mongo_uri, serverSelectionTimeoutMS=3000)
    db = client[db_name]
    screeners = db.screeners

    now_dt = datetime.now(timezone.utc)
    now_ts = int(time.time())

    rows = []

    with path.open(newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)

        if not reader.fieldnames:
            raise SystemExit("CSV has no headers.")

        has_ticker = any(h.strip().lower() == "ticker" for h in reader.fieldnames)
        if not has_ticker:
            raise SystemExit("CSV does not contain a Ticker column. This does not look like a Finviz export.")

        for raw in reader:
            ticker = col(raw, "Ticker").upper()

            if not re.fullmatch(r"[A-Z][A-Z0-9.-]{0,5}", ticker or ""):
                continue

            price = num(col(raw, "Price"))
            change_pct = num(col(raw, "Change"))
            market_cap = num(col(raw, "Market Cap"))

            if price is None or change_pct is None:
                continue

            row = {
                "ticker": ticker,
                "company": col(raw, "Company"),
                "sector": col(raw, "Sector"),
                "industry": col(raw, "Industry"),
                "country": col(raw, "Country"),
                "market_cap": market_cap,
                "market_cap_tier": tier_from_market_cap(market_cap),
                "finviz_market_cap_tier": tier_from_market_cap(market_cap),
                "rsi": num(col(raw, "RSI (14)", "RSI")),
                "avg_volume": integer(col(raw, "Average Volume", "Avg Volume")),
                "rel_volume": num(col(raw, "Relative Volume", "Rel Volume")),
                "volume": integer(col(raw, "Volume")),
                "price": round(price, 4),
                "change_pct": round(change_pct, 4),
                "change_percent": round(change_pct, 4),
                "quote_status": "priced",
                "quote_source": "finviz_elite_screener",
                "quote_updated_at": now_ts,
                "finviz_filter": "manual_browser_export",
                "finviz_seen_at": now_dt,
                "finviz_status": "same",
                "source": "Finviz Elite",
                "screener_source": "Finviz Elite",
            }

            rows.append({k: v for k, v in row.items() if v is not None})

    if not rows:
        print("Parsed 0 usable rows from CSV.")
        client.close()
        return

    current = {row["ticker"] for row in rows}

    ops = [
        UpdateOne(
            {"ticker": row["ticker"]},
            {"$set": row, "$setOnInsert": {"created_at": now_dt}},
            upsert=True,
        )
        for row in rows
    ]

    # Drop old Finviz rows not present in the latest browser export.
    for doc in screeners.find(
        {"quote_source": "finviz_elite_screener", "finviz_status": {"$ne": "dropped"}},
        {"ticker": 1},
    ):
        ticker = doc.get("ticker")
        if ticker and ticker not in current:
            ops.append(
                UpdateOne(
                    {"ticker": ticker},
                    {"$set": {
                        "finviz_status": "dropped",
                        "finviz_seen_at": now_dt,
                        "quote_source": "finviz_elite_screener",
                    }},
                    upsert=False,
                )
            )

    result = screeners.bulk_write(ops, ordered=False)

    print(f"Imported Finviz CSV rows: {len(rows)}")
    print(f"Mongo modified/upserted: {result.modified_count + result.upserted_count}")

    print("")
    print("Top imported rows:")
    for row in sorted(rows, key=lambda r: r.get("change_pct", 0), reverse=True)[:20]:
        print(
            str(row.get("ticker", "")).ljust(7),
            str(row.get("change_pct", "")).rjust(8),
            "price", str(row.get("price", "")).rjust(8),
            "relvol", str(row.get("rel_volume", "")).rjust(8),
            "|", str(row.get("industry", ""))[:45],
        )

    client.close()


if __name__ == "__main__":
    main()
