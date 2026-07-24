"""
Fetch public StockTwits posts for the configured stock watchlist and upsert them
into MongoDB's socials collection for the dashboard rolling social feed.
"""

from __future__ import annotations

import hashlib
import html
import os
import re
import time
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote_plus

from pymongo import MongoClient, UpdateOne
from sentiment_utils import audit_social_sentiment, score_social_sentiment
try:
    from source_status import record_source_status
except Exception:
    def record_source_status(*_args, **_kwargs):
        return None

try:
    from curl_cffi import requests as http_requests
except Exception:
    import requests as http_requests
try:
    import feedparser
except Exception:
    feedparser = None

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_TICKER_FILE = ROOT / "config" / "social_tickers_100.txt"

MONGODB_URI = os.getenv("MONGODB_URI", "mongodb://localhost:27017/feedflash")
DB_NAME = os.getenv("MONGODB_DB", os.getenv("MONGO_DB", "feedflash"))
TICKER_FILE = Path(os.getenv("SOCIAL_TICKER_FILE", str(DEFAULT_TICKER_FILE)))
MAX_TICKERS = int(os.getenv("SOCIAL_MAX_TICKERS", "250"))
MAX_WORKERS = int(os.getenv("SOCIAL_MAX_WORKERS", "8"))
TIMEOUT = int(os.getenv("SOCIAL_REQUEST_TIMEOUT", "15"))
INCLUDE_REDDIT = os.getenv("SOCIAL_INCLUDE_REDDIT", "true").lower() in ("1", "true", "yes")
INCLUDE_X = os.getenv("SOCIAL_INCLUDE_X", "true").lower() in ("1", "true", "yes")
INCLUDE_BLUESKY = os.getenv("SOCIAL_INCLUDE_BLUESKY", "true").lower() in ("1", "true", "yes")
X_BEARER_TOKEN = os.getenv("X_BEARER_TOKEN", "").strip()
X_MAX_RESULTS = int(os.getenv("SOCIAL_X_MAX_RESULTS", "10"))
BLUESKY_MAX_RESULTS = int(os.getenv("SOCIAL_BLUESKY_MAX_RESULTS", "10"))
REDDIT_MAX_PER_SUBREDDIT = int(os.getenv("SOCIAL_REDDIT_MAX_PER_SUBREDDIT", "3"))
REDDIT_GLOBAL_MAX = int(os.getenv("SOCIAL_REDDIT_GLOBAL_MAX", "8"))
REDDIT_RECENT_LIMIT = int(os.getenv("SOCIAL_REDDIT_RECENT_LIMIT", "25"))
REDDIT_TIMEOUT = int(os.getenv("SOCIAL_REDDIT_TIMEOUT", str(min(TIMEOUT, 8))))
REDDIT_CLIENT_ID = os.getenv("REDDIT_CLIENT_ID", "").strip()
REDDIT_CLIENT_SECRET = os.getenv("REDDIT_CLIENT_SECRET", "").strip()
REDDIT_ACCESS_TOKEN = os.getenv("REDDIT_ACCESS_TOKEN", "").strip()
REDDIT_PUBLIC_FALLBACK = os.getenv("SOCIAL_REDDIT_PUBLIC_FALLBACK", "true").lower() in ("1", "true", "yes")
INCLUDE_PRIVATE_TICKERS = os.getenv("SOCIAL_INCLUDE_PRIVATE_TICKERS", "false").lower() in ("1", "true", "yes")
REDDIT_SUBREDDITS = [
    s.strip()
    for s in os.getenv("SOCIAL_REDDIT_SUBREDDITS", "stocks,StockMarket").split(",")
    if s.strip()
]
REDDIT_QUERY_LIMIT = max(1, int(os.getenv("SOCIAL_REDDIT_QUERY_LIMIT", "1")))
REDDIT_SUBREDDIT_LIMIT = max(1, int(os.getenv("SOCIAL_REDDIT_SUBREDDIT_LIMIT", "2")))
REDDIT_MAX_TICKERS_PER_CYCLE = max(0, int(os.getenv("SOCIAL_REDDIT_MAX_TICKERS_PER_CYCLE", "3")))
REDDIT_PUBLIC_JSON = os.getenv("SOCIAL_REDDIT_PUBLIC_JSON", "false").lower() in ("1", "true", "yes")
REDDIT_RECENT_SWEEP = os.getenv("SOCIAL_REDDIT_RECENT_SWEEP", "false").lower() in ("1", "true", "yes")
REDDIT_ARCHIVE_FALLBACK = os.getenv("SOCIAL_REDDIT_ARCHIVE_FALLBACK", "true").lower() in ("1", "true", "yes")
PRIVATE_SOCIAL_TICKERS = [
    s.strip().upper()
    for s in os.getenv("SOCIAL_PRIVATE_TICKERS", "").split(",")
    if s.strip()
]
NITTER_INSTANCES = [
    s.strip().rstrip("/")
    for s in os.getenv("SOCIAL_NITTER_INSTANCES", "https://nitter.net,https://nitter.poast.org").split(",")
    if s.strip()
]
REDDIT_RECENT_CACHE: dict[str, list[dict]] = {}
_REDDIT_TOKEN_CACHE: dict[str, float | str] = {"token": REDDIT_ACCESS_TOKEN, "expires_at": 0.0}

CRYPTO_TICKERS = {
    "BTC", "ETH", "LTC", "DOGE", "SOL", "ADA", "XRP", "BNB", "DOT", "AVAX",
    "MATIC", "SHIB", "TRX", "BCH", "LINK", "ATOM", "UNI", "ETC", "FIL",
}

HEADERS = {"User-Agent": "Mozilla/5.0 FlashFeed/1.0"}
REDDIT_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36 FlashFeed/1.0",
    "Accept": "application/json,text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}
BLUESKY_API = "https://api.bsky.app/xrpc/app.bsky.feed.searchPosts"
US_EXCHANGES = {"NASDAQ", "NYSE", "AMEX"}

BULLISH_WORDS = {
    "bullish", "calls", "breakout", "squeeze", "ripping", "moon", "long",
    "buy", "bought", "beat", "upgrade", "guidance", "surge", "gap up",
}

BEARISH_WORDS = {
    "bearish", "puts", "short", "shorting", "sell", "sold", "miss",
    "downgrade", "offering", "lawsuit", "halt", "dilution", "gap down",
}


def _clean(text: str) -> str:
    return re.sub(r"<[^>]+>", "", text or "").strip()


def _has_cashtag(text: str, ticker: str) -> bool:
    return re.search(rf"(?i)(?<![A-Z0-9])\${re.escape(ticker)}(?![A-Z0-9])", text or "") is not None


def _matches_ticker_text(text: str, ticker: str) -> bool:
    if _has_cashtag(text, ticker):
        return True
    if ticker.upper() == "SPACEX":
        return re.search(r"(?i)(?<![A-Z0-9])space\s*x(?![A-Z0-9])", text or "") is not None
    return False


REDDIT_FINANCE_CONTEXT_RE = re.compile(
    r"(?i)\b(stock|stocks|shares|shareholder|ticker|nasdaq|nyse|amex|market|price|chart|"
    r"earnings|guidance|calls|puts|option|options|short|squeeze|float|volume|gap|breakout|"
    r"offering|reverse split|merger|acquisition|fda|approval|buy|sell|bull|bear|long)\b"
)


def _matches_reddit_ticker_text(text: str, ticker: str) -> bool:
    if _matches_ticker_text(text, ticker):
        return True
    clean_ticker = ticker.upper()
    if not clean_ticker or "." in clean_ticker:
        return False
    plain_match = re.search(rf"(?i)(?<![A-Z0-9]){re.escape(clean_ticker)}(?![A-Z0-9])", text or "")
    return bool(plain_match and REDDIT_FINANCE_CONTEXT_RE.search(text or ""))


def _search_query_for_ticker(ticker: str) -> str:
    if ticker.upper() == "SPACEX":
        return 'SpaceX OR $SPACEX'
    return f"${ticker}"


def _reddit_search_queries(ticker: str) -> list[str]:
    if ticker.upper() == "SPACEX":
        return ["SpaceX stock", "$SPACEX"]
    return [f"${ticker}", f"{ticker} stock"]


def _reddit_access_token() -> str:
    cached = str(_REDDIT_TOKEN_CACHE.get("token") or "")
    expires_at = float(_REDDIT_TOKEN_CACHE.get("expires_at") or 0)
    if cached and (REDDIT_ACCESS_TOKEN or time.time() < expires_at - 30):
        return cached
    if not REDDIT_CLIENT_ID or not REDDIT_CLIENT_SECRET:
        return ""

    try:
        resp = _http_post(
            "https://www.reddit.com/api/v1/access_token",
            headers=REDDIT_HEADERS,
            auth=(REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET),
            data={"grant_type": "client_credentials"},
            timeout=REDDIT_TIMEOUT,
        )
        if resp.status_code != 200:
            print(f"Reddit OAuth token: HTTP {resp.status_code} {resp.text[:120]}")
            return ""
        payload = resp.json()
        token = str(payload.get("access_token") or "")
        if token:
            _REDDIT_TOKEN_CACHE["token"] = token
            _REDDIT_TOKEN_CACHE["expires_at"] = time.time() + float(payload.get("expires_in") or 3600)
        return token
    except Exception as exc:
        print(f"Reddit OAuth token: SKIP {exc}")
        return ""


def _reddit_oauth_get(path: str, params: dict) -> object | None:
    token = _reddit_access_token()
    if not token:
        return None
    headers = {**REDDIT_HEADERS, "Authorization": f"Bearer {token}"}
    try:
        return _http_get(
            f"https://oauth.reddit.com{path}.json",
            headers=headers,
            params=params,
            timeout=REDDIT_TIMEOUT,
        )
    except Exception as exc:
        print(f"Reddit OAuth {path}: SKIP {exc}")
        return None


def _reddit_child_to_entry(child: dict, now: int, fallback_subreddit: str = "") -> dict | None:
    if child.get("kind") != "t3":
        return None
    data = child.get("data", {}) or {}
    permalink = data.get("permalink") or ""
    link = f"https://www.reddit.com{permalink}" if permalink else data.get("url") or ""
    if "/comments/" not in link:
        return None
    subreddit = data.get("subreddit") or fallback_subreddit
    return {
        "title": data.get("title") or "",
        "link": link,
        "summary": data.get("selftext") or "",
        "author": data.get("author") or "",
        "created_at": int(data.get("created_utc") or now),
        "subreddit": subreddit,
        "source": f"r/{subreddit}" if subreddit else "Reddit",
    }


def _reddit_archive_post_to_entry(post: dict, now: int, fallback_subreddit: str = "") -> dict | None:
    if not isinstance(post, dict):
        return None
    post_id = str(post.get("id") or post.get("_id") or "").strip()
    subreddit = str(post.get("subreddit") or fallback_subreddit or "").strip()
    permalink = str(post.get("permalink") or "").strip()
    link = (
        f"https://www.reddit.com{permalink}"
        if permalink.startswith("/")
        else str(post.get("url") or post.get("full_link") or "").strip()
    )
    if not link and post_id and subreddit:
        link = f"https://www.reddit.com/r/{subreddit}/comments/{post_id}"
    if "/comments/" not in link:
        return None
    return {
        "title": post.get("title") or "",
        "link": link,
        "summary": post.get("selftext") or post.get("body") or "",
        "author": post.get("author") or "",
        "created_at": int(post.get("created_utc") or post.get("created") or now),
        "subreddit": subreddit,
        "source": f"r/{subreddit}" if subreddit else "Reddit Archive",
    }


def _fetch_reddit_archive_entries(ticker: str, subreddit: str, limit: int, now: int) -> list[dict]:
    if not REDDIT_ARCHIVE_FALLBACK:
        return []

    query = ticker.upper()
    entries: list[dict] = []
    archive_requests = [
        (
            "ArcticShift",
            "https://arctic-shift.photon-reddit.com/api/posts/search",
            {"query": query, "subreddit": subreddit, "limit": max(1, min(limit * 3, 50)), "sort": "desc"},
        ),
        (
            "PullPush",
            "https://api.pullpush.io/reddit/search/submission/",
            {"q": query, "subreddit": subreddit, "size": max(1, min(limit * 3, 50)), "sort": "desc", "sort_type": "created_utc"},
        ),
    ]

    for label, url, params in archive_requests:
        try:
            resp = _http_get(url, headers=REDDIT_HEADERS, params=params, timeout=REDDIT_TIMEOUT)
            if resp.status_code != 200:
                print(f"Reddit archive {label} r/{subreddit} ${ticker}: HTTP {resp.status_code}")
                continue
            payload = resp.json()
            posts = payload if isinstance(payload, list) else payload.get("data") or payload.get("results") or payload.get("posts") or []
            for post in posts[: max(1, min(limit * 3, 50))]:
                entry = _reddit_archive_post_to_entry(post, now, subreddit)
                if entry is not None:
                    entries.append(entry)
            if entries:
                print(f"Reddit archive {label} r/{subreddit} ${ticker}: {len(entries)} candidate rows")
                break
        except Exception as exc:
            print(f"Reddit archive {label} r/{subreddit} ${ticker}: SKIP {exc}")

    return entries[:limit]


def _fetch_reddit_recent_entries(subreddit: str, now: int) -> list[dict]:
    cache_key = subreddit.lower()
    if cache_key in REDDIT_RECENT_CACHE:
        return REDDIT_RECENT_CACHE[cache_key]

    entries: list[dict] = []
    json_urls = [
        f"https://old.reddit.com/r/{subreddit}/new.json",
        f"https://www.reddit.com/r/{subreddit}/new.json",
    ]
    params = {"limit": max(1, min(REDDIT_RECENT_LIMIT, 100))}
    resp = _reddit_oauth_get(f"/r/{subreddit}/new", params)
    if resp is not None and resp.status_code == 200:
        children = resp.json().get("data", {}).get("children", [])[:REDDIT_RECENT_LIMIT]
        entries = [
            entry for child in children
            if (entry := _reddit_child_to_entry(child, now, subreddit)) is not None
        ]
    elif REDDIT_PUBLIC_FALLBACK:
        for url in json_urls:
            try:
                resp = _http_get(
                    url,
                    headers=REDDIT_HEADERS,
                    params=params,
                    timeout=REDDIT_TIMEOUT,
                )
                if resp.status_code != 200:
                    continue
                children = resp.json().get("data", {}).get("children", [])[:REDDIT_RECENT_LIMIT]
                entries = [
                    entry for child in children
                    if (entry := _reddit_child_to_entry(child, now, subreddit)) is not None
                ]
                if entries:
                    break
            except Exception:
                continue

    if not entries and REDDIT_PUBLIC_FALLBACK:
        for feed_url in (
            f"https://www.reddit.com/r/{subreddit}/new.rss",
            f"https://old.reddit.com/r/{subreddit}/new.rss",
        ):
            try:
                resp = _http_get(feed_url, headers=REDDIT_HEADERS, timeout=REDDIT_TIMEOUT)
                if resp.status_code != 200:
                    continue
                entries = _rss_entries(resp.text)[:REDDIT_RECENT_LIMIT]
                for entry in entries:
                    entry.setdefault("subreddit", subreddit)
                    entry.setdefault("source", f"r/{subreddit}")
                entries = [entry for entry in entries if "/comments/" in (entry.get("link") or "")]
                if entries:
                    break
            except Exception:
                continue

    REDDIT_RECENT_CACHE[cache_key] = entries
    return entries


def _http_get(url: str, **kwargs):
    try:
        return http_requests.get(url, impersonate="chrome124", **kwargs)
    except TypeError:
        return http_requests.get(url, **kwargs)


def _http_post(url: str, **kwargs):
    try:
        return http_requests.post(url, impersonate="chrome124", **kwargs)
    except TypeError:
        return http_requests.post(url, **kwargs)


def _post_id(ticker: str, msg_id) -> str:
    return hashlib.sha1(f"stocktwits:{ticker}:{msg_id}".encode()).hexdigest()[:24]


def _load_tickers() -> list[str]:
    configured = os.getenv("SOCIAL_TICKERS", "")
    if configured.strip():
        tickers = [t.strip().upper() for t in configured.split(",") if t.strip()]
    else:
        tickers = []

    # Explicit server-provided ticker universes come from prediction/high-conviction
    # interest and must not be replaced by the strict FinViz mover fallback.
    if not tickers and os.getenv("SOCIAL_STRICT_FINVIZ_TOP_MOVERS", "true").lower() in ("1", "true", "yes"):
        tickers = _load_momentum_tickers()
        if not tickers:
            print("Social ticker source: strict Finviz top movers only — none found; skipping social collectors")
            return []
        tickers = tickers[:MAX_TICKERS]
        print(f"Social ticker source: strict Finviz top movers only — {','.join(tickers)}")
        return tickers

    source = os.getenv("SOCIAL_TICKER_SOURCE", "momentum").strip().lower()
    if not tickers and source in {"momentum", "movers", "top_momentum", "finviz"}:
        mover_tickers = _load_momentum_tickers()
        if mover_tickers:
            return mover_tickers

    if not tickers:
        tickers = [line.strip().upper() for line in TICKER_FILE.read_text().splitlines() if line.strip()]

    filtered = []
    seen = set()
    for ticker in tickers:
        if ticker in seen or ticker in CRYPTO_TICKERS:
            continue
        if not re.fullmatch(r"[A-Z][A-Z0-9.-]{0,5}", ticker):
            continue
        filtered.append(ticker)
        seen.add(ticker)
        if len(filtered) >= MAX_TICKERS:
            break
    if INCLUDE_PRIVATE_TICKERS:
        for ticker in PRIVATE_SOCIAL_TICKERS:
            if ticker not in seen and re.fullmatch(r"[A-Z][A-Z0-9.-]{0,7}", ticker):
                filtered.append(ticker)
                seen.add(ticker)
    return filtered


def _load_momentum_tickers() -> list[str]:
    limit = int(os.getenv("SOCIAL_MOMENTUM_LIMIT", os.getenv("SOCIAL_TOP_MOMENTUM_LIMIT", "10")))
    limit = max(1, min(MAX_TICKERS, limit))

    try:
        client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=3000)
        db = client[DB_NAME]
        rows = list(db.screeners.find(
            {
                "ticker": {"$exists": True, "$nin": ["", None], "$not": re.compile(r"\.")},
                "price": {"$gt": 0},
                "$or": [
                    {"change_pct": {"$gt": 0}},
                    {"change_percent": {"$gt": 0}},
                ],
                "exchange": {"$in": sorted(US_EXCHANGES)},
                "quote_status": {"$ne": "missing"},
            },
            {"ticker": 1, "change_pct": 1, "change_percent": 1, "rel_volume": 1, "volume": 1, "quote_source": 1, "finviz_seen_at": 1, "quote_updated_at": 1},
        ).sort([("change_pct", -1), ("change_percent", -1), ("rel_volume", -1), ("volume", -1)]).limit(limit * 3))
    except Exception as exc:
        print(f"Social momentum ticker load skipped — {exc}")
        return []
    finally:
        try:
            client.close()
        except Exception:
            pass

    tickers: list[str] = []
    seen: set[str] = set()
    fresh_cutoff = time.time() - 30 * 60

    def row_time(row: dict) -> float:
        value = row.get("finviz_seen_at") or row.get("quote_updated_at") or 0
        if isinstance(value, datetime):
            return value.timestamp()
        try:
            return float(value)
        except (TypeError, ValueError):
            return 0

    preferred = [
        row for row in rows
        if row.get("quote_source") == "finviz_elite_screener" and row_time(row) >= fresh_cutoff
    ]
    fallback = [row for row in rows if row not in preferred]
    for row in [*preferred, *fallback]:
        ticker = str(row.get("ticker") or "").upper().strip()
        if ticker in seen or ticker in CRYPTO_TICKERS:
            continue
        if not re.fullmatch(r"[A-Z][A-Z0-9]{0,5}", ticker):
            continue
        tickers.append(ticker)
        seen.add(ticker)
        if len(tickers) >= limit:
            break

    if tickers:
        print(f"Social ticker source: top momentum movers — {','.join(tickers)}")
    return tickers


def _created_ts(raw: str) -> int:
    if not raw:
        return int(time.time())
    try:
        return int(datetime.strptime(raw, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp())
    except Exception:
        return int(time.time())


def _sentiment_value(message: dict) -> tuple[str, float]:
    entities = message.get("entities") or {}
    sentiment_obj = entities.get("sentiment") or message.get("sentiment") or {}
    raw = ""
    if isinstance(sentiment_obj, dict):
        raw = str(sentiment_obj.get("basic") or "").lower()
    if raw == "bullish":
        return "bullish", 0.58
    if raw == "bearish":
        return "bearish", -0.58
    return "neutral", 0.0


def _score_text_sentiment(text: str) -> tuple[str, float]:
    return score_social_sentiment(text)


def _validated_sentiment_fields(
    text: str,
    source_sentiment: str | None = None,
    source_score: float | None = None,
) -> dict:
    audit = audit_social_sentiment(text, source_sentiment=source_sentiment, source_score=source_score)
    fields = {
        "sentiment": audit["label"],
        "sentiment_score": audit["score"],
        "sentiment_validation": audit,
    }
    if source_sentiment:
        fields["source_sentiment"] = source_sentiment
        fields["source_sentiment_score"] = source_score
    return fields


def _parse_iso_ts(raw: str) -> int:
    if not raw:
        return int(time.time())
    try:
        return int(datetime.fromisoformat(raw.replace("Z", "+00:00")).timestamp())
    except Exception:
        return int(time.time())


def _rss_entries(xml_text: str) -> list[dict]:
    if feedparser is not None:
        feed = feedparser.parse(xml_text)
        return [
            {
                "title": getattr(entry, "title", "") or "",
                "link": getattr(entry, "link", "") or "",
                "summary": getattr(entry, "summary", "") or "",
                "author": getattr(entry, "author", "") or "",
                "published_parsed": getattr(entry, "published_parsed", None),
            }
            for entry in feed.entries
        ]

    entries: list[dict] = []
    try:
        root = ET.fromstring(xml_text)
    except Exception:
        return entries

    namespaces = {"atom": "http://www.w3.org/2005/Atom"}
    for item in root.findall(".//item"):
        entries.append({
            "title": html.unescape((item.findtext("title") or "").strip()),
            "link": (item.findtext("link") or "").strip(),
            "summary": html.unescape((item.findtext("description") or "").strip()),
            "author": (item.findtext("author") or "").strip(),
        })
    for item in root.findall(".//atom:entry", namespaces):
        link = ""
        link_el = item.find("atom:link", namespaces)
        if link_el is not None:
            link = link_el.attrib.get("href", "")
        entries.append({
            "title": html.unescape((item.findtext("atom:title", default="", namespaces=namespaces) or "").strip()),
            "link": link,
            "summary": html.unescape((item.findtext("atom:summary", default="", namespaces=namespaces) or item.findtext("atom:content", default="", namespaces=namespaces) or "").strip()),
            "author": "",
        })
    return entries


def _fetch_ticker(ticker: str) -> list[dict]:
    url = f"https://api.stocktwits.com/api/2/streams/symbol/{ticker}.json"
    try:
        resp = _http_get(url, headers=HEADERS, timeout=TIMEOUT)
        if resp.status_code != 200:
            print(f"StockTwits {ticker}: HTTP {resp.status_code}")
            return []
        payload = resp.json()
    except Exception as exc:
        print(f"StockTwits {ticker}: SKIP {exc}")
        return []

    now = int(time.time())
    docs = []
    messages = payload.get("messages", [])
    message_volume = len(messages)
    message_density = round(message_volume / 30, 3)

    for message in messages:
        body = _clean(message.get("body", ""))
        if not body:
            continue
        source_sentiment, source_score = _sentiment_value(message)
        user = message.get("user") or {}
        created_at = _created_ts(message.get("created_at", ""))
        doc_id = _post_id(ticker, message.get("id", body))
        docs.append({
            "id": doc_id,
            "platform": "StockTwits",
            "source": "StockTwits",
            "collector": "stocktwits_public_symbol_stream",
            "ticker": ticker,
            "symbol": ticker,
            "title": body[:180],
            "text": body[:1000],
            "content": body[:1000],
            "url": f"https://stocktwits.com/symbol/{ticker}",
            "source_url": url,
            "cashtag": f"${ticker}",
            "author": user.get("username", ""),
            **_validated_sentiment_fields(body, source_sentiment, source_score),
            "message_volume": message_volume,
            "message_density": message_density,
            "fetched_at": now,
            "created_at": created_at,
            "timestamp": created_at,
        })
    return docs


def _fetch_reddit_ticker(ticker: str) -> list[dict]:
    if not INCLUDE_REDDIT:
        return []

    docs = []
    now = int(time.time())
    seen_links: set[str] = set()
    reddit_configured = bool(REDDIT_ACCESS_TOKEN or (REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET))
    if not reddit_configured and not REDDIT_PUBLIC_FALLBACK:
        return docs

    queries = _reddit_search_queries(ticker)[:REDDIT_QUERY_LIMIT]
    search_jobs: list[dict] = []

    for query in queries:
        for subreddit in REDDIT_SUBREDDITS[:REDDIT_SUBREDDIT_LIMIT]:
            search_jobs.append({
                "oauth_path": f"/r/{subreddit}/search",
                "urls": [
                    f"https://www.reddit.com/r/{subreddit}/search.json",
                    f"https://old.reddit.com/r/{subreddit}/search.json",
                ],
                "params": {"q": query, "restrict_sr": "on", "sort": "new", "t": "day", "limit": REDDIT_MAX_PER_SUBREDDIT},
                "source": f"r/{subreddit}",
                "subreddit": subreddit,
                "feed_url": f"https://www.reddit.com/r/{subreddit}/search.rss?q={quote_plus(query)}&restrict_sr=1&sort=new&t=day",
                "limit": REDDIT_MAX_PER_SUBREDDIT,
            })

    for job in search_jobs:
        entries = []
        status_label = ""
        try:
            oauth_resp = _reddit_oauth_get(job["oauth_path"], job["params"])
            if oauth_resp is not None and oauth_resp.status_code == 200:
                children = oauth_resp.json().get("data", {}).get("children", [])[:job["limit"]]
                for child in children:
                    entry = _reddit_child_to_entry(child, now, job["subreddit"])
                    if entry is not None:
                        entries.append(entry)
            elif oauth_resp is not None and oauth_resp.status_code in (403, 429):
                print(f"Reddit OAuth {job['source']} ${ticker}: HTTP {oauth_resp.status_code} rate/permission limited")

            for url in job["urls"]:
                if not REDDIT_PUBLIC_FALLBACK:
                    break
                if not reddit_configured and not REDDIT_PUBLIC_JSON:
                    break
                if entries:
                    break
                resp = _http_get(
                    url,
                    headers=REDDIT_HEADERS,
                    params=job["params"],
                    timeout=REDDIT_TIMEOUT,
                )
                status_label = str(resp.status_code)
                if resp.status_code == 200:
                    children = resp.json().get("data", {}).get("children", [])[:job["limit"]]
                    for child in children:
                        if child.get("kind") != "t3":
                            continue
                        data = child.get("data", {}) or {}
                        permalink = data.get("permalink") or ""
                        link = f"https://www.reddit.com{permalink}" if permalink else data.get("url") or ""
                        if "/comments/" not in link:
                            continue
                        entries.append({
                            "title": data.get("title") or "",
                            "link": link,
                            "summary": data.get("selftext") or "",
                            "author": data.get("author") or "",
                            "created_at": int(data.get("created_utc") or now),
                            "subreddit": data.get("subreddit") or job["subreddit"],
                            "source": f"r/{data.get('subreddit')}" if data.get("subreddit") else job["source"],
                        })
                    if entries:
                        break
                elif resp.status_code in (403, 429):
                    print(f"Reddit {job['source']} ${ticker}: HTTP {resp.status_code} rate/permission limited")

            if not entries and REDDIT_PUBLIC_FALLBACK:
                feed_resp = _http_get(job["feed_url"], headers=REDDIT_HEADERS, timeout=REDDIT_TIMEOUT)
                status_label = f"{status_label}/{feed_resp.status_code}" if status_label else str(feed_resp.status_code)
                if feed_resp.status_code == 200:
                    entries = _rss_entries(feed_resp.text)[:job["limit"]]
                    for entry in entries:
                        entry.setdefault("subreddit", job["subreddit"])
                        entry.setdefault("source", job["source"])
                elif feed_resp.status_code not in (403, 429):
                    print(f"Reddit {job['source']} ${ticker}: HTTP {status_label}")

            if not entries:
                entries = _fetch_reddit_archive_entries(ticker, job["subreddit"], job["limit"], now)
        except Exception as exc:
            print(f"Reddit {job['source']} ${ticker}: SKIP {exc}")
            entries = _fetch_reddit_archive_entries(ticker, job["subreddit"], job["limit"], now)
            if not entries:
                continue

        message_volume = len(entries)
        message_density = round(message_volume / 30, 3)

        for entry in entries:
            title = _clean(entry.get("title") or "")
            link = entry.get("link") or ""
            summary = _clean(entry.get("summary") or "")
            text = f"{title} {summary}".strip()
            if not title or not link:
                continue
            if "/comments/" not in link:
                continue
            if link in seen_links:
                continue
            if not _matches_reddit_ticker_text(text, ticker):
                continue
            seen_links.add(link)

            created_at = int(entry.get("created_at") or now)
            if entry.get("published_parsed"):
                try:
                    created_at = int(time.mktime(entry["published_parsed"]))
                except Exception:
                    created_at = now

            doc_id = hashlib.sha1(f"reddit:{ticker}:{link}".encode()).hexdigest()[:24]
            subreddit = entry.get("subreddit") or job["subreddit"] or ""
            source = entry.get("source") or (f"r/{subreddit}" if subreddit else "Reddit Global Search")
            docs.append({
                "id": doc_id,
                "platform": "Reddit",
                "source": source,
                "collector": "reddit_symbol_search_json_rss",
                "ticker": ticker,
                "symbol": ticker,
                "title": title[:180],
                "text": text[:1000],
                "content": summary[:1000],
                "url": link,
                "source_url": job["urls"][0],
                "subreddit": subreddit,
                "query": job["params"].get("q"),
                "cashtag": f"${ticker}",
                "author": entry.get("author", ""),
                **_validated_sentiment_fields(text),
                "message_volume": message_volume,
                "message_density": message_density,
                "fetched_at": now,
                "created_at": created_at,
                "timestamp": created_at,
            })

        if len(docs) >= max(REDDIT_GLOBAL_MAX, REDDIT_MAX_PER_SUBREDDIT * len(REDDIT_SUBREDDITS)):
            break

    if not REDDIT_RECENT_SWEEP:
        return docs

    for subreddit in REDDIT_SUBREDDITS[:REDDIT_SUBREDDIT_LIMIT]:
        entries = _fetch_reddit_recent_entries(subreddit, now)
        message_volume = len(entries)
        message_density = round(message_volume / 30, 3)
        for entry in entries:
            title = _clean(entry.get("title") or "")
            link = entry.get("link") or ""
            summary = _clean(entry.get("summary") or "")
            text = f"{title} {summary}".strip()
            if not title or not link or "/comments/" not in link:
                continue
            if link in seen_links:
                continue
            if not _matches_reddit_ticker_text(text, ticker):
                continue
            seen_links.add(link)

            created_at = int(entry.get("created_at") or now)
            if entry.get("published_parsed"):
                try:
                    created_at = int(time.mktime(entry["published_parsed"]))
                except Exception:
                    created_at = now

            source = entry.get("source") or f"r/{subreddit}"
            doc_id = hashlib.sha1(f"reddit:{ticker}:{link}".encode()).hexdigest()[:24]
            docs.append({
                "id": doc_id,
                "platform": "Reddit",
                "source": source,
                "collector": "reddit_subreddit_recent_filter",
                "ticker": ticker,
                "symbol": ticker,
                "title": title[:180],
                "text": text[:1000],
                "content": summary[:1000],
                "url": link,
                "source_url": f"https://old.reddit.com/r/{subreddit}/new.json",
                "subreddit": entry.get("subreddit") or subreddit,
                "query": ticker,
                "cashtag": f"${ticker}",
                "author": entry.get("author", ""),
                **_validated_sentiment_fields(text),
                "message_volume": message_volume,
                "message_density": message_density,
                "fetched_at": now,
                "created_at": created_at,
                "timestamp": created_at,
            })

    return docs


def _fetch_bluesky_ticker(ticker: str) -> list[dict]:
    if not INCLUDE_BLUESKY:
        return []

    query = _search_query_for_ticker(ticker)
    try:
        resp = _http_get(
            BLUESKY_API,
            headers=HEADERS,
            params={"q": query, "limit": max(1, min(BLUESKY_MAX_RESULTS, 100)), "sort": "latest"},
            timeout=TIMEOUT,
        )
        if resp.status_code != 200:
            print(f"Bluesky ${ticker}: HTTP {resp.status_code} {resp.text[:180]}")
            return []
        payload = resp.json()
    except Exception as exc:
        print(f"Bluesky ${ticker}: SKIP {exc}")
        return []

    now = int(time.time())
    posts = payload.get("posts", [])
    message_volume = len(posts)
    message_density = round(message_volume / 30, 3)
    docs = []

    for post in posts:
        uri = post.get("uri") or ""
        record = post.get("record") or {}
        text = _clean(record.get("text") or "")
        author = post.get("author") or {}
        handle = author.get("handle") or ""
        if not uri or not text or not _matches_ticker_text(text, ticker):
            continue

        post_id = uri.split("/")[-1]
        doc_id = hashlib.sha1(f"bluesky:{ticker}:{uri}".encode()).hexdigest()[:24]
        docs.append({
            "id": doc_id,
            "platform": "Bluesky",
            "source": "Bluesky",
            "collector": "bluesky_public_search_cashtag",
            "ticker": ticker,
            "symbol": ticker,
            "title": text[:180],
            "text": text[:1000],
            "content": text[:1000],
            "url": f"https://bsky.app/profile/{handle}/post/{post_id}" if handle and post_id else "",
            "source_url": BLUESKY_API,
            "query": query,
            "cashtag": f"${ticker}",
            "author": handle,
            **_validated_sentiment_fields(text),
            "message_volume": message_volume,
            "message_density": message_density,
            "reply_count": post.get("replyCount"),
            "repost_count": post.get("repostCount"),
            "like_count": post.get("likeCount"),
            "fetched_at": now,
            "created_at": _parse_iso_ts(record.get("createdAt") or ""),
            "timestamp": _parse_iso_ts(record.get("createdAt") or ""),
        })

    return docs


def _fetch_x_ticker(ticker: str) -> list[dict]:
    if not INCLUDE_X:
        return []
    if not X_BEARER_TOKEN:
        return _fetch_x_public_ticker(ticker)

    query = f"{_search_query_for_ticker(ticker)} lang:en -is:retweet"
    headers = {**HEADERS, "Authorization": f"Bearer {X_BEARER_TOKEN}"}

    try:
        resp = _http_get(
            "https://api.x.com/2/tweets/search/recent",
            headers=headers,
            params={
                "query": query,
                "max_results": max(10, min(X_MAX_RESULTS, 100)),
                "tweet.fields": "created_at,author_id,public_metrics,lang",
            },
            timeout=TIMEOUT,
        )
        if resp.status_code != 200:
            print(f"X/Twitter ${ticker}: HTTP {resp.status_code} {resp.text[:180]}")
            return []
        payload = resp.json()
    except Exception as exc:
        print(f"X/Twitter ${ticker}: SKIP {exc}")
        return []

    now = int(time.time())
    docs = []
    tweets = payload.get("data", [])
    message_volume = len(tweets)
    message_density = round(message_volume / 30, 3)

    for tweet in tweets:
        tweet_id = str(tweet.get("id") or "")
        text = _clean(tweet.get("text", ""))
        if not tweet_id or not text:
            continue
        if not _matches_ticker_text(text, ticker):
            continue

        created_at = _created_ts(str(tweet.get("created_at") or ""))
        metrics = tweet.get("public_metrics") or {}
        doc_id = hashlib.sha1(f"x:{ticker}:{tweet_id}".encode()).hexdigest()[:24]

        docs.append({
            "id": doc_id,
            "platform": "X/Twitter",
            "source": "X/Twitter",
            "collector": "x_recent_search_cashtag",
            "ticker": ticker,
            "symbol": ticker,
            "title": text[:180],
            "text": text[:1000],
            "content": text[:1000],
            "url": f"https://x.com/i/web/status/{tweet_id}",
            "source_url": "https://api.x.com/2/tweets/search/recent",
            "query": query,
            "cashtag": f"${ticker}",
            "author": tweet.get("author_id", ""),
            **_validated_sentiment_fields(text),
            "message_volume": message_volume,
            "message_density": message_density,
            "retweet_count": metrics.get("retweet_count"),
            "reply_count": metrics.get("reply_count"),
            "like_count": metrics.get("like_count"),
            "quote_count": metrics.get("quote_count"),
            "fetched_at": now,
            "created_at": created_at,
            "timestamp": created_at,
        })

    return docs


def _fetch_x_public_ticker(ticker: str) -> list[dict]:
    """Best-effort public X/Twitter fallback through Nitter-compatible RSS search."""
    now = int(time.time())
    docs: list[dict] = []
    query = _search_query_for_ticker(ticker)
    encoded = quote_plus(query)

    for base_url in NITTER_INSTANCES:
        feed_url = f"{base_url}/search/rss?f=tweets&q={encoded}"
        try:
            resp = _http_get(feed_url, headers=HEADERS, timeout=TIMEOUT)
            if resp.status_code != 200:
                print(f"X/Twitter public ${ticker}: HTTP {resp.status_code} from {base_url}")
                continue
            entries = _rss_entries(resp.text)[:X_MAX_RESULTS]
        except Exception as exc:
            print(f"X/Twitter public ${ticker}: SKIP {exc}")
            continue

        message_volume = len(entries)
        message_density = round(message_volume / 30, 3)
        for entry in entries:
            title = _clean(entry.get("title") or "")
            summary = _clean(entry.get("summary") or "")
            text = f"{title} {summary}".strip()
            link = entry.get("link") or ""
            if not text or not _matches_ticker_text(text, ticker):
                continue
            doc_id = hashlib.sha1(f"x-public:{ticker}:{link or text[:120]}".encode()).hexdigest()[:24]
            docs.append({
                "id": doc_id,
                "platform": "X/Twitter",
                "source": "X/Twitter Public Search",
                "collector": "x_public_nitter_rss_cashtag",
                "ticker": ticker,
                "symbol": ticker,
                "title": title[:180] or text[:180],
                "text": text[:1000],
                "content": summary[:1000],
                "url": link,
                "source_url": feed_url,
                "query": query,
                "cashtag": f"${ticker}",
                "author": entry.get("author", ""),
                **_validated_sentiment_fields(text),
                "message_volume": message_volume,
                "message_density": message_density,
                "fetched_at": now,
                "created_at": now,
                "timestamp": now,
            })
        if docs:
            break

    return docs


def _fetch_ticker_social(ticker: str) -> list[dict]:
    return [
        *_fetch_ticker(ticker),
        *_fetch_bluesky_ticker(ticker),
        *_fetch_x_ticker(ticker),
        *_fetch_reddit_ticker(ticker),
    ]


def _fetch_fast_ticker_social(ticker: str) -> list[dict]:
    return [
        *_fetch_ticker(ticker),
        *_fetch_bluesky_ticker(ticker),
        *_fetch_x_ticker(ticker),
    ]


def main() -> None:
    tickers = _load_tickers()
    client = MongoClient(MONGODB_URI)
    db = client[DB_NAME]
    socials = db.socials
    socials.create_index("id", unique=True, sparse=True)
    socials.create_index("platform")
    socials.create_index("ticker")
    socials.create_index("fetched_at")

    found = upserted = modified = 0
    platform_counts: dict[str, int] = {}
    worker_errors = 0
    def write_docs(docs: list[dict]) -> None:
        nonlocal found, upserted, modified
        found += len(docs)
        for doc in docs:
            platform = str(doc.get("platform") or "Unknown")
            platform_counts[platform] = platform_counts.get(platform, 0) + 1
        if docs:
            result = socials.bulk_write([
                UpdateOne({"id": doc["id"]}, {"$set": doc}, upsert=True)
                for doc in docs
            ], ordered=False)
            upserted += result.upserted_count
            modified += result.modified_count

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        futures = [executor.submit(_fetch_fast_ticker_social, ticker) for ticker in tickers]

        for future in as_completed(futures):
            try:
                docs = future.result()
            except Exception as exc:
                worker_errors += 1
                print(f"Social ticker worker failed — {exc}")
                continue
            write_docs(docs)

    if INCLUDE_REDDIT and REDDIT_MAX_TICKERS_PER_CYCLE:
        reddit_tickers = tickers[:REDDIT_MAX_TICKERS_PER_CYCLE]
        with ThreadPoolExecutor(max_workers=min(2, len(reddit_tickers) or 1)) as executor:
            futures = [executor.submit(_fetch_reddit_ticker, ticker) for ticker in reddit_tickers]
            for future in as_completed(futures):
                try:
                    docs = future.result()
                except Exception as exc:
                    worker_errors += 1
                    print(f"Reddit worker failed — {exc}")
                    continue
                write_docs(docs)

    reddit_count = platform_counts.get("Reddit", 0)
    reddit_configured = bool(REDDIT_ACCESS_TOKEN or (REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET))
    record_source_status(
        db,
        "Reddit",
        "working" if reddit_count else ("ready_no_rows_yet" if reddit_configured else "api_key_recommended"),
        detail=(
            f"{reddit_count} matched ticker posts this cycle; {worker_errors} worker errors"
            + ("" if reddit_configured else "; public Reddit endpoints may return 429, set REDDIT_CLIENT_ID/REDDIT_CLIENT_SECRET for reliable OAuth access")
        ),
        count=reddit_count,
        source_type="social",
    )
    for platform in ("StockTwits", "Bluesky", "X/Twitter"):
        count = platform_counts.get(platform, 0)
        record_source_status(
            db,
            platform,
            "working" if count else "ready_no_rows_yet",
            detail=f"{count} matched ticker posts this cycle",
            count=count,
            source_type="social",
        )

    print(f"Social import complete — {found} found, {upserted} new, {modified} updated")
    client.close()


if __name__ == "__main__":
    main()
