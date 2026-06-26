"""
RSS Poller — fetches financial news feeds and extracts ticker symbols.
Uses curl_cffi with chrome124 impersonation for all HTTP requests.
"""

import re
import time
from datetime import datetime, timezone, timedelta
from email.utils import parsedate_to_datetime

import feedparser
from curl_cffi import requests

# ─── FEED SOURCES ─────────────────────────────────────────────────────────────

FEEDS = [
    {
        "name": "GlobeNewswire",
        "url": "https://www.globenewswire.com/RssFeed/subjectcode/13-Earnings%20Releases%20and%20Operating%20Results/feedTitle/GlobeNewswire%20-%20Earnings%20Releases%20and%20Operating%20Results",
    },
    {
        "name": "PRNewswire",
        "url": "https://www.prnewswire.com/rss/news-releases-list.rss",
    },
    {
        "name": "BusinessWire",
        "url": "https://feed.businesswire.com/rss/home/?rss=G1",
    },
    {
        "name": "SEC 8-K",
        "url": "https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=8-K&dateb=&owner=include&count=40&output=atom",
    },
]

CURL_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
    "Accept-Language": "en-US,en;q=0.9",
}

# ─── TICKER EXTRACTION ────────────────────────────────────────────────────────

# Matches: $TICK, (TICK), NYSE: TICK, NASDAQ: TICK, AMEX: TICK, OTC: TICK
_TICKER_PATTERNS = [
    re.compile(r'\$([A-Z]{1,5})\b'),
    re.compile(r'\(([A-Z]{1,5})\)'),
    re.compile(r'(?:NYSE|NASDAQ|AMEX|OTC|NYSEARCA|NYSEMKT):\s*([A-Z]{1,5})\b'),
]

# Common false positives to discard
_STOPWORDS = {
    "CEO", "CFO", "COO", "CTO", "IPO", "ETF", "USD", "Q1", "Q2", "Q3", "Q4",
    "AM", "PM", "EST", "PST", "EDT", "PDT", "LLC", "INC", "LTD", "PLC", "LP",
    "NA", "US", "UK", "EU", "PR", "IR", "AI", "IT", "EV", "TV", "PC", "OTC",
    "SEC", "FDA", "EPA", "DOJ", "FTC", "NYSE", "NASDAQ", "AMEX", "EPS", "PE",
    "ATM", "ACH", "ESG", "YOY", "QOQ", "TTM", "YTD", "EBITDA", "GAAP", "GDP",
}


def extract_tickers(text: str) -> list[str]:
    """Return deduplicated list of likely ticker symbols found in text."""
    found = []
    for pattern in _TICKER_PATTERNS:
        for m in pattern.finditer(text or ""):
            sym = m.group(1)
            if sym not in _STOPWORDS and len(sym) >= 2:
                found.append(sym)
    seen = set()
    result = []
    for t in found:
        if t not in seen:
            seen.add(t)
            result.append(t)
    return result


# ─── DATE PARSING ─────────────────────────────────────────────────────────────

def _parse_published(entry) -> datetime:
    """Extract and normalise a publish timestamp from a feedparser entry."""
    # feedparser gives published_parsed as a time.struct_time in UTC
    if hasattr(entry, "published_parsed") and entry.published_parsed:
        import calendar
        ts = calendar.timegm(entry.published_parsed)
        return datetime.fromtimestamp(ts, tz=timezone.utc)
    if hasattr(entry, "updated_parsed") and entry.updated_parsed:
        import calendar
        ts = calendar.timegm(entry.updated_parsed)
        return datetime.fromtimestamp(ts, tz=timezone.utc)
    # Fall back to now so item still gets included
    return datetime.now(timezone.utc)


# ─── FEED FETCHER ─────────────────────────────────────────────────────────────

def _fetch_feed(feed_meta: dict) -> list[dict]:
    """Fetch one RSS/Atom feed and return a list of article dicts."""
    name = feed_meta["name"]
    url = feed_meta["url"]
    try:
        resp = requests.get(
            url,
            headers=CURL_HEADERS,
            impersonate="chrome124",
            timeout=20,
        )
        resp.raise_for_status()
    except Exception as e:
        print(f"    [WARN] RSS fetch failed ({name}): {e}")
        return []

    parsed = feedparser.parse(resp.text)
    articles = []
    for entry in parsed.entries:
        title = getattr(entry, "title", "") or ""
        link = getattr(entry, "link", "") or ""
        # description lives under summary or content
        description = (
            getattr(entry, "summary", "")
            or (entry.content[0].value if getattr(entry, "content", None) else "")
            or ""
        )
        # Strip HTML tags from description for clean text
        description = re.sub(r"<[^>]+>", " ", description)
        description = re.sub(r"\s+", " ", description).strip()

        published_dt = _parse_published(entry)
        combined_text = f"{title} {description}"
        tickers = extract_tickers(combined_text)

        articles.append({
            "source": name,
            "title": title,
            "published_at": published_dt.isoformat(),
            "published_dt": published_dt,  # kept for sorting; stripped before save
            "link": link,
            "description": description[:1000],  # cap at 1000 chars for DB
            "extracted_tickers": tickers,
        })

    return articles


# ─── PUBLIC API ───────────────────────────────────────────────────────────────

def fetch_all_feeds(max_age_minutes: int = 120) -> list[dict]:
    """
    Fetch all RSS feeds and return articles sorted newest-first.
    Filters out items older than max_age_minutes.
    """
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=max_age_minutes)
    all_articles = []

    for feed_meta in FEEDS:
        articles = _fetch_feed(feed_meta)
        for a in articles:
            if a["published_dt"] >= cutoff:
                all_articles.append(a)
        time.sleep(0.3)  # polite delay between feed fetches

    # Sort newest first
    all_articles.sort(key=lambda x: x["published_dt"], reverse=True)

    # Strip the datetime object (not JSON-serialisable) before returning
    for a in all_articles:
        a.pop("published_dt", None)

    return all_articles


def build_rss_index(articles: list[dict]) -> dict[str, list[dict]]:
    """
    Return a dict mapping ticker → [articles] for fast lookup during
    cross-referencing with Finviz tickers.
    """
    index: dict[str, list[dict]] = {}
    for article in articles:
        for ticker in article.get("extracted_tickers", []):
            index.setdefault(ticker, []).append(article)
    return index


def get_rss_context_for_ticker(ticker: str, rss_index: dict, max_items: int = 2) -> list[dict]:
    """Return the most recent RSS articles that mention a given ticker."""
    return rss_index.get(ticker, [])[:max_items]
