#!/usr/bin/env python3
"""Fetch Benzinga news when BENZINGA_API_KEY is configured."""

from __future__ import annotations

import hashlib
import html
import json
import os
import re
import time
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime

import requests
from dotenv import load_dotenv
from pymongo import MongoClient, UpdateOne

try:
    from bs4 import BeautifulSoup
    from curl_cffi import requests as curl_requests
    _HAS_PUBLIC_RECENT = True
except Exception:
    BeautifulSoup = None
    curl_requests = None
    _HAS_PUBLIC_RECENT = False

from source_status import record_source_status
from sentiment_utils import classify_financial_event, score_financial_sentiment, signed_sentiment_score

load_dotenv()

MONGODB_URI = os.getenv("MONGODB_URI", "mongodb://localhost:27017/feedflash")
DB_NAME = os.getenv("MONGODB_DB", os.getenv("MONGO_DB", "feedflash"))
MONGO_TIMEOUT_MS = int(os.getenv("MONGO_SERVER_SELECTION_TIMEOUT_MS", "3000"))
API_KEY = os.getenv("BENZINGA_API_KEY", "").strip()
LIMIT = int(os.getenv("BENZINGA_LIMIT", "0"))  # 0 = no local cap
TIMEOUT = int(os.getenv("BENZINGA_TIMEOUT", "20"))
PAGE_SIZE = 100  # Benzinga's documented maximum.
CACHE_DAYS = max(1, int(os.getenv("ARTICLE_CACHE_DAYS", "3")))
URL = "https://api.benzinga.com/api/v2/news"
RECENT_URL = "https://www.benzinga.com/recent"
RECENT_HEADERS = {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
}

BLOCKED_TICKERS = {"AI", "CEO", "CFO", "IPO", "ETF", "SEC", "FDA", "USA", "USD", "THE", "FOR", "ARE", "MHRA", "TXM"}
BULLISH_WORDS = ("beat", "beats", "raise", "raises", "surge", "jumps", "gain", "approval", "record", "upgrade")
BEARISH_WORDS = ("miss", "misses", "cut", "cuts", "drop", "falls", "lawsuit", "recall", "downgrade", "offering")


def extract_lightweight_tickers(title: str, content: str) -> str:
    text = f"{title} {content}"
    found = set()
    for match in re.findall(r"(?:NYSE|NASDAQ|Nasdaq|TSX|AMEX)\s*:\s*([A-Z]{1,5})", text):
        found.add(match.upper())
    for match in re.findall(r"\$([A-Z]{1,5})\b", text):
        found.add(match.upper())
    return ",".join(sorted(t for t in found if t not in BLOCKED_TICKERS))


def _ticker_list(value: str) -> list[str]:
    tickers = []
    for raw in dict.fromkeys(str(value or "").upper().replace(";", ",").split(",")):
        ticker = raw.strip()
        if re.fullmatch(r"[A-Z][A-Z0-9.-]{0,11}", ticker):
            tickers.append(ticker)
    return tickers


def _debug_line(payload: dict) -> None:
    print(f"SOURCE_DEBUG_JSON {json.dumps(payload, sort_keys=True)}")


def score_lightweight_sentiment(title: str, content: str) -> tuple[str, float]:
    return score_financial_sentiment(title, content)


def _stable_id(value: str) -> str:
    return hashlib.sha1(value.encode("utf-8")).hexdigest()[:24]


def _published_ts(value) -> int | None:
    if not value:
        return None
    if isinstance(value, (int, float)):
        return int(value)
    try:
        return int(datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp())
    except Exception:
        try:
            return int(parsedate_to_datetime(str(value)).timestamp())
        except Exception:
            return None


def _api_items() -> list[dict]:
    """Fetch every Benzinga result in the cache window using official pagination."""
    date_to = datetime.now(timezone.utc).date()
    date_from = date_to - timedelta(days=CACHE_DAYS)
    items = []
    seen_ids = set()
    page = 0

    while True:
        remaining = LIMIT - len(items) if LIMIT > 0 else PAGE_SIZE
        request_size = min(PAGE_SIZE, remaining) if LIMIT > 0 else PAGE_SIZE
        if request_size <= 0:
            break
        resp = requests.get(
            URL,
            params={
                "token": API_KEY,
                "page": page,
                "pageSize": request_size,
                "displayOutput": "full",
                "dateFrom": date_from.isoformat(),
                "dateTo": date_to.isoformat(),
                "sort": "created:desc",
            },
            headers={"Accept": "application/json", "User-Agent": "FeedFlash/1.0"},
            timeout=TIMEOUT,
        )
        resp.raise_for_status()
        payload = resp.json()
        page_items = payload if isinstance(payload, list) else payload.get("data", [])
        if not page_items:
            break

        page_new = 0
        for item in page_items:
            item_id = str(item.get("id") or item.get("url") or item.get("link") or "")
            if not item_id or item_id in seen_ids:
                continue
            seen_ids.add(item_id)
            items.append(item)
            page_new += 1
            if LIMIT > 0 and len(items) >= LIMIT:
                break

        if not page_new or len(page_items) < request_size or (LIMIT > 0 and len(items) >= LIMIT):
            break
        page += 1

    return items


def _json_object_at(text: str, start: int) -> dict | None:
    in_string = False
    escaped = False
    depth = 0
    for idx in range(start, len(text)):
        ch = text[idx]
        if escaped:
            escaped = False
            continue
        if ch == "\\" and in_string:
            escaped = True
            continue
        if ch == '"':
            in_string = not in_string
            continue
        if in_string:
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(text[start:idx + 1])
                except Exception:
                    return None
    return None


def _decode_next_payload(text: str) -> str:
    text = text.replace('\\"', '"').replace("\\/", "/")
    return re.sub(
        r"\\u([0-9a-fA-F]{4})",
        lambda match: chr(int(match.group(1), 16)),
        text,
    )


def _recent_structured_items(html: str) -> list[dict]:
    decoded = _decode_next_payload(html)
    items = []
    seen = set()
    cursor = 0
    while True:
        idx = decoded.find('"createdAt"', cursor)
        if idx < 0:
            break
        start = decoded.rfind('{"assets"', 0, idx)
        cursor = idx + 11
        if start < 0:
            continue
        item = _json_object_at(decoded, start)
        if not item:
            continue
        url = str(item.get("url") or "")
        if not url.startswith("https://www.benzinga.com/") or url in seen:
            continue
        seen.add(url)
        items.append(item)
        if LIMIT > 0 and len(items) >= LIMIT:
            break
    return items


def _recent_card_items(html: str) -> list[dict]:
    if BeautifulSoup is None:
        return []
    soup = BeautifulSoup(html, "html.parser")
    items = []
    seen = set()
    for anchor in soup.select('a[href^="https://www.benzinga.com/"]'):
        url = anchor.get("href") or ""
        if not re.search(r"/\d{2}/\d{2}/\d+/", url) or url in seen:
            continue
        card = anchor.find_parent("div", class_=lambda value: value and "post-card" in value)
        if not card:
            continue
        title = card.get("title") or ""
        text = re.sub(r"\s+", " ", card.get_text(" ", strip=True)).strip()
        if not title:
            title = text.split(". ")[0].strip()
        if not title:
            continue
        summary = text[len(title):].strip() if text.startswith(title) else text
        seen.add(url)
        items.append({
            "title": title,
            "teaser": summary,
            "teaserText": summary,
            "url": url,
            "tickers": [],
            "stocks": [],
            "created": None,
            "updated": None,
        })
        if LIMIT > 0 and len(items) >= LIMIT:
            break
    return items


def _recent_items() -> list[dict]:
    if not _HAS_PUBLIC_RECENT:
        raise RuntimeError("curl_cffi/BeautifulSoup unavailable for Benzinga public recent fallback")
    resp = curl_requests.get(
        RECENT_URL,
        headers=RECENT_HEADERS,
        impersonate=os.getenv("BENZINGA_RECENT_IMPERSONATE", "chrome124"),
        timeout=TIMEOUT,
    )
    resp.raise_for_status()
    items = _recent_structured_items(resp.text)
    return items or _recent_card_items(resp.text)


def _item_tickers(item: dict) -> list[str]:
    values = []
    for stock in (item.get("stocks") or []) + (item.get("tickers") or []):
        if isinstance(stock, dict):
            values.append(stock.get("name") or stock.get("symbol") or stock.get("ticker") or "")
        else:
            values.append(stock)
    return [
        str(value or "").upper().strip()
        for value in values
        if re.fullmatch(r"[A-Z][A-Z0-9.-]{0,11}", str(value or "").upper().strip())
    ]


def main() -> dict:
    client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=MONGO_TIMEOUT_MS)
    db = client[DB_NAME]
    source_mode = "news_api"
    source_warning = ""

    if not API_KEY:
        source_mode = "public_recent"
        source_warning = "BENZINGA_API_KEY not set; used public /recent fallback"

    try:
        items = _api_items() if API_KEY else _recent_items()
    except Exception as exc:
        print(f"Benzinga import skipped — {exc}")
        detail = f"Benzinga API key missing and public /recent fallback failed: {exc}" if not API_KEY else str(exc)
        record_source_status(db, "Benzinga", "error" if API_KEY else "api_key_required", detail=detail, source_type="structured_news")
        _debug_line({
            "source": "Benzinga",
            "attempted": True,
            "ok": False,
            "fetched": 0,
            "inserted": 0,
            "updated": 0,
            "deduped": 0,
            "tickerMatched": 0,
            "errors": [detail],
            "warnings": [source_warning] if source_warning else [],
        })
        client.close()
        return {"found": 0, "new": 0, "updated": 0, "status": "error", "error": detail}

    docs = []
    now = int(time.time())
    for item in items:
        title = html.unescape(item.get("title") or item.get("headline") or "")
        url = item.get("url") or item.get("link") or ""
        body = re.sub(r"<[^>]+>", " ", item.get("body") or item.get("teaser") or item.get("teaserText") or "")
        body = html.unescape(body)
        body = re.sub(r"\s+", " ", body).strip()
        if not title or not url:
            continue
        api_tickers = _item_tickers(item)
        ticker = ",".join(dict.fromkeys(api_tickers)) or extract_lightweight_tickers(title, body)
        sentiment, confidence = score_lightweight_sentiment(title, body)
        event_type, event_score, event_reason = classify_financial_event(title, body)
        published = _published_ts(item.get("created") or item.get("createdAt") or item.get("updated") or item.get("updatedAt") or item.get("published"))
        tickers = _ticker_list(ticker)
        docs.append({
            "article_id": _stable_id(url),
            "title": title,
            "content": body[:3000],
            "summary": body[:1000],
            "bodyText": body[:3000],
            "url": url,
            "source": "Benzinga",
            "provider": "Benzinga",
            "category": "structured_news",
            "catalystCategory": event_type,
            "catalystScore": event_score,
            "article_kind": "structured",
            "source_type": "news_api" if source_mode == "news_api" else "public_recent",
            "isStructuredNews": True,
            "isNewswire": False,
            "publish_date": published,
            "publishedAt": published,
            "publish_time_trusted": published is not None,
            "fetched_date": now,
            "fetchedAt": now,
            "detected_at": now,
            "ticker": ticker,
            "tickers": tickers,
            "companies": [],
            "sentiment": sentiment,
            "ml_confidence": confidence,
            "sentiment_score": signed_sentiment_score(sentiment, confidence),
            "sentiment_at": now if sentiment != "neutral" else None,
            "event_type": event_type,
            "event_score": event_score,
            "sentiment_reason": event_reason,
            "dedupeKey": f"benzinga:{re.sub(r'[^a-z0-9]+', ' ', title.lower()).strip()}:{published or ''}",
            "raw": {"collector": "benzinga_news_api_v2" if source_mode == "news_api" else "benzinga_public_recent", "id": item.get("id"), "stocks": item.get("stocks") or [], "tickers": item.get("tickers") or []},
            "collector": "benzinga_news_api_v2" if source_mode == "news_api" else "benzinga_public_recent",
        })

    upserted = modified = 0
    if docs:
        result = db.articles.bulk_write([
            UpdateOne(
                {"url": doc["url"]},
                {"$set": {k: v for k, v in doc.items() if k != "article_id"}, "$setOnInsert": {"article_id": doc["article_id"], "first_seen_at": now}},
                upsert=True,
            )
            for doc in docs
        ], ordered=False)
        upserted = result.upserted_count
        modified = result.modified_count

    detail = f"{source_mode}; {source_warning}".strip("; ")
    record_source_status(db, "Benzinga", "working", detail=detail, count=len(docs), source_type="structured_news")
    print(f"Benzinga import complete — {len(docs)} found, {upserted} new, {modified} updated")
    _debug_line({
        "source": "Benzinga",
        "attempted": True,
        "ok": True,
        "fetched": len(docs),
        "inserted": upserted,
        "updated": modified,
        "deduped": max(0, len(docs) - upserted - modified),
        "tickerMatched": sum(1 for doc in docs if doc.get("ticker") or doc.get("tickers")),
        "errors": [],
        "warnings": [source_warning] if source_warning else [],
    })
    client.close()
    return {"found": len(docs), "new": upserted, "updated": modified, "status": "working"}


def fetch_benzinga() -> dict:
    """Compatibility entry point used by the unified collector."""
    return main()


if __name__ == "__main__":
    main()
