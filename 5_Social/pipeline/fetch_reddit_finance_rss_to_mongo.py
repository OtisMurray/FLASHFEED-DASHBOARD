import os
import time
import hashlib
import requests
import feedparser
from datetime import datetime, timezone
from pymongo import MongoClient, UpdateOne

MONGODB_URI = os.getenv("MONGODB_URI", "mongodb://localhost:27017/feedflash")
DB_NAME = os.getenv("MONGODB_DB", "feedflash")
MAX_POSTS_PER_SUBREDDIT = int(os.getenv("REDDIT_MAX_POSTS_PER_SUBREDDIT", "15"))

FINANCE_SUBREDDITS = [
    "stocks",
    "StockMarket",
    "investing",
    "SecurityAnalysis",
]

# Keep WSB, but only if you want high-noise/high-rumor source:
# FINANCE_SUBREDDITS.append("wallstreetbets")

FINANCE_KEYWORDS = [
    "stock", "stocks", "ticker", "shares", "earnings", "revenue", "guidance",
    "buyout", "acquisition", "merger", "offering", "ipo", "sec", "fda",
    "short squeeze", "squeeze", "halt", "lawsuit", "investigation",
    "calls", "puts", "options", "premarket", "after hours",
]

GOSSIP_KEYWORDS = [
    "rumor", "rumour", "hearing", "unconfirmed", "leak", "leaked",
    "buyout", "takeover", "acquisition", "merger", "short squeeze",
    "halt", "offering", "lawsuit", "investigation",
]

HEADERS = {
    "User-Agent": "FeedFlashStockDashboard/0.1 by OtisMurray"
}


def now_ts():
    return int(datetime.now(timezone.utc).timestamp())


def stable_id(source_url):
    return hashlib.sha256(source_url.encode("utf-8")).hexdigest()


def matched_keywords(text, keywords):
    lowered = text.lower()
    return [k for k in keywords if k.lower() in lowered]


def is_finance_relevant(text):
    return len(matched_keywords(text, FINANCE_KEYWORDS)) > 0


def parse_published(entry):
    if getattr(entry, "published_parsed", None):
        return int(time.mktime(entry.published_parsed))
    if getattr(entry, "updated_parsed", None):
        return int(time.mktime(entry.updated_parsed))
    return now_ts()


def main():
    client = MongoClient(MONGODB_URI)
    db = client[DB_NAME]
    socials = db.socials

    ops = []
    seen = 0
    kept = 0

    for subreddit in FINANCE_SUBREDDITS:
        url = f"https://www.reddit.com/r/{subreddit}/new/.rss"
        print(f"Fetching {url}")

        try:
            resp = requests.get(url, headers=HEADERS, timeout=20)
            resp.raise_for_status()
        except Exception as e:
            print(f"Failed {subreddit}: {e}")
            continue

        feed = feedparser.parse(resp.text)

        for entry in feed.entries[:MAX_POSTS_PER_SUBREDDIT]:
            seen += 1

            title = getattr(entry, "title", "").strip()
            link = getattr(entry, "link", "").strip()
            summary = getattr(entry, "summary", "").strip()
            text = f"{title} {summary}"

            if not title or not link:
                continue

            if not is_finance_relevant(text):
                continue

            finance_matches = matched_keywords(text, FINANCE_KEYWORDS)
            gossip_matches = matched_keywords(text, GOSSIP_KEYWORDS)

            doc = {
                "_id": stable_id(link),
                "source": "reddit_subreddit_new_rss",
                "collector": "reddit_rss_finance_only_v1",
                "subreddit": subreddit,
                "title": title,
                "url": link,
                "summary": summary,
                "text": text,
                "finance_keywords": finance_matches,
                "gossip_keywords": gossip_matches,
                "gossip_score": len(gossip_matches),
                "publish_date": parse_published(entry),
                "fetched_at": now_ts(),
                "raw_source_url": url,
            }

            ops.append(
                UpdateOne(
                    {"_id": doc["_id"]},
                    {"$set": doc},
                    upsert=True,
                )
            )
            kept += 1

    if ops:
        result = socials.bulk_write(ops, ordered=False)
        print({
            "seen": seen,
            "kept": kept,
            "upserted": result.upserted_count,
            "modified": result.modified_count,
        })
    else:
        print({"seen": seen, "kept": kept, "upserted": 0, "modified": 0})


if __name__ == "__main__":
    main()
