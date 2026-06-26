import os
import time
import hashlib
import requests
from datetime import datetime
from pymongo import MongoClient, UpdateOne

MONGODB_URI = os.getenv("MONGODB_URI", "mongodb://localhost:27017/feedflash")
DB_NAME = os.getenv("MONGODB_DB", "feedflash")
MAX_PER_QUERY = int(os.getenv("BLUESKY_MAX_PER_QUERY", "20"))

API = "https://api.bsky.app/xrpc/app.bsky.feed.searchPosts"

QUERIES = [
    "stocks",
    "earnings",
    "stock market",
    "short squeeze",
    "IPO",
    "merger acquisition",
    "FDA approval stock",
    "SEC investigation stock",
    "options trading",
    "$AAPL",
    "$TSLA",
    "$NVDA",
    "$AMD"
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

def main():
    client = MongoClient(MONGODB_URI)
    db = client[DB_NAME]
    col = db.socials

    ops = []
    seen = set()
    total_seen = 0
    total_kept = 0

    for query in QUERIES:
        print(f"Fetching Bluesky query: {query}")

        try:
            resp = requests.get(
                API,
                params={"q": query, "limit": MAX_PER_QUERY, "sort": "latest"},
                headers=HEADERS,
                timeout=25
            )
            print("status:", resp.status_code)
            if resp.status_code >= 400:
                print(resp.text[:300])
                continue
        except Exception as e:
            print(f"Bluesky {query}: SKIP {e}")
            continue

        posts = resp.json().get("posts", [])

        for post in posts:
            total_seen += 1

            uri = post.get("uri", "")
            record = post.get("record", {}) or {}
            text = record.get("text", "") or ""
            author = post.get("author", {}) or {}
            handle = author.get("handle", "")

            if not uri or not text:
                continue

            sid = stable_id(uri)
            if sid in seen:
                continue
            seen.add(sid)

            finance_keywords = matches(text, FINANCE_KEYWORDS)
            if not finance_keywords:
                continue

            post_id = uri.split("/")[-1]
            url = f"https://bsky.app/profile/{handle}/post/{post_id}" if handle else ""

            gossip_keywords = matches(text, GOSSIP_KEYWORDS)

            doc = {
                "_id": sid,
                "social_id": sid[:24],
                "platform": "Bluesky",
                "source": "bluesky_public_search_api",
                "collector": "bluesky_public_finance_search_v1",
                "query": query,
                "title": text[:140],
                "text": text,
                "content": text,
                "url": url,
                "author": handle,
                "author_display_name": author.get("displayName", ""),
                "ticker": "",
                "sentiment": "neutral",
                "score": 0,
                "ml_confidence": 0,
                "finance_keywords": finance_keywords,
                "keywords": finance_keywords,
                "gossip_keywords": gossip_keywords,
                "gossip_score": len(gossip_keywords),
                "message_density": None,
                "created_at": parse_iso(record.get("createdAt")),
                "publish_date": parse_iso(record.get("createdAt")),
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
