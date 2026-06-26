#!/usr/bin/env python3
"""Fetch Benzinga news when BENZINGA_API_KEY is configured."""

from __future__ import annotations

import hashlib
import os
import re
import time
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime

import requests
from dotenv import load_dotenv
from pymongo import MongoClient, UpdateOne

from source_status import record_source_status
from sentiment_utils import classify_financial_event, score_financial_sentiment

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


def main() -> dict:
    client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=MONGO_TIMEOUT_MS)
    db = client[DB_NAME]

    if not API_KEY:
        print("Benzinga import skipped — BENZINGA_API_KEY not set")
        record_source_status(db, "Benzinga", "api_key_required", detail="BENZINGA_API_KEY not set", source_type="structured_news")
        client.close()
        return {"found": 0, "new": 0, "updated": 0, "status": "api_key_required"}

    try:
        items = _api_items()
    except Exception as exc:
        print(f"Benzinga import skipped — {exc}")
        record_source_status(db, "Benzinga", "error", detail=str(exc), source_type="structured_news")
        client.close()
        return {"found": 0, "new": 0, "updated": 0, "status": "error", "error": str(exc)}

    docs = []
    now = int(time.time())
    for item in items:
        title = item.get("title") or item.get("headline") or ""
        url = item.get("url") or item.get("link") or ""
        body = re.sub(r"<[^>]+>", " ", item.get("body") or item.get("teaser") or "")
        body = re.sub(r"\s+", " ", body).strip()
        if not title or not url:
            continue
        api_tickers = [
            str(stock.get("name") or "").upper().strip()
            for stock in (item.get("stocks") or [])
            if re.fullmatch(r"[A-Z][A-Z0-9.-]{0,11}", str(stock.get("name") or "").upper().strip())
        ]
        ticker = ",".join(dict.fromkeys(api_tickers)) or extract_lightweight_tickers(title, body)
        sentiment, confidence = score_lightweight_sentiment(title, body)
        event_type, event_score, event_reason = classify_financial_event(title, body)
        published = _published_ts(item.get("created") or item.get("updated") or item.get("published"))
        docs.append({
            "article_id": _stable_id(url),
            "title": title,
            "content": body[:3000],
            "url": url,
            "source": "Benzinga",
            "category": "structured_news",
            "article_kind": "structured",
            "source_type": "news_api",
            "publish_date": published,
            "publish_time_trusted": published is not None,
            "fetched_date": now,
            "detected_at": now,
            "ticker": ticker,
            "sentiment": sentiment,
            "ml_confidence": confidence,
            "sentiment_at": now if sentiment != "neutral" else None,
            "event_type": event_type,
            "event_score": event_score,
            "sentiment_reason": event_reason,
            "collector": "benzinga_news_api_v2",
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

    record_source_status(db, "Benzinga", "working", count=len(docs), source_type="structured_news")
    print(f"Benzinga import complete — {len(docs)} found, {upserted} new, {modified} updated")
    client.close()
    return {"found": len(docs), "new": upserted, "updated": modified, "status": "working"}


def fetch_benzinga() -> dict:
    """Compatibility entry point used by the unified collector."""
    return main()


if __name__ == "__main__":
    main()
