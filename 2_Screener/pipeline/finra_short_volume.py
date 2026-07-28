#!/usr/bin/env python3
"""
FINRA daily short-volume ingestion (CNMSshvol) with source/date/checksum provenance.

FINRA publishes one pipe-delimited consolidated file per trading day at
cdn.finra.org. It reports, per symbol, how much of that day's volume was sold
short. That is NOT short interest -- most short volume is market-maker flow that
gets covered the same day -- but it is the only daily-frequency signal that
exists between FINRA's twice-monthly settlement figures. si_estimate.py turns it
into a short-interest estimate; this module only fetches, parses, and caches it.

Each cached day carries where it came from, what trade date it covers, when we
pulled it, and a sha256 of the exact bytes we parsed, so a stale or changed file
is always distinguishable from a fresh one.

Weekends/holidays return HTTP 403 (not 404) from the CDN -- treated as "no file
for that day", not as an error.
"""

from __future__ import annotations

import hashlib
import os
from calendar import monthrange
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone

try:
    from curl_cffi import requests as http_requests
except Exception:  # pragma: no cover - exercised only when curl_cffi is absent
    import requests as http_requests


URL_TEMPLATE = os.getenv(
    "FINRA_DAILY_VOLUME_URL_TEMPLATE",
    "https://cdn.finra.org/equity/regsho/daily/CNMSshvol{date}.txt",
)
CACHE_COLLECTION = "finra_short_volume_daily"
HTTP_TIMEOUT = int(os.getenv("FINRA_HTTP_TIMEOUT", "25"))
MAX_WORKERS = int(os.getenv("FINRA_MAX_WORKERS", "6"))

# FINRA settlement figures are published roughly 9 business days after the
# settlement date itself (the 15th and the last business day of each month).
SETTLEMENT_PUBLICATION_LAG_BUSINESS_DAYS = 9

# How far before the settlement date we look to establish each ticker's own
# "normal" short-volume ratio. Four weeks of trading days.
BASELINE_WINDOW_DAYS = 28


@dataclass(frozen=True)
class DayFile:
    """One trading day's parsed short-volume file, with its provenance."""

    trade_date: str                     # YYYYMMDD, as named in the FINRA URL
    symbols: dict[str, tuple[float, float]] = field(repr=False)  # SYM -> (short_vol, total_vol)
    checksum: str = ""                  # sha256 of the exact bytes parsed
    source_url: str = ""
    fetched_at: datetime | None = None
    row_count: int = 0

    def as_cache_doc(self) -> dict:
        return {
            "trade_date": self.trade_date,
            "symbols": {sym: list(pair) for sym, pair in self.symbols.items()},
            "checksum": self.checksum,
            "source_url": self.source_url,
            "fetched_at": self.fetched_at,
            "row_count": self.row_count,
            "source": "finra_regsho_daily",
        }

    @classmethod
    def from_cache_doc(cls, doc: dict) -> "DayFile":
        raw = doc.get("symbols") or {}
        symbols = {}
        for sym, pair in raw.items():
            try:
                symbols[sym] = (float(pair[0]), float(pair[1]))
            except (TypeError, ValueError, IndexError):
                continue
        return cls(
            trade_date=str(doc.get("trade_date") or ""),
            symbols=symbols,
            checksum=str(doc.get("checksum") or ""),
            source_url=str(doc.get("source_url") or ""),
            fetched_at=doc.get("fetched_at"),
            row_count=int(doc.get("row_count") or 0),
        )


def daily_url(day: date) -> str:
    return URL_TEMPLATE.replace("{date}", day.strftime("%Y%m%d"))


def checksum_of(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", "replace")).hexdigest()


def parse_daily_text(text: str) -> dict[str, tuple[float, float]]:
    """Parse the pipe-delimited daily file into {symbol: (short_vol, total_vol)}.

    Layout: Date|Symbol|ShortVolume|ShortExemptVolume|TotalVolume|Market
    Volumes are consolidated across venues and arrive as decimals. Rows with a
    non-positive total volume carry no ratio information and are dropped.
    """
    out: dict[str, tuple[float, float]] = {}
    lines = text.splitlines()
    for line in lines[1:]:  # skip the header row
        parts = line.split("|")
        if len(parts) < 5:
            continue
        symbol = parts[1].strip().upper()
        if not symbol:
            continue
        try:
            short_vol = float(parts[2])
            total_vol = float(parts[4])
        except (TypeError, ValueError):
            continue
        if total_vol <= 0:
            continue
        out[symbol] = (short_vol, total_vol)
    return out


def _prev_business_day(day: date) -> date:
    while day.weekday() >= 5:
        day -= timedelta(days=1)
    return day


def _business_days_after(day: date, count: int) -> date:
    while count > 0:
        day += timedelta(days=1)
        if day.weekday() < 5:
            count -= 1
    return day


def latest_published_settlement(today: date) -> date:
    """Most recent FINRA short-interest settlement date whose report is public.

    Settlements land on the 15th and the last business day of each month, and
    publish about nine business days later. Anything not yet published cannot be
    the base our estimate builds on.
    """
    candidates: list[date] = []
    for months_back in range(3):
        year, month = today.year, today.month - months_back
        while month <= 0:
            month += 12
            year -= 1
        candidates.append(_prev_business_day(date(year, month, 15)))
        candidates.append(_prev_business_day(date(year, month, monthrange(year, month)[1])))
    published = [
        day for day in candidates
        if _business_days_after(day, SETTLEMENT_PUBLICATION_LAG_BUSINESS_DAYS) <= today
    ]
    return max(published)


def trading_days_between(start: date, end: date) -> list[date]:
    """Weekday calendar days in (start, end). Holidays simply return no file."""
    days: list[date] = []
    cursor = start + timedelta(days=1)
    while cursor < end:
        if cursor.weekday() < 5:
            days.append(cursor)
        cursor += timedelta(days=1)
    return days


def fetch_day(day: date) -> DayFile | None:
    """Download and parse one day. Returns None when FINRA has no file for it."""
    url = daily_url(day)
    try:
        response = http_requests.get(
            url, timeout=HTTP_TIMEOUT, headers={"User-Agent": "Mozilla/5.0"}
        )
    except Exception:
        return None
    status = getattr(response, "status_code", 0)
    text = getattr(response, "text", "") or ""
    # Weekends and holidays answer 403; a login/error page answers 200 with HTML.
    if status != 200 or not text.startswith("Date|"):
        return None
    symbols = parse_daily_text(text)
    if not symbols:
        return None
    return DayFile(
        trade_date=day.strftime("%Y%m%d"),
        symbols=symbols,
        checksum=checksum_of(text),
        source_url=url,
        fetched_at=datetime.now(timezone.utc),
        row_count=len(symbols),
    )


def load_days(db, days: list[date]) -> dict[str, DayFile]:
    """Return {trade_date: DayFile} for the requested days, cache-first.

    Cached days are never re-fetched: FINRA's daily file is immutable once
    published. Days with no file (weekend/holiday) are simply absent.
    """
    wanted = {day.strftime("%Y%m%d"): day for day in days}
    loaded: dict[str, DayFile] = {}

    if db is not None and wanted:
        try:
            cursor = db[CACHE_COLLECTION].find({"trade_date": {"$in": list(wanted)}})
            for doc in cursor:
                day_file = DayFile.from_cache_doc(doc)
                if day_file.symbols:
                    loaded[day_file.trade_date] = day_file
        except Exception:
            pass

    missing = [day for key, day in wanted.items() if key not in loaded]
    if not missing:
        return loaded

    fetched: list[DayFile] = []
    with ThreadPoolExecutor(max_workers=max(1, MAX_WORKERS)) as pool:
        futures = {pool.submit(fetch_day, day): day for day in missing}
        for future in as_completed(futures):
            try:
                day_file = future.result()
            except Exception:
                day_file = None
            if day_file is not None:
                fetched.append(day_file)

    for day_file in fetched:
        loaded[day_file.trade_date] = day_file

    if db is not None and fetched:
        try:
            from pymongo import UpdateOne

            db[CACHE_COLLECTION].bulk_write(
                [
                    UpdateOne(
                        {"trade_date": day_file.trade_date},
                        {"$set": day_file.as_cache_doc()},
                        upsert=True,
                    )
                    for day_file in fetched
                ],
                ordered=False,
            )
        except Exception:
            pass

    return loaded


def series_for(days: dict[str, DayFile], ticker: str) -> list[tuple[str, float, float]]:
    """This ticker's (trade_date, short_vol, total_vol) rows, oldest first."""
    symbol = str(ticker or "").upper()
    rows: list[tuple[str, float, float]] = []
    for trade_date in sorted(days):
        pair = days[trade_date].symbols.get(symbol)
        if pair is None:
            continue
        short_vol, total_vol = pair
        if total_vol > 0:
            rows.append((trade_date, short_vol, total_vol))
    return rows
