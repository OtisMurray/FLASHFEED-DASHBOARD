#!/usr/bin/env python3
"""Fetch Benzinga news when BENZINGA_API_KEY is configured."""

from __future__ import annotations

import hashlib
import os
import re
import time
from datetime import datetime, timezone

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
LIMIT = int(os.getenv("BENZINGA_LIMIT", "50"))
TIMEOUT = int(os.getenv("BENZINGA_TIMEOUT", "20"))
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


def _published_ts(value) -> int:
    if not value:
        return int(time.time())
    if isinstance(value, (int, float)):
        return int(value)
    try:
        return int(datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp())
    except Exception:
        return int(time.time())


def main() -> None:
    client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=MONGO_TIMEOUT_MS)
    db = client[DB_NAME]

    if not API_KEY:
        print("Benzinga import skipped — BENZINGA_API_KEY not set")
        record_source_status(db, "Benzinga", "api_key_required", detail="BENZINGA_API_KEY not set", source_type="structured_news")
        client.close()
        return

    try:
        resp = requests.get(
            URL,
            params={"token": API_KEY, "pagesize": LIMIT, "displayOutput": "full"},
            headers={"Accept": "application/json", "User-Agent": "FeedFlash/1.0"},
            timeout=TIMEOUT,
        )
        resp.raise_for_status()
        payload = resp.json()
    except Exception as exc:
        print(f"Benzinga import skipped — {exc}")
        record_source_status(db, "Benzinga", "error", detail=str(exc), source_type="structured_news")
        client.close()
        return

    items = payload if isinstance(payload, list) else payload.get("data", [])
    docs = []
    now = int(time.time())
    for item in items[:LIMIT]:
        title = item.get("title") or item.get("headline") or ""
        url = item.get("url") or item.get("link") or ""
        body = re.sub(r"<[^>]+>", " ", item.get("body") or item.get("teaser") or "")
        body = re.sub(r"\s+", " ", body).strip()
        if not title or not url:
            continue
        ticker = extract_lightweight_tickers(title, body)
        sentiment, confidence = score_lightweight_sentiment(title, body)
        event_type, event_score, event_reason = classify_financial_event(title, body)
        docs.append({
            "article_id": _stable_id(url),
            "title": title,
            "content": body[:3000],
            "url": url,
            "source": "Benzinga",
            "category": "structured_news",
            "publish_date": _published_ts(item.get("created") or item.get("updated") or item.get("published")),
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
                {"$set": {k: v for k, v in doc.items() if k != "article_id"}, "$setOnInsert": {"article_id": doc["article_id"]}},
                upsert=True,
            )
            for doc in docs
        ], ordered=False)
        upserted = result.upserted_count
        modified = result.modified_count

    record_source_status(db, "Benzinga", "working", count=len(docs), source_type="structured_news")
    print(f"Benzinga import complete — {len(docs)} found, {upserted} new, {modified} updated")

    # --- OPTIONAL Kafka publish (additive; OFF unless KAFKA_PUBLISH_NEWS=true) ---
    if os.getenv("KAFKA_PUBLISH_NEWS", "false").strip().lower() in ("1", "true", "yes"):
        try:
            import sys
            sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "Infrastructure", "kafka"))
            from news_publisher import publish_articles
            _sent = publish_articles(docs)
            print(f"Kafka publish — {_sent} news events sent to topic")
        except Exception as exc:
            print(f"Kafka publish skipped (Mongo import unaffected): {exc}")

    client.close()


if __name__ == "__main__":
    main()
