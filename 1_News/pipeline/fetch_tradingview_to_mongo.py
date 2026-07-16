"""Fetch TradingView's broad market:stock News Flow into MongoDB.

All modes use the market-wide feed. Ticker lists are used only to tag returned
stories; they never determine which stories are fetched.
"""

from __future__ import annotations

import hashlib
import os
import re
import sys
import time

import requests
from pymongo import MongoClient, UpdateOne
from pymongo.errors import OperationFailure

from sentiment_utils import classify_financial_event, score_financial_sentiment
from source_status import record_source_status

MONGODB_URI = os.getenv("MONGODB_URI", "mongodb://localhost:27017/feedflash")
DB_NAME = os.getenv("MONGODB_DB", os.getenv("MONGO_DB", "feedflash"))
TIMEOUT = int(os.getenv("TRADINGVIEW_REQUEST_TIMEOUT", "12"))
NEWS_FLOW_URL = "https://news-mediator.tradingview.com/public/news-flow/v2/news"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json,text/plain,*/*",
}

BULLISH_WORDS = [
    "rise", "rises", "rose", "jump", "jumps", "surge", "surges", "gain", "gains",
    "beat", "beats", "strong", "growth", "upgrade", "raises", "bullish",
    "record", "profit", "approval", "partnership", "contract", "dividend", "soars",
    "rally", "rallies", "higher",
]

BEARISH_WORDS = [
    "fall", "falls", "fell", "drop", "drops", "slump", "slumps", "miss",
    "misses", "weak", "downgrade", "cuts", "bearish", "lawsuit", "fraud",
    "bankruptcy", "recall", "layoffs", "concern", "concerns", "risk-off",
    "lower",
]


def _clean(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def _stable_id(prefix: str, value: str) -> str:
    return hashlib.sha1(f"{prefix}:{value}".encode("utf-8")).hexdigest()[:24]


def _published_ts(value) -> int | None:
    try:
        n = int(value)
        if n > 1_000_000_000:
            return n
    except Exception:
        pass
    return None


def _score_title_sentiment(title: str) -> tuple[str, float]:
    return score_financial_sentiment(title, "")


def _ticker_from_symbol(symbol: str) -> str:
    value = str(symbol or "").strip().upper()
    if ":" not in value:
        return ""
    ticker = value.split(":", 1)[1]
    return ticker if re.fullmatch(r"[A-Z0-9][A-Z0-9.-]{0,11}", ticker) else ""


def _news_flow_doc(item: dict) -> dict | None:
    title = _clean(item.get("title", ""))
    if len(title) < 12:
        return None

    provider = item.get("provider") or {}
    related_symbols = [
        str(row.get("symbol") or "").upper()
        for row in (item.get("relatedSymbols") or [])
        if row.get("symbol")
    ]
    related_tickers = list(dict.fromkeys(filter(None, (_ticker_from_symbol(symbol) for symbol in related_symbols))))
    story_path = item.get("storyPath") or ""
    link = item.get("link") or (f"https://www.tradingview.com{story_path}" if story_path else "")
    item_id = str(item.get("id") or link or title)
    published = _published_ts(item.get("published"))
    sentiment, confidence = _score_title_sentiment(title)
    event_type, event_score, event_reason = classify_financial_event(title, provider.get("name", ""))

    return {
        "article_id": _stable_id("tradingview-flow", item_id),
        "title": title,
        "content": _clean(provider.get("name", "")),
        "url": link or f"https://www.tradingview.com/news/{item_id}/",
        "source": "TradingView News Flow",
        "category": "tradingview_news",
        "article_kind": "structured",
        "source_type": "structured_aggregator",
        "publish_date": published,
        "publish_time_trusted": published is not None,
        "fetched_date": int(time.time()),
        "detected_at": int(time.time()),
        "ticker": ",".join(related_tickers),
        "tickers": related_tickers,
        "related_symbols": related_symbols,
        "company": "",
        "sentiment": sentiment,
        "ml_confidence": confidence,
        "sentiment_at": int(time.time()) if sentiment != "neutral" else None,
        "event_type": event_type,
        "event_score": event_score,
        "sentiment_reason": event_reason,
        "provider": provider.get("name", ""),
        "provider_id": provider.get("id", ""),
        "permission": item.get("permission", ""),
        "urgency": item.get("urgency"),
        "collector": "tradingview_public_news_flow_v2",
    }


def _fetch_full_stock_flow() -> list[dict]:
    params = [
        ("filter", "lang:en"),
        ("filter", "market:stock"),
        ("client", "web"),
        ("streaming", "true"),
        ("user_prostatus", "non_pro"),
    ]
    resp = requests.get(NEWS_FLOW_URL, params=params, headers=HEADERS, timeout=TIMEOUT)
    resp.raise_for_status()
    payload = resp.json()
    return [doc for item in payload.get("items", []) if (doc := _news_flow_doc(item)) is not None]


def _ensure_index(collection, *args, **kwargs) -> None:
    try:
        collection.create_index(*args, **kwargs)
    except OperationFailure as exc:
        if getattr(exc, "code", None) != 86:
            raise


def main() -> dict:
    client = MongoClient(MONGODB_URI)
    db = client[DB_NAME]
    articles = db.articles
    _ensure_index(articles, "url", unique=True)
    _ensure_index(articles, "article_id", unique=True, sparse=True)
    _ensure_index(articles, "ticker")
    _ensure_index(articles, "source")

    found = upserted = modified = 0
    errors = 0
    kafka_publish_docs = []

    try:
        batches = [_fetch_full_stock_flow()]
    except Exception as exc:
        print(f"TradingView broad News Flow: SKIP {exc}")
        batches = []
        errors = 1

    for docs in batches:
        try:
            found += len(docs)
            if not docs:
                continue
            ops = []
            for doc in docs:
                key_parts = [{"article_id": doc["article_id"]}]
                if doc.get("url"):
                    key_parts.insert(0, {"url": doc["url"]})
                key = {"$or": key_parts} if len(key_parts) > 1 else key_parts[0]
                set_doc = dict(doc)
                article_id = set_doc.pop("article_id")
                ops.append(UpdateOne(
                    key,
                    {"$set": set_doc, "$setOnInsert": {"article_id": article_id, "first_seen_at": int(time.time())}},
                    upsert=True,
                ))
            result = articles.bulk_write(ops, ordered=False)
            upserted += result.upserted_count
            modified += result.modified_count
            if result.upserted_count or result.modified_count:
                kafka_publish_docs.extend(docs)
        except Exception as exc:
            errors += 1
            print(f"TradingView persistence error: {exc}")

    if errors:
        record_source_status(
            db,
            "TradingView News Flow",
            "partial_error" if found else "error",
            detail=f"{found} broad-feed articles found; {errors} fetch/persistence errors",
            count=found,
            source_type="structured_news",
        )
    elif found:
        record_source_status(
            db,
            "TradingView News Flow",
            "working",
            detail="broad market:stock News Flow scanned without local ticker/article caps; each upstream batch is accumulated in MongoDB",
            count=found,
            source_type="structured_news",
        )
    else:
        record_source_status(
            db,
            "TradingView News Flow",
            "no_rows",
            detail="No TradingView market:stock news returned",
            count=0,
            source_type="structured_news",
        )

    print(f"TradingView import complete — {found} found, {upserted} new, {modified} updated")

    if os.getenv("KAFKA_PUBLISH_NEWS", "false").strip().lower() in ("1", "true", "yes"):
        try:
            sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "Infrastructure", "kafka"))
            from news_publisher import publish_articles

            sent = publish_articles(kafka_publish_docs)
            print(f"Kafka publish — {sent} TradingView news events sent to topic")
        except Exception as exc:
            print(f"Kafka publish skipped (Mongo import unaffected): {exc}")

    client.close()
    return {"found": found, "new": upserted, "updated": modified, "errors": errors, "scope": "broad_stock"}


def fetch_tradingview_news(tickers=None, max_tickers=0) -> dict:
    """Compatibility entry point for unified_fetch; broad stock flow is intentionally uncapped."""
    return main()


if __name__ == "__main__":
    main()
