"""
Fetch real RSS articles using Ryan's existing fetch_rss.py feed list/fetch logic,
then upsert them into MongoDB for the current Express/Mongoose backend.

This avoids fake seed data and does not replace Ryan's original PostgreSQL fetcher.
"""

from __future__ import annotations

import json
import os
import re
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo
from pymongo import MongoClient
from dotenv import load_dotenv
import requests

from fetch_rss import RSS_FEEDS, _fetch_feed
from keyword_filter import load_keywords, filter_articles
from sentiment_utils import classify_financial_event, score_financial_sentiment

load_dotenv()

MONGO_URI = os.environ.get("MONGODB_URI", "mongodb://localhost:27017/feedflash")
DB_NAME = os.environ.get("MONGO_DB", "feedflash")
MARKET_WINDOW_TIMEZONE = os.environ.get("MARKET_WINDOW_TIMEZONE", "America/New_York")
MARKET_WINDOW_CLOSE_HOUR = int(os.environ.get("MARKET_WINDOW_CLOSE_HOUR_ET", "17"))
PRUNE_OLD_ARTICLES = os.environ.get("MARKET_WINDOW_PRUNE", "false").lower() in ("1", "true", "yes")
FILTER_TO_MARKET_WINDOW = os.environ.get("MARKET_WINDOW_FILTER", "false").lower() in ("1", "true", "yes")
INCLUDE_CUSTOM_RSS = os.environ.get("INCLUDE_CUSTOM_RSS_SOURCES", "false").lower() in ("1", "true", "yes")
SEC_COMPANY_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json"

APPROVED_STRUCTURED_FEED_NAMES = {
    "PR Newswire",
    "ACCESS Newswire",
    "BusinessWire",
    "GlobeNewswire Public Companies",
    "SEC EDGAR Current",
    "SEC EDGAR 8-K",
    "SEC EDGAR 10-Q",
    "SEC EDGAR 10-K",
    "FDA Press Releases",
    "FDA Recalls",
    "FDA Drug Approvals",
    "FDA MedWatch Safety Alerts",
}

APPROVED_SOURCE_PREFIXES = (
    "PR Newswire",
    "ACCESS Newswire",
    "BusinessWire",
    "GlobeNewswire",
    "SEC EDGAR",
    "FDA",
)

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

    found = {ticker for ticker in found if ticker not in BLOCKED_TICKERS}
    return ",".join(sorted(found))


def score_lightweight_sentiment(title: str, content: str) -> tuple[str, float]:
    return score_financial_sentiment(title, content)


client = MongoClient(MONGO_URI)
db = client[DB_NAME]
articles_col = db["articles"]
_SEC_CIK_TICKER_MAP: dict[str, str] | None = None


def _load_sec_cik_ticker_map() -> dict[str, str]:
    global _SEC_CIK_TICKER_MAP
    if _SEC_CIK_TICKER_MAP is not None:
        return _SEC_CIK_TICKER_MAP

    _SEC_CIK_TICKER_MAP = {}
    try:
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


MARKET_WINDOW_START = latest_market_close_cutoff()
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
    feeds = [feed for feed in RSS_FEEDS if feed[0] in APPROVED_STRUCTURED_FEED_NAMES]
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
ACCESS_NEWSWIRE_API = "https://www.accessnewswire.com/newsroom/api?pageindex=0&pageSize=50"
ACCESS_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
}


def _strip_html(value: str) -> str:
    text = re.sub(r"<[^>]+>", " ", value or "")
    return re.sub(r"\s+", " ", text).strip()


def _fetch_access_newswire() -> list[dict]:
    try:
        session = requests.Session()
        page = session.get(ACCESS_NEWSWIRE_URL, headers=ACCESS_HEADERS, timeout=20)
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

        resp = session.post(ACCESS_NEWSWIRE_API, headers=headers, timeout=20)
        resp.raise_for_status()
        payload = resp.json()
    except Exception as exc:
        print(f"ACCESS Newswire: SKIP {exc}")
        return []

    articles = []
    for item in payload.get("data", {}).get("articles", []):
        url = item.get("releaseurl") or ""
        title = (item.get("title") or "").strip()
        if not url or not title:
            continue

        pub_ts = None
        raw_date = item.get("adate")
        if raw_date:
            try:
                pub_dt = datetime.fromisoformat(str(raw_date)).replace(tzinfo=ZoneInfo(MARKET_WINDOW_TIMEZONE))
                pub_ts = int(pub_dt.astimezone(timezone.utc).timestamp())
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
    now_ts = int(time.time())

    last_fetch = int(fetch_state.get(url, 0))
    seconds_since = now_ts - last_fetch
    seconds_left = COOLDOWN_SECONDS - seconds_since

    if seconds_left > 0:
        return name, url, [], False, seconds_left

    print(f"Fetching {name}...")

    if url == "accessnewswire://newsroom":
        raw_articles = _fetch_access_newswire()
    else:
        raw_articles = _fetch_feed(name, url, category, timeout=RSS_HTTP_TIMEOUT)
    if FILTER_TO_MARKET_WINDOW:
        raw_articles = [article for article in raw_articles if _within_market_window(article)]

    docs = []

    processed_articles = []

    for article in raw_articles:
        article["detected_at"] = now_ts

        title = article.get("title", "")
        content = article.get("content", "")

        article["ticker"] = extract_lightweight_tickers(title, content)
        if category == "filings" and not article["ticker"]:
            article["ticker"] = extract_sec_ticker(title, content, article.get("url", ""))
        if category == "fda" and not article["ticker"]:
            continue
        sentiment, confidence = score_lightweight_sentiment(title, content)
        event_type, event_score, event_reason = classify_financial_event(title, content)
        article["sentiment"] = sentiment
        article["ml_confidence"] = confidence
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

        docs.append({
            "article_id": article_id,
            "title": article.get("title", ""),
            "content": article.get("content", ""),
            "url": article_url,
            "source": article.get("source", name),
            "category": article.get("category", category),
            "publish_date": article.get("publish_date"),
            "fetched_date": now_ts,
            "detected_at": article.get("detected_at", now_ts),
            "ticker": article.get("ticker", ""),
            "company": article.get("company", ""),
            "sentiment": article.get("sentiment", "neutral"),
            "ml_confidence": article.get("ml_confidence", 0),
            "sentiment_at": article.get("sentiment_at"),
            "event_type": article.get("event_type", "general_news"),
            "event_score": article.get("event_score", 0),
            "sentiment_reason": article.get("sentiment_reason", ""),
            "keyword_match": keyword_match_list,
        })

    return name, url, docs, True, 0


MAX_WORKERS = int(os.environ.get("RSS_MAX_WORKERS", "16"))
RSS_HTTP_TIMEOUT = int(os.environ.get("RSS_HTTP_TIMEOUT", "12"))

feeds_to_run = _runtime_rss_feeds()
pruned_count = prune_old_articles()
print(
    "Market article window starts "
    f"{MARKET_WINDOW_START.isoformat()} UTC ({MARKET_WINDOW_CLOSE_HOUR}:00 ET cutoff); "
    f"window filter {'on' if FILTER_TO_MARKET_WINDOW else 'off'}; "
    f"pruned {pruned_count} old articles"
)
print(f"Starting parallel RSS import with {MAX_WORKERS} workers across {len(feeds_to_run)} feeds...")

# Collect only new/updated articles so the optional Kafka publish below stays
# minimal (we never republish unchanged rows). Filled in during the upsert loop.
kafka_publish_docs = []

with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
    futures = [executor.submit(process_feed, feed) for feed in feeds_to_run]

    for future in as_completed(futures):
        name, url, docs, did_fetch, seconds_left = future.result()

        if not did_fetch:
            cooldown_skips.append(seconds_left)
            continue

        fetch_state[url] = int(time.time())

        feed_new = 0
        feed_updated = 0
        feed_skip = 0

        for mongo_doc in docs:
            # Use URL as the primary upsert key because Mongo has a unique index on url.
            # If the same story comes in with a different generated article_id, matching by
            # article_id causes duplicate-key crashes on url_1.
            upsert_filter = {"url": mongo_doc["url"]} if mongo_doc.get("url") else {"article_id": mongo_doc["article_id"]}

            set_doc = dict(mongo_doc)
            set_on_insert = {}

            # Preserve original article_id for already-known URLs; only set article_id when inserting.
            if "article_id" in set_doc:
                set_on_insert["article_id"] = set_doc.pop("article_id")

            update_doc = {"$set": set_doc}
            if set_on_insert:
                update_doc["$setOnInsert"] = set_on_insert

            result = articles_col.update_one(
                upsert_filter,
                update_doc,
                upsert=True,
            )

            if result.upserted_id:
                feed_new += 1
                kafka_publish_docs.append(mongo_doc)
            elif result.modified_count:
                feed_updated += 1
                kafka_publish_docs.append(mongo_doc)
            else:
                feed_skip += 1

        total_new += feed_new
        total_updated += feed_updated
        total_skip += feed_skip

        print(f"{name}: {feed_new} new, {feed_updated} updated, {feed_skip} unchanged")

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
