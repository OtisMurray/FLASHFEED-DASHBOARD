import os
import time
import hashlib
import requests
from datetime import datetime
from pymongo import MongoClient, UpdateOne

MONGODB_URI = os.getenv("MONGODB_URI", "mongodb://localhost:27017/feedflash")
DB_NAME = os.getenv("MONGODB_DB", "feedflash")
MAX_SYMBOLS = int(os.getenv("STOCKTWITS_MAX_SYMBOLS", "20"))

def load_symbols():
    path = os.getenv("SOCIAL_TICKERS_FILE", "config/social_tickers_100.txt")
    symbols = []

    try:
        with open(path, "r") as f:
            for line in f:
                sym = line.strip().upper()
                if not sym or sym.startswith("#"):
                    continue
                symbols.append(sym)
    except FileNotFoundError:
        symbols = [
            "AAPL", "TSLA", "NVDA", "AMD", "MSFT", "META", "GOOGL", "AMZN",
            "PLTR", "SMCI", "COIN", "MSTR", "GME", "AMC", "RIVN", "SOFI",
            "INTC", "ORCL", "ADBE", "AVGO"
        ]

    # preserve order, remove dupes
    out = []
    seen = set()
    for sym in symbols:
        if sym not in seen:
            seen.add(sym)
            out.append(sym)

    offset = int(os.getenv("STOCKTWITS_SYMBOL_OFFSET", "0"))

    if offset < 0:
        offset = 0

    return out[offset:offset + MAX_SYMBOLS]

SYMBOLS = load_symbols()

FINANCE_KEYWORDS = [
    "stock", "stocks", "ticker", "shares", "earnings", "revenue", "guidance",
    "buyout", "acquisition", "merger", "offering", "ipo", "sec", "fda",
    "short squeeze", "squeeze", "halt", "lawsuit", "investigation",
    "calls", "puts", "options", "premarket", "after hours", "$",
    "bullish", "bearish"
]

GOSSIP_KEYWORDS = [
    "rumor", "rumour", "hearing", "unconfirmed", "leak", "leaked",
    "buyout", "takeover", "acquisition", "merger", "short squeeze",
    "halt", "offering", "lawsuit", "investigation", "fda approval",
    "sec investigation"
]

HEADERS = {
    "User-Agent": "FeedFlashStockDashboard/0.1 contact: otisemurray@icloud.com"
}

def now_ts():
    return int(time.time())

def stable_id(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()

def parse_iso(value):
    if not value:
        return now_ts()
    try:
        return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp())
    except Exception:
        return now_ts()

def matches(text, keywords):
    low = (text or "").lower()
    return [k for k in keywords if k.lower() in low]

def sentiment_from_msg(msg):
    entities = msg.get("entities", {}) or {}
    sentiment = entities.get("sentiment")
    if isinstance(sentiment, dict):
        basic = sentiment.get("basic")
        if basic:
            return basic.lower()
    return "neutral"

def main():
    client = MongoClient(MONGODB_URI)
    db = client[DB_NAME]
    col = db.socials

    ops = []
    seen = set()
    total_seen = 0
    total_kept = 0

    for symbol in SYMBOLS:
        print(f"Fetching StockTwits symbol: {symbol}")

        url = f"https://api.stocktwits.com/api/2/streams/symbol/{symbol}.json"

        try:
            resp = requests.get(url, headers=HEADERS, timeout=25)
            print("status:", resp.status_code)
            if resp.status_code >= 400:
                print(resp.text[:300])
                continue
        except Exception as e:
            print(f"StockTwits {symbol}: SKIP {e}")
            continue

        messages = resp.json().get("messages", [])

        for msg in messages:
            total_seen += 1

            mid = str(msg.get("id", ""))
            body = msg.get("body", "") or ""

            if not mid or not body:
                continue

            sid = stable_id(f"stocktwits:{mid}")
            if sid in seen:
                continue
            seen.add(sid)

            user = msg.get("user", {}) or {}
            gossip_keywords = matches(body, GOSSIP_KEYWORDS)
            finance_keywords = matches(f"${symbol} {body}", FINANCE_KEYWORDS) or [symbol]

            doc = {
                "_id": sid,
                "social_id": sid[:24],
                "platform": "StockTwits",
                "source": "stocktwits_public_symbol_stream",
                "collector": "stocktwits_public_symbol_stream_v1",
                "symbol": symbol,
                "ticker": symbol,
                "title": body[:140],
                "text": body,
                "content": body,
                "url": f"https://stocktwits.com/symbol/{symbol}",
                "author": user.get("username", ""),
                "sentiment": sentiment_from_msg(msg),
                "score": 0,
                "ml_confidence": 0,
                "finance_keywords": finance_keywords,
                "keywords": finance_keywords,
                "gossip_keywords": gossip_keywords,
                "gossip_score": len(gossip_keywords),
                "message_density": None,
                "created_at": parse_iso(msg.get("created_at")),
                "publish_date": parse_iso(msg.get("created_at")),
                "detected_at": now_ts(),
                "fetched_at": now_ts(),
                "is_real": True
            }

            ops.append(UpdateOne({"_id": doc["_id"]}, {"$set": doc}, upsert=True))
            total_kept += 1

    if ops:
        result = col.bulk_write(ops, ordered=False)
        print({"seen": total_seen, "kept": total_kept, "upserted": result.upserted_count, "modified": result.modified_count})
    else:
        print({"seen": total_seen, "kept": total_kept, "upserted": 0, "modified": 0})

    client.close()

if __name__ == "__main__":
    main()
