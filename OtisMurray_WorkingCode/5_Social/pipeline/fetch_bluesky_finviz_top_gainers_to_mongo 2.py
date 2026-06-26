import os
import re
import time
import hashlib
import requests
from datetime import datetime
from pymongo import UpdateOne
from social_finviz_universe import mongo_db, load_finviz_top_gainers

TIMEOUT = int(os.getenv("BLUESKY_TIMEOUT", "12"))
LIMIT_PER_TICKER = int(os.getenv("BLUESKY_LIMIT_PER_TICKER", "20"))
SEARCH_URL = "https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts"
HEADERS = {"User-Agent": "FeedFlashStockDashboard/0.1"}

def now_ts():
    return int(time.time())

def stable_id(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()

def parse_time(value):
    try:
        return int(datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp())
    except Exception:
        return now_ts()

def strict_contains_ticker(text, ticker):
    return re.search(rf"(?<![A-Za-z0-9])\$?{re.escape(ticker)}(?![A-Za-z0-9])", text or "", flags=re.I) is not None

def fetch_ticker(ticker):
    params = {"q": f"${ticker} OR {ticker} stock", "sort": "latest", "limit": str(LIMIT_PER_TICKER)}

    try:
        r = requests.get(SEARCH_URL, params=params, headers=HEADERS, timeout=TIMEOUT)
        if r.status_code >= 400:
            return ticker, [], f"http_{r.status_code}"
        payload = r.json()
    except Exception as exc:
        return ticker, [], str(exc)

    docs = []

    for post in payload.get("posts", []):
        record = post.get("record", {}) or {}
        text = str(record.get("text") or "").strip()
        uri = str(post.get("uri") or "")
        cid = str(post.get("cid") or "")
        author = post.get("author", {}) or {}

        if not text or not strict_contains_ticker(text, ticker):
            continue

        created = parse_time(record.get("createdAt") or post.get("indexedAt"))
        detected = now_ts()
        sid = stable_id(f"bluesky:{ticker}:{uri}:{cid}")

        docs.append({
            "_id": sid,
            "social_id": sid[:24],
            "platform": "Bluesky",
            "source": "bluesky_public_search",
            "collector": "bluesky_finviz_top_gainers_only_v4",
            "social_universe": "finviz_top_gainers",
            "ticker_universe_source": "finviz_elite_screener_top_gainers",
            "finviz_top_gainer_source": True,
            "ticker": ticker,
            "symbol": ticker,
            "title": text[:140],
            "text": text,
            "content": text,
            "url": f"https://bsky.app/profile/{author.get('handle', '')}/post/{uri.split('/')[-1]}" if uri else "",
            "author": author.get("handle", ""),
            "sentiment": "neutral",
            "keywords": [ticker],
            "finance_keywords": [ticker],
            "publish_date": created,
            "created_at": created,
            "detected_at": detected,
            "fetched_at": detected,
            "is_real": True
        })

    return ticker, docs, None

def main():
    client, db = mongo_db()
    tickers = load_finviz_top_gainers(db)

    if not tickers:
        print({"collector": "bluesky_finviz_top_gainers_only_v4", "status": "skipped", "reason": "no_finviz_top_gainers"})
        return

    print({"collector": "bluesky_finviz_top_gainers_only_v4", "tickers": tickers})

    ops = []
    errors = []

    for ticker in tickers:
        ticker, docs, error = fetch_ticker(ticker)
        if error:
            errors.append({"ticker": ticker, "error": error})
            print(f"Bluesky {ticker}: SKIP {error}")
            continue

        print(f"Bluesky {ticker}: {len(docs)} posts")

        for doc in docs:
            ops.append(UpdateOne({"_id": doc["_id"]}, {"$set": doc}, upsert=True))

    result = db.socials.bulk_write(ops, ordered=False) if ops else None

    print({
        "collector": "bluesky_finviz_top_gainers_only_v4",
        "tickers_checked": tickers,
        "upserted": result.upserted_count if result else 0,
        "modified": result.modified_count if result else 0,
        "errors": errors[:5]
    })

    client.close()

if __name__ == "__main__":
    main()
