"""
Priyanshu FeedFlash adapter: reads structured articles from feedflash.db (SQLite).
Fails gracefully if the DB is absent or empty.

Column mapping (Priyanshu's articles table -> dashboard fields):
    headline / title          -> headline
    source                    -> source
    datetime (ISO string)     -> timestamp   (falls back to publish_date unix int)
    ticker                    -> ticker
    sentiment OR sign of
      sentiment_combined      -> sentiment_label  (bullish | bearish | neutral)
    sentiment_finbert_prosus
      OR sentiment_ml         -> finbert_score    (FinBERT [-1, 1])
    sentiment_vader           -> vader_score      (VADER compound [-1, 1])
    url                       -> article_url
"""

import json
import logging
import os
import sqlite3
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

logger = logging.getLogger("priyanshu_adapter")

# Priyanshu's FeedFlash codebase is vendored into the repo at external/feedflash.
# The CODE default is repo-relative (this file lives at the repo root), so a fresh
# clone is self-contained with no ~/dev present. Override with FEEDFLASH_ROOT.
_REPO_ROOT = Path(__file__).resolve().parent
# Runtime/writable data lives under VAR_ROOT (default repo/var) so a deployed host
# can mount a persistent volume there; defaults keep local dev unchanged.
_VAR_ROOT = Path(os.environ.get("VAR_ROOT", str(_REPO_ROOT / "var")))
FEEDFLASH_ROOT = Path(os.environ.get(
    "FEEDFLASH_ROOT", str(_REPO_ROOT / "external" / "feedflash")))

# The WRITABLE DB must not churn the tracked external/ tree, so it defaults into
# the gitignored var/ runtime dir (override with FEEDFLASH_DB). Exported to the
# environment so the scorer subprocess (db_sqlite's FEEDFLASH_DB shim) writes to
# the same file the adapter reads.
FEEDFLASH_DB = os.environ.get(
    "FEEDFLASH_DB", str(_VAR_ROOT / "feedflash" / "feedflash.db"))
os.environ.setdefault("FEEDFLASH_DB", FEEDFLASH_DB)

# ─── NEWS SOURCE RECOGNITION + SELECTION ─────────────────────────────────────
# phase1 now captures each article's real publisher label off the Finviz news
# table (e.g. "PR Newswire", "Business Wire", "Benzinga") instead of a flat
# "Finviz". We canonicalise the noisy real-world labels to the eight sources the
# professor wanted selectable, plus an "Other" bucket for everything else so the
# existing aggregator/wire-service news is never silently dropped.
RECOGNIZED_SOURCES = [
    "Global Newswire", "PR Newswire", "Business Wire", "Dow Jones Newswires",
    "ACCESS Wire", "Benzinga", "SEC", "FDA",
    # TradingView news (fetched live by tradingview_adapter, FinBERT/VADER-scored).
    # Its own selectable source; the underlying provider is preserved per-item.
    "TradingView",
]
OTHER_SOURCE = "Other"
SOURCE_CATALOG = RECOGNIZED_SOURCES + [OTHER_SOURCE]

# lowercased alias substring -> canonical name. Ordered: more specific first.
_SOURCE_ALIASES = [
    ("globe newswire",  "Global Newswire"),
    ("globenewswire",   "Global Newswire"),
    ("global newswire", "Global Newswire"),
    ("pr newswire",     "PR Newswire"),
    ("prnewswire",      "PR Newswire"),
    ("business wire",   "Business Wire"),
    ("businesswire",    "Business Wire"),
    ("dow jones",       "Dow Jones Newswires"),
    ("access newswire", "ACCESS Wire"),
    ("accesswire",      "ACCESS Wire"),
    ("access wire",     "ACCESS Wire"),
    ("benzinga",        "Benzinga"),
    ("tradingview",     "TradingView"),
    ("food and drug",   "FDA"),
    ("fda",             "FDA"),
    ("securities and exchange", "SEC"),
    ("sec filing",      "SEC"),
    ("sec",             "SEC"),
]


def canonical_source(raw) -> str:
    """Map a raw publisher label to one of RECOGNIZED_SOURCES, else OTHER_SOURCE."""
    s = (raw or "").strip().lower()
    if not s:
        return OTHER_SOURCE
    for alias, canon in _SOURCE_ALIASES:
        if alias in s:
            return canon
    return OTHER_SOURCE


def display_source(raw) -> str:
    """Clean label for the UI: the canonical name for a recognised source, else
    the raw label as-is (so aggregators like Investing.com still read naturally)."""
    canon = canonical_source(raw)
    if canon != OTHER_SOURCE:
        return canon
    return (raw or "").strip() or "FeedFlash"


# Server-side persisted selection of enabled sources (subset of SOURCE_CATALOG),
# maintained from Settings → News Sources. Lives in the gitignored var/ runtime
# dir, same pattern as the credentials/keyword stores. Default = all enabled.
SELECTED_SOURCES_FILE = os.environ.get(
    "FEEDFLASH_SOURCES", str(_VAR_ROOT / "feedflash" / "selected_sources.json"))


def load_selected_sources() -> list:
    """Enabled source names. Returns the full catalog (everything on) when no
    selection has been saved yet, so news is never hidden by default."""
    try:
        with open(SELECTED_SOURCES_FILE) as fh:
            data = json.load(fh)
        sel = [s for s in data if s in SOURCE_CATALOG]
        return sel if sel else list(SOURCE_CATALOG)
    except (FileNotFoundError, ValueError, TypeError):
        return list(SOURCE_CATALOG)


def save_selected_sources(enabled: list) -> list:
    """Persist the enabled-source selection (validated against the catalog).
    Returns the saved list."""
    sel = [s for s in (enabled or []) if s in SOURCE_CATALOG]
    if not sel:                       # empty selection would hide everything
        sel = list(SOURCE_CATALOG)
    os.makedirs(os.path.dirname(SELECTED_SOURCES_FILE), exist_ok=True)
    with open(SELECTED_SOURCES_FILE, "w") as fh:
        json.dump(sel, fh)
    return sel

# Fixed candidate paths checked first (fast), in priority order. The gitignored
# runtime DB is primary; FEEDFLASH_ROOT-derived paths follow so an env-pointed
# external root (e.g. a teammate's existing DB) is still found.
_CANDIDATE_PATHS = [
    Path(FEEDFLASH_DB),
    FEEDFLASH_ROOT / "feedflash.db",
    FEEDFLASH_ROOT / "data" / "feedflash.db",
    FEEDFLASH_ROOT / "flashfeed-web" / "data" / "feedflash.db",
    FEEDFLASH_ROOT / "flashfeed-web" / "feedflash.db",
    Path(__file__).parent.parent / "FeedFlash" / "data" / "feedflash.db",
    Path(__file__).parent.parent / "FeedFlash" / "feedflash.db",
]

# Roots searched recursively if no fixed candidate matches
_SEARCH_ROOTS = [
    FEEDFLASH_ROOT,
    Path(__file__).parent / "codebases" / "priyanshu" / "FeedFlash-main",
]

COLUMN_MAPPING = {
    "headline":        "headline (fallback: title)",
    "source":          "source",
    "timestamp":       "datetime (fallback: publish_date unix int)",
    "ticker":          "ticker",
    "sentiment_label": "sentiment (fallback: sign of sentiment_combined)",
    "finbert_score":   "sentiment_finbert_prosus (fallback: sentiment_ml)",
    "vader_score":     "sentiment_vader",
    "article_url":     "url",
}

_mapping_printed = False


def _print_mapping_once():
    global _mapping_printed
    if _mapping_printed:
        return
    _mapping_printed = True
    print("  [priyanshu] column mapping (dashboard field <- feedflash column):")
    for field, col in COLUMN_MAPPING.items():
        print(f"  [priyanshu]   {field:16} <- {col}")


def _find_db():
    """Locate feedflash.db: fixed candidates first, then recursive search."""
    for p in _CANDIDATE_PATHS:
        try:
            if p.exists() and p.stat().st_size > 4096:  # >4 KB = real SQLite file
                return p
        except OSError:
            pass

    for root in _SEARCH_ROOTS:
        try:
            if not root.is_dir():
                continue
            for p in sorted(root.rglob("feedflash.db")):
                try:
                    if p.stat().st_size > 4096:
                        return p
                except OSError:
                    pass
        except OSError:
            pass
    return None


def _unix_to_iso(val):
    if isinstance(val, (int, float)) and val and val > 0:
        try:
            return datetime.fromtimestamp(val, tz=timezone.utc).isoformat()
        except (OSError, OverflowError, ValueError):
            pass
    return val


def _derive_label(sentiment, combined):
    """bullish / bearish / neutral from C++ label or sentiment_combined sign."""
    s = (sentiment or "").strip().lower()
    if s in ("bullish", "bearish", "neutral"):
        return s
    if combined is not None:
        try:
            c = float(combined)
            if c >= 0.15:
                return "bullish"
            if c <= -0.15:
                return "bearish"
            return "neutral"
        except (TypeError, ValueError):
            pass
    return None


def fetch_priyanshu_articles(limit: int = 50) -> list:
    """
    Return up to `limit` articles from feedflash.db, newest first.
    Each item carries both the canonical dashboard fields (headline, source,
    timestamp, ticker, sentiment_label, finbert_score, vader_score, article_url)
    and the legacy keys the existing News tab JS reads (title, url, sentiment,
    ml_confidence, publish_date, ...). Returns [] with a log line on any failure.
    """
    db_path = _find_db()
    if db_path is None:
        print("  [priyanshu] feedflash.db not found (candidates + recursive search) — returning []")
        return []

    _print_mapping_once()

    try:
        conn = sqlite3.connect(str(db_path), timeout=5)
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            """
            SELECT id,
                   COALESCE(headline, title)              AS headline,
                   source,
                   url,
                   category,
                   ticker,
                   `datetime`                             AS dt_text,
                   publish_date,
                   fetched_date,
                   sentiment,
                   sentiment_combined,
                   sentiment_category,
                   ml_confidence,
                   COALESCE(sentiment_finbert_prosus, sentiment_ml) AS finbert_score,
                   sentiment_vader                        AS vader_score
            FROM articles
            WHERE COALESCE(headline, title) IS NOT NULL
            ORDER BY COALESCE(`datetime`, publish_date, fetched_date) DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
        conn.close()

        out = []
        for r in rows:
            d = dict(r)
            timestamp = d.pop("dt_text", None) or _unix_to_iso(d.get("publish_date"))
            label = _derive_label(d.get("sentiment"), d.get("sentiment_combined"))
            d.update({
                # Canonical dashboard fields
                "headline":        d.get("headline"),
                "source":          display_source(d.get("source")),
                "timestamp":       timestamp,
                "ticker":          d.get("ticker"),
                "sentiment_label": label,
                "finbert_score":   d.get("finbert_score"),
                "vader_score":     d.get("vader_score"),
                "article_url":     d.get("url"),
                # Legacy keys the existing News tab JS reads
                "title":           d.get("headline"),
                "sentiment":       label,
                "publish_date":    timestamp,
                "fetched_date":    _unix_to_iso(d.get("fetched_date")),
                "company":         None,
                "sentiment_finbert_prosus": d.get("finbert_score"),
                "sentiment_vader": d.get("vader_score"),
            })
            out.append(d)

        print(f"  [priyanshu] fetched {len(out)} articles from {db_path}")
        return out

    except sqlite3.DatabaseError as exc:
        print(f"  [priyanshu] DB error ({db_path}): {exc} — returning []")
        return []
    except Exception as exc:
        print(f"  [priyanshu] unexpected error: {exc} — returning []")
        return []


def news_sentiment_by_ticker(days: int = 3) -> dict:
    """Aggregate the FeedFlash FinBERT/VADER scores per ticker over the last
    `days` of articles, for the React Screener's structured-news column.

    Each article's score is the mean of its available FinBERT and VADER scores
    (both in [-1, 1]); a ticker's score is the mean across its articles in the
    window. Returns {TICKER: {"score": float[-1,1], "count": int}} — only tickers
    with at least one scored article. {} if the DB is absent/unreadable. Pure
    read of feedflash.db — no scoring, no model call.
    """
    db_path = _find_db()
    if db_path is None:
        return {}

    cutoff = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d %H:%M:%S")
    try:
        conn = sqlite3.connect(str(db_path), timeout=5)
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            """
            SELECT UPPER(ticker)                              AS ticker,
                   COALESCE(sentiment_finbert_prosus, sentiment_ml) AS finbert,
                   sentiment_vader                            AS vader
            FROM articles
            WHERE ticker IS NOT NULL AND ticker != ''
              AND `datetime` IS NOT NULL AND `datetime` >= ?
            """,
            (cutoff,),
        ).fetchall()
        conn.close()
    except sqlite3.DatabaseError as exc:
        print(f"  [priyanshu] news agg DB error ({db_path}): {exc} — returning {{}}")
        return {}
    except Exception as exc:
        print(f"  [priyanshu] news agg unexpected error: {exc} — returning {{}}")
        return {}

    agg: dict = {}
    for r in rows:
        vals = [float(v) for v in (r["finbert"], r["vader"])
                if isinstance(v, (int, float))]
        if not vals:
            continue
        combined = sum(vals) / len(vals)
        a = agg.setdefault(r["ticker"], {"sum": 0.0, "count": 0})
        a["sum"] += combined
        a["count"] += 1

    out = {t: {"score": round(a["sum"] / a["count"], 4), "count": a["count"]}
           for t, a in agg.items() if a["count"]}
    print(f"  [priyanshu] news sentiment for {len(out)} tickers "
          f"(last {days}d, {len(rows)} scored articles)")
    return out


def feedflash_article_count() -> int:
    """Total scored-article count in feedflash.db — the same store the News page
    reads — for the TopBar pill. 0 if the DB is absent/unreadable. Cheap COUNT."""
    db_path = _find_db()
    if db_path is None:
        return 0
    try:
        conn = sqlite3.connect(str(db_path), timeout=5)
        n = conn.execute("SELECT COUNT(*) FROM articles").fetchone()[0]
        conn.close()
        return int(n or 0)
    except Exception:
        return 0


def ticker_articles(ticker: str, days: int = 3) -> list:
    """One ticker's FeedFlash articles over the last `days`, newest first, each
    with its FinBERT + VADER scores and a per-article sentiment label/score, for
    the Charts detail news panel. Pure read of feedflash.db — returns [] if the DB
    is absent/unreadable or the ticker has none in the window."""
    db_path = _find_db()
    if db_path is None or not ticker:
        return []
    cutoff = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d %H:%M:%S")
    try:
        conn = sqlite3.connect(str(db_path), timeout=5)
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            """
            SELECT id,
                   COALESCE(headline, title)                 AS headline,
                   source, url, `datetime`                   AS dt_text,
                   sentiment, sentiment_combined, sentiment_category, ml_confidence,
                   COALESCE(sentiment_finbert_prosus, sentiment_ml) AS finbert_score,
                   sentiment_vader                           AS vader_score
            FROM articles
            WHERE UPPER(ticker) = ?
              AND `datetime` IS NOT NULL AND `datetime` >= ?
            ORDER BY `datetime` DESC
            """,
            (ticker.upper(), cutoff),
        ).fetchall()
        conn.close()
    except Exception as exc:
        print(f"  [priyanshu] ticker_articles error ({ticker}): {exc} — returning []")
        return []

    out = []
    for r in rows:
        d = dict(r)
        label = _derive_label(d.get("sentiment"), d.get("sentiment_combined"))
        # Per-article score: FinBERT if present, else the combined score.
        score = d.get("finbert_score")
        if score is None:
            score = d.get("sentiment_combined")
        out.append({
            "id":            str(d.get("id")),
            "headline":      d.get("headline"),
            "source":        display_source(d.get("source")),
            "url":           d.get("url"),
            "timestamp":     d.get("dt_text"),
            "sentiment_label": label,
            "sentiment_score": round(score, 4) if isinstance(score, (int, float)) else None,
            "finbert_score": d.get("finbert_score"),
            "vader_score":   d.get("vader_score"),
            "category":      d.get("sentiment_category"),
        })
    return out


# ─── PIPELINE RUNNER (called by the dashboard scheduler) ─────────────────────

PIPELINE_DIR = FEEDFLASH_ROOT / "sentiment_analyzer"
PIPELINE_TIMEOUT_SEC = 120   # per-script budget; job runs every 5 min

# Writable ticker-list the scraper ingests, in the gitignored var/ runtime dir
# (NOT the vendored tree). phase1 reads this path via its FEEDFLASH_TICKERS shim.
FEEDFLASH_TICKERS_FILE = os.environ.get(
    "FEEDFLASH_TICKERS", str(_VAR_ROOT / "feedflash" / "tickers_with_news.json"))

# Always-on baseline so the legacy mega-cap news features keep data even when no
# mega-cap is a current mover. The screener movers are unioned on top, capped.
_NEWS_BASELINE = ["NVDA", "TSLA", "AAPL", "AMD"]


def screener_news_universe(limit: int = 25) -> list:
    """The tickers FeedFlash should ingest news for: the top `limit` movers from
    the latest multicap screener run (ranked by |% change|, then volume), unioned
    with the mega-cap baseline. Pure DB read of the multicap table — no Finviz
    call. Falls back to the baseline if the screener table is empty/unreadable."""
    def _n(x):
        try:
            return abs(float(str(x).replace("%", "").replace(",", "").strip()))
        except (TypeError, ValueError):
            return 0.0
    try:
        import multicap_screener
        rows = [r for r in multicap_screener.get_latest_multicap(limit=500)
                if r.get("status") != "dropped" and r.get("ticker")]
        rows.sort(key=lambda r: (_n(r.get("change_pct")), _n(r.get("volume"))), reverse=True)
        movers = [r["ticker"].upper() for r in rows[:limit]]
    except Exception as exc:
        logger.warning("[priyanshu] could not read screener universe: %s", exc)
        movers = []
    # De-dup, baseline first so the mega-caps are never dropped by the cap.
    seen, out = set(), []
    for t in _NEWS_BASELINE + movers:
        if t and t not in seen:
            seen.add(t)
            out.append(t)
    return out


def run_priyanshu_pipeline(tickers: list = None, limit: int = 25) -> bool:
    """
    Run Priyanshu's pipeline once: phase1 (fetch Finviz headlines into
    feedflash.db) then phase2 (score with FinBERT/VADER via
    integrated_processor). Designed for APScheduler: never raises — any
    error or timeout is logged and swallowed so the dashboard stays up.

    The ticker universe is the live screener's current movers (capped at `limit`)
    rather than a fixed list, so the News Sentiment column has data for tickers
    actually on screen. phase1 fetches the PUBLIC finviz.com/quote.ashx news table
    per ticker (no Elite token, threaded with polite sleeps), so widening the list
    never touches the rate-limited quote_export token. Pass `tickers` to override.
    """
    if not PIPELINE_DIR.is_dir():
        logger.warning("[priyanshu] pipeline dir missing: %s", PIPELINE_DIR)
        return False

    universe = [t.upper() for t in (tickers or screener_news_universe(limit)) if t]
    try:
        os.makedirs(os.path.dirname(FEEDFLASH_TICKERS_FILE), exist_ok=True)
        with open(FEEDFLASH_TICKERS_FILE, "w") as fh:
            json.dump(universe, fh)
        print(f"  [priyanshu] news universe ({len(universe)}): {', '.join(universe[:12])}"
              f"{'…' if len(universe) > 12 else ''}")
    except Exception as exc:
        logger.error("[priyanshu] could not write ticker list %s: %s",
                     FEEDFLASH_TICKERS_FILE, exc)
        return False

    # phase1 reads the list from this env path (its FEEDFLASH_TICKERS shim).
    env = {**os.environ, "FEEDFLASH_TICKERS": FEEDFLASH_TICKERS_FILE}

    for script in ("phase1_headline_scraper.py", "phase2_sentiment_analysis.py"):
        try:
            result = subprocess.run(
                [sys.executable, script],
                cwd=str(PIPELINE_DIR),
                capture_output=True,
                text=True,
                timeout=PIPELINE_TIMEOUT_SEC,
                env=env,
            )
            if result.returncode != 0:
                logger.error("[priyanshu] %s exited %s: %s",
                             script, result.returncode, (result.stderr or "")[-400:])
                return False
            print(f"  [priyanshu] {script} OK")
        except subprocess.TimeoutExpired:
            logger.error("[priyanshu] %s timed out after %ss", script, PIPELINE_TIMEOUT_SEC)
            return False
        except Exception as exc:
            logger.error("[priyanshu] %s failed: %s", script, exc)
            return False
    return True


# ─── SEC EDGAR 8-K INGEST (free, no key, ticker-mapped) ──────────────────────
# The Finviz quote news table surfaces the wire services (PR Newswire, Business
# Wire, GlobeNewswire, ACCESSWIRE, Benzinga) but NOT SEC filings — those live in
# EDGAR. This pulls recent 8-K filings per screener ticker straight from EDGAR's
# free Atom feed and writes them into the SAME articles store (source="SEC"), so
# they flow through fetch_priyanshu_articles → /api/news/structured, the Charts
# detail news alert, and the Settings source filter with zero extra plumbing.
# EDGAR requires a descriptive User-Agent and asks for <=10 req/s; we stay polite.
SEC_USER_AGENT = os.environ.get(
    "SEC_USER_AGENT", "Sentiment-Scout research (contact: apa6457@psu.edu)")
_SEC_TICKER_MAP: dict = {}      # TICKER -> zero-padded CIK, fetched once per process


def _sec_ticker_cik_map() -> dict:
    """Official free ticker→CIK map (sec.gov/files/company_tickers.json), cached."""
    global _SEC_TICKER_MAP
    if _SEC_TICKER_MAP:
        return _SEC_TICKER_MAP
    try:
        import requests
        data = requests.get("https://www.sec.gov/files/company_tickers.json",
                            headers={"User-Agent": SEC_USER_AGENT}, timeout=15).json()
        _SEC_TICKER_MAP = {v["ticker"].upper(): str(v["cik_str"]).zfill(10)
                           for v in data.values()}
    except Exception as exc:
        logger.warning("[sec] ticker→CIK map fetch failed: %s", exc)
        _SEC_TICKER_MAP = {}
    return _SEC_TICKER_MAP


def run_sec_edgar_ingest(tickers: list = None, per_ticker: int = 5,
                         universe_limit: int = 25) -> int:
    """Fetch recent 8-K filings per ticker from SEC EDGAR and upsert them into the
    articles store as source='SEC'. Never raises — returns the number of new rows
    inserted (0 on any failure). Pure additive: INSERT OR IGNORE keyed on the
    filing URL (UNIQUE), so re-runs don't duplicate and nothing else is touched."""
    import requests
    from xml.etree import ElementTree as ET

    db_path = _find_db()
    if db_path is None:
        # No store yet — create via the vendored table helper so SEC can seed it.
        db_path = Path(FEEDFLASH_DB)
        os.makedirs(os.path.dirname(db_path), exist_ok=True)

    universe = [t.upper() for t in (tickers or screener_news_universe(universe_limit)) if t]
    cik_map = _sec_ticker_cik_map()
    if not cik_map:
        logger.warning("[sec] no CIK map — skipping SEC ingest")
        return 0

    ns = {"a": "http://www.w3.org/2005/Atom"}
    rows = []
    for t in universe:
        cik = cik_map.get(t)
        if not cik:
            continue
        url = (f"https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany"
               f"&CIK={cik}&type=8-K&dateb=&owner=include&count={per_ticker}&output=atom")
        try:
            resp = requests.get(url, headers={"User-Agent": SEC_USER_AGENT}, timeout=15)
            resp.raise_for_status()
            root = ET.fromstring(resp.text)
        except Exception as exc:
            logger.info("[sec] fetch failed for %s: %s", t, exc)
            time.sleep(0.4)
            continue
        for e in root.findall("a:entry", ns):
            title_el = e.find("a:title", ns)
            upd_el = e.find("a:updated", ns)
            link_el = e.find("a:link", ns)
            title = (title_el.text if title_el is not None else "8-K").strip()
            updated = (upd_el.text if upd_el is not None else None)
            href = link_el.get("href") if link_el is not None else None
            if not href:
                continue
            # Normalize to a UTC ISO datetime string the store sorts on.
            dt_iso = None
            if updated:
                try:
                    dt_iso = datetime.fromisoformat(updated).astimezone(timezone.utc).isoformat()
                except Exception:
                    dt_iso = updated
            day = (dt_iso or "")[:10]
            headline = f"SEC 8-K — Current report{(' (' + day + ')') if day else ''}"
            rows.append((f"sec-{cik}-{href.rsplit('/', 2)[-2] if '/' in href else href}",
                         t, headline, href, "SEC", dt_iso))
        time.sleep(0.4)   # EDGAR courtesy (well under 10 req/s)

    if not rows:
        return 0
    inserted = 0
    try:
        conn = sqlite3.connect(str(db_path), timeout=10)
        for _id, ticker, headline, href, source, dt_iso in rows:
            cur = conn.execute(
                "INSERT OR IGNORE INTO articles (id, ticker, headline, title, url, source, `datetime`) "
                "VALUES (?,?,?,?,?,?,?)",
                (_id, ticker, headline, headline, href, source, dt_iso))
            inserted += cur.rowcount
        conn.commit()
        conn.close()
    except sqlite3.DatabaseError as exc:
        logger.warning("[sec] DB write failed: %s", exc)
        return 0
    print(f"  [sec] EDGAR 8-K ingest: {inserted} new filings across {len(universe)} tickers")
    return inserted
