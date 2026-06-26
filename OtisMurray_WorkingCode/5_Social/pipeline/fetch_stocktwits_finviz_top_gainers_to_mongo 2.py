import os
import re
import time
import hashlib
import requests
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor, as_completed
from pymongo import UpdateOne
from social_finviz_universe import mongo_db, load_finviz_top_gainers

MAX_WORKERS = int(os.getenv("STOCKTWITS_MAX_WORKERS", "4"))
TIMEOUT = int(os.getenv("STOCKTWITS_TIMEOUT", "12"))

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

def sentiment_from_msg(msg):
    sentiment = ((msg.get("entities") or {}).get("sentiment") or {})
    raw = str(sentiment.get("basic") if isinstance(sentiment, dict) else "").lower()
    return raw if raw in {"bullish", "bearish"} else "neutral"

def fetch_symbol(ticker):
    url = f"https://api.stocktwits.com/api/2/streams/symbol/{ticker}.json"

    try:
        r = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
        if r.status_code == 429:
            return ticker, [], "rate_limited_429"
        if r.status_code >= 400:
            return ticker, [], f"http_{r.status_code}"
        payload = r.json()
    except Exception as exc:
        return ticker, [], str(exc)

    docs = []

    for msg in payload.get("messages", []):
        mid = str(msg.get("id") or "")
        body = str(msg.get("body") or "").strip()
        if not mid or not body:
            continue

        created = parse_time(msg.get("created_at") or "")
        detected = now_ts()
        user = msg.get("user", {}) or {}
        sid = stable_id(f"stocktwits:{ticker}:{mid}")

        docs.append({
            "_id": sid,
            "social_id": sid[:24],
            "platform": "StockTwits",
            "source": "stocktwits_public_symbol_stream",
            "collector": "stocktwits_finviz_top_gainers_only_v4",
            "social_universe": "finviz_top_gainers",
            "ticker_universe_source": "finviz_elite_screener_top_gainers",
            "finviz_top_gainer_source": True,
            "ticker": ticker,
            "symbol": ticker,
            "title": body[:140],
            "text": body,
            "content": body,
            "url": f"https://stocktwits.com/symbol/{ticker}",
            "author": user.get("username", ""),
            "sentiment": sentiment_from_msg(msg),
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
        print({"collector": "stocktwits_finviz_top_gainers_only_v4", "status": "skipped", "reason": "no_finviz_top_gainers"})
        return

    print({"collector": "stocktwits_finviz_top_gainers_only_v4", "tickers": tickers})

    ops = []
    errors = []

    with ThreadPoolExecutor(max_workers=max(1, min(MAX_WORKERS, len(tickers)))) as pool:
        futures = {pool.submit(fetch_symbol, t): t for t in tickers}

        for fut in as_completed(futures):
            ticker, docs, error = fut.result()
            if error:
                errors.append({"ticker": ticker, "error": error})
                print(f"StockTwits {ticker}: SKIP {error}")
                continue

            print(f"StockTwits {ticker}: {len(docs)} messages")

            for doc in docs:
                ops.append(UpdateOne({"_id": doc["_id"]}, {"$set": doc}, upsert=True))

    result = db.socials.bulk_write(ops, ordered=False) if ops else None

    print({
        "collector": "stocktwits_finviz_top_gainers_only_v4",
        "tickers_checked": tickers,
        "upserted": result.upserted_count if result else 0,
        "modified": result.modified_count if result else 0,
        "errors": errors[:5]
    })

    client.close()

if __name__ == "__main__":
    main()
