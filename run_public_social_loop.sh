#!/usr/bin/env bash
cd ~/Desktop/"INTEGRATED STOCK PROJECT"/Project/Working_Code
source .venv/bin/activate

while true; do
  echo
  echo "===== PUBLIC SOCIAL COLLECTOR RUN $(date) ====="

  echo "--- Top momentum social collector (StockTwits, Reddit, Bluesky, X when token is set) ---"
  MONGO_URI="mongodb://localhost:27017/feedflash" \
  MONGODB_URI="mongodb://localhost:27017/feedflash" \
  SOCIAL_TICKER_SOURCE="momentum" \
  SOCIAL_MOMENTUM_LIMIT="${SOCIAL_MOMENTUM_LIMIT:-10}" \
  SOCIAL_MAX_TICKERS="${SOCIAL_MAX_TICKERS:-10}" \
  SOCIAL_MAX_WORKERS="${SOCIAL_MAX_WORKERS:-8}" \
  python 1_News/pipeline/fetch_social_to_mongo.py

  echo "===== 5m rolling social counts ====="
  curl -sS "http://localhost:3001/api/social/rolling/stats?window_minutes=5"
  echo

  sleep 60
done
