import os
import time
import hashlib
import requests
from datetime import datetime
from pymongo import MongoClient, UpdateOne

MONGODB_URI = os.getenv("MONGODB_URI", "mongodb://localhost:27017/feedflash")
DB_NAME = os.getenv("MONGODB_DB", "feedflash")

REDDIT_MAX = int(os.getenv("REDDIT_MAX_POSTS_PER_SUBREDDIT", "15"))
BLUESKY_MAX = int(os.getenv("BLUESKY_MAX_PER_QUERY", "20"))
X_MAX = int(os.getenv("X_MAX_RESULTS", "25"))
STOCKTWITS_MAX_SYMBOLS = int(os.getenv("STOCKTWITS_MAX_SYMBOLS", "20"))

HEADERS = {
    "User-Agent": "FeedFlashStockDashboard/0.1 contact: otisemurray@icloud.com"
}

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
    "$AAPL OR $TSLA OR $NVDA OR $AMD OR $MSFT"
]

SYMBOLS = [
    "AAPL", "TSLA", "NVDA", "AMD", "MSFT", "META", "GOOGL", "AMZN",
    "PLTR", "SMCI", "COIN", "MSTR", "GME", "AMC", "RIVN", "SOFI",
    "INTC", "ORCL", "ADBE", "AVGO"
][:STOCKTWITS_MAX_SYMBOLS]


def now_ts():
    return int(time.time())


def stable_id(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def parse_iso_dt(value):
    if not value:
        return now_ts()
    try:
        return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp())
    except Exception:
        return now_ts()


def matches(text, keywords):
    low = (text or "").lower()
    return [k for k in keywords if k.lower() in low]


def save_docs(col, docs, label):
    if not docs:
        print(f"{label}: 0 kept")
        return

    ops = [
        UpdateOne({"_id": doc["_id"]}, {"$set": doc}, upsert=True)
        for doc in docs
    ]

    result = col.bulk_write(ops, ordered=False)
    print({
        "collector": label,
        "kept": len(docs),
        "upserted": result.upserted_count,
        "modified": result.modified_count
    })


def reddit_docs():
    import feedparser

    subreddits = ["stocks", "StockMarket", "investing", "SecurityAnalysis", "options"]
    docs = []

    for subreddit in subreddits:
        feed_url = f"https://www.reddit.com/r/{subreddit}/new/.rss"
        print(f"Fetching Reddit r/{subreddit}")

        try:
            resp = requests.get(feed_url, headers=HEADERS, timeout=25)
            resp.raise_for_status()
        except Exception as e:
            print(f"Reddit r/{subreddit}: SKIP {e}")
            continue

        feed = feedparser.parse(resp.text)

        for entry in feed.entries[:REDDIT_MAX]:
            title = getattr(entry, "title", "").strip()
            url = getattr(entry, "link", "").strip()
            summary = getattr(entry, "summary", "").strip()
            text = f"{title} {summary}".strip()

            if not title or not url:
                continue

            finance_keywords = matches(text, FINANCE_KEYWORDS)
            if not finance_keywords:
                continue

            sid = stable_id(url)
            docs.append({
                "_id": sid,
                "social_id": sid[:24],
                "platform": "Reddit",
                "source": "reddit_subreddit_new_rss",
                "collector": "reddit_rss_finance_only_v1",
                "subreddit": subreddit,
                "title": title,
                "text": title,
                "content": summary,
                "url": url,
                "author": getattr(entry, "author", ""),
                "ticker": "",
                "sentiment": "neutral",
                "score": 0,
                "ml_confidence": 0,
                "finance_keywords": finance_keywords,
                "keywords": finance_keywords,
                "gossip_keywords": matches(text, GOSSIP_KEYWORDS),
                "gossip_score": len(matches(text, GOSSIP_KEYWORDS)),
                "message_density": None,
                "created_at": now_ts(),
                "publish_date": now_ts(),
                "detected_at": now_ts(),
                "fetched_at": now_ts(),
                "is_real": True
            })

    return docs


def bluesky_docs():
    handle = os.getenv("BSKY_HANDLE")
    app_password = os.getenv("BSKY_APP_PASSWORD")

    if not handle or not app_password:
        print("Bluesky: SKIP missing BSKY_HANDLE or BSKY_APP_PASSWORD")
        return []

    print("Logging into Bluesky...")
    session_resp = requests.post(
        "https://bsky.social/xrpc/com.atproto.server.createSession",
        json={"identifier": handle, "password": app_password},
        headers=HEADERS,
        timeout=25
    )
    print("Bluesky auth status:", session_resp.status_code)

    if session_resp.status_code >= 400:
        print(session_resp.text[:300])
        return []

    access_jwt = session_resp.json().get("accessJwt")
    if not access_jwt:
        print("Bluesky: no accessJwt returned")
        return []

    auth_headers = dict(HEADERS)
    auth_headers["Authorization"] = f"Bearer {access_jwt}"

    docs = []
    seen = set()

    for query in QUERIES:
        print(f"Fetching Bluesky query: {query}")

        try:
            resp = requests.get(
                "https://bsky.social/xrpc/app.bsky.feed.searchPosts",
                headers=auth_headers,
                params={"q": query, "limit": BLUESKY_MAX, "sort": "latest"},
                timeout=25
            )
            print("Bluesky status:", resp.status_code)
            if resp.status_code >= 400:
                print(resp.text[:300])
                continue
        except Exception as e:
            print(f"Bluesky {query}: SKIP {e}")
            continue

        for post in resp.json().get("posts", []):
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

            docs.append({
                "_id": sid,
                "social_id": sid[:24],
                "platform": "Bluesky",
                "source": "bluesky_authenticated_search_api",
                "collector": "bluesky_finance_auth_api_v1",
                "query": query,
                "title": text[:140],
                "text": text,
                "content": text,
                "url": url,
                "author": handle,
                "ticker": "",
                "sentiment": "neutral",
                "score": 0,
                "ml_confidence": 0,
                "finance_keywords": finance_keywords,
                "keywords": finance_keywords,
                "gossip_keywords": matches(text, GOSSIP_KEYWORDS),
                "gossip_score": len(matches(text, GOSSIP_KEYWORDS)),
                "message_density": None,
                "created_at": parse_iso_dt(record.get("createdAt")),
                "publish_date": parse_iso_dt(record.get("createdAt")),
                "detected_at": now_ts(),
                "fetched_at": now_ts(),
                "is_real": True
            })

    return docs


def x_docs():
    bearer = os.getenv("X_BEARER_TOKEN")

    if not bearer:
        print("X/Twitter: SKIP missing X_BEARER_TOKEN")
        return []

    headers = dict(HEADERS)
    headers["Authorization"] = f"Bearer {bearer}"

    docs = []
    seen = set()

    for query in QUERIES:
        x_query = f'({query}) lang:en -is:retweet'
        print(f"Fetching X query: {x_query}")

        try:
            resp = requests.get(
                "https://api.x.com/2/tweets/search/recent",
                headers=headers,
                params={
                    "query": x_query,
                    "max_results": max(10, min(X_MAX, 100)),
                    "tweet.fields": "created_at,author_id,public_metrics,lang",
                },
                timeout=25
            )
            print("X status:", resp.status_code)
            if resp.status_code >= 400:
                print(resp.text[:500])
                continue
        except Exception as e:
            print(f"X {query}: SKIP {e}")
            continue

        data = resp.json().get("data", [])

        for tweet in data:
            tid = tweet.get("id", "")
            text = tweet.get("text", "")

            if not tid or not text:
                continue

            sid = stable_id(f"x:{tid}")
            if sid in seen:
                continue
            seen.add(sid)

            finance_keywords = matches(text, FINANCE_KEYWORDS)
            if not finance_keywords:
                continue

            docs.append({
                "_id": sid,
                "social_id": sid[:24],
                "platform": "X/Twitter",
                "source": "x_api_recent_search",
                "collector": "x_finance_recent_search_api_v1",
                "query": query,
                "title": text[:140],
                "text": text,
                "content": text,
                "url": f"https://x.com/i/web/status/{tid}",
                "author": tweet.get("author_id", ""),
                "ticker": "",
                "sentiment": "neutral",
                "score": 0,
                "ml_confidence": 0,
                "finance_keywords": finance_keywords,
                "keywords": finance_keywords,
                "gossip_keywords": matches(text, GOSSIP_KEYWORDS),
                "gossip_score": len(matches(text, GOSSIP_KEYWORDS)),
                "message_density": None,
                "created_at": parse_iso_dt(tweet.get("created_at")),
                "publish_date": parse_iso_dt(tweet.get("created_at")),
                "detected_at": now_ts(),
                "fetched_at": now_ts(),
                "is_real": True
            })

    return docs


def stocktwits_docs():
    username = os.getenv("STOCKTWITS_USERNAME")
    password = os.getenv("STOCKTWITS_PASSWORD")

    if not username or not password:
        print("StockTwits: SKIP missing STOCKTWITS_USERNAME or STOCKTWITS_PASSWORD")
        return []

    docs = []
    seen = set()

    for symbol in SYMBOLS:
        print(f"Fetching StockTwits symbol: {symbol}")

        # Official StockTwits docs commonly expose symbol stream style endpoints.
        # Credentials are passed through HTTP Basic if your access supports it.
        url = f"https://api.stocktwits.com/api/2/streams/symbol/{symbol}.json"

        try:
            resp = requests.get(
                url,
                headers=HEADERS,
                auth=(username, password),
                timeout=25
            )
            print("StockTwits status:", resp.status_code)
            if resp.status_code >= 400:
                print(resp.text[:300])
                continue
        except Exception as e:
            print(f"StockTwits {symbol}: SKIP {e}")
            continue

        messages = resp.json().get("messages", [])

        for msg in messages:
            mid = str(msg.get("id", ""))
            body = msg.get("body", "") or ""

            if not mid or not body:
                continue

            sid = stable_id(f"stocktwits:{mid}")
            if sid in seen:
                continue
            seen.add(sid)

            finance_keywords = matches(f"{symbol} {body}", FINANCE_KEYWORDS) or [symbol]

            user = msg.get("user", {}) or {}
            created_at = msg.get("created_at")

            docs.append({
                "_id": sid,
                "social_id": sid[:24],
                "platform": "StockTwits",
                "source": "stocktwits_symbol_stream_api",
                "collector": "stocktwits_symbol_stream_api_v1",
                "symbol": symbol,
                "ticker": symbol,
                "title": body[:140],
                "text": body,
                "content": body,
                "url": f"https://stocktwits.com/symbol/{symbol}",
                "author": user.get("username", ""),
                "sentiment": "neutral",
                "score": 0,
                "ml_confidence": 0,
                "finance_keywords": finance_keywords,
                "keywords": finance_keywords,
                "gossip_keywords": matches(body, GOSSIP_KEYWORDS),
                "gossip_score": len(matches(body, GOSSIP_KEYWORDS)),
                "message_density": None,
                "created_at": parse_iso_dt(created_at),
                "publish_date": parse_iso_dt(created_at),
                "detected_at": now_ts(),
                "fetched_at": now_ts(),
                "is_real": True
            })

    return docs


def main():
    client = MongoClient(MONGODB_URI)
    db = client[DB_NAME]
    col = db.socials

    save_docs(col, reddit_docs(), "reddit_rss_finance_only_v1")
    save_docs(col, bluesky_docs(), "bluesky_finance_auth_api_v1")
    save_docs(col, x_docs(), "x_finance_recent_search_api_v1")
    save_docs(col, stocktwits_docs(), "stocktwits_symbol_stream_api_v1")

    client.close()
    print("All social collectors complete.")


if __name__ == "__main__":
    main()
