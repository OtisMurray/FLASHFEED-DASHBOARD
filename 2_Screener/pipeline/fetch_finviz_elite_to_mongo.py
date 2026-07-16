#!/usr/bin/env python3
"""
Fetch Finviz Elite screener CSV rows into MongoDB's screeners collection.

Uses FINVIZ_AUTH_TOKEN / FINVIZ_TOKEN from the environment when available.
If Finviz only exposes a browser-session export, FINVIZ_COOKIE can be supplied
locally as a fallback. Secrets are never printed.
"""

from __future__ import annotations

import csv
import io
import math
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlencode

from dotenv import load_dotenv
from pymongo import MongoClient, UpdateOne

try:
    from curl_cffi import requests as http_requests
except Exception:
    import requests as http_requests

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "1_News" / "pipeline"))
try:
    from source_status import record_source_status
except Exception:
    def record_source_status(*_args, **_kwargs):
        return None

load_dotenv()

MONGODB_URI = os.getenv("MONGODB_URI", "mongodb://localhost:27017/feedflash")
DB_NAME = os.getenv("MONGODB_DB", os.getenv("MONGO_DB", "feedflash"))
MONGO_TIMEOUT_MS = int(os.getenv("MONGO_SERVER_SELECTION_TIMEOUT_MS", "3000"))
AUTH_TOKEN = os.getenv("FINVIZ_AUTH_TOKEN") or os.getenv("FINVIZ_TOKEN") or ""
FINVIZ_COOKIE = os.getenv("FINVIZ_COOKIE") or os.getenv("FINVIZ_ELITE_COOKIE") or ""
MAX_WORKERS = int(os.getenv("FINVIZ_MAX_WORKERS", "3"))
TIMEOUT = int(os.getenv("FINVIZ_REQUEST_TIMEOUT", "25"))
MAX_RETRIES = int(os.getenv("FINVIZ_MAX_RETRIES", "3"))

TOKEN_EXPORT_URL = "https://elite.finviz.com/export"
COOKIE_EXPORT_URL = "https://elite.finviz.com/export/screener"
COLUMNS = "0,1,2,3,4,5,6,59,63,64,65,66,67"
TIER_FILTERS = {
    "mega": "cap_mega,sh_curvol_o5000,sh_relvol_o1.5,ta_change_u",
    "large": "cap_large,sh_curvol_o5000,sh_relvol_o2,ta_change_u",
    "mid": "cap_mid,sh_curvol_o1000,sh_relvol_o2.5,ta_change_u",
    "small": "cap_small,sh_curvol_o500,sh_relvol_o3,ta_change_u",
    "micro": "cap_micro,sh_curvol_o100,sh_relvol_o3,ta_change_u",
    "nano": "cap_nano,sh_curvol_o100,sh_relvol_o4,ta_change_u",
}

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "text/csv,text/plain,*/*",
    "Referer": "https://elite.finviz.com/",
}


def _request_headers() -> dict[str, str]:
    headers = dict(HEADERS)
    if FINVIZ_COOKIE:
        headers["Cookie"] = FINVIZ_COOKIE
    return headers


def _num(value):
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value) if math.isfinite(float(value)) else None
    text = str(value).strip().replace(",", "").replace("$", "").replace("%", "")
    if not text or text in {"-", "N/A", "NA", "--"}:
        return None
    mult = 1.0
    suffix = text[-1:].upper()
    if suffix in {"K", "M", "B", "T"}:
        mult = {"K": 1e3, "M": 1e6, "B": 1e9, "T": 1e12}[suffix]
        text = text[:-1]
    try:
        return float(text) * mult
    except ValueError:
        return None


def _int(value):
    number = _num(value)
    return int(number) if number is not None else None


def _col(row: dict, *names: str) -> str:
    lower = {str(k).strip().lower(): v for k, v in row.items()}
    for name in names:
        value = lower.get(name.lower())
        if value is not None and str(value).strip():
            return str(value).strip()
    return ""


def _fetch_tier(tier: str, filter_text: str) -> tuple[str, list[dict], str | None]:
    params = {
        "v": "152",
        "f": filter_text,
        "o": "-change",
        "c": COLUMNS,
    }
    _signal = os.getenv("FINVIZ_SIGNAL", "").strip()
    if _signal:
        params["s"] = _signal
    candidates: list[tuple[str, str]] = []
    if AUTH_TOKEN:
        token_params = {**params, "auth": AUTH_TOKEN}
        candidates.append(("token", f"{TOKEN_EXPORT_URL}?{urlencode(token_params)}"))
    if FINVIZ_COOKIE:
        candidates.append(("cookie", f"{COOKIE_EXPORT_URL}?{urlencode(params)}"))
    if not candidates:
        return tier, [], "FINVIZ_AUTH_TOKEN or FINVIZ_COOKIE not set"

    headers = _request_headers()
    last_error = ""
    for auth_mode, url in candidates:
        resp = None
        for attempt in range(MAX_RETRIES):
            try:
                try:
                    resp = http_requests.get(url, headers=headers, impersonate="chrome124", timeout=TIMEOUT)
                except TypeError:
                    resp = http_requests.get(url, headers=headers, timeout=TIMEOUT)
            except Exception as exc:
                if attempt >= MAX_RETRIES - 1:
                    last_error = f"{auth_mode} request failed: {exc}"
                    break
                time.sleep(1.5 * (attempt + 1))
                continue

            if resp.status_code != 429:
                break
            if attempt < MAX_RETRIES - 1:
                time.sleep(3 * (attempt + 1))

        if resp is None or resp.status_code != 200:
            status = getattr(resp, "status_code", "no response")
            last_error = f"{auth_mode} http 429 after retries" if status == 429 else f"{auth_mode} http {status}"
            continue

        text = (resp.text or "").strip()
        if not text:
            last_error = f"{auth_mode} empty response"
            continue
        lower_start = text[:240].lower()
        if "<html" in lower_start or "invalid" in lower_start or "login" in lower_start:
            last_error = f"invalid {auth_mode} auth or html response"
            continue
        break
    else:
        return tier, [], last_error or "Finviz auth failed"

    reader = csv.DictReader(io.StringIO(text))
    if not reader.fieldnames or not any(h.strip().lower() == "ticker" for h in reader.fieldnames):
        return tier, [], "missing ticker column"

    rows = []
    now = datetime.now(timezone.utc)
    now_ts = int(time.time())
    for raw in reader:
        ticker = _col(raw, "Ticker").upper()
        if not re.fullmatch(r"[A-Z][A-Z0-9.-]{0,5}", ticker or ""):
            continue
        change_pct = _num(_col(raw, "Change"))
        price = _num(_col(raw, "Price"))
        row = {
            "ticker": ticker,
            "company": _col(raw, "Company"),
            "sector": _col(raw, "Sector"),
            "industry": _col(raw, "Industry"),
            "country": _col(raw, "Country"),
            "market_cap": _num(_col(raw, "Market Cap")),
            "market_cap_tier": tier,
            "finviz_market_cap_tier": tier,
            "rsi": _num(_col(raw, "RSI (14)", "RSI")),
            "avg_volume": _int(_col(raw, "Average Volume", "Avg Volume")),
            "rel_volume": _num(_col(raw, "Relative Volume", "Rel Volume")),
            "volume": _int(_col(raw, "Volume")),
            "price": round(price, 4) if price is not None else None,
            "change_pct": round(change_pct, 4) if change_pct is not None else None,
            "change_percent": round(change_pct, 4) if change_pct is not None else None,
            "quote_status": "priced" if price is not None else "screened",
            "quote_source": "finviz_elite_screener",
            "quote_updated_at": now_ts,
            "finviz_filter": filter_text,
            "finviz_seen_at": now,
            "source": "Finviz Elite",
        }
        rows.append({k: v for k, v in row.items() if v is not None})
    return tier, rows, None


def main() -> None:
    client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=MONGO_TIMEOUT_MS)
    db = client[DB_NAME]

    if not AUTH_TOKEN and not FINVIZ_COOKIE:
        print("Finviz Elite import skipped — FINVIZ_AUTH_TOKEN/FINVIZ_COOKIE not set")
        record_source_status(db, "Finviz Elite Screener", "api_key_required", detail="FINVIZ_AUTH_TOKEN or FINVIZ_COOKIE not set", source_type="numeric_screener")
        print("Finviz Elite import complete — 0 rows, 0 updated, 0 dropped")
        client.close()
        return

    screeners = db.screeners

    previous_by_tier = {
        tier: set(
            doc["ticker"]
            for doc in screeners.find(
                {"finviz_market_cap_tier": tier, "finviz_status": {"$ne": "dropped"}},
                {"ticker": 1},
            )
            if doc.get("ticker")
        )
        for tier in TIER_FILTERS
    }

    all_rows: list[dict] = []
    fetched_by_tier: dict[str, set[str]] = {}
    errors = []

    with ThreadPoolExecutor(max_workers=max(1, min(MAX_WORKERS, len(TIER_FILTERS)))) as pool:
        futures = [pool.submit(_fetch_tier, tier, filt) for tier, filt in TIER_FILTERS.items()]
        for future in as_completed(futures):
            tier, rows, error = future.result()
            if error:
                errors.append(f"{tier}: {error}")
            fetched_by_tier[tier] = {row["ticker"] for row in rows}
            previous = previous_by_tier.get(tier, set())
            for row in rows:
                row["finviz_status"] = "same" if row["ticker"] in previous else "added"
            all_rows.extend(rows)
            print(f"Finviz {tier}: {len(rows)} rows")

    now = datetime.now(timezone.utc)
    ops = [
        UpdateOne(
            {"ticker": row["ticker"]},
            {"$set": row, "$setOnInsert": {"created_at": now}},
            upsert=True,
        )
        for row in all_rows
    ]

    dropped = 0
    for tier, previous in previous_by_tier.items():
        current = fetched_by_tier.get(tier, set())
        for ticker in sorted(previous - current):
            ops.append(UpdateOne(
                {"ticker": ticker, "finviz_market_cap_tier": tier},
                {"$set": {"finviz_status": "dropped", "finviz_seen_at": now, "quote_source": "finviz_elite_screener"}},
                upsert=False,
            ))
            dropped += 1

    updated = 0
    if ops:
        result = screeners.bulk_write(ops, ordered=False)
        updated = int(result.modified_count + result.upserted_count)

    for error in errors[:8]:
        print(f"Finviz warning: {error}")
    status = "working" if all_rows else "error"
    detail = "; ".join(errors[:4]) if errors else ""
    record_source_status(db, "Finviz Elite Screener", status, detail=detail, count=len(all_rows), source_type="numeric_screener")
    print(f"Finviz Elite import complete — {len(all_rows)} rows, {updated} updated, {dropped} dropped")
    client.close()


if __name__ == "__main__":
    main()
