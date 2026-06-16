#!/usr/bin/env python3
"""
Batch LLM sentiment scoring for MongoDB articles.

Fast collectors should write articles immediately with lightweight sentiment.
This script is the slower enrichment pass: it sends many articles in one Gemini
request, asks the model to echo each article id, and writes the mapped results
back to MongoDB. That keeps request count low while preserving row-level mapping.
"""

from __future__ import annotations

import argparse
import json
import os
import time
from datetime import datetime, timezone
from typing import Literal

from dotenv import load_dotenv
from pymongo import MongoClient, UpdateOne

load_dotenv()

MONGODB_URI = os.environ.get("MONGODB_URI", "mongodb://localhost:27017/feedflash")
DB_NAME = os.environ.get("MONGO_DB", "feedflash")
DEFAULT_MODEL = os.environ.get("GEMINI_SENTIMENT_MODEL", "gemini-2.5-flash")


def _local_label(text: str) -> tuple[str, float]:
    lower = text.lower()
    bullish_words = ("beat", "beats", "raise", "raises", "surge", "jumps", "approval", "record", "contract", "upgrade")
    bearish_words = ("miss", "misses", "cut", "cuts", "offering", "lawsuit", "recall", "downgrade", "bankruptcy", "falls")
    bullish = sum(1 for word in bullish_words if word in lower)
    bearish = sum(1 for word in bearish_words if word in lower)
    if bullish > bearish:
        return "positive", min(0.95, 0.55 + bullish * 0.1)
    if bearish > bullish:
        return "negative", min(0.95, 0.55 + bearish * 0.1)
    return "neutral", 0.5


def load_articles(limit: int, ticker_only: bool) -> list[dict]:
    db = MongoClient(MONGODB_URI)[DB_NAME]
    query: dict = {
        "$or": [
            {"ai_sentiment_label": {"$exists": False}},
            {"ai_sentiment_label": None},
            {"ai_sentiment_label": ""},
        ],
    }
    if ticker_only:
        query["$or"] = [
            {"ticker": {"$nin": ["", None]}},
            {"tickers_mentioned.0": {"$exists": True}},
        ]
        query["ai_sentiment_label"] = {"$in": [None, ""]}

    rows = db.articles.find(
        query,
        {
            "_id": 1,
            "article_id": 1,
            "ticker": 1,
            "tickers_mentioned": 1,
            "title": 1,
            "summary": 1,
            "content": 1,
            "source": 1,
        },
    ).sort([("fetched_date", -1), ("publish_date", -1)]).limit(limit)
    return list(rows)


def to_prompt_items(rows: list[dict]) -> list[dict]:
    items = []
    for idx, row in enumerate(rows, 1):
        tickers = row.get("tickers_mentioned") or []
        if not tickers and row.get("ticker"):
            tickers = [str(row.get("ticker")).split(",")[0].strip()]
        body = " ".join(
            part for part in [
                row.get("title") or "",
                row.get("summary") or "",
                (row.get("content") or "")[:1200],
            ] if part
        )
        items.append({
            "id": idx,
            "mongo_id": str(row.get("_id")),
            "ticker": ",".join(tickers),
            "source": row.get("source") or "",
            "headline": body[:1600],
        })
    return items


def score_with_gemini(items: list[dict], model: str) -> list[dict]:
    try:
        from google import genai
        from pydantic import BaseModel
    except Exception as exc:
        raise RuntimeError(f"google-genai/pydantic unavailable: {exc}") from exc

    class Sentiment(BaseModel):
        id: int
        label: Literal["positive", "negative", "neutral", "mixed"]
        score: float
        reason: str = ""

    api_key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY or GOOGLE_API_KEY is not set")

    client = genai.Client(api_key=api_key)
    prompt = (
        "Classify each financial news item for likely stock impact. "
        "Return one result per item and echo the id exactly. "
        "Use positive, negative, neutral, or mixed. Score must be 0.0 to 1.0.\n"
        + json.dumps(items, ensure_ascii=True)
    )
    response = client.models.generate_content(
        model=model,
        contents=prompt,
        config={
            "response_mime_type": "application/json",
            "response_schema": list[Sentiment],
        },
    )
    return [item.model_dump() for item in response.parsed]


def normalize_label(label: str) -> str:
    label = (label or "neutral").lower()
    if label == "positive":
        return "bullish"
    if label == "negative":
        return "bearish"
    return "neutral" if label == "neutral" else "mixed"


def write_results(rows: list[dict], items: list[dict], results: list[dict], model: str, apply_primary: bool) -> int:
    db = MongoClient(MONGODB_URI)[DB_NAME]
    by_id = {int(result.get("id")): result for result in results if result.get("id") is not None}
    now = datetime.now(timezone.utc)
    ops = []

    for row, item in zip(rows, items):
        result = by_id.get(int(item["id"]))
        if not result:
            continue
        label = normalize_label(str(result.get("label") or "neutral"))
        score = float(result.get("score") or 0)
        update = {
            "ai_sentiment_label": label,
            "ai_sentiment_score": max(0.0, min(1.0, score)),
            "ai_sentiment_reason": str(result.get("reason") or "")[:400],
            "ai_sentiment_model": model,
            "ai_sentiment_at": now,
        }
        if apply_primary and label in {"bullish", "bearish", "neutral"}:
            update["sentiment"] = label
            update["ml_confidence"] = update["ai_sentiment_score"]
            update["sentiment_at"] = int(time.time())
        ops.append(UpdateOne({"_id": row["_id"]}, {"$set": update}))

    if not ops:
        return 0
    result = db.articles.bulk_write(ops, ordered=False)
    return int(result.modified_count + result.upserted_count)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=50)
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--ticker-only", action="store_true", default=True)
    parser.add_argument("--apply-primary", action="store_true")
    parser.add_argument("--fallback-local", action="store_true")
    args = parser.parse_args()

    rows = load_articles(max(1, min(args.limit, 100)), args.ticker_only)
    if not rows:
        print("No articles need AI sentiment enrichment.")
        return

    items = to_prompt_items(rows)
    try:
        results = score_with_gemini(items, args.model)
    except Exception as exc:
        if not args.fallback_local:
            raise
        print(f"Gemini unavailable; using local fallback: {exc}")
        results = []
        for item in items:
            label, score = _local_label(item["headline"])
            results.append({"id": item["id"], "label": label, "score": score, "reason": "local fallback"})

    modified = write_results(rows, items, results, args.model, args.apply_primary)
    print(f"Batch AI sentiment complete: items={len(items)} results={len(results)} modified={modified}")


if __name__ == "__main__":
    main()
