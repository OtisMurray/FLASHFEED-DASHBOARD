import os
import re
import json
import time
import hashlib
import requests
from bs4 import BeautifulSoup
from urllib.parse import urljoin, urlparse
from pymongo import MongoClient, UpdateOne
from pymongo.errors import BulkWriteError

from sentiment_utils import classify_financial_event, score_financial_sentiment

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "../.."))
CONFIG_PATH = os.path.join(ROOT, "config", "unstructured_news_sources.json")
DEFAULT_TICKER_FILE = os.path.join(ROOT, "config", "social_tickers_100.txt")

MONGODB_URI = os.getenv("MONGODB_URI", "mongodb://localhost:27017/feedflash")
DB_NAME = os.getenv("MONGODB_DB", "feedflash")
MAX_PER_SOURCE = int(os.getenv("UNSTRUCTURED_MAX_PER_SOURCE", "40"))

HEADERS = {
    "User-Agent": "FeedFlashStockDashboard/0.1 contact: otisemurray@icloud.com",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}

BAD_TITLE_EXACT = {
    "home", "login", "log in", "sign in", "subscribe", "about", "about us",
    "contact", "contact us", "privacy policy", "terms of use", "terms",
    "advertise", "careers", "newsroom", "industries", "solutions",
    "read more", "learn more", "markets", "business", "finance"
}

BAD_TITLE_CONTAINS = [
    "cookie",
    "privacy",
    "terms of",
    "advertisement",
    "sponsored",
    "newsletter",
    "sign up",
    "subscribe",
    "conference & event software",
    "blog topics",
    "press release distribution",
    "investor relations",
    "public relations",
]

FINANCE_HINTS = [
    "stock", "stocks", "market", "markets", "shares", "earnings", "revenue",
    "profit", "guidance", "fed", "rate", "inflation", "oil",
    "sec", "ipo", "merger", "acquisition", "deal", "dow",
    "nasdaq", "s&p", "bond", "treasury", "futures", "trading", "investors",
    "bank", "banks", "finance", "economy", "economic", "ai", "chip",
    "semiconductor", "ev", "energy", "pharma", "fda"
]

FINANCE_HINT_RE = re.compile(
    r"(?<![a-z0-9])(?:" + "|".join(re.escape(h) for h in FINANCE_HINTS) + r")(?![a-z0-9])",
    re.IGNORECASE,
)

BULLISH_WORDS = [
    "rise", "rises", "rose", "jump", "jumps", "surge", "surges", "gain", "gains",
    "beat", "beats", "strong", "growth", "upgrade", "raises", "bullish",
    "record", "profit", "approval", "partnership", "contract", "dividend", "soars",
    "rally", "rallies", "higher", "up",
]

BEARISH_WORDS = [
    "fall", "falls", "fell", "drop", "drops", "slump", "slumps", "miss",
    "misses", "weak", "downgrade", "cuts", "bearish", "lawsuit", "fraud",
    "bankruptcy", "recall", "layoffs", "concern", "concerns", "risk-off",
    "lower", "down",
]

BLOCKED_TICKERS = {
    "AI", "IPO", "CEO", "CFO", "ETF", "SEC", "FDA", "USA", "USD", "GDP",
    "EV", "PE", "EPS", "ROI", "API", "IT", "NEW", "FOR", "ARE", "THE",
    "MHRA", "TXM",
}

COMMON_COMPANY_TICKERS = {
    "apple": "AAPL",
    "tesla": "TSLA",
    "nvidia": "NVDA",
    "advanced micro devices": "AMD",
    "amd": "AMD",
    "intel": "INTC",
    "roku": "ROKU",
    "rivian": "RIVN",
    "qualcomm": "QCOM",
    "kohl": "KSS",
    "kohl's": "KSS",
    "palantir": "PLTR",
    "microsoft": "MSFT",
    "amazon": "AMZN",
    "meta": "META",
    "google": "GOOGL",
    "alphabet": "GOOGL",
    "spacex": "SPACEX",
}

BLOCKED_LINK_DOMAINS = {
    "finance.yahoo.com",
    "www.coindesk.com",
    "coindesk.com",
    "cointelegraph.com",
    "www.cointelegraph.com",
    "www.zerohedge.com",
    "zerohedge.com",
}

def now_ts():
    return int(time.time())

def clean(text):
    return re.sub(r"\s+", " ", text or "").strip()

def stable_id(source, url):
    return hashlib.sha256(f"{source}|{url}".encode("utf-8")).hexdigest()

def load_tracked_tickers():
    configured = os.getenv("TRACKED_TICKERS") or os.getenv("SOCIAL_TICKERS") or ""
    raw = configured.split(",") if configured.strip() else []
    if not raw:
        try:
            with open(os.getenv("SOCIAL_TICKER_FILE", DEFAULT_TICKER_FILE), "r") as f:
                raw = f.read().splitlines()
        except Exception:
            raw = []

    tickers = set()
    for value in raw:
        ticker = value.strip().upper()
        if re.fullmatch(r"[A-Z][A-Z0-9.-]{0,5}", ticker) and ticker not in BLOCKED_TICKERS:
            tickers.add(ticker)
    tickers.add("SPACEX")
    return tickers

TRACKED_TICKERS = load_tracked_tickers()

def title_ok(title):
    if not title:
        return False

    title = clean(title)
    low = title.lower()

    if "{{" in title or "}}" in title:
        return False

    if len(title) < 28 or len(title) > 220:
        return False

    if low in BAD_TITLE_EXACT:
        return False

    if any(bad in low for bad in BAD_TITLE_CONTAINS):
        return False

    # Avoid all-caps nav labels and category-only labels.
    words = title.split()
    if len(words) < 4:
        return False

    return True

def has_finance_hint(title):
    return bool(FINANCE_HINT_RE.search(title or ""))

def extract_tickers(title):
    text = title or ""
    found = set()

    for match in re.findall(r"\$([A-Z][A-Z0-9.-]{0,5})\b", text):
        found.add(match.upper())
    for match in re.findall(r"(?:NYSE|NASDAQ|Nasdaq|AMEX)\s*:\s*([A-Z][A-Z0-9.-]{0,5})", text):
        found.add(match.upper())
    lower_text = text.lower()
    for company, ticker in COMMON_COMPANY_TICKERS.items():
        if re.search(rf"(?<![a-z0-9]){re.escape(company)}(?![a-z0-9])", lower_text):
            found.add(ticker)

    return sorted(ticker for ticker in found if ticker not in BLOCKED_TICKERS)

def score_lightweight_sentiment(title):
    return score_financial_sentiment(title, "")

def url_ok(url, cfg):
    parsed = urlparse(url)
    domain = parsed.netloc.lower()
    path = parsed.path.lower()

    if domain in BLOCKED_LINK_DOMAINS:
        return False

    allowed_domains = [d.lower() for d in cfg.get("allowed_domains", [])]
    if allowed_domains and domain not in allowed_domains:
        return False

    required = cfg.get("required_path_contains", [])
    if required and not any(r.lower() in path for r in required):
        return False

    if path in ["", "/", "/newsroom", "/business", "/markets"]:
        return False

    return True

def extract_candidates(html, page_url, cfg):
    soup = BeautifulSoup(html, "html.parser")
    candidates = []

    # Prefer links because we need URL + title.
    for a in soup.find_all("a", href=True):
        title = clean(a.get_text(" ", strip=True))
        href = a.get("href", "")
        url = urljoin(page_url, href).split("#")[0].split("?")[0]

        if not title_ok(title):
            continue

        if not url_ok(url, cfg):
            continue

        if not has_finance_hint(title):
            continue

        candidates.append((title, url))

    # Deduplicate by URL, keeping the longest/best title.
    by_url = {}
    for title, url in candidates:
        prev = by_url.get(url)
        if prev is None or len(title) > len(prev):
            by_url[url] = title

    rows = []
    for url, title in by_url.items():
        rows.append((title, url))

    rows.sort(key=lambda x: x[0])

    return rows[:MAX_PER_SOURCE]

def fetch_source(cfg):
    source = cfg["source"]
    page_url = cfg["url"]

    print(f"\nFetching {source}: {page_url}")

    try:
        resp = requests.get(page_url, headers=HEADERS, timeout=25)
        print("status:", resp.status_code, "len:", len(resp.text))
        resp.raise_for_status()
    except Exception as e:
        print(f"{source}: SKIP {e}")
        return []

    rows = extract_candidates(resp.text, page_url, cfg)
    print(f"{source}: candidates={len(rows)}")

    for title, url in rows[:8]:
        print(" -", title)
        print("   ", url)

    docs = []
    for title, url in rows:
        sid = stable_id(source, url)
        tickers = extract_tickers(title)
        sentiment, confidence = score_lightweight_sentiment(title)
        event_type, event_score, event_reason = classify_financial_event(title, "")
        docs.append({
            "_id": sid,
            "article_id": sid[:24],
            "source": source,
            "category": "public_market_news" if source in {"Finviz News", "TradingView News"} else "public_news",
            "title": title,
            "url": url,
            "link": url,
            "summary": "",
            "content": "",
            "publish_date": now_ts(),
            "fetched_date": now_ts(),
            "fetched_at": now_ts(),
            "collector": "unstructured_news_title_only_v1",
            "ticker": ",".join(tickers),
            "tickers_mentioned": tickers,
            "sentiment": sentiment,
            "ml_confidence": confidence,
            "sentiment_at": now_ts() if sentiment != "neutral" else None,
            "event_type": event_type,
            "event_score": event_score,
            "sentiment_reason": event_reason,
            "is_real": True
        })

    return docs

def main():
    with open(CONFIG_PATH, "r") as f:
        sources = json.load(f)

    client = MongoClient(MONGODB_URI)
    db = client[DB_NAME]
    articles_col = db.articles

    total_found = 0
    article_upserted = 0
    article_modified = 0
    kafka_publish_docs = []

    for cfg in sources:
        docs = fetch_source(cfg)
        total_found += len(docs)

        if not docs:
            continue

        article_ops = []
        for doc in docs:
            article_doc = dict(doc)
            document_id = article_doc.pop("_id")
            article_id = article_doc.pop("article_id")
            source = article_doc.pop("source")
            article_ops.append(UpdateOne(
                {"url": doc["url"]},
                {
                    "$set": article_doc,
                    "$setOnInsert": {"_id": document_id, "article_id": article_id, "source": source},
                    "$addToSet": {"discovery_sources": source},
                },
                upsert=True
            ))

        try:
            article_result = articles_col.bulk_write(article_ops, ordered=False)
            article_upserted += article_result.upserted_count
            article_modified += article_result.modified_count
        except BulkWriteError as e:
            print("BulkWriteError for", cfg["source"])
            print(e.details)

        kafka_publish_docs.extend(docs)

    print("\nUnstructured import complete:", {
        "found": total_found,
        "upserted": article_upserted,
        "modified": article_modified
    })

    # --- OPTIONAL Kafka publish (additive; OFF unless KAFKA_PUBLISH_NEWS=true) ---
    if os.getenv("KAFKA_PUBLISH_NEWS", "false").strip().lower() in ("1", "true", "yes"):
        try:
            import sys
            sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "Infrastructure", "kafka"))
            from news_publisher import publish_articles
            _sent = publish_articles(kafka_publish_docs)
            print(f"Kafka publish — {_sent} news events sent to topic")
        except Exception as exc:
            print(f"Kafka publish skipped (Mongo import unaffected): {exc}")

    client.close()

if __name__ == "__main__":
    main()
