"""
Fetch current public stock quote snapshots for the configured watchlist and
upsert them into MongoDB's screeners collection.

No fallback numbers are generated. Missing/failed quotes are left untouched.
"""

from __future__ import annotations

import math
import os
import re
import time
from pathlib import Path

import requests
from pymongo import MongoClient, UpdateOne

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_TICKER_FILE = ROOT / "config" / "social_tickers_100.txt"

MONGODB_URI = os.getenv("MONGODB_URI", "mongodb://localhost:27017/feedflash")
DB_NAME = os.getenv("MONGODB_DB", os.getenv("MONGO_DB", "feedflash"))
TICKER_FILE = Path(os.getenv("QUOTE_TICKER_FILE", str(DEFAULT_TICKER_FILE)))
MAX_TICKERS = int(os.getenv("QUOTE_MAX_TICKERS", "5000"))
CHUNK_SIZE = int(os.getenv("QUOTE_CHUNK_SIZE", "40"))
TIMEOUT = int(os.getenv("QUOTE_REQUEST_TIMEOUT", "20"))

CRYPTO_TICKERS = {
    "BTC", "ETH", "LTC", "DOGE", "SOL", "ADA", "XRP", "BNB", "DOT", "AVAX",
    "MATIC", "SHIB", "TRX", "BCH", "LINK", "ATOM", "UNI", "ETC", "FIL",
    "BITO",
}

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json,text/plain,*/*",
}


def _load_tickers() -> list[str]:
    configured = os.getenv("QUOTE_TICKERS", "")
    if configured.strip():
        tickers = [t.strip().upper() for t in configured.split(",") if t.strip()]
    else:
        tickers = [line.strip().upper() for line in TICKER_FILE.read_text().splitlines() if line.strip()]

    filtered = []
    seen = set()
    for ticker in tickers:
        if ticker in seen or ticker in CRYPTO_TICKERS:
            continue
        if not re.fullmatch(r"[A-Z][A-Z0-9.-]{0,5}", ticker):
            continue
        filtered.append(ticker)
        seen.add(ticker)
        if len(filtered) >= MAX_TICKERS:
            break
    return filtered


def _chunks(values: list[str], size: int):
    for i in range(0, len(values), size):
        yield values[i:i + size]


def _parse_number(value):
    if value is None:
        return None
    if isinstance(value, (int, float)):
        number = float(value)
        return number if math.isfinite(number) else None

    text = str(value).strip().replace(",", "").replace("$", "").replace("%", "")
    if not text or text.upper() in {"N/A", "NA", "--"}:
        return None

    multiplier = 1.0
    suffix = text[-1:].upper()
    if suffix in {"K", "M", "B", "T"}:
        multiplier = {"K": 1e3, "M": 1e6, "B": 1e9, "T": 1e12}[suffix]
        text = text[:-1]

    try:
        number = float(text) * multiplier
    except ValueError:
        return None
    return number if math.isfinite(number) else None


def _int_or_none(value):
    number = _parse_number(value)
    return int(number) if number is not None else None


def _fetch_quotes(symbols: list[str], session: requests.Session) -> list[dict]:
    url = "https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol"
    try:
        resp = session.get(
            url,
            params={"symbols": "|".join(symbols), "requestMethod": "itv"},
            timeout=TIMEOUT,
        )
        resp.raise_for_status()
        payload = resp.json()
    except Exception as exc:
        print(f"CNBC quote chunk failed for {','.join(symbols[:4])}...: {exc}")
        return []

    rows = []
    for item in payload.get("FormattedQuoteResult", {}).get("FormattedQuote", []):
        quote_type = str(item.get("type") or "").upper()
        sub_type = str(item.get("subType") or "").upper()
        symbol = str(item.get("symbol") or "").upper()
        if not symbol or symbol in CRYPTO_TICKERS:
            continue

        # Keep this stock-only. ETFs, funds, crypto trusts, and indexes do not
        # belong in the stock screener the professor is grading.
        if quote_type != "STOCK" or (sub_type and "COMMON" not in sub_type):
            continue

        price = _parse_number(item.get("last"))
        previous_close = _parse_number(item.get("previous_day_closing"))
        if price is None:
            continue

        if previous_close and previous_close > 0:
            change = price - previous_close
            change_pct = (change / previous_close) * 100
        else:
            change = _parse_number(item.get("change"))
            change_pct = _parse_number(item.get("change_pct"))
            if change is None or change_pct is None:
                continue

        rows.append({
            "ticker": symbol,
            "company": item.get("name") or item.get("altName") or item.get("shortName") or "",
            "price": round(float(price), 4),
            "change": round(float(change), 4),
            "change_pct": round(float(change_pct), 4),
            "change_percent": round(float(change_pct), 4),
            "volume": _int_or_none(item.get("volume")),
            "avg_volume": _int_or_none(item.get("tendayavgvol")),
            "market_cap": _parse_number(item.get("mktcapView")),
            "exchange": item.get("exchange") or "",
            "sector": item.get("sector") or None,
            "industry": item.get("industry") or None,
            "pe_ratio": _parse_number(item.get("pe")),
            "week_52_high": _parse_number(item.get("yrhiprice")),
            "week_52_low": _parse_number(item.get("yrloprice")),
            "previous_close": round(float(previous_close), 4) if previous_close else None,
            "quote_time": item.get("last_time") or item.get("last_timedate") or None,
            "quote_status": "priced",
            "quote_source": "cnbc_public_quote",
            "quote_updated_at": int(time.time()),
        })
    return rows


def main() -> None:
    tickers = _load_tickers()
    session = requests.Session()
    session.headers.update(HEADERS)

    rows = []
    for chunk in _chunks(tickers, CHUNK_SIZE):
        rows.extend(_fetch_quotes(chunk, session))
        time.sleep(0.25)

    client = MongoClient(MONGODB_URI)
    db = client[DB_NAME]
    screeners = db.screeners

    updated = 0
    if rows:
        result = screeners.bulk_write([
            UpdateOne(
                {"ticker": row["ticker"]},
                {"$set": {k: v for k, v in row.items() if v is not None}},
                upsert=True,
            )
            for row in rows
        ], ordered=False)
        updated = result.upserted_count + result.modified_count

    print(f"Quote import complete — {len(rows)} quotes, {updated} updated")
    client.close()


if __name__ == "__main__":
    main()
