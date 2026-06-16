"""
RSS Feed Fetcher — replaces the C++ feedflash binary for cloud deployment.

Fetches all configured RSS feeds, auto-extracts tickers (DS440 engine),
scores sentiment (DS440 rule-based lexicon), and upserts articles into
the shared Neon PostgreSQL database.

Run manually:
  python scripts/fetch_rss.py

Called by GitHub Actions (.github/workflows/rss-fetch.yml) every 15 min.

Environment:
  POSTGRES_DSN          — Neon PostgreSQL connection string (required)
  SENTIMENT_SERVICE_URL — Optional FinBERT service URL for deep NLP scoring
                          e.g. https://flashfeed-sentiment.railway.app
"""

from __future__ import annotations

import hashlib
import logging
import os
import sys
import time
from typing import Optional

import feedparser
import psycopg
import requests
from dotenv import load_dotenv

load_dotenv()

# ── DS440 modules (ticker extraction + rule-based sentiment) ─────────────────
_REPO_ROOT = os.path.dirname(os.path.dirname(__file__))
sys.path.insert(0, _REPO_ROOT)

try:
    from processing.ticker_extraction import extract_tickers
    from processing.sentiment_engine import score_sentiment
    _DS440_OK = True
except ImportError as _e:
    _DS440_OK = False
    print(f"[WARN] DS440 modules unavailable ({_e}); skipping ticker/sentiment tagging")

# ── Integrated-Sentiment-Analyzer (VADER + FinBERT) ──────────────────────────
_ISA_DIR = os.path.abspath(os.path.join(_REPO_ROOT, "..", "sentiment_analyzer"))
_isa_scorer = None

def _load_isa_scorer():
    global _isa_scorer
    if not os.path.isdir(_ISA_DIR):
        return
    try:
        sys.path.insert(0, _ISA_DIR)
        _saved_cwd = os.getcwd()
        os.chdir(_ISA_DIR)
        from sentiment_scorer import SentimentScorer
        _isa_scorer = SentimentScorer(use_cuda=False)
        os.chdir(_saved_cwd)
        print("[INFO] ISA SentimentScorer loaded (VADER + FinBERT)")
    except Exception as _e:
        print(f"[INFO] ISA SentimentScorer unavailable: {_e}")

_load_isa_scorer()

log = logging.getLogger(__name__)

HEADERS = {"User-Agent": "Mozilla/5.0 FeedFetch/2.0 (FlashFeed)"}

# ── RSS feed list (mirrors config.json in the C++ repo — fallback if DB unavailable)
RSS_FEEDS: list[tuple[str, str, str]] = [
    ("CNBC Markets",          "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=20910258",  "markets"),
    ("CNBC Finance",          "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10000664",  "markets"),
    ("MarketWatch Top",       "https://feeds.marketwatch.com/marketwatch/topstories/",                                "markets"),
    ("MarketWatch Breaking",  "https://feeds.marketwatch.com/marketwatch/bulletins/",                                 "markets"),
    ("Yahoo Finance",         "https://finance.yahoo.com/news/rssindex",                                              "markets"),
    # DISABLED until verified public feed/API: ("Benzinga",              "https://www.benzinga.com/feed/",                                                       "markets"),
    ("Seeking Alpha",         "https://seekingalpha.com/market_currents.xml",                                         "markets"),
    ("The Motley Fool",       "https://www.fool.com/feeds/index.aspx?id=fool-headlines",                              "equities"),
    # DISABLED broken 404 feed: ("Investopedia",          "https://www.investopedia.com/feedbuilder/feed/getNewsFeed",                            "markets"),
    # DISABLED requires licensed/official access: ("Reuters Business",      "https://feeds.reuters.com/reuters/businessNews",                                       "economy"),
    # DISABLED requires licensed/official access: ("Reuters Finance",       "https://feeds.reuters.com/reuters/financialsNews",                                     "economy"),
    ("BBC Business",          "https://feeds.bbci.co.uk/news/business/rss.xml",                                      "economy"),
    ("Federal Reserve",       "https://www.federalreserve.gov/feeds/press_all.xml",                                   "economy"),
    ("Forbes Business",       "https://www.forbes.com/business/feed/",                                               "economy"),
    ("ZeroHedge",             "https://cms.zerohedge.com/fullrss2.xml",                                              "equities"),
    ("Business Insider",      "https://feeds2.feedburner.com/businessinsider",                                        "equities"),
    ("SEC EDGAR 8-K",         "https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=8-K&dateb=&owner=include&count=40&search_text=&output=atom", "filings"),
    ("SEC EDGAR 10-Q",        "https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=10-Q&dateb=&owner=include&count=40&search_text=&output=atom", "filings"),
    ("SEC EDGAR 10-K",        "https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=10-K&dateb=&owner=include&count=40&search_text=&output=atom", "filings"),
    ("PR Newswire",           "https://www.prnewswire.com/rss/news-releases-list.rss",                               "press_releases"),
    # DISABLED: current RSS URL returns invalid channel ID; needs valid BusinessWire RSS/media feed: ("BusinessWire",          "https://feed.businesswire.com/rss/home/?rss=G1",                                      "press_releases"),
    ("GlobeNewswire Earnings","https://www.globenewswire.com/RssFeed/subjectcode/23-Earnings",                        "press_releases"),
    ("GlobeNewswire M&A",     "https://www.globenewswire.com/RssFeed/subjectcode/14-Mergers%20and%20Acquisitions",   "press_releases"),
    # DISABLED broken 404 feed; replace with official FDA endpoint later: ("FDA Drug Approvals",    "https://www.fda.gov/drugs/resources-information-approved-drugs/rss",                   "fda"),
    # DISABLED: returned HTML, use official Benzinga API/key: ("Benzinga", "https://www.benzinga.com/latest?feed=rss&page=1", "markets"),
    ("FDA Press Releases", "https://www.fda.gov/about-fda/contact-fda/stay-informed/rss-feeds/press-releases/rss.xml", "fda"),
    ("FDA Recalls", "https://www.fda.gov/about-fda/contact-fda/stay-informed/rss-feeds/recalls/rss.xml", "fda"),
    ("FDA What's New Drugs", "https://www.fda.gov/about-fda/contact-fda/stay-informed/rss-feeds/drugs/rss.xml", "fda"),
    ("FDA MedWatch Safety Alerts", "https://www.fda.gov/AboutFDA/ContactFDA/StayInformed/RSSFeeds/MedWatch/rss.xml", "fda"),
    ("CoinDesk",              "https://www.coindesk.com/arc/outboundfeeds/rss/",                                     "crypto"),
    ("CoinTelegraph",         "https://cointelegraph.com/rss",                                                        "crypto"),
    ("OilPrice",              "https://oilprice.com/rss/main",                                                        "commodities"),
    # DISABLED: current RSS URL redirects to invalid HTML page; needs verified ACCESS/Newswire feed: ("AccessWire",            "https://www.accesswire.com/rss/default.aspx",                                         "press_releases"),
]


def _load_feeds_from_db(dsn: str) -> list[tuple[str, str, str]]:
    """Load enabled RSS sources from the rss_sources PostgreSQL table."""
    try:
        with psycopg.connect(dsn) as conn:
            rows = conn.execute(
                "SELECT name, url, category FROM rss_sources WHERE enabled = TRUE ORDER BY name"
            ).fetchall()
        if rows:
            log.info("Loaded %d RSS sources from database", len(rows))
            return [(r[0], r[1], r[2]) for r in rows]
    except Exception as exc:
        log.debug("Could not load feeds from DB (%s); using hardcoded list", exc)
    return RSS_FEEDS


# ── Helpers ──────────────────────────────────────────────────────────────────

def _article_id(url: str) -> str:
    return hashlib.sha1(url.encode()).hexdigest()[:16]


def _fetch_feed(name: str, url: str, category: str, timeout: int = 15) -> list[dict]:
    try:
        resp = requests.get(url, headers=HEADERS, timeout=timeout)
        resp.raise_for_status()
        feed = feedparser.parse(resp.content)
    except Exception as exc:
        log.warning("%-30s  SKIP  %s", name, exc)
        return []

    articles = []
    for entry in feed.entries[:50]:
        link = getattr(entry, "link", "") or ""
        if not link:
            continue

        title = (getattr(entry, "title", "") or "").strip()

        # Content: prefer summary, fall back to first content block
        content = ""
        if hasattr(entry, "summary") and entry.summary:
            content = entry.summary
        elif hasattr(entry, "content") and entry.content:
            content = entry.content[0].get("value", "")
        content = content[:2000]

        # Publish timestamp
        pub_ts: Optional[int] = None
        if hasattr(entry, "published_parsed") and entry.published_parsed:
            try:
                pub_ts = int(time.mktime(entry.published_parsed))
            except Exception:
                pass

        articles.append({
            "id":           _article_id(link),
            "title":        title,
            "content":      content,
            "url":          link,
            "source":       name,
            "category":     category,
            "publish_date": pub_ts,
        })

    return articles


def _tag_articles(articles: list[dict]) -> list[dict]:
    """Add ticker symbols and sentiment to each article.

    Sentiment priority:
      1. ISA SentimentScorer (VADER + FinBERT) — when available locally
      2. DS440 rule-based lexicon — fallback
    """
    if not _DS440_OK and _isa_scorer is None:
        return articles

    for a in articles:
        title   = a.get("title", "")
        content = a.get("content", "")[:500]

        # Ticker extraction (DS440)
        if _DS440_OK:
            try:
                a["ticker"] = ",".join(extract_tickers(title, content))
            except Exception:
                a["ticker"] = ""

        # Sentiment scoring
        scored = False
        if _isa_scorer is not None:
            try:
                text   = f"{title}. {title}. {content}"  # title doubled for weight
                result = _isa_scorer.score(text)
                finbert = result.finbert if result.finbert is not None else 0.0
                vader   = result.vader   if result.vader   is not None else 0.0
                score   = finbert * 0.7 + vader * 0.3
                a["sentiment"]     = "bullish" if score > 0.05 else "bearish" if score < -0.05 else "neutral"
                a["ml_confidence"] = round(abs(finbert), 4)
                a["sentiment_at"]  = int(time.time())
                scored = True
            except Exception as _e:
                log.warning("ISA scoring failed for '%s': %s", title[:60], _e)

        if not scored and _DS440_OK:
            try:
                rb    = score_sentiment(title, content)
                score = rb["sentiment_score"]
                a["sentiment"]     = "bullish" if score > 0.05 else "bearish" if score < -0.05 else "neutral"
                a["ml_confidence"] = abs(round(score, 4))
                a["sentiment_at"]  = int(time.time())
            except Exception:
                a["sentiment"] = a["ml_confidence"] = a["sentiment_at"] = None

    return articles


def _upsert(articles: list[dict], dsn: str) -> tuple[int, int]:
    """INSERT ... ON CONFLICT DO NOTHING. Returns (inserted, skipped)."""
    now = int(time.time())
    inserted = skipped = 0

    with psycopg.connect(dsn) as conn:
        with conn.cursor() as cur:
            for a in articles:
                cur.execute(
                    """
                    INSERT INTO articles
                      (id, title, content, url, source, category,
                       publish_date, fetched_date, ticker,
                       sentiment, ml_confidence, sentiment_at)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                    ON CONFLICT (url) DO NOTHING
                    """,
                    (
                        a["id"], a["title"], a.get("content", ""),
                        a["url"], a["source"], a.get("category"),
                        a.get("publish_date"), now,
                        a.get("ticker", ""),
                        a.get("sentiment"), a.get("ml_confidence"),
                        a.get("sentiment_at"),
                    ),
                )
                if cur.rowcount:
                    inserted += 1
                else:
                    skipped += 1
        conn.commit()

    return inserted, skipped


# ── Optional: call FinBERT service for deep NLP scoring ─────────────────────

def _deep_analyze(dsn: str, service_url: str, batch: int = 50) -> int:
    """
    Re-score unanalyzed articles using the external FinBERT sentiment service.
    Only runs if SENTIMENT_SERVICE_URL is set.
    """
    with psycopg.connect(dsn) as conn:
        rows = conn.execute(
            "SELECT id, title, content FROM articles WHERE sentiment IS NULL LIMIT %s",
            (batch,),
        ).fetchall()

    if not rows:
        return 0

    articles = [{"id": r[0], "title": r[1], "content": (r[2] or "")[:800]} for r in rows]

    try:
        resp = requests.post(
            f"{service_url.rstrip('/')}/analyze-articles",
            json={"articles": articles},
            timeout=120,
        )
        resp.raise_for_status()
        results = resp.json().get("results", [])
    except Exception as exc:
        log.warning("FinBERT service call failed: %s", exc)
        return 0

    now = int(time.time())
    updated = 0
    with psycopg.connect(dsn) as conn:
        for r in results:
            if r.get("sentiment") and r.get("id"):
                conn.execute(
                    "UPDATE articles SET sentiment=%s, ml_confidence=%s, sentiment_at=%s WHERE id=%s",
                    (r["sentiment"], r.get("confidence"), now, r["id"]),
                )
                updated += 1
        conn.commit()

    return updated


# ── Main ─────────────────────────────────────────────────────────────────────

def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s  %(levelname)-8s  %(message)s",
    )

    dsn = os.environ.get("POSTGRES_DSN")
    if not dsn:
        log.error("POSTGRES_DSN not set")
        sys.exit(1)

    service_url = os.environ.get("SENTIMENT_SERVICE_URL", "").strip()

    # Load feeds: try DB first, fall back to hardcoded list
    feeds = _load_feeds_from_db(dsn)

    total_new = total_skip = 0

    for name, url, category in feeds:
        log.info("Fetching %-30s …", name)
        raw      = _fetch_feed(name, url, category)
        # Add detected_at for source latency tracking
        now_ts = int(time.time())
        for article in raw:
            article["detected_at"] = now_ts
        articles = _tag_articles(raw)
        new, skip = _upsert(articles, dsn)
        log.info("  +%d new  %d skipped", new, skip)
        total_new  += new
        total_skip += skip
        time.sleep(0.4)   # polite crawl delay

    log.info("RSS fetch complete — %d new, %d already existed", total_new, total_skip)

    # Optional deep NLP scoring via FinBERT service
    if service_url:
        log.info("Running FinBERT deep analysis via %s …", service_url)
        updated = _deep_analyze(dsn, service_url)
        log.info("FinBERT updated %d articles", updated)


if __name__ == "__main__":
    main()
