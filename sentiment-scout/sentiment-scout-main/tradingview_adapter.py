"""
TradingView news adapter: fetches TradingView's news-headlines feed via
curl_cffi (browser TLS impersonation), scores each headline with the same
FinBERT/VADER path the other structured news uses, and persists headline +
metadata + link (never article bodies) to a local SQLite store under var/.

TradingView is inherently brittle (undocumented endpoint, bot protection, rate
limits). Every network and parse path degrades gracefully: on a block, an
endpoint change, or an empty response we log the real error and no-op — never
fabricating items and never raising into the scheduler or the request thread.

Endpoint (probed live 2026-06-16):
    https://news-headlines.tradingview.com/v2/headlines
      ?client=web&lang=en&symbol=NASDAQ:AAPL     (per-symbol)
      ?client=web&lang=en&category=base          (general market feed)
  -> {"items": [ {id, title, provider, source, published(unix s), link,
                  relatedSymbols:[{symbol:"NASDAQ:AAPL"}], storyPath}, ... ]}

Output (fetch_tradingview_articles / ticker_articles) matches priyanshu_adapter's
canonical shape (headline, source, timestamp, ticker, sentiment_label,
finbert_score, vader_score, article_url + legacy title/url/sentiment/...), so it
merges cleanly into /api/news/structured and flows through the existing
canonical_source() / Settings → News Sources filter. `source` is the selectable
label "TradingView"; the underlying provider (Reuters, Dow Jones, …) is kept in
`provider`. canonical_source("TradingView") resolves to the recognized
"TradingView" source, so the existing per-source toggle filters it.
"""

import logging
import os
import sqlite3
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

logger = logging.getLogger("tradingview_adapter")

# Selectable top-level source label; underlying provider preserved per item.
SOURCE_NAME = "TradingView"

# Repo-relative code root; writable data under VAR_ROOT (default repo/var), same
# convention as priyanshu_adapter / yosef_adapter so a deployed host can mount a
# persistent volume and a fresh clone is self-contained.
_REPO_ROOT = Path(__file__).resolve().parent
_VAR_ROOT = Path(os.environ.get("VAR_ROOT", str(_REPO_ROOT / "var")))
STORE_PATH = Path(os.environ.get(
    "TRADINGVIEW_DB", str(_VAR_ROOT / "tradingview" / "tradingview_news.db")))
# Screener universe DB — the canonical path database.py resolves (repo root).
SCREENER_DB = _REPO_ROOT / "sentiment_screener.db"

NEWS_BASE = "https://news-headlines.tradingview.com/v2/headlines"
IMPERSONATE = "chrome124"
HEADERS = {
    "Origin": "https://www.tradingview.com",
    "Referer": "https://www.tradingview.com/",
    "Accept": "application/json",
    "Accept-Language": "en-US,en;q=0.9",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
}

# Per-ticker fetches need an EXCHANGE:TICKER symbol; we don't store the exchange,
# so try the common US venues and take the first that returns headlines.
EXCHANGE_PREFIXES = ("NASDAQ", "NYSE")

# Politeness / brittleness controls.
REQUEST_TIMEOUT = 15        # seconds per request
POLITE_DELAY = 0.5          # seconds between successive requests
MAX_RETRIES = 3             # on 429 / 5xx / transient network errors
BACKOFF_BASE = 1.5          # seconds; exponential: BASE * 2**attempt
MAX_TICKERS = 8             # cap per-ticker fan-out to stay polite
PERTICKER_DEADLINE = 30     # seconds; hard cap on the per-ticker fan-out phase
MAX_STORE_PER_RUN = 150     # cap items scored+stored per run (newest first)


# ─── SENTIMENT SCORING (same FinBERT/VADER path as the structured pipeline) ──
# Lazily loaded once. VADER is always available (nltk); FinBERT (ProsusAI) is
# loaded from the local HF cache when present and otherwise skipped — never an
# extra LLM/model API call. Mirrors FeedFlash's sentiment_scorer.py mapping.

_vader = None
_finbert = None
_finbert_tried = False


def _get_vader():
    global _vader
    if _vader is None:
        try:
            from nltk.sentiment.vader import SentimentIntensityAnalyzer
            _vader = SentimentIntensityAnalyzer()
        except Exception as exc:
            logger.warning("[tradingview] VADER unavailable: %s", exc)
            _vader = False
    return _vader or None


def _get_finbert():
    global _finbert, _finbert_tried
    if _finbert_tried:
        return _finbert
    _finbert_tried = True
    try:
        # Offline-first: use cached ProsusAI/finbert weights, don't hit the hub.
        os.environ.setdefault("HF_HUB_OFFLINE", "1")
        os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
        from transformers import pipeline
        _finbert = pipeline(
            "text-classification", model="ProsusAI/finbert",
            tokenizer="ProsusAI/finbert", device=-1, truncation=True, max_length=512,
        )
        print("  [tradingview] FinBERT (ProsusAI) loaded from cache")
    except Exception as exc:
        logger.warning("[tradingview] FinBERT unavailable (VADER-only): %s", exc)
        _finbert = None
    return _finbert


def _score_vader(text):
    v = _get_vader()
    if not v or not text:
        return None
    try:
        return round(float(v.polarity_scores(text)["compound"]), 4)
    except Exception:
        return None


def _finbert_compound(out):
    """Map one FinBERT output dict → compound in [-1, 1] (FeedFlash neutral-bias)."""
    label = out["label"].lower()
    conf = float(out["score"])
    if "positive" in label:
        return round(conf, 4)
    if "negative" in label:
        return round(-conf, 4)
    if conf < 0.7:
        return 0.15
    if conf < 0.85:
        return 0.05
    return 0.0


def _score_finbert_batch(texts):
    """Batched FinBERT scoring (one pipeline call) → list aligned to `texts`.
    Far faster than per-item on CPU. [None]*n if FinBERT is unavailable."""
    fb = _get_finbert()
    if not fb or not texts:
        return [None] * len(texts)
    try:
        return [_finbert_compound(o) for o in fb(texts)]
    except Exception as exc:
        logger.warning("[tradingview] FinBERT batch scoring failed: %s", exc)
        return [None] * len(texts)


def _label_from_scores(finbert, vader):
    """bullish / bearish / neutral from the available scores (FinBERT preferred)."""
    score = finbert if finbert is not None else vader
    if score is None:
        return None
    if score >= 0.15:
        return "bullish"
    if score <= -0.15:
        return "bearish"
    return "neutral"


# ─── STORE (headline + metadata + link only; never article bodies) ──────────

def _store_conn():
    STORE_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(STORE_PATH), timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS tv_news (
            tv_id           TEXT PRIMARY KEY,
            fetched_at      TEXT NOT NULL,
            headline        TEXT NOT NULL,
            provider        TEXT,
            source          TEXT NOT NULL,
            published_at    TEXT,
            url             TEXT,
            ticker          TEXT,
            urgency         INTEGER,
            sentiment_label TEXT,
            finbert_score   REAL,
            vader_score     REAL
        )
        """
    )
    return conn


# ─── SCREENER UNIVERSE ───────────────────────────────────────────────────────

def _read_screener_tickers(limit):
    conn = sqlite3.connect(str(SCREENER_DB), timeout=5)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT DISTINCT ticker FROM ticker_insights ORDER BY id DESC LIMIT ?",
        (limit * 3,),
    ).fetchall()
    conn.close()
    seen, out = set(), []
    for r in rows:
        t = (r["ticker"] or "").strip().upper()
        if t and t not in seen:
            seen.add(t)
            out.append(t)
        if len(out) >= limit:
            break
    return out


def _current_screener_tickers(limit=MAX_TICKERS):
    """Latest distinct screener tickers (direct read, no dashboard import).

    Guarded by a daemon-thread join timeout: if the screener DB is ever slow or
    blocked (e.g. an iCloud-evicted file at the legacy Desktop path), per-ticker
    enrichment degrades to the always-available market feed instead of hanging
    the scheduler. SQLite's own `timeout` only covers lock contention, not an OS
    read that blocks under the lock."""
    if not SCREENER_DB.exists():
        return []
    import threading
    result = {"tickers": []}

    def worker():
        try:
            result["tickers"] = _read_screener_tickers(limit)
        except Exception as exc:
            logger.warning("[tradingview] screener ticker read failed: %s", exc)

    th = threading.Thread(target=worker, daemon=True)
    th.start()
    th.join(timeout=8)
    if th.is_alive():
        logger.warning("[tradingview] screener DB read timed out — using market feed only")
        return []
    return result["tickers"]


# ─── HTTP (curl_cffi browser impersonation + polite backoff) ─────────────────

def _get_json(params):
    """One polite GET with retry/backoff. Returns parsed JSON or None — never
    raises. A block (403/429), endpoint change (4xx/5xx), TLS/network error, or
    non-JSON body all return None with a real logged error."""
    try:
        from curl_cffi import requests
    except Exception as exc:
        logger.error("[tradingview] curl_cffi import failed: %s", exc)
        return None

    for attempt in range(MAX_RETRIES):
        try:
            resp = requests.get(NEWS_BASE, params=params, headers=HEADERS,
                                impersonate=IMPERSONATE, timeout=REQUEST_TIMEOUT)
        except Exception as exc:
            wait = BACKOFF_BASE * (2 ** attempt)
            logger.warning("[tradingview] request error (attempt %d/%d): %s — backoff %.1fs",
                           attempt + 1, MAX_RETRIES, exc, wait)
            time.sleep(wait)
            continue

        if resp.status_code == 200:
            try:
                return resp.json()
            except Exception as exc:
                logger.error("[tradingview] non-JSON 200 (endpoint changed?): %s | %r",
                             exc, resp.text[:200])
                return None
        if resp.status_code in (429, 500, 502, 503, 504):
            wait = BACKOFF_BASE * (2 ** attempt)
            logger.warning("[tradingview] HTTP %s (rate-limit/transient) — backoff %.1fs",
                           resp.status_code, wait)
            time.sleep(wait)
            continue
        logger.error("[tradingview] HTTP %s for params=%s — giving up (no items)",
                     resp.status_code, params)
        return None

    logger.error("[tradingview] exhausted %d retries for params=%s", MAX_RETRIES, params)
    return None


def _unix_to_iso(val):
    try:
        return datetime.fromtimestamp(float(val), tz=timezone.utc).isoformat()
    except (TypeError, ValueError, OSError, OverflowError):
        return None


def _ticker_from_related(item):
    rel = item.get("relatedSymbols") or []
    if rel and isinstance(rel, list):
        sym = (rel[0] or {}).get("symbol") or ""
        return (sym.split(":", 1)[1] if ":" in sym else sym).strip().upper() or None
    return None


def _normalize(item, queried_ticker=None):
    """Map one raw TradingView item to our store fields. Bodies are never kept."""
    story = item.get("storyPath") or ""
    url = item.get("link") or (f"https://www.tradingview.com{story}" if story else None)
    return {
        "tv_id":        item.get("id"),
        "headline":     (item.get("title") or "").strip(),
        "provider":     item.get("source") or item.get("provider"),
        "source":       SOURCE_NAME,
        "published_at": _unix_to_iso(item.get("published")),
        "url":          url,
        "ticker":       queried_ticker or _ticker_from_related(item),
        "urgency":      item.get("urgency"),
    }


def _fetch_headlines(symbol=None):
    """Fetch one feed (per-symbol if given, else the general market feed).
    Returns a list of raw item dicts, or [] on any failure."""
    params = {"client": "web", "lang": "en"}
    if symbol:
        params["symbol"] = symbol
    else:
        params["category"] = "base"
    data = _get_json(params)
    if not isinstance(data, dict):
        return []
    items = data.get("items")
    return items if isinstance(items, list) else []


# ─── PUBLIC: fetch + score + store ───────────────────────────────────────────

def fetch_and_store(tickers=None):
    """Fetch TradingView headlines (general feed + per-ticker for the screener
    universe), score, and upsert into the store. Returns count of new rows.
    Never raises."""
    if tickers is None:
        tickers = _current_screener_tickers()
    universe = {t.upper() for t in (tickers or [])}

    collected = {}
    logger.info("[tradingview] fetch start: universe=%d tickers", len(universe))

    # 1) General market feed — robust, no exchange needed. Keep items relevant to
    #    the screener universe (or all of them when we have no universe yet).
    for raw in _fetch_headlines():
        n = _normalize(raw)
        if not n["tv_id"] or not n["headline"]:
            continue
        if universe and (n["ticker"] not in universe):
            continue
        collected[n["tv_id"]] = n
    logger.info("[tradingview] after base feed: %d items", len(collected))

    # 2) Per-ticker feeds for current screener tickers (best-effort, deadline-bounded).
    deadline = time.time() + PERTICKER_DEADLINE
    for t in list(universe)[:MAX_TICKERS]:
        if time.time() > deadline:
            logger.info("[tradingview] per-ticker deadline reached — stopping fan-out")
            break
        for ex in EXCHANGE_PREFIXES:
            time.sleep(POLITE_DELAY)
            items = _fetch_headlines(symbol=f"{ex}:{t}")
            if items:
                for raw in items:
                    n = _normalize(raw, queried_ticker=t)
                    if n["tv_id"] and n["headline"]:
                        collected[n["tv_id"]] = n
                break

    if not collected:
        print("  [tradingview] no items fetched (blocked, empty, or no universe) — no-op")
        return 0

    try:
        conn = _store_conn()
    except sqlite3.DatabaseError as exc:
        logger.error("[tradingview] store open failed: %s", exc)
        return 0

    # 3) Keep only items not already stored, newest first, capped per run.
    fresh = []
    for n in sorted(collected.values(), key=lambda x: x["published_at"] or "", reverse=True):
        if not conn.execute("SELECT 1 FROM tv_news WHERE tv_id = ?", (n["tv_id"],)).fetchone():
            fresh.append(n)
        if len(fresh) >= MAX_STORE_PER_RUN:
            break

    if not fresh:
        conn.close()
        print(f"  [tradingview] fetched {len(collected)} items, 0 new (all known) — no-op")
        return 0

    # 4) Score (FinBERT batched + VADER) and insert.
    logger.info("[tradingview] collected=%d, scoring %d new items", len(collected), len(fresh))
    finberts = _score_finbert_batch([n["headline"] for n in fresh])
    now = datetime.now(timezone.utc).isoformat()
    new_rows = 0
    try:
        with conn:
            for n, finbert in zip(fresh, finberts):
                vader = _score_vader(n["headline"])
                label = _label_from_scores(finbert, vader)
                conn.execute(
                    """INSERT OR IGNORE INTO tv_news
                       (tv_id, fetched_at, headline, provider, source, published_at,
                        url, ticker, urgency, sentiment_label, finbert_score, vader_score)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (n["tv_id"], now, n["headline"], n["provider"], n["source"],
                     n["published_at"], n["url"], n["ticker"], n["urgency"],
                     label, finbert, vader),
                )
                new_rows += 1
        conn.close()
    except sqlite3.DatabaseError as exc:
        logger.error("[tradingview] store write failed: %s", exc)
        return 0

    print(f"  [tradingview] fetched {len(collected)} items, scored+stored {new_rows} new → {STORE_PATH.name}")
    return new_rows


def _row_to_article(d):
    """Store row → priyanshu-canonical article dict (so the structured route,
    /api/articles and the Charts detail panel all render it unchanged)."""
    ts = d.get("published_at") or d.get("fetched_at")
    fb = d.get("finbert_score")
    return {
        # Canonical dashboard fields
        "id":              d.get("tv_id"),
        "headline":        d.get("headline"),
        "source":          SOURCE_NAME,            # selectable label; canonical_source → "TradingView"
        "provider":        d.get("provider"),      # underlying provider preserved
        "category":        None,
        "timestamp":       ts,
        "ticker":          d.get("ticker"),
        "sentiment_label": d.get("sentiment_label"),
        "finbert_score":   fb,
        "vader_score":     d.get("vader_score"),
        "article_url":     d.get("url"),
        "urgency":         d.get("urgency"),
        # Legacy keys the existing News tab / Charts JS reads
        "title":           d.get("headline"),
        "url":             d.get("url"),
        "sentiment":       d.get("sentiment_label"),
        "ml_confidence":   abs(fb) if fb is not None else None,
        "publish_date":    ts,
        "company":         None,
        "sentiment_finbert_prosus": fb,
        "sentiment_vader": d.get("vader_score"),
    }


def fetch_tradingview_articles(limit=50):
    """Up to `limit` stored TradingView articles, newest first, in priyanshu's
    canonical shape. Returns [] on any failure."""
    if not STORE_PATH.exists():
        print("  [tradingview] store not present yet — returning []")
        return []
    try:
        conn = _store_conn()
        rows = conn.execute(
            "SELECT * FROM tv_news ORDER BY COALESCE(published_at, fetched_at) DESC LIMIT ?",
            (limit,),
        ).fetchall()
        conn.close()
    except sqlite3.DatabaseError as exc:
        logger.error("[tradingview] store read failed: %s", exc)
        return []
    out = [_row_to_article(dict(r)) for r in rows]
    print(f"  [tradingview] returning {len(out)} stored articles")
    return out


def ticker_articles(ticker, days=3, limit=50):
    """Stored TradingView articles for one ticker within the last `days`, newest
    first, in canonical shape. For the Charts detail news panel. [] on failure."""
    ticker = (ticker or "").strip().upper()
    if not ticker or not STORE_PATH.exists():
        return []
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    try:
        conn = _store_conn()
        rows = conn.execute(
            """SELECT * FROM tv_news
               WHERE ticker = ? AND COALESCE(published_at, fetched_at) >= ?
               ORDER BY COALESCE(published_at, fetched_at) DESC LIMIT ?""",
            (ticker, cutoff, limit),
        ).fetchall()
        conn.close()
    except sqlite3.DatabaseError as exc:
        logger.error("[tradingview] ticker read failed: %s", exc)
        return []
    return [_row_to_article(dict(r)) for r in rows]


# ─── PIPELINE RUNNER (called by the dashboard scheduler) ─────────────────────

def run_tradingview_pipeline():
    """One fetch+score+store cycle. Never raises — for APScheduler."""
    try:
        fetch_and_store()
        return True
    except Exception as exc:                       # pragma: no cover - safety net
        logger.error("[tradingview] pipeline failed: %s", exc)
        return False


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    new = fetch_and_store()
    print(f"\nNew rows: {new}")
    for a in fetch_tradingview_articles(limit=8):
        print(f"  [{a['sentiment']}] {a['ticker'] or '-':6} {(a['provider'] or '?')[:12]:12} "
              f"fb={a['finbert_score']} | {a['headline'][:64]}")
