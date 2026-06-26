import os
import re
import time
import hashlib
import requests
import feedparser
from urllib.parse import quote_plus
from pymongo import UpdateOne
from social_finviz_universe import mongo_db, load_finviz_top_gainers

TIMEOUT = int(os.getenv("REDDIT_TIMEOUT", "10"))
LIMIT_PER_TICKER = int(os.getenv("REDDIT_LIMIT_PER_TICKER", "10"))
SUBREDDITS = "stocks+StockMarket+investing+options+pennystocks"
HEADERS = {"User-Agent": "FeedFlashStockDashboard/0.1"}

def now_ts():
    return int(time.time())

def stable_id(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()

def parse_entry_time(entry):
    if getattr(entry, "published_parsed", None):
        return int(time.mktime(entry.published_parsed))
    if getattr(entry, "updated_parsed", None):
        return int(time.mktime(entry.updated_parsed))
    return now_ts()

def strict_contains_ticker(text, ticker):
    return re.search(rf"(?<![A-Za-z0-9])\$?{re.escape(ticker)}(?![A-Za-z0-9])", text or "", flags=re.I) is not None

def fetch_ticker(ticker):
    q = quote_plus(f"${ticker} OR {ticker}")
    url = f"https://www.reddit.com/r/{SUBREDDITS}/search.rss?q={q}&restrict_sr=on&sort=new&t=day"

    try:
        r = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
        if r.status_code >= 400:
            return ticker, [], f"http_{r.status_code}"
        feed = feedparser.parse(r.text)
    except Exception as exc:
        return ticker, [], str(exc)

    docs = []

    for entry in feed.entries[:LIMIT_PER_TICKER]:
        title = str(getattr(entry, "title", "") or "").strip()
        summary = str(getattr(entry, "summary", "") or "").strip()
        link = str(getattr(entry, "link", "") or "").strip()
        author = str(getattr(entry, "author", "") or "").strip()
        text = f"{title} {summary}".strip()

        if not title or not link or not strict_contains_ticker(text, ticker):
            continue

        published = parse_entry_time(entry)
        detected = now_ts()
        sid = stable_id(f"reddit:{ticker}:{link}")

        docs.append({
            "_id": sid,
            "social_id": sid[:24],
            "platform": "Reddit",
            "source": "reddit_public_search_rss",
            "collector": "reddit_finviz_top_gainers_only_v4",
            "social_universe": "finviz_top_gainers",
            "ticker_universe_source": "finviz_elite_screener_top_gainers",
            "finviz_top_gainer_source": True,
            "ticker": ticker,
            "symbol": ticker,
            "title": title[:140],
            "text": title,
            "content": summary,
            "url": link,
            "author": author,
            "sentiment": "neutral",
            "keywords": [ticker],
            "finance_keywords": [ticker],
            "publish_date": published,
            "created_at": published,
            "detected_at": detected,
            "fetched_at": detected,
            "is_real": True
        })

    return ticker, docs, None

def main():
    client, db = mongo_db()
    tickers = load_finviz_top_gainers(db)

    if not tickers:
        print({"collector": "reddit_finviz_top_gainers_only_v4", "status": "skipped", "reason": "no_finviz_top_gainers"})
        return

    print({"collector": "reddit_finviz_top_gainers_only_v4", "tickers": tickers})

    ops = []
    errors = []

    for ticker in tickers:
        ticker, docs, error = fetch_ticker(ticker)
        if error:
            errors.append({"ticker": ticker, "error": error})
            print(f"Reddit {ticker}: SKIP {error}")
            continue

        print(f"Reddit {ticker}: {len(docs)} posts")

        for doc in docs:
            ops.append(UpdateOne({"_id": doc["_id"]}, {"$set": doc}, upsert=True))

    result = db.socials.bulk_write(ops, ordered=False) if ops else None

    print({
        "collector": "reddit_finviz_top_gainers_only_v4",
        "tickers_checked": tickers,
        "upserted": result.upserted_count if result else 0,
        "modified": result.modified_count if result else 0,
        "errors": errors[:5]
    })

    client.close()

if __name__ == "__main__":
    main()
