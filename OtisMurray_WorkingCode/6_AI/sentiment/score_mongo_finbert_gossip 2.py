#!/usr/bin/env python3
import argparse
import html
import os
import re
import time
from typing import Any

from pymongo import MongoClient, UpdateOne
from transformers import AutoModelForSequenceClassification, AutoTokenizer, pipeline

MODEL_NAME = os.environ.get("FINBERT_MODEL", "ProsusAI/finbert")
MODEL_VERSION = f"finbert_gossip_v1:{MODEL_NAME}"

TAG_RE = re.compile(r"<[^>]+>")
SPACE_RE = re.compile(r"\s+")
CASHTAG_RE = re.compile(r"\$[A-Z]{1,6}\b")

GOSSIP_TERMS = {
    "rumor": 24,
    "rumour": 24,
    "reportedly": 18,
    "sources": 16,
    "unconfirmed": 26,
    "allegedly": 18,
    "leak": 18,
    "leaked": 18,
    "whispers": 22,
    "chatter": 18,
    "speculation": 18,
    "takeover": 18,
    "buyout": 18,
    "acquisition target": 22,
    "short squeeze": 24,
    "squeeze": 18,
    "gamma squeeze": 24,
    "insider": 14,
    "activist": 12,
    "pump": 18,
    "dump": 18,
    "moon": 10,
    "rocket": 10,
    "bagholder": 12,
}

GOSSIP_PATTERNS = [
    (term, weight, re.compile(r"(?<![a-zA-Z])" + re.escape(term) + r"(?![a-zA-Z])", re.I))
    for term, weight in GOSSIP_TERMS.items()
]

_finbert = None


def clean_text(value: Any) -> str:
    if not value:
        return ""
    s = html.unescape(str(value))
    s = TAG_RE.sub(" ", s)
    s = SPACE_RE.sub(" ", s)
    return s.strip()


def doc_text(doc: dict) -> str:
    parts = [
        doc.get("title"),
        doc.get("text"),
        doc.get("content"),
        doc.get("summary"),
        doc.get("description"),
    ]
    return " ".join(clean_text(x) for x in parts if x)[:2500]


def load_finbert():
    global _finbert
    if _finbert is not None:
        return _finbert

    print(f"Loading FinBERT model: {MODEL_NAME}")
    tokenizer = AutoTokenizer.from_pretrained(MODEL_NAME)
    model = AutoModelForSequenceClassification.from_pretrained(MODEL_NAME)

    _finbert = pipeline(
        "text-classification",
        model=model,
        tokenizer=tokenizer,
        top_k=None,
        truncation=True,
        max_length=512,
        device=-1,
    )
    return _finbert


def normalize_label(label: str) -> str:
    label = str(label or "").lower()
    if "positive" in label:
        return "bullish"
    if "negative" in label:
        return "bearish"
    return "neutral"


def score_sentiment(text: str) -> dict:
    if not text.strip():
        return {
            "sentiment": "neutral",
            "sentiment_label": "neutral",
            "sentiment_score": 0.0,
            "sentiment_confidence": 0.0,
            "ml_confidence": 0.0,
            "finbert_scores": {"bullish": 0.0, "bearish": 0.0, "neutral": 1.0},
        }

    raw = load_finbert()(text[:2500])[0]

    scores = {"bullish": 0.0, "bearish": 0.0, "neutral": 0.0}
    for item in raw:
        scores[normalize_label(item["label"])] = float(item["score"])

    bullish = scores["bullish"]
    bearish = scores["bearish"]
    neutral = scores["neutral"]

    sentiment_score = bullish - bearish

    if bullish >= bearish and bullish >= neutral:
        label = "bullish"
        confidence = bullish
    elif bearish >= bullish and bearish >= neutral:
        label = "bearish"
        confidence = bearish
    else:
        label = "neutral"
        confidence = neutral

    return {
        "sentiment": label,
        "sentiment_label": label,
        "sentiment_score": round(sentiment_score, 4),
        "sentiment_confidence": round(confidence, 4),
        "ml_confidence": round(confidence, 4),
        "finbert_scores": {
            "bullish": round(bullish, 4),
            "bearish": round(bearish, 4),
            "neutral": round(neutral, 4),
        },
    }


def score_gossip(text: str, collection_name: str) -> dict:
    lower = text.lower()
    score = 0
    hits = []

    for term, weight, pattern in GOSSIP_PATTERNS:
        count = len(pattern.findall(lower))
        if count:
            score += weight * min(count, 3)
            hits.append(term)

    if "??" in text:
        score += 6
    if "!!" in text:
        score += 6
    if re.search(r"\bBREAKING\b", text):
        score += 8
    if len(CASHTAG_RE.findall(text)) >= 3:
        score += 8
    if collection_name == "socials":
        score += 4

    score = max(0, min(100, int(score)))

    if score >= 65:
        level = "high"
    elif score >= 30:
        level = "medium"
    elif score > 0:
        level = "low"
    else:
        level = "none"

    return {
        "gossip_score": score,
        "gossip_level": level,
        "gossip_keywords": sorted(set(hits))[:30],
    }


def build_query(force: bool, recent_minutes: int | None) -> dict:
    missing = {
        "$or": [
            {"sentiment_model_version": {"$ne": MODEL_VERSION}},
            {"gossip_model_version": {"$ne": MODEL_VERSION}},
            {"sentiment_score": {"$exists": False}},
            {"gossip_score": {"$exists": False}},
        ]
    }

    if not recent_minutes:
        return {} if force else missing

    since = int(time.time()) - recent_minutes * 60
    recent = {
        "$or": [
            {"fetched_at": {"$gte": since}},
            {"fetched_date": {"$gte": since}},
            {"detected_at": {"$gte": since}},
            {"timestamp": {"$gte": since}},
            {"created_at": {"$gte": since}},
            {"publish_date": {"$gte": since}},
        ]
    }

    return recent if force else {"$and": [recent, missing]}


def score_collection(db, name: str, limit: int, force: bool, recent_minutes: int | None):
    col = db[name]
    query = build_query(force, recent_minutes)

    projection = {
        "title": 1,
        "text": 1,
        "content": 1,
        "summary": 1,
        "description": 1,
        "fetched_at": 1,
        "fetched_date": 1,
        "detected_at": 1,
        "timestamp": 1,
        "created_at": 1,
        "publish_date": 1,
    }

    cursor = col.find(query, projection).sort([("_id", -1)])
    if limit and limit > 0:
        cursor = cursor.limit(limit)

    ops = []
    seen = 0
    labels = {"bullish": 0, "neutral": 0, "bearish": 0}
    gossip = {"none": 0, "low": 0, "medium": 0, "high": 0}
    now = int(time.time())

    for doc in cursor:
        text = doc_text(doc)
        sent = score_sentiment(text)
        gos = score_gossip(text, name)

        labels[sent["sentiment"]] += 1
        gossip[gos["gossip_level"]] += 1
        seen += 1

        update = {
            **sent,
            **gos,
            "sentiment_at": now,
            "scored_at": now,
            "sentiment_model_version": MODEL_VERSION,
            "gossip_model_version": MODEL_VERSION,
        }

        ops.append(UpdateOne({"_id": doc["_id"]}, {"$set": update}))

        if len(ops) >= 250:
            col.bulk_write(ops, ordered=False)
            ops = []

    if ops:
        col.bulk_write(ops, ordered=False)

    print({
        "collection": name,
        "seen": seen,
        "sentiment": labels,
        "gossip": gossip,
        "model": MODEL_VERSION,
    })


def run_once(args):
    uri = os.environ.get("MONGODB_URI") or os.environ.get("MONGO_URI") or "mongodb://localhost:27017/feedflash"
    db_name = os.environ.get("MONGO_DB", "feedflash")

    client = MongoClient(uri)
    db = client[db_name]

    for name in [x.strip() for x in args.collections.split(",") if x.strip()]:
        score_collection(db, name, args.limit, args.force, args.recent_minutes)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--collections", default="articles,socials")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--recent-minutes", type=int, default=None)
    ap.add_argument("--loop", action="store_true")
    ap.add_argument("--sleep-seconds", type=int, default=60)
    args = ap.parse_args()

    if args.loop:
        while True:
            print(f"\n===== FINBERT/GOSSIP SCORE RUN {time.strftime('%Y-%m-%d %H:%M:%S')} =====", flush=True)
            try:
                run_once(args)
            except Exception as e:
                print({"ok": False, "error": str(e)}, flush=True)
            time.sleep(max(10, args.sleep_seconds))
    else:
        run_once(args)


if __name__ == "__main__":
    main()
