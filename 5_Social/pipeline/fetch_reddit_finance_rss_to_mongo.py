import os
import re
import time
import hashlib
import requests
import feedparser
from datetime import datetime, timezone
from pymongo import MongoClient, UpdateOne

MONGODB_URI = os.getenv("MONGODB_URI", "mongodb://localhost:27017/feedflash")
DB_NAME = os.getenv("MONGODB_DB", "feedflash")
MAX_POSTS_PER_SUBREDDIT = int(os.getenv("REDDIT_MAX_POSTS_PER_SUBREDDIT", "25"))
REQUEST_TIMEOUT = int(os.getenv("SOCIAL_REDDIT_TIMEOUT", "8"))

FINANCE_SUBREDDITS = [
    "stocks",
    "StockMarket",
    "investing",
    "SecurityAnalysis",
    "options",
]

FINANCE_KEYWORDS = [
    "stock", "stocks", "ticker", "shares", "earnings", "revenue", "guidance",
    "buyout", "acquisition", "merger", "offering", "ipo", "sec", "fda",
    "short squeeze", "squeeze", "halt", "lawsuit", "investigation",
    "calls", "puts", "options", "premarket", "after hours", "$"
]

GOSSIP_KEYWORDS = [
    "rumor", "rumour", "hearing", "unconfirmed", "leak", "leaked",
    "buyout", "takeover", "acquisition", "merger", "short squeeze",
    "halt", "offering", "lawsuit", "investigation", "fda approval",
    "sec investigation"
]

BLOCKED_FALSE_TICKERS = {
    "AI", "CEO", "CFO", "IPO", "ETF", "SEC", "FDA", "USA", "USD",
    "THE", "FOR", "ARE", "YOU", "CAN", "HAS", "NEW", "NOW"
}

HEADERS = {
    "User-Agent": "FeedFlashStockDashboard/0.1 contact: otisemurray@icloud.com"
}

TICKER_RE = re.compile(r"(?<![A-Z0-9])\$?([A-Z]{1,5})(?![A-Z0-9])")


def now_ts():
    return int(datetime.now(timezone.utc).timestamp())


def stable_id(source_url):
    return hashlib.sha256(source_url.encode("utf-8")).hexdigest()


def word_match(text, keyword):
    keyword = keyword.strip()
    if not keyword:
        return False

    if keyword == "$":
        return "$" in text

    escaped = re.escape(keyword)

    if re.fullmatch(r"[A-Za-z0-9]+", keyword):
        return re.search(rf"\b{escaped}\b", text, flags=re.I) is not None

    return re.search(escaped, text, flags=re.I) is not None


def matched_keywords(text, keywords):
    return [k for k in keywords if word_match(text, k)]


def is_finance_relevant(text):
    return len(matched_keywords(text, FINANCE_KEYWORDS)) > 0


def parse_published(entry):
    if getattr(entry, "published_parsed", None):
        return int(time.mktime(entry.published_parsed))
    if getattr(entry, "updated_parsed", None):
        return int(time.mktime(entry.updated_parsed))
    return now_ts()


def extract_tickers(text):
    tickers = []
    for m in TICKER_RE.finditer(text or ""):
        ticker = m.group(1).upper()
        if ticker in BLOCKED_FALSE_TICKERS:
            continue
        if len(ticker) <= 1:
            continue
        tickers.append(ticker)
    return sorted(set(tickers))[:8]


def main():
    client = MongoClient(MONGODB_URI)
    db = client[DB_NAME]
    socials = db.socials

    ops = []
    seen = 0
    kept = 0
    failures = []

    for subreddit in FINANCE_SUBREDDITS:
        url = f"https://www.reddit.com/r/{subreddit}/new/.rss"
        print(f"Fetching {url}")

        try:
            resp = requests.get(url, headers=HEADERS, timeout=REQUEST_TIMEOUT)
            resp.raise_for_status()
        except Exception as e:
            failures.append({"subreddit": subreddit, "error": str(e)})
            print(f"Reddit r/{subreddit}: SKIP {e}")
            continue

        feed = feedparser.parse(resp.text)

        for entry in feed.entries[:MAX_POSTS_PER_SUBREDDIT]:
            seen += 1

            title = getattr(entry, "title", "").strip()
            link = getattr(entry, "link", "").strip()
            summary = getattr(entry, "summary", "").strip()
            author = getattr(entry, "author", "").strip()
            text = f"{title} {summary}".strip()

            if not title or not link:
                continue

            if not is_finance_relevant(text):
                continue

            finance_matches = matched_keywords(text, FINANCE_KEYWORDS)
            gossip_matches = matched_keywords(text, GOSSIP_KEYWORDS)
            tickers = extract_tickers(text)
            published = parse_published(entry)
            sid = stable_id(link)

            doc = {
                "_id": sid,
                "social_id": sid[:24],
                "platform": "Reddit",
                "source": "reddit_subreddit_new_rss",
                "collector": "reddit_rss_finance_only_v2_safe",
                "subreddit": subreddit,
                "author": author,
                "title": title,
                "text": title,
                "content": summary,
                "url": link,
                "ticker": ",".join(tickers),
                "sentiment": "neutral",
                "score": 0,
                "ml_confidence": 0,
                "finance_keywords": finance_matches,
                "gossip_keywords": gossip_matches,
                "gossip_score": len(gossip_matches),
                "publish_date": published,
                "fetched_at": now_ts(),
                "detected_at": now_ts(),
                "raw_source_url": url,
            }

            ops.append(UpdateOne({"_id": doc["_id"]}, {"$set": doc}, upsert=True))
            kept += 1

    result_summary = {
        "collector": "reddit_rss_finance_only_v2_safe",
        "seen": seen,
        "kept": kept,
        "failures": failures,
        "upserted": 0,
        "modified": 0,
        "total_reddit_socials": socials.count_documents({"platform": "Reddit"}),
    }

    if ops:
        result = socials.bulk_write(ops, ordered=False)
        result_summary["upserted"] = result.upserted_count
        result_summary["modified"] = result.modified_count
        result_summary["total_reddit_socials"] = socials.count_documents({"platform": "Reddit"})

    print(result_summary)


if __name__ == "__main__":
    main()
