# CLEANED + ALIGNED VERSION FOR DASHBOARD COMPATIBILITY

import argparse
import csv
import time
import random
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from curl_cffi import requests
from pymongo import MongoClient, ASCENDING, DESCENDING

ET = ZoneInfo("America/New_York")

# =========================
# TIME
# =========================
def build_start_utc_today_6am():
    now_et = datetime.now(ET)
    start_et = now_et.replace(hour=6, minute=0, second=0, microsecond=0)
    return start_et.astimezone(timezone.utc)

def parse_stocktwits_time(created_at):
    try:
        return datetime.fromisoformat(created_at.replace("Z", "+00:00")).astimezone(timezone.utc)
    except:
        return None

def utc_now_iso():
    return datetime.now(timezone.utc).isoformat()

# =========================
# FINVIZ
# =========================
def read_finviz_tickers(csv_path):
    tickers = []
    with open(csv_path, "r", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for row in reader:
            t = (row.get("Ticker") or "").strip().upper()
            if t:
                tickers.append(t)

    return list(set(tickers))

# =========================
# FETCH
# =========================
def get_symbol_stream(symbol, since_id=None):
    url = f"https://api.stocktwits.com/api/2/streams/symbol/{symbol}.json"
    params = {"limit": 50}

    if since_id:
        params["since"] = since_id

    try:
        r = requests.get(url, params=params, impersonate="chrome", timeout=20)

        if r.status_code == 200:
            return r.json()

        if r.status_code == 404:
            return {"_status": 404}

        return None

    except:
        return None

# =========================
# NORMALIZE (IMPORTANT FIX)
# =========================
def normalize(msg, symbol):
    created = parse_stocktwits_time(msg.get("created_at"))

    if not created:
        return None

    # Sentiment tag ("Bullish"/"Bearish") — required by mongo_rt.py aggregations
    sentiment = ((msg.get("entities") or {}).get("sentiment") or {}).get("basic")

    return {
        "id": msg["id"],
        "stream_symbol": symbol,
        "author": msg.get("user", {}).get("username", ""),

        "created_at": msg.get("created_at"),
        "created_at_dt": created,

        "post": msg.get("body", ""),
        "sentiment": sentiment,

        # CRITICAL FIXES (for dashboard filters)
        "is_low_quality": False,
        "is_spam": False,
        "is_duplicate_exact": False,

        "source_type": "Rumor/Social",
        "rumor_flag": False,

        "scraped_at_utc": utc_now_iso()
    }

# =========================
# MAIN
# =========================
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--finviz_csv", required=True)
    parser.add_argument("--once", action="store_true",
                        help="Run a single scrape cycle and exit (for schedulers)")
    args = parser.parse_args()

    client = MongoClient("mongodb://localhost:27017/")
    db = client["stocktwits"]
    col = db["messages"]
    state = db["state"]

    col.create_index([("id", ASCENDING)], unique=True)
    col.create_index([("stream_symbol", ASCENDING), ("created_at_dt", DESCENDING)])

    tickers = read_finviz_tickers(args.finviz_csv)

    print(f"Loaded {len(tickers)} tickers")

    while True:
        start_utc = build_start_utc_today_6am()

        for t in tickers:
            doc = state.find_one({"_id": t}) or {}
            since_id = doc.get("last_id")

            data = get_symbol_stream(t, since_id)

            if isinstance(data, dict) and data.get("_status") == 404:
                continue

            if not data:
                continue

            msgs = data.get("messages", [])

            new_docs = []

            for m in msgs:
                d = normalize(m, t)

                if not d:
                    continue

                if d["created_at_dt"] < start_utc:
                    continue

                new_docs.append(d)

            if new_docs:
                try:
                    col.insert_many(new_docs, ordered=False)
                except:
                    pass

                last_id = max(d["id"] for d in new_docs)

                state.update_one(
                    {"_id": t},
                    {"$set": {"last_id": last_id}},
                    upsert=True
                )

                print(f"{t}: inserted {len(new_docs)}")

            time.sleep(random.uniform(0.8, 1.5))

        print("Cycle complete.")
        if args.once:
            break
        print("Sleeping...\n")
        time.sleep(120)

if __name__ == "__main__":
    main()