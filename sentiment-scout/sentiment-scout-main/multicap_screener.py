"""
Multi-cap screener: polls 6 Finviz market-cap tiers in parallel via curl_cffi.
Stores results in multicap_screener table in sentiment_screener.db.
No Selenium required.
"""

import csv
import io
import sqlite3
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

from curl_cffi import requests as cffi_requests

import config

DB_PATH    = Path(__file__).parent / "sentiment_screener.db"

# v=152 custom view; c= picks columns explicitly (v=111 has no RelVol/RSI):
# 0 No. | 1 Ticker | 2 Company | 3 Sector | 4 Industry | 5 Country | 6 Market Cap
# 59 RSI (14) | 63 Average Volume | 64 Relative Volume | 65 Price | 66 Change | 67 Volume
# 71 After-Hours Close | 72 After-Hours Change (Finviz's extended-hours pair:
# pre-market before the open, after-hours after the close) | 81 Prev Close | 86 Open
_COLS = "c=0,1,2,3,4,5,6,59,63,64,65,66,67,71,72,81,86"
# Screener filters per tier; the auth token is appended at call time (see
# tier_urls) so a Settings-saved token applies on the next poll with no restart.
_TIER_FILTERS = {
    "mega":  "cap_mega,sh_curvol_o5000,sh_relvol_o1.5",
    "large": "cap_large,sh_curvol_o5000,sh_relvol_3.5to",
    "mid":   "cap_mid,sh_curvol_o1000,sh_relvol_3to",
    "small": "cap_small,sh_curvol_o500,sh_relvol_3.5to",
    "micro": "cap_micro,sh_curvol_o100,sh_relvol_3.3to",
    "nano":  "cap_nano,sh_curvol_o750,sh_relvol_5to",
}


def tier_urls() -> dict:
    """The 6 tier export URLs, built with the live Finviz token read at call time
    (Settings-store value if set, else .env). A UI-saved token is picked up on the
    next poll — nothing is frozen at import."""
    token = config.get_finviz_token()
    return {tier: f"https://elite.finviz.com/export?v=152&f={flt}&{_COLS}&auth={token}"
            for tier, flt in _TIER_FILTERS.items()}

CURL_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://finviz.com/",
}

SCHEMA = """
CREATE TABLE IF NOT EXISTS multicap_screener (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    run_timestamp   TEXT    NOT NULL,
    ticker          TEXT    NOT NULL,
    company         TEXT,
    market_cap_tier TEXT    NOT NULL,
    status          TEXT    NOT NULL DEFAULT 'same',
    price           REAL,
    change_pct      TEXT,
    volume          TEXT,
    rel_volume      TEXT,
    avg_volume      TEXT,
    rsi             TEXT,
    ah_close        TEXT,
    ah_change       TEXT,
    prev_close      TEXT,
    open_price      TEXT,
    capture_session TEXT
)
"""

# Additive migrations for DBs created before the extended-hours columns
_MIGRATIONS = [
    "ALTER TABLE multicap_screener ADD COLUMN ah_close TEXT",
    "ALTER TABLE multicap_screener ADD COLUMN ah_change TEXT",
    "ALTER TABLE multicap_screener ADD COLUMN prev_close TEXT",
    "ALTER TABLE multicap_screener ADD COLUMN open_price TEXT",
    "ALTER TABLE multicap_screener ADD COLUMN capture_session TEXT",
]


def capture_session(now=None) -> str:
    """Which market session a capture falls in (ET): pre | regular | post.
    Makes the single extended-hours number Finviz returns interpretable."""
    t = (now or datetime.now(ZoneInfo("America/New_York"))).strftime("%H:%M")
    if t < "09:30":
        return "pre"
    if t < "16:00":
        return "regular"
    return "post"

# In-memory state: previous ticker sets per tier (survives across scheduler calls)
_prev_tickers: dict = {}
_state_lock = threading.Lock()


def _init_db():
    conn = sqlite3.connect(str(DB_PATH))
    conn.execute(SCHEMA)
    for mig in _MIGRATIONS:
        try:
            conn.execute(mig)
        except sqlite3.OperationalError:
            pass  # column already exists
    conn.commit()
    conn.close()


def _fetch_tier(session, tier: str, url: str) -> tuple:
    """Fetch one tier CSV. Returns (tier, list_of_row_dicts)."""
    try:
        resp = session.get(url, headers=CURL_HEADERS, impersonate="chrome124", timeout=25)
        resp.raise_for_status()
        reader = csv.DictReader(io.StringIO(resp.text))
        rows = list(reader)
        print(f"  [multicap] {tier}: {len(rows)} rows")
        return tier, rows
    except Exception as exc:
        print(f"  [multicap] {tier}: ERROR — {exc}")
        return tier, None   # None = fetch failed (distinct from a legit empty tier);
                            # caller skips state/status bookkeeping to avoid false drops


def _safe_float(val):
    if val is None:
        return None
    try:
        return float(str(val).replace(",", "").replace("%", "").strip() or "nan") if str(val).strip() else None
    except (ValueError, TypeError):
        return None


def run_multicap_screener() -> dict:
    """
    Fetch all 6 tiers simultaneously and persist to DB.
    Returns a summary dict: {run_timestamp, total, by_tier}.
    """
    _init_db()
    session   = cffi_requests.Session()
    now_utc   = datetime.now(timezone.utc).isoformat()
    session_tag = capture_session()
    tier_rows: dict = {}

    with ThreadPoolExecutor(max_workers=6) as pool:
        futures = {pool.submit(_fetch_tier, session, tier, url): tier
                   for tier, url in tier_urls().items()}
        for fut in as_completed(futures):
            tier, rows = fut.result()
            tier_rows[tier] = rows

    conn = sqlite3.connect(str(DB_PATH))
    total_inserted = 0
    old_sets: dict = {}   # tier -> set BEFORE this cycle; the drop pass below
                          # needs it because _prev_tickers is overwritten here

    for tier, rows in tier_rows.items():
        if rows is None:   # fetch error — keep previous state untouched
            continue
        current_tickers = {(r.get("Ticker") or "").strip()
                           for r in rows if (r.get("Ticker") or "").strip()}

        with _state_lock:
            is_first = tier not in _prev_tickers
            old_set  = _prev_tickers.get(tier, set())
            _prev_tickers[tier] = current_tickers
        old_sets[tier] = old_set

        for row in rows:
            ticker = (row.get("Ticker") or "").strip()
            if not ticker:
                continue

            if is_first:
                status = "first"
            elif ticker not in old_set:
                status = "added"
            else:
                status = "same"

            conn.execute(
                """INSERT INTO multicap_screener
                   (run_timestamp, ticker, company, market_cap_tier, status,
                    price, change_pct, volume, rel_volume, avg_volume, rsi,
                    ah_close, ah_change, prev_close, open_price, capture_session)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    now_utc,
                    ticker,
                    (row.get("Company") or row.get("Name") or "").strip(),
                    tier,
                    status,
                    _safe_float(row.get("Price")),
                    (row.get("Change") or "").strip(),
                    (row.get("Volume") or "").strip(),
                    (row.get("Relative Volume") or row.get("Rel Volume") or "").strip(),
                    (row.get("Average Volume") or row.get("Avg Volume") or "").strip(),
                    (row.get("Relative Strength Index (14)") or row.get("RSI (14)") or row.get("RSI") or "").strip(),
                    (row.get("After-Hours Close") or "").strip(),
                    (row.get("After-Hours Change") or "").strip(),
                    (row.get("Prev Close") or "").strip(),
                    (row.get("Open") or "").strip(),
                    session_tag,
                ),
            )
            total_inserted += 1

    # Also record dropped tickers so the UI can show them
    for tier in tier_rows:
        if tier_rows[tier] is None:   # fetch error — can't infer drops this cycle
            continue
        old_set = old_sets.get(tier, set())
        current = {(r.get("Ticker") or "").strip() for r in tier_rows[tier]}
        dropped = old_set - current
        for ticker in dropped:
            conn.execute(
                """INSERT INTO multicap_screener
                   (run_timestamp, ticker, company, market_cap_tier, status,
                    price, change_pct, volume, rel_volume, avg_volume, rsi,
                    capture_session)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (now_utc, ticker, "", tier, "dropped",
                 None, "", "", "", "", "", session_tag),
            )

    conn.commit()
    conn.close()

    summary = {
        "run_timestamp": now_utc,
        "total":         total_inserted,
        "by_tier":       {t: (len(r) if r is not None else "error") for t, r in tier_rows.items()},
    }
    print(f"  [multicap] stored {total_inserted} rows across {len(tier_rows)} tiers")
    return summary


def get_latest_multicap(limit: int = 500) -> list:
    """Return rows from the most recent multicap run."""
    _init_db()
    try:
        conn = sqlite3.connect(str(DB_PATH))
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            """SELECT * FROM multicap_screener
               WHERE run_timestamp = (SELECT MAX(run_timestamp) FROM multicap_screener)
               ORDER BY market_cap_tier, ticker
               LIMIT ?""",
            (limit,),
        ).fetchall()
        conn.close()
        return [dict(r) for r in rows]
    except Exception as exc:
        print(f"  [multicap] get_latest_multicap error: {exc}")
        return []


if __name__ == "__main__":
    result = run_multicap_screener()
    print(result)
