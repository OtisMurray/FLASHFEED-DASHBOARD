"""
Reddit finance posts → MongoDB socials.

Fetches ONE subreddit per invocation, rotating through the list via a
simple timestamp-based index. That means zero burst traffic — one RSS
request every 5 minutes — so Reddit's rate limiter is never triggered.

Over 6 cycles (30 min) all subreddits are covered once.
"""
import os
import time
import hashlib
import re
import requests
import feedparser
from datetime import datetime, timezone
from pymongo import MongoClient, UpdateOne

MONGODB_URI = os.getenv("MONGODB_URI", "mongodb://localhost:27017/feedflash")
DB_NAME     = os.getenv("MONGODB_DB", "feedflash")
MAX_POSTS   = int(os.getenv("REDDIT_MAX_POSTS_PER_SUBREDDIT", "25"))
CYCLE_SECS  = int(os.getenv("REDDIT_CYCLE_SECONDS", "300"))   # how often this script runs

SUBREDDITS = [
    "stocks",
    "investing",
    "wallstreetbets",
    "StockMarket",
    "options",
    "SecurityAnalysis",
]

FINANCE_KW = [
    "stock", "stocks", "ticker", "shares", "earnings", "revenue", "guidance",
    "buyout", "acquisition", "merger", "offering", "ipo", "sec", "fda",
    "short squeeze", "squeeze", "halt", "lawsuit", "investigation",
    "calls", "puts", "options", "premarket", "after hours", "$",
    "bullish", "bearish", "rally", "crash", "moon",
]

GOSSIP_KW = [
    "rumor", "rumour", "hearing", "unconfirmed", "leak", "leaked",
    "buyout", "takeover", "acquisition", "merger", "short squeeze",
    "halt", "offering", "lawsuit", "investigation",
]

CASHTAG_RE = re.compile(r"\$([A-Z]{1,5})\b")

# Rotate through realistic desktop User-Agents
_UAS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0",
]


def _ua():
    # Pick UA based on minute so it looks consistent per session
    return _UAS[int(time.time() // 600) % len(_UAS)]


def now_ts():
    return int(datetime.now(timezone.utc).timestamp())


def sid(url):
    return hashlib.sha256(url.encode()).hexdigest()


def kwmatch(text, kws):
    low = text.lower()
    return [k for k in kws if k.lower() in low]


def cashtags(text):
    return list(set(CASHTAG_RE.findall(text or "")))


def pick_subreddit():
    """Return the subreddit index for this cycle based on current time."""
    idx = (now_ts() // CYCLE_SECS) % len(SUBREDDITS)
    return SUBREDDITS[idx]


def fetch_rss(subreddit):
    """Fetch subreddit RSS. Returns feedparser result or None."""
    # old.reddit.com is more lenient with anonymous RSS access
    url = f"https://old.reddit.com/r/{subreddit}/new/.rss"
    headers = {
        "User-Agent": _ua(),
        "Accept": "application/atom+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
    }
    try:
        r = requests.get(url, headers=headers, timeout=20)
        if r.status_code == 429:
            print(f"r/{subreddit}: 429 rate-limited — will retry next cycle")
            return None
        if r.status_code >= 400:
            print(f"r/{subreddit}: HTTP {r.status_code} — skipping")
            return None
        return feedparser.parse(r.text)
    except Exception as e:
        print(f"r/{subreddit}: error: {e}")
        return None


def parse_pub(entry):
    if getattr(entry, "published_parsed", None):
        return int(time.mktime(entry.published_parsed))
    if getattr(entry, "updated_parsed", None):
        return int(time.mktime(entry.updated_parsed))
    return now_ts()


def to_doc(entry, subreddit):
    title = getattr(entry, "title", "").strip()
    link  = getattr(entry, "link", "").strip()
    body  = getattr(entry, "summary", "").strip()[:500]
    if not title or not link:
        return None
    text = f"{title} {body}"
    fkw  = kwmatch(text, FINANCE_KW)
    if not fkw:
        return None
    gkw  = kwmatch(text, GOSSIP_KW)
    tags = cashtags(text)
    pub  = parse_pub(entry)
    _id  = sid(link)
    return {
        "_id": _id,
        "social_id": _id[:24],
        "platform": "Reddit",
        "source": "reddit_rss_finance",
        "collector": "reddit_rss_rotating_v3",
        "subreddit": subreddit,
        "title": title,
        "text": title,
        "content": body,
        "url": link,
        "author": getattr(entry, "author", ""),
        "ticker": ",".join(tags) if tags else "",
        "sentiment": "neutral",
        "score": 0,
        "ml_confidence": 0,
        "finance_keywords": fkw,
        "keywords": fkw,
        "gossip_keywords": gkw,
        "gossip_score": len(gkw),
        "message_density": None,
        "publish_date": pub,
        "created_at": pub,
        "detected_at": now_ts(),
        "fetched_at": now_ts(),
        "is_real": True,
    }


def main():
    sub = pick_subreddit()
    print(f"Reddit cycle: fetching r/{sub} (1 of {len(SUBREDDITS)} per run)")

    feed = fetch_rss(sub)
    if feed is None or not feed.entries:
        print(f"r/{sub}: no entries returned")
        return

    client = MongoClient(MONGODB_URI)
    col    = client[DB_NAME].socials
    docs   = [d for e in feed.entries[:MAX_POSTS] if (d := to_doc(e, sub))]
    print(f"r/{sub}: {len(feed.entries[:MAX_POSTS])} seen, {len(docs)} finance posts kept")

    if docs:
        ops = [UpdateOne({"_id": d["_id"]}, {"$set": d}, upsert=True) for d in docs]
        result = col.bulk_write(ops, ordered=False)
        print({"upserted": result.upserted_count, "modified": result.modified_count})

    client.close()


if __name__ == "__main__":
    main()
