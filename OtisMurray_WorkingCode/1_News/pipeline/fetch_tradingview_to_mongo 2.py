"""
Fetch ticker-specific TradingView news for the current Finviz mover set.

Uses TradingView's public news-mediator symbol endpoint. This is more reliable
than scraping the JavaScript-heavy TradingView news page and keeps collection
focused on the symbols day traders are already watching.
"""

from __future__ import annotations

import hashlib
import os
import re
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from urllib.parse import urlencode

import requests
from pymongo import MongoClient, UpdateOne
from pymongo.errors import OperationFailure

from sentiment_utils import classify_financial_event, score_financial_sentiment

MONGODB_URI = os.getenv("MONGODB_URI", "mongodb://localhost:27017/feedflash")
DB_NAME = os.getenv("MONGODB_DB", os.getenv("MONGO_DB", "feedflash"))
MAX_TICKERS = int(os.getenv("TRADINGVIEW_MAX_TICKERS", os.getenv("SOCIAL_MAX_TICKERS", "10")))
MAX_WORKERS = int(os.getenv("TRADINGVIEW_MAX_WORKERS", "6"))
MAX_PER_TICKER = int(os.getenv("TRADINGVIEW_MAX_PER_TICKER", "8"))
TIMEOUT = int(os.getenv("TRADINGVIEW_REQUEST_TIMEOUT", "12"))

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json,text/plain,*/*",
}

KNOWN_NYSE_TICKERS = {
    "ABBV", "BA", "BAC", "CAT", "COST", "CRM", "CVX", "DE", "DIS", "GE",
    "GS", "HD", "JPM", "KO", "LLY", "LOW", "MA", "MCD", "MRK", "MS",
    "ORCL", "PEP", "PFE", "PG", "SBUX", "SHOP", "T", "TGT", "TSM",
    "UBER", "UNH", "V", "WMT", "XOM", "KSS",
}

KNOWN_AMEX_TICKERS = {"SPY", "QQQ", "DIA", "IWM"}

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


def _load_tickers_from_env() -> list[str]:
    raw = os.getenv("TRADINGVIEW_TICKERS") or os.getenv("SOCIAL_TICKERS") or ""
    tickers = []
    seen = set()
    for value in raw.split(","):
        ticker = value.strip().upper()
        if not ticker or ticker in seen:
            continue
        if not re.fullmatch(r"[A-Z][A-Z0-9.-]{0,5}", ticker):
            continue
        tickers.append(ticker)
        seen.add(ticker)
        if len(tickers) >= MAX_TICKERS:
            break
    return tickers


def _load_positive_movers(db) -> list[str]:
    configured = _load_tickers_from_env()
    if configured:
        return configured

    rows = list(db.screeners.find({}))
    candidates = []
    for row in rows:
        ticker = str(row.get("ticker") or "").upper()
        try:
            change = float(row.get("change_pct") if row.get("change_pct") is not None else row.get("change_percent") or 0)
        except Exception:
            change = 0
        try:
            volume = float(row.get("volume") or 0)
        except Exception:
            volume = 0
        try:
            avg_volume = float(row.get("avg_volume") or 0)
        except Exception:
            avg_volume = 0
        rel_volume = volume / max(1, avg_volume) if volume and avg_volume else 0
        if ticker and change > 0:
            candidates.append((ticker, change, rel_volume, volume))

    candidates.sort(key=lambda item: (item[1], item[2], item[3]), reverse=True)
    return [ticker for ticker, _change, _rel_volume, _volume in candidates[:MAX_TICKERS]]


def _exchange_candidates(ticker: str) -> tuple[str, ...]:
    if ticker in KNOWN_NYSE_TICKERS:
        return ("NYSE", "NASDAQ", "AMEX")
    if ticker in KNOWN_AMEX_TICKERS:
        return ("AMEX", "NASDAQ", "NYSE")
    return ("NASDAQ", "NYSE", "AMEX")


def _tradingview_url(symbol: str) -> str:
    query = urlencode(
        [
            ("filter", "lang:en"),
            ("filter", f"symbol:{symbol}"),
            ("client", "web"),
            ("user_prostatus", "non_pro"),
        ],
        doseq=True,
    )
    return f"https://news-mediator.tradingview.com/public/view/v1/symbol?{query}"


def _published_ts(value) -> int:
    try:
        n = int(value)
        if n > 1_000_000_000:
            return n
    except Exception:
        pass
    return int(time.time())


def _score_title_sentiment(title: str) -> tuple[str, float]:
    return score_financial_sentiment(title, "")


def _fetch_ticker(ticker: str) -> list[dict]:
    errors = []
    for exchange in _exchange_candidates(ticker):
        symbol = f"{exchange}:{ticker}"
        url = _tradingview_url(symbol)
        try:
            resp = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
            resp.raise_for_status()
            payload = resp.json()
        except Exception as exc:
            errors.append(f"{symbol}: {exc}")
            continue

        docs = []
        for item in payload.get("items", [])[:MAX_PER_TICKER]:
            title = _clean(item.get("title", ""))
            if len(title) < 12:
                continue
            provider = item.get("provider") or {}
            story_path = item.get("storyPath") or ""
            link = item.get("link") or (f"https://www.tradingview.com{story_path}" if story_path else "")
            published = _published_ts(item.get("published"))
            item_id = item.get("id") or link or f"{symbol}:{title}"
            sentiment, confidence = _score_title_sentiment(title)
            event_type, event_score, event_reason = classify_financial_event(title, provider.get("name", ""))
            docs.append({
                "article_id": _stable_id("tradingview", str(item_id)),
                "title": title,
                "content": _clean(provider.get("name", "")),
                "url": link,
                "source": "TradingView News Flow",
                "category": "tradingview_news",
                "publish_date": published,
                "fetched_date": int(time.time()),
                "detected_at": int(time.time()),
                "ticker": ticker,
                "company": "",
                "sentiment": sentiment,
                "ml_confidence": confidence,
                "sentiment_at": int(time.time()) if sentiment != "neutral" else None,
                "event_type": event_type,
                "event_score": event_score,
                "sentiment_reason": event_reason,
                "provider": provider.get("name", ""),
                "tradingview_symbol": symbol,
                "collector": "tradingview_news_mediator_symbol_v1",
            })
        if docs:
            return docs

    print(f"TradingView {ticker}: SKIP {'; '.join(errors) if errors else 'no items'}")
    return []


def _ensure_index(collection, *args, **kwargs) -> None:
    try:
        collection.create_index(*args, **kwargs)
    except OperationFailure as exc:
        if getattr(exc, "code", None) != 86:
            raise


def main() -> None:
    client = MongoClient(MONGODB_URI)
    db = client[DB_NAME]
    articles = db.articles
    _ensure_index(articles, "url", unique=True)
    _ensure_index(articles, "article_id", unique=True, sparse=True)
    _ensure_index(articles, "ticker")
    _ensure_index(articles, "source")

    tickers = _load_positive_movers(db)
    found = upserted = modified = 0
    kafka_publish_docs = []

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        futures = [executor.submit(_fetch_ticker, ticker) for ticker in tickers]
        for future in as_completed(futures):
            docs = future.result()
            found += len(docs)
            if not docs:
                continue
            ops = []
            for doc in docs:
                key = {"url": doc["url"]} if doc.get("url") else {"article_id": doc["article_id"]}
                set_doc = dict(doc)
                article_id = set_doc.pop("article_id")
                ops.append(UpdateOne(
                    key,
                    {"$set": set_doc, "$setOnInsert": {"article_id": article_id}},
                    upsert=True,
                ))
            result = articles.bulk_write(ops, ordered=False)
            upserted += result.upserted_count
            modified += result.modified_count
            kafka_publish_docs.extend(docs)

    print(f"TradingView import complete — {found} found, {upserted} new, {modified} updated")

    # --- OPTIONAL Kafka publish (additive; OFF unless KAFKA_PUBLISH_NEWS=true) ---
    if os.getenv("KAFKA_PUBLISH_NEWS", "false").strip().lower() in ("1", "true", "yes"):
        try:
            import sys
            sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "Infrastructure", "kafka"))
            from news_publisher import publish_articles
            _sent = publish_articles(kafka_publish_docs)
            print(f"Kafka publish — {_sent} news events sent to topic")
        except Exception as exc:
            print(f"Kafka publish skipped (Mongo import unaffected): {exc}")

    client.close()


if __name__ == "__main__":
    main()
