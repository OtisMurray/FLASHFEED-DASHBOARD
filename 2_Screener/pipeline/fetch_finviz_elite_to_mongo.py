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

try:
    from bs4 import BeautifulSoup
except Exception:
    BeautifulSoup = None

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "1_News" / "pipeline"))
try:
    from source_status import record_source_status
except Exception:
    def record_source_status(*_args, **_kwargs):
        return None

FINVIZ_AUTH_DIR = Path(__file__).resolve().parents[2] / "chart-service"
if str(FINVIZ_AUTH_DIR) not in sys.path:
    sys.path.insert(0, str(FINVIZ_AUTH_DIR))
try:
    import finviz_auth as _finviz_auth
except Exception:
    _finviz_auth = None

load_dotenv()

MONGODB_URI = os.getenv("MONGODB_URI", "mongodb://localhost:27017/feedflash")
DB_NAME = os.getenv("MONGODB_DB", os.getenv("MONGO_DB", "feedflash"))
MONGO_TIMEOUT_MS = int(os.getenv("MONGO_SERVER_SELECTION_TIMEOUT_MS", "3000"))
AUTH_TOKEN = os.getenv("FINVIZ_AUTH_TOKEN") or os.getenv("FINVIZ_TOKEN") or ""
FINVIZ_COOKIE_FILE = os.getenv("FINVIZ_COOKIE_FILE") or os.getenv("FINVIZ_ELITE_COOKIE_FILE") or ""


def _load_cookie_from_file() -> str:
    candidates: list[Path] = []
    if FINVIZ_COOKIE_FILE:
        candidates.append(Path(FINVIZ_COOKIE_FILE).expanduser())
    candidates.extend([
        Path("config/finviz_cookie.txt"),
        Path(".finviz_cookie"),
        Path.home() / ".config" / "feedflash" / "finviz_cookie.txt",
    ])
    for candidate in candidates:
        try:
            if candidate.exists() and candidate.is_file():
                text = candidate.read_text(encoding="utf-8").strip()
                if text:
                    return text
        except Exception:
            continue
    return ""


FINVIZ_COOKIE = os.getenv("FINVIZ_COOKIE") or os.getenv("FINVIZ_ELITE_COOKIE") or _load_cookie_from_file()
AUTO_AUTH_CONFIGURED = bool(_finviz_auth and _finviz_auth.have_login())
FINVIZ_AUTH_MODE = (
    "auto_login_cookie" if AUTO_AUTH_CONFIGURED
    else "token" if AUTH_TOKEN
    else "cookie" if FINVIZ_COOKIE
    else "public_fallback"
)
MAX_WORKERS = int(os.getenv("FINVIZ_MAX_WORKERS", "3"))
TIMEOUT = int(os.getenv("FINVIZ_REQUEST_TIMEOUT", "25"))
MAX_RETRIES = int(os.getenv("FINVIZ_MAX_RETRIES", "3"))

TOKEN_EXPORT_URL = "https://elite.finviz.com/export"
COOKIE_EXPORT_URL = "https://elite.finviz.com/export/screener"
PUBLIC_SCREENER_URL = "https://finviz.com/screener.ashx"
# Finviz Elite's CSV export returns the full v=152 screener schema when these
# column ids are requested. Some numeric columns are unit-normalized by Finviz:
# Market Cap / shares / sales are reported in millions, while Average Volume is
# reported in thousands.
COLUMNS = ",".join(str(i) for i in range(0, 90))
PUBLIC_FALLBACK_LIMIT = max(20, min(200, int(os.getenv("FINVIZ_PUBLIC_FALLBACK_LIMIT", "100"))))
PUBLIC_FALLBACK_DROP_OLD = os.getenv("FINVIZ_PUBLIC_FALLBACK_DROP_OLD", "true").lower() not in {"0", "false", "no"}
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


def _new_session():
    session_factory = getattr(http_requests, "Session", None)
    return session_factory() if callable(session_factory) else http_requests


def _session_get(session, url: str, headers: dict[str, str]):
    try:
        return session.get(url, headers=headers, impersonate="chrome124", timeout=TIMEOUT)
    except TypeError:
        return session.get(url, headers=headers, timeout=TIMEOUT)


def _attach_auto_auth(session) -> bool:
    if not AUTO_AUTH_CONFIGURED:
        return False
    try:
        return bool(_finviz_auth.load_cookies_into(session))
    except Exception:
        return False


def _refresh_auto_auth() -> bool:
    if not AUTO_AUTH_CONFIGURED:
        return False
    try:
        _finviz_auth.refresh(force=True)
        return True
    except Exception:
        return False


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


def _has_unit_suffix(value) -> bool:
    text = str(value or "").strip().replace(",", "").replace("$", "").replace("%", "")
    return bool(text and text[-1:].upper() in {"K", "M", "B", "T"})


def _millions(value):
    number = _num(value)
    if number is None:
        return None
    return number if _has_unit_suffix(value) else number * 1_000_000


def _thousands(value):
    number = _num(value)
    if number is None:
        return None
    return number if _has_unit_suffix(value) else number * 1_000


def _int_millions(value):
    number = _millions(value)
    return int(number) if number is not None else None


def _int_thousands(value):
    number = _thousands(value)
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
    if AUTO_AUTH_CONFIGURED:
        candidates.append(("auto_login_cookie", f"{COOKIE_EXPORT_URL}?{urlencode(params)}"))
    if AUTH_TOKEN:
        token_params = {**params, "auth": AUTH_TOKEN}
        candidates.append(("token", f"{TOKEN_EXPORT_URL}?{urlencode(token_params)}"))
    if FINVIZ_COOKIE:
        candidates.append(("cookie", f"{COOKIE_EXPORT_URL}?{urlencode(params)}"))
    if not candidates:
        return tier, [], "Finviz authentication is not configured"

    headers = _request_headers()
    last_error = ""
    for auth_mode, url in candidates:
        session = _new_session()
        if auth_mode == "auto_login_cookie" and not _attach_auto_auth(session):
            last_error = "automatic Finviz login unavailable"
            continue
        resp = None
        for attempt in range(MAX_RETRIES):
            try:
                resp = _session_get(session, url, headers)
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

        if getattr(resp, "status_code", None) in {401, 403} and _refresh_auto_auth():
            session = _new_session()
            if _attach_auto_auth(session):
                auth_mode = "auto_login_cookie"
                auto_url = f"{COOKIE_EXPORT_URL}?{urlencode(params)}"
                try:
                    resp = _session_get(session, auto_url, headers)
                except Exception as exc:
                    last_error = f"auto-login retry failed: {exc.__class__.__name__}"

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
        volume = _int(_col(raw, "Volume"))
        rel_volume = _num(_col(raw, "Relative Volume", "Rel Volume"))
        avg_volume = _int_thousands(_col(raw, "Average Volume", "Avg Volume"))
        if avg_volume is not None and volume and rel_volume and avg_volume < 10_000:
            avg_volume = int(volume / max(0.01, rel_volume))
        row = {
            "ticker": ticker,
            "company": _col(raw, "Company"),
            "sector": _col(raw, "Sector"),
            "industry": _col(raw, "Industry"),
            "country": _col(raw, "Country"),
            "market_cap": _millions(_col(raw, "Market Cap")),
            "market_cap_tier": tier,
            "finviz_market_cap_tier": tier,
            "pe_ratio": _num(_col(raw, "P/E")),
            "forward_pe": _num(_col(raw, "Forward P/E")),
            "peg": _num(_col(raw, "PEG")),
            "ps_ratio": _num(_col(raw, "P/S")),
            "pb_ratio": _num(_col(raw, "P/B")),
            "price_to_cash": _num(_col(raw, "P/Cash")),
            "price_to_free_cash_flow": _num(_col(raw, "P/Free Cash Flow")),
            "dividend_yield": _num(_col(raw, "Dividend Yield")),
            "payout_ratio": _num(_col(raw, "Payout Ratio")),
            "eps_ttm": _num(_col(raw, "EPS (ttm)")),
            "eps_growth_this_y": _num(_col(raw, "EPS Growth This Year")),
            "eps_growth_next_y": _num(_col(raw, "EPS Growth Next Year")),
            "eps_growth_past_5y": _num(_col(raw, "EPS Growth Past 5 Years")),
            "eps_growth_next_5y": _num(_col(raw, "EPS Growth Next 5 Years")),
            "sales_growth_past_5y": _num(_col(raw, "Sales Growth Past 5 Years")),
            "eps_growth_qoq": _num(_col(raw, "EPS Growth Quarter Over Quarter")),
            "sales_growth": _num(_col(raw, "Sales Growth Quarter Over Quarter")),
            "shares_outstanding": _int_millions(_col(raw, "Shares Outstanding")),
            "shares_float": _int_millions(_col(raw, "Shares Float")),
            "insider_own": _num(_col(raw, "Insider Ownership")),
            "insider_transactions": _num(_col(raw, "Insider Transactions")),
            "inst_own": _num(_col(raw, "Institutional Ownership")),
            "inst_transactions": _num(_col(raw, "Institutional Transactions")),
            "float_short": _num(_col(raw, "Short Float")),
            "short_ratio": _num(_col(raw, "Short Ratio")),
            "roa": _num(_col(raw, "Return on Assets")),
            "roe": _num(_col(raw, "Return on Equity")),
            "roi": _num(_col(raw, "Return on Invested Capital")),
            "current_ratio": _num(_col(raw, "Current Ratio")),
            "quick_ratio": _num(_col(raw, "Quick Ratio")),
            "lt_debt_equity": _num(_col(raw, "LT Debt/Equity")),
            "debt_equity": _num(_col(raw, "Total Debt/Equity")),
            "gross_margin": _num(_col(raw, "Gross Margin")),
            "operating_margin": _num(_col(raw, "Operating Margin")),
            "profit_margin": _num(_col(raw, "Profit Margin")),
            "perf_week": _num(_col(raw, "Performance (Week)")),
            "perf_month": _num(_col(raw, "Performance (Month)")),
            "perf_quarter": _num(_col(raw, "Performance (Quarter)")),
            "perf_half": _num(_col(raw, "Performance (Half Year)")),
            "perf_year": _num(_col(raw, "Performance (Year)")),
            "perf_ytd": _num(_col(raw, "Performance (YTD)")),
            "beta": _num(_col(raw, "Beta")),
            "atr": _num(_col(raw, "Average True Range")),
            "volatility_week": _num(_col(raw, "Volatility (Week)")),
            "volatility_month": _num(_col(raw, "Volatility (Month)")),
            "sma20": _num(_col(raw, "20-Day Simple Moving Average")),
            "sma50": _num(_col(raw, "50-Day Simple Moving Average")),
            "sma200": _num(_col(raw, "200-Day Simple Moving Average")),
            "week_52_high": _num(_col(raw, "52-Week High")),
            "week_52_low": _num(_col(raw, "52-Week Low")),
            "rsi": _num(_col(raw, "RSI (14)", "RSI")),
            "change_from_open": _num(_col(raw, "Change from Open")),
            "gap": _num(_col(raw, "Gap")),
            "analyst": _col(raw, "Analyst Recom") or None,
            "avg_volume": avg_volume,
            "rel_volume": rel_volume,
            "volume": volume,
            "earnings_date": _col(raw, "Earnings Date") or None,
            "target_price": _num(_col(raw, "Target Price")),
            "ipo_date": _col(raw, "IPO Date") or None,
            "after_hours_close": _num(_col(raw, "After-Hours Close")),
            "after_hours_change": _num(_col(raw, "After-Hours Change")),
            "book_per_share": _num(_col(raw, "Book/sh")),
            "cash_per_share": _num(_col(raw, "Cash/sh")),
            "dividend": _num(_col(raw, "Dividend")),
            "employees": _int(_col(raw, "Employees")),
            "eps_next_q": _num(_col(raw, "EPS Next Q")),
            "income": _millions(_col(raw, "Income")),
            "index": _col(raw, "Index") or None,
            "optionable": _col(raw, "Optionable") or None,
            "previous_close": _num(_col(raw, "Prev Close", "Previous Close")),
            "sales": _millions(_col(raw, "Sales")),
            "shortable": _col(raw, "Shortable") or None,
            "short_interest": _int_millions(_col(raw, "Short Interest")),
            "float_percent": _num(_col(raw, "Float %")),
            "open": _num(_col(raw, "Open")),
            "high": _num(_col(raw, "High")),
            "low": _num(_col(raw, "Low")),
            "trades": _int(_col(raw, "Trades")),
            "price": round(price, 4) if price is not None else None,
            "change_pct": round(change_pct, 4) if change_pct is not None else None,
            "change_percent": round(change_pct, 4) if change_pct is not None else None,
            "quote_status": "priced" if price is not None else "screened",
            "quote_source": "finviz_elite_screener",
            "quote_updated_at": now_ts,
            "finviz_filter": filter_text,
            "finviz_auth_mode": auth_mode,
            "finviz_public_fallback": False,
            "finviz_seen_at": now,
            "source": "Finviz Elite",
        }
        rows.append({k: v for k, v in row.items() if v is not None})
    return tier, rows, None


def _http_get(url: str):
    try:
        return http_requests.get(url, headers=HEADERS, impersonate="chrome124", timeout=TIMEOUT)
    except TypeError:
        return http_requests.get(url, headers=HEADERS, timeout=TIMEOUT)


def _public_finviz_rows(limit: int = PUBLIC_FALLBACK_LIMIT) -> tuple[list[dict], list[str]]:
    if BeautifulSoup is None:
        return [], ["BeautifulSoup unavailable for public FinViz fallback"]

    rows: list[dict] = []
    errors: list[str] = []
    seen: set[str] = set()
    now = datetime.now(timezone.utc)
    now_ts = int(time.time())

    for start in range(1, limit + 1, 20):
        params = {
            "v": "152",
            "s": "ta_topgainers",
            "ft": "4",
            "o": "-change",
        }
        if start > 1:
            params["r"] = str(start)
        url = f"{PUBLIC_SCREENER_URL}?{urlencode(params)}"
        try:
            resp = _http_get(url)
            if resp.status_code != 200:
                errors.append(f"public top gainers http {resp.status_code}")
                continue
            soup = BeautifulSoup(resp.text or "", "html.parser")
        except Exception as exc:
            errors.append(f"public top gainers request failed: {exc}")
            continue

        page_count = 0
        for link in soup.find_all("a", href=re.compile(r"stock\?t=", re.I)):
            classes = set(link.get("class") or [])
            if "tab-link" not in classes:
                continue
            ticker = str(link.get_text(strip=True) or "").upper()
            if not re.fullmatch(r"[A-Z][A-Z0-9.-]{0,5}", ticker or "") or ticker in seen:
                continue
            tr = link.find_parent("tr")
            cells = [td.get_text(" ", strip=True) for td in (tr.find_all("td") if tr else [])]
            if len(cells) < 11 or not str(cells[0]).strip().isdigit():
                continue
            seen.add(ticker)
            page_count += 1
            change_pct = _num(cells[10])
            price = _num(cells[9])
            row = {
                "ticker": ticker,
                "company": cells[2],
                "sector": cells[3],
                "industry": cells[4],
                "country": cells[5],
                "market_cap": _millions(cells[6]),
                "market_cap_tier": "public_top_gainers",
                "finviz_market_cap_tier": "public_top_gainers",
                "pe_ratio": _num(cells[7]),
                "volume": _int(cells[8]),
                "price": round(price, 4) if price is not None else None,
                "change_pct": round(change_pct, 4) if change_pct is not None else None,
                "change_percent": round(change_pct, 4) if change_pct is not None else None,
                "quote_status": "priced" if price is not None else "screened",
                "quote_source": "finviz_elite_screener",
                "quote_updated_at": now_ts,
                "finviz_filter": "public_top_gainers",
                "finviz_public_fallback": True,
                "finviz_auth_mode": "public_fallback",
                "finviz_seen_at": now,
                "source": "Finviz Public Top Gainers",
                "screener_source": "Finviz Public",
            }
            rows.append({k: v for k, v in row.items() if v is not None})
            if len(rows) >= limit:
                break
        if page_count == 0:
            break
        if len(rows) >= limit:
            break

    return rows, errors


def _write_rows(screeners, rows: list[dict], previous: set[str], now: datetime, drop_old: bool) -> tuple[int, int]:
    ops = [
        UpdateOne(
            {"ticker": row["ticker"]},
            {"$set": row, "$setOnInsert": {"created_at": now}},
            upsert=True,
        )
        for row in rows
    ]
    dropped = 0
    current = {row["ticker"] for row in rows}
    if drop_old:
        for ticker in sorted(previous - current):
            ops.append(UpdateOne(
                {"ticker": ticker, "quote_source": "finviz_elite_screener"},
                {"$set": {"finviz_status": "dropped", "finviz_seen_at": now, "quote_source": "finviz_elite_screener"}},
                upsert=False,
            ))
            dropped += 1
    updated = 0
    if ops:
        result = screeners.bulk_write(ops, ordered=False)
        updated = int(result.modified_count + result.upserted_count)
    return updated, dropped


def _persist_momentum_snapshot(db, rows: list[dict], auth_mode: str) -> int:
    """Persist one real Finviz observation per minute for causal replay."""
    if not rows:
        return 0
    snapshot_sec = int(time.time() // 60 * 60)
    snapshot_at = datetime.fromtimestamp(snapshot_sec, tz=timezone.utc)
    ordered = sorted(
        rows,
        key=lambda row: (_num(row.get("change_pct")) is not None, _num(row.get("change_pct")) or -math.inf),
        reverse=True,
    )
    snapshot_rows = []
    for rank, row in enumerate(ordered, start=1):
        clean = dict(row)
        clean["rank"] = rank
        snapshot_rows.append(clean)
    source = "Finviz Public Top Gainers" if auth_mode.startswith("public_fallback") else "Finviz Elite"
    doc = {
        "snapshot_sec": snapshot_sec,
        "snapshot_at": snapshot_at,
        "updated_at": datetime.now(timezone.utc),
        "source": source,
        "auth_mode": auth_mode,
        "count": len(snapshot_rows),
        "top_tickers": [row.get("ticker") for row in snapshot_rows[:20] if row.get("ticker")],
        "rows": snapshot_rows,
    }
    collection = db["finviz_momentum_snapshots"]
    collection.update_one(
        {"_id": f"finviz_momentum:{snapshot_sec}"},
        {"$set": doc, "$setOnInsert": {"created_at": snapshot_at}},
        upsert=True,
    )
    collection.create_index([("snapshot_sec", -1)])
    collection.create_index([("rows.ticker", 1), ("snapshot_sec", -1)])
    return len(snapshot_rows)


def main() -> None:
    client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=MONGO_TIMEOUT_MS)
    db = client[DB_NAME]

    screeners = db.screeners

    if not AUTH_TOKEN and not FINVIZ_COOKIE and not AUTO_AUTH_CONFIGURED:
        rows, errors = _public_finviz_rows(PUBLIC_FALLBACK_LIMIT)
        previous = set(
            doc["ticker"]
            for doc in screeners.find(
                {"quote_source": "finviz_elite_screener", "finviz_status": {"$ne": "dropped"}},
                {"ticker": 1},
            )
            if doc.get("ticker")
        )
        for row in rows:
            row["finviz_status"] = "same" if row["ticker"] in previous else "added"
        updated, dropped = _write_rows(screeners, rows, previous, datetime.now(timezone.utc), PUBLIC_FALLBACK_DROP_OLD)
        snapshotted = _persist_momentum_snapshot(db, rows, "public_fallback")
        detail = "FINVIZ_AUTH_TOKEN/FINVIZ_COOKIE not set; used public top-gainers fallback; no secret values printed"
        if errors:
            detail = f"{detail}; {'; '.join(errors[:3])}"
        for error in errors[:8]:
            print(f"Finviz public warning: {error}")
        status = "working_public" if rows else "api_key_required"
        record_source_status(db, "Finviz Elite Screener", status, detail=detail, count=len(rows), source_type="numeric_screener")
        print(f"Finviz public fallback — {len(rows)} rows")
        print(f"Finviz momentum snapshot — {snapshotted} real rows")
        print(f"Finviz Elite import complete — {len(rows)} rows, {updated} updated, {dropped} dropped")
        client.close()
        return

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

    row_auth_modes = {str(row.get("finviz_auth_mode") or "") for row in all_rows}
    auth_mode_label = (
        "auto_login_cookie" if "auto_login_cookie" in row_auth_modes
        else "token" if "token" in row_auth_modes
        else "cookie" if "cookie" in row_auth_modes
        else FINVIZ_AUTH_MODE
    )
    if not all_rows:
        fallback_rows, fallback_errors = _public_finviz_rows(PUBLIC_FALLBACK_LIMIT)
        if fallback_rows:
            previous = set(
                doc["ticker"]
                for doc in screeners.find(
                    {"quote_source": "finviz_elite_screener", "finviz_status": {"$ne": "dropped"}},
                    {"ticker": 1},
                )
                if doc.get("ticker")
            )
            for row in fallback_rows:
                row["finviz_status"] = "same" if row["ticker"] in previous else "added"
                row["finviz_auth_mode"] = "public_fallback_after_auth_failure"
                row["finviz_auth_failed_at"] = now
            fallback_updated, _ = _write_rows(screeners, fallback_rows, previous, now, False)
            all_rows = fallback_rows
            updated += fallback_updated
            auth_mode_label = "public_fallback_after_auth_failure"
            errors.extend(fallback_errors)
            print(f"Finviz auth failed; public fallback preserved old full-universe rows and refreshed {len(fallback_rows)} top gainers")

    for error in errors[:8]:
        print(f"Finviz warning: {error}")
    snapshotted = _persist_momentum_snapshot(db, all_rows, auth_mode_label)
    status = "working" if auth_mode_label in {"token", "cookie", "auto_login_cookie"} and all_rows else "working_public" if all_rows else "error"
    detail_parts = [
        f"auth_mode={auth_mode_label}",
        "cookie_file_checked" if FINVIZ_COOKIE_FILE else "",
        "public fallback did not drop old authenticated rows" if auth_mode_label == "public_fallback_after_auth_failure" else "",
        "; ".join(errors[:4]) if errors else "",
    ]
    detail = "; ".join(part for part in detail_parts if part)
    record_source_status(db, "Finviz Elite Screener", status, detail=detail, count=len(all_rows), source_type="numeric_screener")
    print(f"Finviz momentum snapshot — {snapshotted} real rows")
    print(f"Finviz Elite import complete — {len(all_rows)} rows, {updated} updated, {dropped} dropped")
    client.close()


if __name__ == "__main__":
    main()
