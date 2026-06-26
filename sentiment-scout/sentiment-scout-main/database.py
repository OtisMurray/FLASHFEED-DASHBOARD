"""
SQLite database layer for Sentiment Screener.
Tables: screener_runs, ticker_insights
"""

import json
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

DB_PATH = Path(__file__).parent / "sentiment_screener.db"

# ─── SCHEMA ───────────────────────────────────────────────────────────────────

SCHEMA = """
CREATE TABLE IF NOT EXISTS screener_runs (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    run_timestamp    TEXT    NOT NULL,
    total_tickers    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ticker_insights (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id            INTEGER NOT NULL REFERENCES screener_runs(id),
    ticker            TEXT    NOT NULL,
    company           TEXT,
    sector            TEXT,
    price             REAL,
    change_pct        TEXT,
    rel_volume        TEXT,
    rsi               TEXT,
    direction         TEXT,
    conviction        INTEGER,
    timing            TEXT,
    news_catalyst     TEXT,
    summary           TEXT,
    risk_factors      TEXT,   -- JSON array string
    article_headlines TEXT,   -- JSON array string
    high_conviction   INTEGER DEFAULT 0,  -- 1 = appeared in both Finviz + RSS
    was_correct       INTEGER,  -- NULL=unchecked, 1=correct, 0=wrong
    price_at_check    REAL,
    created_at        TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS rss_items (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    fetched_at         TEXT    NOT NULL,
    source             TEXT    NOT NULL,
    title              TEXT    NOT NULL,
    published_at       TEXT,
    link               TEXT    UNIQUE,   -- deduplicate across runs
    description        TEXT,
    extracted_tickers  TEXT,             -- JSON array string
    finviz_match       INTEGER DEFAULT 0
);
"""

_MIGRATIONS = [
    "ALTER TABLE ticker_insights ADD COLUMN high_conviction INTEGER DEFAULT 0",
    "ALTER TABLE ticker_insights ADD COLUMN stocktwits_posts TEXT",      # JSON array
    "ALTER TABLE ticker_insights ADD COLUMN stocktwits_bull_count INTEGER DEFAULT 0",
    "ALTER TABLE ticker_insights ADD COLUMN stocktwits_bear_count INTEGER DEFAULT 0",
    "ALTER TABLE ticker_insights ADD COLUMN stocktwits_watchlist INTEGER DEFAULT 0",
    "ALTER TABLE ticker_insights ADD COLUMN news_sources TEXT",          # JSON array of source names
    "ALTER TABLE ticker_insights ADD COLUMN market_cap TEXT",            # e.g. "1.5B"
    "ALTER TABLE rss_items ADD COLUMN matched_keyword TEXT",             # literal text that passed the keyword filter
    # Extended-hours fields (Finviz c=71,72,81,86). ah_change is Finviz's single
    # extended-hours number — pre-market before the open, after-hours after the
    # close; capture_session records which applies to this row.
    "ALTER TABLE ticker_insights ADD COLUMN ah_close TEXT",
    "ALTER TABLE ticker_insights ADD COLUMN ah_change TEXT",
    "ALTER TABLE ticker_insights ADD COLUMN prev_close TEXT",
    "ALTER TABLE ticker_insights ADD COLUMN open_price TEXT",
    "ALTER TABLE ticker_insights ADD COLUMN capture_session TEXT",
    # One-line LLM rationale for the conviction score (AI Top Picks ranking).
    "ALTER TABLE ticker_insights ADD COLUMN reason TEXT",
]


# ─── CONNECTION ───────────────────────────────────────────────────────────────

def get_connection() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db():
    with get_connection() as conn:
        conn.executescript(SCHEMA)
        for migration in _MIGRATIONS:
            try:
                conn.execute(migration)
            except sqlite3.OperationalError:
                pass  # column already exists


# ─── WRITES ───────────────────────────────────────────────────────────────────

def save_run(total_tickers: int) -> int:
    """Insert a screener_runs row and return its id."""
    now = datetime.now(timezone.utc).isoformat()
    with get_connection() as conn:
        cur = conn.execute(
            "INSERT INTO screener_runs (run_timestamp, total_tickers) VALUES (?, ?)",
            (now, total_tickers),
        )
        return cur.lastrowid


def save_insight(run_id: int, stock: dict, insight: dict):
    """Insert one ticker_insights row from merged stock + insight dicts."""
    now = datetime.now(timezone.utc).isoformat()

    def safe_float(val):
        try:
            return float(str(val).replace(",", "").replace("%", "").strip())
        except (ValueError, TypeError):
            return None

    news_items = stock.get("news", [])
    headlines = [item.get("headline", "") for item in news_items]

    # Deduplicated ordered list of sources actually used in the prompt
    seen: set[str] = set()
    news_sources: list[str] = []
    for item in news_items:
        src = item.get("source", "")
        if src and src not in seen:
            seen.add(src)
            news_sources.append(src)
    # Always include Stocktwits if we have posts
    st = stock.get("stocktwits") or {}
    if st.get("posts"):
        if "Stocktwits" not in seen:
            news_sources.append("Stocktwits")

    high_conviction = 1 if stock.get("high_conviction") else 0

    # Stocktwits fields
    st_posts = json.dumps([
        {"text": p.get("text_clean") or p.get("text", ""),
         "sentiment": p.get("sentiment"),
         "timestamp": p.get("timestamp", "")}
        for p in st.get("posts", [])
    ])
    st_bull = st.get("bullish_count", 0)
    st_bear = st.get("bearish_count", 0)
    st_wl   = st.get("watchlist_count", 0)

    with get_connection() as conn:
        conn.execute(
            """
            INSERT INTO ticker_insights (
                run_id, ticker, company, sector,
                price, change_pct, rel_volume, rsi,
                market_cap,
                direction, conviction, timing,
                news_catalyst, summary, reason,
                risk_factors, article_headlines,
                high_conviction,
                stocktwits_posts, stocktwits_bull_count,
                stocktwits_bear_count, stocktwits_watchlist,
                news_sources,
                ah_close, ah_change, prev_close, open_price, capture_session,
                was_correct, price_at_check, created_at
            ) VALUES (
                ?, ?, ?, ?,
                ?, ?, ?, ?,
                ?,
                ?, ?, ?,
                ?, ?, ?,
                ?, ?,
                ?,
                ?, ?, ?, ?,
                ?,
                ?, ?, ?, ?, ?,
                NULL, NULL, ?
            )
            """,
            (
                run_id,
                insight.get("ticker") or stock.get("ticker"),
                stock.get("company"),
                stock.get("sector"),
                safe_float(stock.get("price")),
                stock.get("change_pct"),
                stock.get("relative_volume"),
                stock.get("rsi"),
                stock.get("market_cap"),
                insight.get("direction"),
                insight.get("conviction"),
                insight.get("timing"),
                insight.get("news_catalyst"),
                insight.get("summary"),
                insight.get("reason"),
                json.dumps(insight.get("risk_factors") or []),
                json.dumps(headlines),
                high_conviction,
                st_posts, st_bull, st_bear, st_wl,
                json.dumps(news_sources),
                stock.get("ah_close"), stock.get("ah_change"),
                stock.get("prev_close"), stock.get("open_price"),
                stock.get("capture_session"),
                now,
            ),
        )


# ─── RSS ──────────────────────────────────────────────────────────────────────

def save_rss_items(articles: list[dict], finviz_tickers: set[str]):
    """
    Insert RSS articles into rss_items, skipping duplicates by link.
    finviz_tickers: set of ticker symbols returned by Finviz this run.
    """
    now = datetime.now(timezone.utc).isoformat()
    with get_connection() as conn:
        for article in articles:
            extracted = article.get("extracted_tickers", [])
            finviz_match = 1 if any(t in finviz_tickers for t in extracted) else 0
            try:
                conn.execute(
                    """
                    INSERT OR IGNORE INTO rss_items
                        (fetched_at, source, title, published_at, link,
                         description, extracted_tickers, finviz_match, matched_keyword)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        now,
                        article.get("source", ""),
                        article.get("title", ""),
                        article.get("published_at", ""),
                        article.get("link", ""),
                        article.get("description", ""),
                        json.dumps(extracted),
                        finviz_match,
                        article.get("matched_keyword"),
                    ),
                )
            except Exception:
                pass  # link uniqueness violation already handled by INSERT OR IGNORE


def get_recent_rss_items(limit: int = 20) -> list[dict]:
    """Return the most recently fetched RSS items for the dashboard."""
    rows = query(
        "SELECT * FROM rss_items ORDER BY id DESC LIMIT ?", (limit,)
    )
    results = []
    for r in rows:
        d = dict(r)
        try:
            d["extracted_tickers"] = json.loads(d.get("extracted_tickers") or "[]")
        except Exception:
            d["extracted_tickers"] = []
        results.append(d)
    return results


def query(sql: str, params: tuple = ()) -> list[sqlite3.Row]:
    with get_connection() as conn:
        return conn.execute(sql, params).fetchall()


# ─── PERFORMANCE CHECK ────────────────────────────────────────────────────────

def _fetch_current_price(ticker: str, curl_session) -> float | None:
    """Scrape current price from Finviz quote page for a ticker."""
    from bs4 import BeautifulSoup

    url = f"https://finviz.com/quote.ashx?t={ticker}"
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Referer": "https://finviz.com/",
    }
    try:
        resp = curl_session.get(url, headers=headers, impersonate="chrome124", timeout=15)
        resp.raise_for_status()
        soup = BeautifulSoup(resp.text, "lxml")

        # Primary: current Finviz DOM uses <strong class="quote-price_wrapper_price">
        price_tag = soup.find("strong", class_="quote-price_wrapper_price")
        if price_tag:
            txt = price_tag.get_text(strip=True)
            cleaned = re.sub(r"[^\d.]", "", txt)
            if cleaned:
                return float(cleaned)

        # Fallback 1: any <strong> whose class contains "price" and text looks like a number
        for strong in soup.find_all("strong"):
            cls = " ".join(strong.get("class") or [])
            if "price" in cls.lower():
                txt = strong.get_text(strip=True)
                cleaned = re.sub(r"[^\d.]", "", txt)
                if cleaned and 1 <= len(cleaned) <= 10:
                    try:
                        return float(cleaned)
                    except ValueError:
                        pass

        # Fallback 2: snapshot table — find "Price" label then read next sibling
        for td in soup.find_all("td"):
            if td.get_text(strip=True) == "Price":
                sibling = td.find_next_sibling("td")
                if sibling:
                    cleaned = re.sub(r"[^\d.]", "", sibling.get_text(strip=True))
                    if cleaned:
                        return float(cleaned)

    except Exception as e:
        print(f"    [WARN] Could not fetch price for {ticker}: {e}")
    return None


def _direction_correct(direction: str, entry_price: float, current_price: float) -> bool:
    """True if the direction matched the actual price movement."""
    delta = current_price - entry_price
    if direction == "long":
        return delta > 0
    if direction == "short":
        return delta < 0
    # neutral: correct only if price barely moved (within 0.5%)
    return abs(delta / entry_price) < 0.005


def check_performance(curl_session=None):
    """
    Find insights older than 1 hour with no was_correct verdict,
    fetch current price, mark was_correct, and print an accuracy summary.
    """
    from curl_cffi import requests as cffi_requests

    if curl_session is None:
        curl_session = cffi_requests.Session()

    with get_connection() as conn:
        rows = conn.execute(
            """
            SELECT id, ticker, price, direction, created_at
            FROM ticker_insights
            WHERE was_correct IS NULL
              AND direction IS NOT NULL
              AND direction != 'neutral'
              AND price IS NOT NULL
              AND created_at <= datetime('now', '-1 hour')
            """
        ).fetchall()

    if not rows:
        print("\n  No pending predictions older than 1 hour to evaluate.")
        return

    print(f"\n  Evaluating {len(rows)} pending prediction(s)...\n")
    for row in rows:
        current_price = _fetch_current_price(row["ticker"], curl_session)
        if current_price is None:
            print(f"    Skipping {row['ticker']} — could not fetch current price")
            continue

        correct = _direction_correct(row["direction"], row["price"], current_price)
        with get_connection() as conn:
            conn.execute(
                "UPDATE ticker_insights SET was_correct = ?, price_at_check = ? WHERE id = ?",
                (1 if correct else 0, current_price, row["id"]),
            )

        symbol = "✓" if correct else "✗"
        print(
            f"    {symbol} {row['ticker']}  {row['direction'].upper()}  "
            f"entry=${row['price']:.2f}  now=${current_price:.2f}  "
            f"({'correct' if correct else 'wrong'})"
        )

    _print_accuracy_summary()


def _print_accuracy_summary():
    """Query all evaluated predictions and print an accuracy breakdown."""
    with get_connection() as conn:
        rows = conn.execute(
            """
            SELECT direction,
                   COUNT(*)                          AS total,
                   SUM(CASE WHEN was_correct=1 THEN 1 ELSE 0 END) AS correct
            FROM ticker_insights
            WHERE was_correct IS NOT NULL
            GROUP BY direction
            """
        ).fetchall()

        overall = conn.execute(
            """
            SELECT COUNT(*) AS total,
                   SUM(CASE WHEN was_correct=1 THEN 1 ELSE 0 END) AS correct
            FROM ticker_insights
            WHERE was_correct IS NOT NULL
            """
        ).fetchone()

    if not overall or overall["total"] == 0:
        print("\n  No evaluated predictions yet.")
        return

    total = overall["total"]
    correct = overall["correct"] or 0
    pct = (correct / total * 100) if total else 0

    print("\n" + "─" * 50)
    print("  ACCURACY SUMMARY (all-time evaluated predictions)")
    print("─" * 50)
    print(f"  {'Direction':<12} {'Total':>6}  {'Correct':>8}  {'Accuracy':>9}")
    print(f"  {'─'*12}  {'─'*6}  {'─'*8}  {'─'*9}")
    for row in rows:
        d = row["direction"].upper()
        t = row["total"]
        c = row["correct"] or 0
        p = (c / t * 100) if t else 0
        print(f"  {d:<12} {t:>6}  {c:>8}  {p:>8.1f}%")
    print(f"  {'─'*12}  {'─'*6}  {'─'*8}  {'─'*9}")
    print(f"  {'TOTAL':<12} {total:>6}  {correct:>8}  {pct:>8.1f}%")
    print("─" * 50)
