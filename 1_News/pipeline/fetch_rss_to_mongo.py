"""
Fetch real RSS articles using Ryan's existing fetch_rss.py feed list/fetch logic,
then upsert them into MongoDB for the current Express/Mongoose backend.

This avoids fake seed data and does not replace Ryan's original PostgreSQL fetcher.
"""

from __future__ import annotations

import json
import hashlib
import os
import re
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urljoin
from zoneinfo import ZoneInfo
from bs4 import BeautifulSoup
from pymongo import MongoClient, UpdateOne
from dotenv import load_dotenv
import requests

try:
    from curl_cffi import requests as curl_requests
    _HAS_CURL = True
except Exception:
    curl_requests = None
    _HAS_CURL = False

from fetch_rss import RSS_FEEDS, _fetch_feed
from keyword_filter import load_keywords, filter_articles
from sentiment_utils import classify_financial_event, score_financial_sentiment, signed_sentiment_score
from source_status import record_source_status

load_dotenv()

MONGO_URI = os.environ.get("MONGODB_URI", "mongodb://localhost:27017/feedflash")
DB_NAME = os.environ.get("MONGO_DB", "feedflash")
MARKET_WINDOW_TIMEZONE = os.environ.get("MARKET_WINDOW_TIMEZONE", "America/New_York")
MARKET_WINDOW_CLOSE_HOUR = int(os.environ.get("MARKET_WINDOW_CLOSE_HOUR_ET", "17"))
PRUNE_OLD_ARTICLES = os.environ.get("MARKET_WINDOW_PRUNE", "false").lower() in ("1", "true", "yes")
FILTER_TO_MARKET_WINDOW = os.environ.get("MARKET_WINDOW_FILTER", "true").lower() in ("1", "true", "yes")  # Enabled by default to reduce noise
ARTICLE_CACHE_DAYS = max(1, int(os.environ.get("ARTICLE_CACHE_DAYS", "3")))
INCLUDE_CUSTOM_RSS = False
ENABLE_DEDUP_HASH = os.environ.get("ENABLE_DEDUP_HASH", "true").lower() in ("1", "true", "yes")
SEC_COMPANY_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json"
RSS_FAST_MODE = os.environ.get("RSS_FAST_MODE", "false").lower() in ("1", "true", "yes")
RSS_HTTP_TIMEOUT = int(os.environ.get("RSS_HTTP_TIMEOUT", "12"))
NEWSWIRE_HTTP_TIMEOUT = int(os.environ.get("NEWSWIRE_HTTP_TIMEOUT", "8" if RSS_FAST_MODE else "20"))
NEWSWIRE_MAX_PAGES = max(0, int(os.environ.get("NEWSWIRE_MAX_PAGES", "1" if RSS_FAST_MODE else "0")))
ENABLE_COMPANY_ALIAS_MATCH = os.environ.get(
    "ENABLE_COMPANY_ALIAS_MATCH",
    "false" if RSS_FAST_MODE else "true",
).lower() in ("1", "true", "yes")

APPROVED_STRUCTURED_FEED_NAMES = {
    "PR Newswire",
    "PR Newswire Financial",
    "ACCESS Newswire",
    "Business Wire",
    "BusinessWire",
    "GlobeNewswire Public Companies",
    "FDA Press Releases",
    "FDA Recalls",
    "FDA Drug Approvals",
    "FDA MedWatch Safety Alerts",
}

APPROVED_SOURCE_PREFIXES = (
    "PR Newswire",
    "PR Newswire Financial",
    "ACCESS Newswire",
    "Business Wire",
    "BusinessWire",
    "GlobeNewswire",
    "FDA",
    "SEC EDGAR",
)

GENERIC_COMPANY_ALIAS_WORDS = {
    "the", "inc", "incorporated", "corp", "corporation", "company", "co",
    "ltd", "limited", "plc", "group", "holdings", "holding", "class",
    "common", "ordinary", "shares", "technologies", "technology",
    "news", "newswire", "wire", "press", "release", "releases",
}

GENERIC_COMPANY_ALIASES = {
    "global", "american", "international", "united", "first", "new",
    "energy", "capital", "financial", "markets", "digital", "solutions",
    "systems", "resources", "partners", "industries", "properties",
    "access", "access newswire", "globenewswire", "business wire",
    "businesswire", "pr newswire", "press releases", "market news",
}

CRYPTO_TICKERS = {
    "BTC", "ETH", "LTC", "DOGE", "SOL", "ADA", "XRP", "BNB", "DOT", "AVAX",
    "MATIC", "SHIB", "TRX", "BCH", "LINK", "ATOM", "UNI", "ETC", "FIL",
}

COMMON_COMPANY_TICKERS = {
    "nvidia": "NVDA",
    "apple": "AAPL",
    "tesla": "TSLA",
    "microsoft": "MSFT",
    "amazon": "AMZN",
    "meta": "META",
    "facebook": "META",
    "google": "GOOGL",
    "alphabet": "GOOGL",
    "netflix": "NFLX",
    "amd": "AMD",
    "advanced micro devices": "AMD",
    "super micro": "SMCI",
    "super micro computer": "SMCI",
    "micron": "MU",
    "intel": "INTC",
    "palantir": "PLTR",
    "casey's": "CASY",
    "caseys": "CASY",
    "newmont": "NEM",
    "badger meter": "BMI",
    "west fraser": "WFG",
    "oracle": "ORCL",
    "alcoa": "AA",
    "goldman": "GS",
    "jpmorgan": "JPM",
    "jp morgan": "JPM",
    "bank of america": "BAC",
    "walmart": "WMT",
    "costco": "COST",
    "broadcom": "AVGO",
    "qualcomm": "QCOM",
    "salesforce": "CRM",
    "adobe": "ADBE",
    "snowflake": "SNOW",
    "coinbase": "COIN",
    "spacex": "SPACEX",
    "space x": "SPACEX",
    "bitcoin": "BTC",
    "ethereum": "ETH",
}

BULLISH_WORDS = [
    "rise", "rises", "rose", "jump", "jumps", "surge", "surges", "gain", "gains",
    "beat", "beats", "strong", "growth", "upgrade", "raises", "bullish",
    "record", "profit", "approval", "partnership", "contract", "dividend"
]

BEARISH_WORDS = [
    "fall", "falls", "fell", "drop", "drops", "slump", "slumps", "miss",
    "misses", "weak", "downgrade", "cuts", "bearish", "lawsuit", "fraud",
    "bankruptcy", "recall", "layoffs", "concern", "concerns", "risk-off"
]

BLOCKED_TICKERS = {
    "AI", "IPO", "CEO", "CFO", "ETF", "SEC", "FDA", "USA", "USD", "GDP",
    "EV", "PE", "EPS", "ROI", "API", "IT", "NEW", "FOR", "ARE", "THE",
    "MHRA", "TXM", "ANTHROPIC", "OPENAI", *CRYPTO_TICKERS
}

ALWAYS_STOCK_NEWS_SOURCES = set()

STOCK_MARKET_TERMS = [
    "stock", "stocks", "share", "shares", "shareholder", "shareholders",
    "investor", "investors", "securities", "common stock", "preferred stock",
    "class action", "lead plaintiff", "nasdaq", "nyse", "amex", "otc",
    "tsx", "lse", "listed", "listing", "delisting", "ipo", "spac",
    "earnings", "quarterly results", "annual results", "financial results",
    "revenue", "profit", "loss", "dividend", "buyback",
    "repurchase", "merger", "acquisition", "acquires", "acquired",
    "strategic alternatives", "public offering", "registered direct",
    "private placement", "warrant", "convertible", "bond offering",
    "sec filing", "8-k", "10-q", "10-k", "form 4", "s-1",
]

STOCK_MARKET_RE = re.compile(
    r"(?<![a-z0-9])(?:" + "|".join(re.escape(term) for term in STOCK_MARKET_TERMS) + r")(?![a-z0-9])",
    re.IGNORECASE,
)

EXCHANGE_TICKER_RE = re.compile(r"\b(?:NASDAQ|Nasdaq|NYSE|AMEX|OTC|TSX|LSE)\s*:\s*[A-Z][A-Z0-9.-]{0,5}\b")
LEGAL_SPAM_RE = re.compile(
    r"shareholder alert|stockholder alert|investor alert|securities fraud|securities class action|"
    r"class action|lead plaintiff|substantial losses|losses in excess|secure counsel|your rights|"
    r"deadline|rosen law|hagens berman|kirby mcinerney|robbins llp|pomerantz|bragar eagel|"
    r"levi korsinsky|glancy prongay|the law offices|law firm|investor counsel",
    re.IGNORECASE,
)


def _normalize_headline(text: str) -> str:
    """Normalize headline for deduplication: lowercase, remove punctuation, extra spaces."""
    text = text.lower()
    text = re.sub(r'[^\w\s]', '', text)
    text = re.sub(r'\s+', ' ', text).strip()
    text = re.sub(r'\b(the|a|an|is|at|which|on|and|or|but|in|with|for|to|of|as|by)\b', '', text)
    return text.strip()


def _headline_hash(headline: str) -> str:
    """Create a hash from normalized headline for cross-wire deduplication."""
    normalized = _normalize_headline(headline)
    return hashlib.md5(normalized.encode()).hexdigest()


def _to_epoch_seconds(value, fallback: int | None = None) -> int | None:
    if value in (None, ""):
        return fallback
    if isinstance(value, (int, float)):
        number = int(value)
        return number // 1000 if number > 10_000_000_000 else number
    if isinstance(value, datetime):
        dt = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
        return int(dt.timestamp())
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return fallback
        if re.fullmatch(r"\d+(\.\d+)?", text):
            return _to_epoch_seconds(float(text), fallback)
        try:
            parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
            parsed = parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
            return int(parsed.timestamp())
        except Exception:
            return fallback
    return fallback


def _market_session_for_sec(sec: int | None) -> str:
    if not sec:
        return "missing"
    dt = datetime.fromtimestamp(sec, timezone.utc).astimezone(ZoneInfo("America/New_York"))
    if dt.weekday() >= 5:
        return "weekend"
    minutes = dt.hour * 60 + dt.minute
    if 4 * 60 <= minutes < 9 * 60 + 30:
        return "premarket"
    if 9 * 60 + 30 <= minutes < 16 * 60:
        return "regular"
    if 16 * 60 <= minutes < 20 * 60:
        return "postmarket"
    return "overnight"


def _normalize_company_alias(value: str) -> str:
    text = (value or "").lower()
    text = text.replace("&", " and ")
    text = re.sub(r"[^a-z0-9 ]+", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def _company_aliases(company: str) -> set[str]:
    normalized = _normalize_company_alias(company)
    if not normalized:
        return set()
    aliases = {normalized}
    tokens = [token for token in normalized.split() if token not in GENERIC_COMPANY_ALIAS_WORDS]
    trimmed = " ".join(tokens).strip()
    if trimmed and len(tokens) >= 2:
        aliases.add(trimmed)
    raw_first = re.sub(r"[^A-Za-z0-9]", "", (company or "").strip().split()[0]) if (company or "").strip().split() else ""
    distinctive_single_token = bool(re.search(r"[a-z][A-Z]|[A-Z][a-z]+[A-Z]", raw_first))
    if tokens and distinctive_single_token and len(tokens[0]) >= 7 and tokens[0] not in GENERIC_COMPANY_ALIASES:
        aliases.add(tokens[0])
    return {
        alias for alias in aliases
        if len(alias) >= 5
        and alias not in GENERIC_COMPANY_ALIASES
        and not alias.isdigit()
    }


def extract_lightweight_tickers(title: str, content: str) -> str:
    text = f"{title} {content}"
    found = set()

    # Exchange patterns like (NYSE: BMI), NASDAQ: AAPL, TSX: WFG
    for match in re.findall(r"(?:NYSE|NASDAQ|Nasdaq|TSX|AMEX)\s*:\s*([A-Z]{1,5})", text):
        found.add(match.upper())

    # Cash-tag patterns like $NVDA
    for match in re.findall(r"\$([A-Z]{1,5})\b", text):
        found.add(match.upper())

    lower_text = text.lower()
    for company, ticker in COMMON_COMPANY_TICKERS.items():
        if re.search(rf"(?<![a-z0-9]){re.escape(company)}(?![a-z0-9])", lower_text):
            found.add(ticker)

    if ENABLE_COMPANY_ALIAS_MATCH:
        alias_map = _load_public_company_alias_map()
        normalized_title = _normalize_company_alias(title)
        normalized_context = _normalize_company_alias(f"{title} {content[:600]}")
        for alias, ticker in alias_map.items():
            if re.search(rf"(?<![a-z0-9]){re.escape(alias)}(?![a-z0-9])", normalized_title):
                found.add(ticker)
            elif len(alias) >= 12 and re.search(rf"(?<![a-z0-9]){re.escape(alias)}(?![a-z0-9])", normalized_context):
                found.add(ticker)

    found = {ticker for ticker in found if ticker not in BLOCKED_TICKERS}
    return ",".join(sorted(found))


def score_lightweight_sentiment(title: str, content: str) -> tuple[str, float]:
    return score_financial_sentiment(title, content)


client = MongoClient(MONGO_URI)
db = client[DB_NAME]
articles_col = db["articles"]
_SEC_CIK_TICKER_MAP: dict[str, str] | None = None
_PUBLIC_COMPANY_ALIAS_MAP: dict[str, str] | None = None


def _load_public_company_alias_map() -> dict[str, str]:
    """Build a lightweight company-name resolver from the current screener universe."""
    global _PUBLIC_COMPANY_ALIAS_MAP
    if _PUBLIC_COMPANY_ALIAS_MAP is not None:
        return _PUBLIC_COMPANY_ALIAS_MAP

    alias_map: dict[str, str] = {}
    try:
        cursor = db["screeners"].find(
            {
                "ticker": {"$type": "string", "$ne": ""},
                "company": {"$type": "string", "$ne": ""},
            },
            {"_id": 0, "ticker": 1, "company": 1},
        ).limit(int(os.environ.get("COMPANY_ALIAS_MAX_SCREENERS", "12000")))
        for row in cursor:
            ticker = str(row.get("ticker") or "").upper().strip()
            if not re.fullmatch(r"[A-Z][A-Z0-9.-]{0,5}", ticker) or ticker in BLOCKED_TICKERS:
                continue
            for alias in _company_aliases(str(row.get("company") or "")):
                alias_map.setdefault(alias, ticker)
    except Exception as exc:
        print(f"Public company alias map unavailable: {exc}")

    for company, ticker in COMMON_COMPANY_TICKERS.items():
        alias_map.setdefault(_normalize_company_alias(company), ticker)

    _PUBLIC_COMPANY_ALIAS_MAP = alias_map
    return _PUBLIC_COMPANY_ALIAS_MAP


def _load_sec_cik_ticker_map() -> dict[str, str]:
    global _SEC_CIK_TICKER_MAP
    if _SEC_CIK_TICKER_MAP is not None:
        return _SEC_CIK_TICKER_MAP

    _SEC_CIK_TICKER_MAP = {}
    try:
        if _HAS_CURL:
            response = curl_requests.get(
                SEC_COMPANY_TICKERS_URL,
                headers={"User-Agent": os.getenv("SEC_USER_AGENT", "FeedFlash Research Dashboard")},
                impersonate="chrome124",
                timeout=15,
            )
        else:
            response = requests.get(
                SEC_COMPANY_TICKERS_URL,
                headers={"User-Agent": os.getenv("SEC_USER_AGENT", "FeedFlash Research Dashboard")},
                timeout=15,
            )
        response.raise_for_status()
        payload = response.json()
    except Exception as exc:
        print(f"SEC ticker map unavailable: {exc}")
        return _SEC_CIK_TICKER_MAP

    for row in payload.values() if isinstance(payload, dict) else []:
        try:
            cik = str(int(row.get("cik_str"))).lstrip("0")
            ticker = str(row.get("ticker") or "").upper().strip()
        except Exception:
            continue
        if cik and re.fullmatch(r"[A-Z][A-Z0-9.-]{0,5}", ticker):
            _SEC_CIK_TICKER_MAP[cik] = ticker
    return _SEC_CIK_TICKER_MAP


def extract_sec_ticker(title: str, content: str, url: str = "") -> str:
    """Map SEC CIK accession URLs/titles to ticker symbols before keyword scoring."""
    text = f"{title} {content} {url}"
    cik_map = _load_sec_cik_ticker_map()
    found = set()

    for match in re.findall(r"/Archives/edgar/data/0*(\d{3,10})/", text, flags=re.I):
        ticker = cik_map.get(match.lstrip("0"))
        if ticker:
            found.add(ticker)

    for match in re.findall(r"\bCIK[:#\s-]*0*(\d{3,10})\b", text, flags=re.I):
        ticker = cik_map.get(match.lstrip("0"))
        if ticker:
            found.add(ticker)

    return ",".join(sorted(found))


def latest_market_close_cutoff(now: datetime | None = None) -> datetime:
    """Return the latest weekday 5 PM Eastern cutoff as a UTC datetime."""
    eastern = ZoneInfo(MARKET_WINDOW_TIMEZONE)
    now_et = (now or datetime.now(timezone.utc)).astimezone(eastern)
    cutoff_et = now_et.replace(
        hour=MARKET_WINDOW_CLOSE_HOUR,
        minute=0,
        second=0,
        microsecond=0,
    )

    if now_et.weekday() >= 5 or now_et < cutoff_et:
        cutoff_et -= timedelta(days=1)

    while cutoff_et.weekday() >= 5:
        cutoff_et -= timedelta(days=1)

    return cutoff_et.astimezone(timezone.utc)


MARKET_WINDOW_START = datetime.now(timezone.utc) - timedelta(days=ARTICLE_CACHE_DAYS)
MARKET_WINDOW_START_TS = int(MARKET_WINDOW_START.timestamp())


def _publish_timestamp(article: dict) -> int | None:
    value = article.get("publish_date")
    if value is None or value == "":
        return None
    try:
        n = float(value)
    except (TypeError, ValueError):
        return None
    if n > 1_000_000_000_000:
        n = n / 1000
    if n <= 1_000_000_000:
        return None
    return int(n)


def _within_market_window(article: dict) -> bool:
    publish_ts = _publish_timestamp(article)
    return publish_ts is None or publish_ts >= MARKET_WINDOW_START_TS


def _market_window_query() -> dict:
    cutoff_date = MARKET_WINDOW_START
    missing_publish_date = {
        "$or": [
            {"publish_date": {"$exists": False}},
            {"publish_date": None},
            {"publish_date": ""},
        ],
    }

    return {
        "$or": [
            {"publish_date": {"$type": "date", "$gte": cutoff_date}},
            {"publish_date": {"$type": "int", "$gte": MARKET_WINDOW_START_TS}},
            {"publish_date": {"$type": "long", "$gte": MARKET_WINDOW_START_TS}},
            {"publish_date": {"$type": "double", "$gte": MARKET_WINDOW_START_TS}},
            {
                "$and": [
                    missing_publish_date,
                    {
                        "$or": [
                            {"fetched_date": {"$type": "date", "$gte": cutoff_date}},
                            {"fetched_date": {"$type": "int", "$gte": MARKET_WINDOW_START_TS}},
                            {"fetched_date": {"$type": "long", "$gte": MARKET_WINDOW_START_TS}},
                            {"fetched_date": {"$type": "double", "$gte": MARKET_WINDOW_START_TS}},
                            {"detected_at": {"$type": "date", "$gte": cutoff_date}},
                            {"detected_at": {"$type": "int", "$gte": MARKET_WINDOW_START_TS}},
                            {"detected_at": {"$type": "long", "$gte": MARKET_WINDOW_START_TS}},
                            {"detected_at": {"$type": "double", "$gte": MARKET_WINDOW_START_TS}},
                            {"createdAt": {"$gte": cutoff_date}},
                        ],
                    },
                ],
            },
        ],
    }


def _approved_source_query() -> dict:
    return {"$or": [{"source": {"$regex": f"^{re.escape(prefix)}", "$options": "i"}} for prefix in APPROVED_SOURCE_PREFIXES]}


def prune_old_articles() -> int:
    if not PRUNE_OLD_ARTICLES:
        return 0

    return articles_col.delete_many({
        "$or": [
            {"$nor": [_market_window_query()]},
            {"$nor": [_approved_source_query()]},
        ]
    }).deleted_count

# FEEDFLASH_CUSTOM_RSS_SOURCES_PATCH_V1
def _runtime_rss_feeds():
    """Return professor-approved structured feeds only by default."""
    # PR Newswire and GlobeNewswire cap their public RSS responses at 20 rows.
    # Their official listing pages paginate, so use those collectors instead.
    feeds = [
        feed for feed in RSS_FEEDS
        if feed[0] in APPROVED_STRUCTURED_FEED_NAMES
        and feed[0] not in {"PR Newswire", "PR Newswire Financial", "GlobeNewswire Public Companies", "ACCESS Newswire"}
    ]
    feeds.extend([
        ("PR Newswire", "prnewswire://newsroom", "press_releases"),
        ("GlobeNewswire Public Companies", "globenewswire://search", "press_releases"),
    ])
    feeds.append(("ACCESS Newswire", "accessnewswire://newsroom", "press_releases"))
    seen = {(name.lower(), url) for name, url, _cat in feeds}

    if not INCLUDE_CUSTOM_RSS:
        return feeds

    try:
        for row in db["rss_sources"].find({"enabled": {"$ne": False}}):
            name = str(row.get("name") or row.get("source") or "").strip()
            url = str(row.get("url") or "").strip()
            category = str(row.get("category") or "custom").strip() or "custom"
            if not name or not url:
                continue
            key = (name.lower(), url)
            if key in seen:
                continue
            feeds.append((name, url, category))
            seen.add(key)
    except Exception as exc:
        print(f"[WARN] could not load custom rss_sources from Mongo: {exc}")

    return feeds


ACCESS_NEWSWIRE_URL = "https://www.accessnewswire.com/newsroom"
ACCESS_NEWSWIRE_PAGE_SIZE = max(50, int(os.environ.get("ACCESS_NEWSWIRE_PAGE_SIZE", "250")))
ACCESS_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
}
NEWSWIRE_LISTING_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}


def _strip_html(value: str) -> str:
    text = re.sub(r"<[^>]+>", " ", value or "")
    return re.sub(r"\s+", " ", text).strip()


def _source_display_name(name: str) -> str:
    return "Business Wire" if re.sub(r"\s+", "", name or "").lower() == "businesswire" else name


def _ticker_list(value: str) -> list[str]:
    tickers = []
    for raw in dict.fromkeys(str(value or "").upper().replace(";", ",").split(",")):
        ticker = raw.strip()
        if re.fullmatch(r"[A-Z][A-Z0-9.-]{0,5}", ticker):
            tickers.append(ticker)
    return tickers


def _parse_businesswire_listing_time(value: str) -> int | None:
    text = re.sub(r"\s+", " ", value or "").strip()
    for fmt in ("%b %d, %Y at %I:%M %p", "%b %d, %Y %I:%M %p", "%B %d, %Y at %I:%M %p"):
        try:
            return int(datetime.strptime(text, fmt).replace(tzinfo=ZoneInfo(MARKET_WINDOW_TIMEZONE)).astimezone(timezone.utc).timestamp())
        except ValueError:
            continue
    return None


def _fetch_business_wire() -> list[dict]:
    """Use the official RSS channel, then the public English newsroom if the RSS channel is empty."""
    rss_articles = _fetch_feed("Business Wire", "https://feed.businesswire.com/rss/home/?rss=G1", "press_releases", timeout=RSS_HTTP_TIMEOUT)
    if rss_articles:
        for article in rss_articles:
            article["source"] = "Business Wire"
            article["provider"] = "Business Wire"
        return rss_articles

    if not _HAS_CURL:
        print("Business Wire: RSS returned 0 rows and curl_cffi is unavailable for public newsroom fallback")
        return []

    url = "https://www.businesswire.com/newsroom/language/en"
    try:
        resp = curl_requests.get(url, headers=NEWSWIRE_LISTING_HEADERS, impersonate="chrome124", timeout=NEWSWIRE_HTTP_TIMEOUT)
        resp.raise_for_status()
    except Exception as exc:
        print(f"Business Wire public newsroom: SKIP {exc}")
        return []

    soup = BeautifulSoup(resp.text, "html.parser")
    articles = []
    seen_urls = set()
    for anchor in soup.select('a[href*="/news/home/"]'):
        href = anchor.get("href") or ""
        title = anchor.get_text(" ", strip=True)
        if not href or not title:
            continue
        release_url = urljoin("https://www.businesswire.com", href)
        if release_url in seen_urls:
            continue
        seen_urls.add(release_url)

        card = anchor.find_parent("div", class_=lambda value: value and "border-b" in value)
        card_text = card.get_text(" ", strip=True) if card else ""
        date_match = re.search(r"\b[A-Z][a-z]{2} \d{1,2}, \d{4} at \d{1,2}:\d{2} [AP]M\b", card_text)
        publish_date = _parse_businesswire_listing_time(date_match.group(0)) if date_match else None
        summary = card_text
        if date_match:
            summary = summary.replace(date_match.group(0), "", 1).strip()
        if summary.startswith(title):
            summary = summary[len(title):].strip()

        articles.append({
            "id": f"bw-{hashlib.sha1(release_url.encode('utf-8')).hexdigest()[:20]}",
            "title": title,
            "content": summary[:2000],
            "summary": summary[:1000],
            "url": release_url,
            "source": "Business Wire",
            "provider": "Business Wire",
            "category": "press_releases",
            "publish_date": publish_date,
            "raw_source": "businesswire_public_newsroom",
        })

    return articles


def _known_recent_urls(source_name: str) -> set[str]:
    """URLs already cached for a source, used only to end incremental paging."""
    try:
        return {
            str(row.get("url") or "")
            for row in articles_col.find(
                {"source": source_name, "url": {"$type": "string", "$ne": ""}, **_market_window_query()},
                {"_id": 0, "url": 1},
            )
        }
    except Exception as exc:
        print(f"{source_name}: could not load incremental cursor ({exc}); using full window scan")
        return set()


def _parse_et_listing_time(value: str, *, allow_time_only: bool = False) -> int | None:
    text = re.sub(r"\s+", " ", value or "").strip()
    if not text:
        return None
    formats = ["%B %d, %Y %H:%M ET", "%b %d, %Y, %H:%M ET", "%b %d, %Y %H:%M ET"]
    if allow_time_only:
        formats.append("%H:%M ET")
    for fmt in formats:
        try:
            parsed = datetime.strptime(text, fmt)
            if fmt == "%H:%M ET":
                now_et = datetime.now(ZoneInfo(MARKET_WINDOW_TIMEZONE))
                parsed = parsed.replace(year=now_et.year, month=now_et.month, day=now_et.day)
            return int(parsed.replace(tzinfo=ZoneInfo(MARKET_WINDOW_TIMEZONE)).astimezone(timezone.utc).timestamp())
        except ValueError:
            continue
    return None


def _fetch_pr_newswire() -> list[dict]:
    """Page through PR Newswire's official listing until the cache window ends."""
    base_url = "https://www.prnewswire.com"
    articles = []
    seen_urls = set()
    known_urls = _known_recent_urls("PR Newswire")
    page_index = 1
    while True:
        url = f"{base_url}/news-releases/news-releases-list/?page={page_index}&pagesize=100"
        try:
            if _HAS_CURL:
                resp = curl_requests.get(url, headers=NEWSWIRE_LISTING_HEADERS, impersonate="chrome124", timeout=NEWSWIRE_HTTP_TIMEOUT)
            else:
                resp = requests.get(url, headers=NEWSWIRE_LISTING_HEADERS, timeout=NEWSWIRE_HTTP_TIMEOUT)
            resp.raise_for_status()
        except Exception as exc:
            print(f"PR Newswire page {page_index}: STOP {exc}")
            break

        soup = BeautifulSoup(resp.text, "html.parser")
        page_new = 0
        page_dates = []
        page_overlaps_cache = False
        for card in soup.select('div[aria-label="News Release"]'):
            anchor = card.select_one('a[href*="/news-releases/"]')
            title_node = card.select_one("h3 .langspan") or card.select_one("h3")
            if not anchor or not title_node:
                continue
            release_url = urljoin(base_url, anchor.get("href") or "")
            if not re.search(r"-\d{8,}\.html$", release_url) or release_url in seen_urls:
                continue
            seen_urls.add(release_url)
            page_overlaps_cache = page_overlaps_cache or release_url in known_urls
            page_new += 1
            raw_date = card.select_one("h3 small")
            publish_date = _parse_et_listing_time(raw_date.get_text(" ", strip=True) if raw_date else "", allow_time_only=True)
            if publish_date is not None:
                page_dates.append(publish_date)
            summary = card.select_one("p.remove-outline") or card.select_one("p")
            articles.append({
                "id": f"prn-{hashlib.sha1(release_url.encode('utf-8')).hexdigest()[:20]}",
                "title": title_node.get_text(" ", strip=True),
                "content": summary.get_text(" ", strip=True)[:2000] if summary else "",
                "url": release_url,
                "source": "PR Newswire",
                "category": "press_releases",
                "publish_date": publish_date,
            })

        if not page_new:
            break
        # Listings are newest-first. Once a whole page has reached the cached
        # stream, all newer unseen rows have already been collected. This keeps
        # initial backfills uncapped while making one-minute polls incremental.
        if known_urls and page_overlaps_cache:
            break
        if page_dates and max(page_dates) < MARKET_WINDOW_START_TS:
            break
        if NEWSWIRE_MAX_PAGES and page_index >= NEWSWIRE_MAX_PAGES:
            break
        page_index += 1
    return articles


def _fetch_globenewswire() -> list[dict]:
    """Page through GlobeNewswire's official search until the cache window ends."""
    base_url = "https://www.globenewswire.com"
    articles = []
    seen_urls = set()
    known_urls = _known_recent_urls("GlobeNewswire Public Companies")
    page_index = 1
    while True:
        url = f"{base_url}/search?page={page_index}&pageSize=100"
        try:
            if _HAS_CURL:
                resp = curl_requests.get(url, headers=NEWSWIRE_LISTING_HEADERS, impersonate="chrome124", timeout=NEWSWIRE_HTTP_TIMEOUT)
            else:
                resp = requests.get(url, headers=NEWSWIRE_LISTING_HEADERS, timeout=NEWSWIRE_HTTP_TIMEOUT)
            resp.raise_for_status()
        except Exception as exc:
            print(f"GlobeNewswire page {page_index}: STOP {exc}")
            break

        soup = BeautifulSoup(resp.text, "html.parser")
        page_new = 0
        page_dates = []
        page_overlaps_cache = False
        for row in soup.select("li.row"):
            anchor = row.select_one('.mainLink a[href*="/news-release/"]')
            if not anchor:
                continue
            release_url = urljoin(base_url, anchor.get("href") or "")
            if release_url in seen_urls:
                continue
            seen_urls.add(release_url)
            page_overlaps_cache = page_overlaps_cache or release_url in known_urls
            page_new += 1
            date_node = row.select_one(".date-source span")
            publish_date = _parse_et_listing_time(date_node.get_text(" ", strip=True) if date_node else "")
            if publish_date is not None:
                page_dates.append(publish_date)
            summary = row.select_one(".newsTxt")
            source_node = row.select_one(".sourceLink")
            articles.append({
                "id": f"gnw-{hashlib.sha1(release_url.encode('utf-8')).hexdigest()[:20]}",
                "title": anchor.get_text(" ", strip=True),
                "content": summary.get_text(" ", strip=True)[:2000] if summary else "",
                "url": release_url,
                "source": "GlobeNewswire Public Companies",
                "category": "press_releases",
                "publish_date": publish_date,
                "company": source_node.get_text(" ", strip=True) if source_node else "",
            })

        if not page_new:
            break
        if known_urls and page_overlaps_cache:
            break
        if page_dates and max(page_dates) < MARKET_WINDOW_START_TS:
            break
        if NEWSWIRE_MAX_PAGES and page_index >= NEWSWIRE_MAX_PAGES:
            break
        page_index += 1
    return articles


def is_stock_market_news(article: dict, source_name: str, category: str, ticker: str) -> tuple[bool, str]:
    """Accept public-company market news without requiring ticker extraction."""
    title = article.get("title", "")
    content = article.get("content", "")
    text = f"{title} {content} {article.get('company', '')}"

    if LEGAL_SPAM_RE.search(text):
        return False, "legal_spam"

    if source_name in ALWAYS_STOCK_NEWS_SOURCES:
        return True, "trusted_stock_feed"

    if category == "filings":
        return True, "sec_filing"

    if ticker:
        return True, "ticker_or_company_match"

    if EXCHANGE_TICKER_RE.search(text):
        return True, "exchange_symbol"

    match = STOCK_MARKET_RE.search(text)
    if match:
        return True, f"market_term:{match.group(0).lower()}"

    return False, "not_stock_market_news"


def _fetch_access_newswire() -> list[dict]:
    try:
        session = requests.Session()
        if _HAS_CURL:
            page = curl_requests.get(ACCESS_NEWSWIRE_URL, headers=ACCESS_HEADERS, impersonate="chrome124", timeout=NEWSWIRE_HTTP_TIMEOUT)
        else:
            page = session.get(ACCESS_NEWSWIRE_URL, headers=ACCESS_HEADERS, timeout=NEWSWIRE_HTTP_TIMEOUT)
        page.raise_for_status()
        match = re.search(r'<input name="AntiforgeryFieldname" type="hidden" value="([^"]+)"', page.text)
        headers = {
            **ACCESS_HEADERS,
            "Referer": ACCESS_NEWSWIRE_URL,
            "Origin": "https://www.accessnewswire.com",
            "X-Requested-With": "XMLHttpRequest",
            "account": "1",
        }
        if match:
            headers["X-CSRF-TOKEN-HEADERNAME"] = match.group(1)

    except Exception as exc:
        print(f"ACCESS Newswire: SKIP {exc}")
        return []

    articles = []
    seen_ids = set()
    known_urls = _known_recent_urls("ACCESS Newswire")
    page_index = 0
    while True:
        api_url = f"https://www.accessnewswire.com/newsroom/api?pageindex={page_index}&pageSize={ACCESS_NEWSWIRE_PAGE_SIZE}"
        try:
            if _HAS_CURL:
                resp = curl_requests.post(api_url, headers=headers, impersonate="chrome124", timeout=NEWSWIRE_HTTP_TIMEOUT)
            else:
                resp = session.post(api_url, headers=headers, timeout=NEWSWIRE_HTTP_TIMEOUT)
            resp.raise_for_status()
            items = resp.json().get("data", {}).get("articles", [])
        except Exception as exc:
            print(f"ACCESS Newswire page {page_index}: STOP {exc}")
            break
        if not items:
            break

        page_new_ids = []
        page_dates = []
        page_overlaps_cache = False
        for item in items:
            url = item.get("releaseurl") or ""
            title = (item.get("title") or "").strip()
            stable_item_id = str(item.get("id") or url)
            if not url or not title or stable_item_id in seen_ids:
                continue
            seen_ids.add(stable_item_id)
            page_overlaps_cache = page_overlaps_cache or url in known_urls
            page_new_ids.append(stable_item_id)

            pub_ts = None
            raw_date = item.get("adate")
            if raw_date:
                try:
                    pub_dt = datetime.fromisoformat(str(raw_date)).replace(tzinfo=ZoneInfo(MARKET_WINDOW_TIMEZONE))
                    pub_ts = int(pub_dt.astimezone(timezone.utc).timestamp())
                    page_dates.append(pub_ts)
                except Exception:
                    pub_ts = None

            articles.append({
                "id": f"access-{item.get('id') or abs(hash(url))}",
                "title": title,
                "content": _strip_html(item.get("body", ""))[:2000],
                "url": url,
                "source": "ACCESS Newswire",
                "category": "press_releases",
                "publish_date": pub_ts,
                "company": item.get("company") or "",
            })

        if not page_new_ids:
            break
        if known_urls and page_overlaps_cache:
            break
        if page_dates and max(page_dates) < MARKET_WINDOW_START_TS:
            break
        if NEWSWIRE_MAX_PAGES and page_index + 1 >= NEWSWIRE_MAX_PAGES:
            break
        page_index += 1

    return articles


keywords = load_keywords(None)

COOLDOWN_SECONDS = int(os.environ.get("RSS_COOLDOWN_SECONDS", "60"))
STATE_FILE = Path(os.environ.get("RSS_STATE_FILE", "1_News/pipeline/.rss_fetch_state.json"))


def load_fetch_state():
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text())
        except Exception:
            return {}
    return {}


def save_fetch_state(state):
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(state, indent=2, sort_keys=True))


fetch_state = load_fetch_state()

total_new = 0
total_updated = 0
total_skip = 0
cooldown_skips = []


def process_feed(feed):
    name, url, category = feed
    source_name = _source_display_name(name)
    now_ts = int(time.time())

    last_fetch = int(fetch_state.get(url, 0))
    seconds_since = now_ts - last_fetch
    seconds_left = COOLDOWN_SECONDS - seconds_since

    if seconds_left > 0:
        return source_name, url, [], False, seconds_left, 0, 0

    print(f"Fetching {source_name}...")

    if url == "accessnewswire://newsroom":
        raw_articles = _fetch_access_newswire()
    elif url == "prnewswire://newsroom":
        raw_articles = _fetch_pr_newswire()
    elif url == "globenewswire://search":
        raw_articles = _fetch_globenewswire()
    elif re.sub(r"\s+", "", name or "").lower() == "businesswire":
        raw_articles = _fetch_business_wire()
    else:
        raw_articles = _fetch_feed(source_name, url, category, timeout=RSS_HTTP_TIMEOUT)
    if FILTER_TO_MARKET_WINDOW:
        raw_articles = [article for article in raw_articles if _within_market_window(article)]
    raw_count = len(raw_articles)

    docs = []

    processed_articles = []

    for article in raw_articles:
        # detected_at is set once here with the feed's fetch time — will be persisted
        # on first insert and never overwritten on updates (see $min in upsert logic)
        article["detected_at"] = now_ts

        title = article.get("title", "")
        content = article.get("content", "")

        article["ticker"] = extract_lightweight_tickers(title, content)
        if category == "filings" and not article["ticker"]:
            article["ticker"] = extract_sec_ticker(title, content, article.get("url", ""))
        if category == "fda" and not article["ticker"]:
            continue
        is_relevant, relevance_reason = is_stock_market_news(article, name, category, article["ticker"])
        if not is_relevant:
            continue
        article["stock_news_relevance"] = relevance_reason
        article["stock_news_filter_version"] = "stock_market_relevance_v2"
        article["suppress_from_main_news"] = False
        article["main_feed_priority"] = 100 if category == "press_releases" else 85 if category == "fda" else 75
        sentiment, confidence = score_lightweight_sentiment(title, content)
        event_type, event_score, event_reason = classify_financial_event(title, content)
        article["sentiment"] = sentiment
        article["ml_confidence"] = confidence
        article["sentiment_score"] = signed_sentiment_score(sentiment, confidence)
        article["sentiment_at"] = now_ts if sentiment != "neutral" else None
        article["event_type"] = event_type
        article["event_score"] = event_score
        article["sentiment_reason"] = event_reason
        processed_articles.append(article)

    filtered_articles = filter_articles(processed_articles, keywords, require_match=False)

    for article in filtered_articles:
        article_id = article.get("id")
        article_url = article.get("url")

        if not article_id or not article_url:
            continue

        keyword_match = article.get("keyword_match")
        keyword_match_list = [keyword_match] if keyword_match else []

        headline = article.get("title", "")
        headline_hash = _headline_hash(headline) if ENABLE_DEDUP_HASH and headline else None
        publish_sec = _to_epoch_seconds(article.get("publish_date"))
        detected_sec = _to_epoch_seconds(article.get("detected_at"), now_ts)
        fetched_sec = now_ts
        event_sec = publish_sec or detected_sec or fetched_sec
        feed_sort_time = max(sec for sec in [publish_sec, detected_sec, fetched_sec] if sec)
        market_session = _market_session_for_sec(event_sec)

        docs.append({
            "article_id": article_id,
            "title": headline,
            "content": article.get("content", ""),
            "summary": article.get("summary") or article.get("content", "")[:1000],
            "bodyText": article.get("content", ""),
            "url": article_url,
            "source": _source_display_name(article.get("source", source_name)),
            "provider": article.get("provider") or _source_display_name(article.get("source", source_name)),
            "category": article.get("category", category),
            "catalystCategory": article.get("event_type", "general_news"),
            "catalystScore": article.get("event_score", 0),
            "article_kind": "structured",
            "source_type": "filing" if category == "filings" else "regulatory" if category == "fda" else "newswire" if category == "press_releases" else "structured_rss",
            "isStructuredNews": True,
            "isNewswire": category == "press_releases",
            "collector": "structured_rss_to_mongo_v2",
            "publish_date": article.get("publish_date"),
            "publishedAt": article.get("publish_date"),
            "publish_sec": publish_sec,
            "event_sec": event_sec,
            "feed_sort_time": feed_sort_time,
            "market_session": market_session,
            "publish_time_trusted": article.get("publish_date") is not None,
            "fetched_date": now_ts,
            "fetchedAt": now_ts,
            "ingested_sec": now_ts,
            "detected_at": article.get("detected_at", now_ts),
            "detected_sec": detected_sec,
            "ticker": article.get("ticker", ""),
            "tickers": _ticker_list(article.get("ticker", "")),
            "company": article.get("company", ""),
            "companies": [article.get("company", "")] if article.get("company") else [],
            "sentiment": article.get("sentiment", "neutral"),
            "ml_confidence": article.get("ml_confidence", 0),
            "sentiment_score": article.get("sentiment_score", 0),
            "sentiment_at": article.get("sentiment_at"),
            "event_type": article.get("event_type", "general_news"),
            "event_score": article.get("event_score", 0),
            "sentiment_reason": article.get("sentiment_reason", ""),
            "dedupeKey": f"{_source_display_name(article.get('source', source_name)).lower()}:{_normalize_headline(headline)}:{article.get('publish_date') or ''}",
            "raw": {
                "collector": article.get("raw_source") or "structured_rss_to_mongo_v2",
                "source": article.get("source", source_name),
                "category": category,
            },
            "keyword_match": keyword_match_list,
            "headline_hash": headline_hash,
            "stock_news_relevance": article.get("stock_news_relevance", ""),
            "stock_news_filter_version": article.get("stock_news_filter_version", ""),
            "suppress_from_main_news": article.get("suppress_from_main_news", False),
            "main_feed_priority": article.get("main_feed_priority", 50),
        })

    return name, url, docs, True, 0, raw_count, len(processed_articles)


MAX_WORKERS = int(os.environ.get("RSS_MAX_WORKERS", "16"))

feeds_to_run = _runtime_rss_feeds()
pruned_count = prune_old_articles()
print(
    "Article cache window starts "
    f"{MARKET_WINDOW_START.isoformat()} UTC (rolling {ARTICLE_CACHE_DAYS}d); "
    f"window filter {'on' if FILTER_TO_MARKET_WINDOW else 'off'}; "
    f"pruned {pruned_count} old articles"
)
print(f"Starting parallel RSS import with {MAX_WORKERS} workers across {len(feeds_to_run)} feeds...")

# Build the SEC CIK map before worker threads start. Without this preload,
# concurrent SEC feeds can observe the shared map after it is initialized to an
# empty dict but before the HTTP response populates it, producing blank tickers.
_load_sec_cik_ticker_map()

# Collect only new/updated articles so the optional Kafka publish below stays
# minimal (we never republish unchanged rows). Filled in during the upsert loop.
kafka_publish_docs = []

with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
    futures = [executor.submit(process_feed, feed) for feed in feeds_to_run]

    for future in as_completed(futures):
        name, url, docs, did_fetch, seconds_left, raw_count, processed_count = future.result()

        if not did_fetch:
            cooldown_skips.append(seconds_left)
            continue

        fetch_state[url] = int(time.time())

        feed_new = 0
        feed_updated = 0
        feed_skip = 0

        if ENABLE_DEDUP_HASH:
            for mongo_doc in docs:
                # Cross-wire deduplication: if headline_hash already exists from a different source,
                # skip this article (it's the same story from another wire)
                headline_hash = mongo_doc.get("headline_hash")
                if headline_hash:
                    existing = articles_col.find_one({"headline_hash": headline_hash}, {"_id": 1, "source": 1})
                    if existing and existing.get("_id") != mongo_doc.get("_id"):
                        # Same story from different source — skip duplicate
                        feed_skip += 1
                        continue

                upsert_filter = {"url": mongo_doc["url"]} if mongo_doc.get("url") else {"article_id": mongo_doc["article_id"]}
                set_doc = dict(mongo_doc)
                set_on_insert = {"first_seen_at": int(time.time())}
                if "article_id" in set_doc:
                    set_on_insert["article_id"] = set_doc.pop("article_id")
                detected_value = mongo_doc.get("detected_at", int(time.time()))
                set_doc.pop("detected_at", None)
                update_doc = {"$set": set_doc, "$min": {"detected_at": detected_value}}
                for key in list(set_on_insert.keys()):
                    if key in update_doc.get("$set", {}) or key in update_doc.get("$min", {}):
                        del set_on_insert[key]
                if set_on_insert:
                    update_doc["$setOnInsert"] = set_on_insert
                result = articles_col.update_one(upsert_filter, update_doc, upsert=True)
                if result.upserted_id:
                    feed_new += 1
                    kafka_publish_docs.append(mongo_doc)
                elif result.modified_count:
                    feed_updated += 1
                    kafka_publish_docs.append(mongo_doc)
                else:
                    feed_skip += 1
        else:
            ops = []
            now_insert = int(time.time())
            for mongo_doc in docs:
                # Use URL as the primary upsert key because Mongo has a unique index on url.
                # If the same story comes in with a different generated article_id, matching by
                # article_id causes duplicate-key crashes on url_1.
                upsert_filter = {"url": mongo_doc["url"]} if mongo_doc.get("url") else {"article_id": mongo_doc["article_id"]}
                set_doc = dict(mongo_doc)
                set_on_insert = {"first_seen_at": now_insert}
                if "article_id" in set_doc:
                    set_on_insert["article_id"] = set_doc.pop("article_id")
                detected_value = mongo_doc.get("detected_at", now_insert)
                set_doc.pop("detected_at", None)
                update_doc = {"$set": set_doc, "$min": {"detected_at": detected_value}}
                for key in list(set_on_insert.keys()):
                    if key in update_doc.get("$set", {}) or key in update_doc.get("$min", {}):
                        del set_on_insert[key]
                if set_on_insert:
                    update_doc["$setOnInsert"] = set_on_insert
                ops.append(UpdateOne(upsert_filter, update_doc, upsert=True))

            if ops:
                result = articles_col.bulk_write(ops, ordered=False)
                feed_new = result.upserted_count
                feed_updated = result.modified_count
                feed_skip = max(0, len(docs) - feed_new - feed_updated)
                if feed_new or feed_updated:
                    kafka_publish_docs.extend(docs)

        total_new += feed_new
        total_updated += feed_updated
        total_skip += feed_skip

        status = "working" if raw_count > 0 else "no_rows"
        detail = (
            f"scanned {raw_count} rows in rolling {ARTICLE_CACHE_DAYS}d window; "
            f"{processed_count} passed stock-news relevance; "
            f"{len(docs)} persisted after keyword/dedup filters; "
            f"{feed_new} new, {feed_updated} updated, {feed_skip} unchanged"
        )
        record_source_status(
            db,
            name,
            status,
            count=len(docs),
            detail=detail,
            source_type="structured_news",
            metrics={
                "records_received": raw_count,
                "records_relevance_passed": processed_count,
                "records_relevance_rejected": max(0, raw_count - processed_count),
                "records_filtered": max(0, raw_count - processed_count),
                "records_accepted": len(docs),
                "records_new": feed_new,
                "records_updated": feed_updated,
                "records_duplicates": feed_skip,
                "records_malformed": 0,
                "dedupe_hash_enabled": ENABLE_DEDUP_HASH,
                "article_cache_days": ARTICLE_CACHE_DAYS,
            },
        )

        ticker_matched = sum(1 for doc in docs if doc.get("ticker") or doc.get("tickers"))
        source_debug = {
            "source": _source_display_name(name),
            "attempted": True,
            "ok": status == "working",
            "fetched": raw_count,
            "inserted": feed_new,
            "updated": feed_updated,
            "deduped": feed_skip,
            "tickerMatched": ticker_matched,
            "errors": [] if status == "working" else [detail],
        }
        print(f"{_source_display_name(name)}: {feed_new} new, {feed_updated} updated, {feed_skip} unchanged")
        print(f"SOURCE_DEBUG_JSON {json.dumps(source_debug, sort_keys=True)}")

if cooldown_skips:
    print(
        f"Cooldown active for {len(cooldown_skips)}/{len(feeds_to_run)} feeds. "
        f"Next fetch available in {max(cooldown_skips)}s."
    )

save_fetch_state(fetch_state)
print(f"RSS Mongo import complete — {total_new} new, {total_updated} updated, {total_skip} unchanged")

# --- OPTIONAL Kafka publish (additive; OFF unless KAFKA_PUBLISH_NEWS=true) ----
# Sends only the new/updated articles through Kafka so the existing consumer fans
# them out to Redis (hot, rolling per-ticker feed) and MongoDB. Best-effort:
# if Kafka or confluent-kafka is unavailable, the Mongo import above is
# completely unaffected — the whole block is wrapped in try/except.
if os.getenv("KAFKA_PUBLISH_NEWS", "false").strip().lower() in ("1", "true", "yes"):
    try:
        import sys
        sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "Infrastructure" / "kafka"))
        from news_publisher import publish_articles

        _sent = publish_articles(kafka_publish_docs)
        print(f"Kafka publish — {_sent} news events sent to topic")
    except Exception as exc:
        print(f"Kafka publish skipped (Mongo import unaffected): {exc}")

client.close()


def main() -> dict:
    """Return the completed import summary for the unified runner.

    This module performs its import at module execution time for compatibility
    with the existing standalone script entry point.
    """
    return {"new": total_new, "updated": total_updated, "unchanged": total_skip}
