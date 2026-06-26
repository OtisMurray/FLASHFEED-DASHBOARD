"""
Stocktwits Scraper
──────────────────
Fetches recent posts and sentiment data for a ticker from Stocktwits.

Strategy (two requests per ticker):
  1. API  → https://api.stocktwits.com/api/2/streams/symbol/TICKER.json
             Returns up to 30 posts with Bullish/Bearish sentiment tags.
  2. Page → https://stocktwits.com/symbol/TICKER
             Extracts __NEXT_DATA__ JSON for watchlist_count and
             dailySentiment aggregate (when available).

All requests use curl_cffi with impersonate="chrome124".
"""

import json
import re
import time
from datetime import datetime, timezone, timedelta

from curl_cffi import requests
from bs4 import BeautifulSoup

# ─── CONFIG ───────────────────────────────────────────────────────────────────
MAX_POSTS       = 30     # posts to fetch per ticker
MAX_POSTS_PROMPT = 8     # posts included in the Claude prompt
MAX_AGE_HOURS   = 6      # ignore posts older than this
REQUEST_TIMEOUT = 15     # seconds

_API_URL  = "https://api.stocktwits.com/api/2/streams/symbol/{ticker}.json"
_PAGE_URL = "https://stocktwits.com/symbol/{ticker}"

_HEADERS_API = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://stocktwits.com/",
    "Origin": "https://stocktwits.com",
}

_HEADERS_PAGE = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}


# ─── HELPERS ──────────────────────────────────────────────────────────────────

def _parse_iso(ts_str: str) -> datetime | None:
    """Parse a Stocktwits ISO-8601 timestamp to a UTC datetime."""
    if not ts_str:
        return None
    try:
        return datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
    except ValueError:
        return None


def _clean_body(text: str) -> str:
    """Strip cashtags, URLs, and collapse whitespace for cleaner prompt text."""
    text = re.sub(r"https?://\S+", "", text)          # remove URLs
    text = re.sub(r"\$[A-Z]{1,5}\b", "", text)        # remove $TICK cashtags
    text = re.sub(r"\s+", " ", text).strip()
    return text


# ─── STEP 1: API FETCH ────────────────────────────────────────────────────────

def _fetch_api_posts(ticker: str) -> tuple[list[dict], dict]:
    """
    Call the Stocktwits streams API and return (posts, symbol_meta).
    posts: [{"text", "text_clean", "timestamp", "sentiment", "username"}]
    symbol_meta: {"watchlist_count", "title"}
    """
    url = _API_URL.format(ticker=ticker)
    try:
        resp = requests.get(
            url,
            params={"limit": MAX_POSTS, "filter": "all"},
            headers=_HEADERS_API,
            impersonate="chrome124",
            timeout=REQUEST_TIMEOUT,
        )
        resp.raise_for_status()
        data = resp.json()
    except Exception as e:
        return [], {}

    if data.get("response", {}).get("status") != 200:
        return [], {}

    cutoff = datetime.now(timezone.utc) - timedelta(hours=MAX_AGE_HOURS)
    posts = []
    for msg in data.get("messages", []):
        body = msg.get("body", "").strip()
        if not body:
            continue

        ts = _parse_iso(msg.get("created_at", ""))
        if ts and ts < cutoff:
            continue  # skip stale posts

        sentiment_obj = (msg.get("entities") or {}).get("sentiment")
        sentiment = sentiment_obj.get("basic") if sentiment_obj else None  # "Bullish"|"Bearish"|None

        posts.append({
            "text":       body,
            "text_clean": _clean_body(body),
            "timestamp":  msg.get("created_at", ""),
            "sentiment":  sentiment,          # "Bullish", "Bearish", or None
            "username":   (msg.get("user") or {}).get("username", ""),
        })

    sym = data.get("symbol", {})
    meta = {
        "watchlist_count": sym.get("watchlist_count", 0),
        "title": sym.get("title", ticker),
    }
    return posts, meta


# ─── STEP 2: PAGE FETCH (metadata + aggregate sentiment) ─────────────────────

def _fetch_page_meta(ticker: str) -> dict:
    """
    Fetch the Stocktwits symbol page and extract aggregated metadata from
    __NEXT_DATA__ (watchlist_count, dailySentiment).
    Returns {} on failure.
    """
    url = _PAGE_URL.format(ticker=ticker)
    try:
        resp = requests.get(
            url,
            headers=_HEADERS_PAGE,
            impersonate="chrome124",
            timeout=REQUEST_TIMEOUT,
        )
        resp.raise_for_status()
    except Exception:
        return {}

    # Stocktwits embeds a body-tag data attribute JSON blob
    # Look for the script tag containing "__NEXT_DATA__" style JSON
    soup = BeautifulSoup(resp.text, "lxml")
    scripts = soup.find_all("script", src=False)
    for s in scripts:
        txt = s.get_text()
        if '"sentiment"' in txt and '"watchlistCount"' in txt:
            try:
                data = json.loads(txt)
                init = data["props"]["pageProps"]["initialData"]
                return {
                    "watchlist_count":  init.get("watchlistCount", 0),
                    "daily_sentiment":  init.get("dailySentiment"),   # may be None
                    "title":            init.get("title", ticker),
                    "sector":           init.get("sector", ""),
                }
            except Exception:
                pass
    return {}


# ─── PUBLIC API ───────────────────────────────────────────────────────────────

def fetch_stocktwits(ticker: str) -> dict:
    """
    Fetch Stocktwits posts and metadata for one ticker.

    Returns:
        {
            "ticker":          str,
            "title":           str,
            "watchlist_count": int,
            "daily_sentiment": str | None,   # aggregate from page, often None
            "message_count":   int,          # posts fetched (≤ MAX_POSTS)
            "bullish_count":   int,
            "bearish_count":   int,
            "posts":           list[dict],   # all recent posts
            "error":           str | None,
        }
    """
    result = {
        "ticker":          ticker,
        "title":           ticker,
        "watchlist_count": 0,
        "daily_sentiment": None,
        "message_count":   0,
        "bullish_count":   0,
        "bearish_count":   0,
        "posts":           [],
        "error":           None,
    }

    # Fetch posts from API
    posts, api_meta = _fetch_api_posts(ticker)
    if not posts and not api_meta:
        result["error"] = "API returned no data"
        return result

    result["posts"]           = posts
    result["message_count"]   = len(posts)
    result["bullish_count"]   = sum(1 for p in posts if p["sentiment"] == "Bullish")
    result["bearish_count"]   = sum(1 for p in posts if p["sentiment"] == "Bearish")
    result["watchlist_count"] = api_meta.get("watchlist_count", 0)
    result["title"]           = api_meta.get("title", ticker)

    # Overlay page metadata (has daily_sentiment aggregate)
    page_meta = _fetch_page_meta(ticker)
    if page_meta:
        result["watchlist_count"] = page_meta.get("watchlist_count") or result["watchlist_count"]
        result["daily_sentiment"] = page_meta.get("daily_sentiment")
        result["title"]           = page_meta.get("title") or result["title"]

    return result


def build_stocktwits_prompt_section(data: dict) -> str:
    """
    Format Stocktwits data as a concise block for the Claude prompt.
    """
    if data.get("error") or not data.get("posts"):
        return "No Stocktwits data available."

    total   = data["message_count"]
    bulls   = data["bullish_count"]
    bears   = data["bearish_count"]
    neutral = total - bulls - bears
    wl      = data["watchlist_count"]
    ds      = data.get("daily_sentiment")

    lines = [
        f"Stocktwits — {total} recent posts | "
        f"Bullish: {bulls} | Bearish: {bears} | No tag: {neutral} | "
        f"Watchlisted by: {wl:,}",
    ]
    if ds:
        lines.append(f"Daily aggregate sentiment: {ds}")

    # Pick the most signal-rich posts: tagged ones first, then by recency
    tagged   = [p for p in data["posts"] if p["sentiment"]]
    untagged = [p for p in data["posts"] if not p["sentiment"]]
    ordered  = (tagged + untagged)[:MAX_POSTS_PROMPT]

    lines.append("")
    for i, p in enumerate(ordered, 1):
        tag = f"[{p['sentiment']}]" if p["sentiment"] else "[—]"
        body = p["text_clean"] or p["text"]
        # Truncate long posts
        if len(body) > 140:
            body = body[:137] + "…"
        ts_short = p["timestamp"][:16].replace("T", " ") if p["timestamp"] else ""
        lines.append(f"  {i}. {tag} {ts_short}  {body}")

    return "\n".join(lines)
