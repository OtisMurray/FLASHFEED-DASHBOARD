#!/usr/bin/env bash
set -e

cd ~/Desktop/"INTEGRATED STOCK PROJECT"/Project/Working_Code

source .venv/bin/activate

echo "Running Reddit finance-only RSS collector..."
MONGODB_URI="mongodb://localhost:27017/feedflash" \
REDDIT_MAX_POSTS_PER_SUBREDDIT="${REDDIT_MAX_POSTS_PER_SUBREDDIT:-15}" \
python3 "5_Social/pipeline/fetch_reddit_finance_rss_to_mongo.py"

echo "Running Bluesky public search collector..."
MONGODB_URI="mongodb://localhost:27017/feedflash" \
BLUESKY_MAX_PER_QUERY="${BLUESKY_MAX_PER_QUERY:-20}" \
python3 "5_Social/pipeline/fetch_bluesky_public_to_mongo.py"

echo "Running StockTwits public symbol stream collector..."
MONGODB_URI="mongodb://localhost:27017/feedflash" \
SOCIAL_TICKERS_FILE="${SOCIAL_TICKERS_FILE:-config/social_tickers_100.txt}" \
STOCKTWITS_MAX_SYMBOLS="${STOCKTWITS_MAX_SYMBOLS:-100}" \
python3 "5_Social/pipeline/fetch_stocktwits_public_to_mongo.py"

echo "Social collectors complete."
echo "Working: Reddit, Bluesky, StockTwits."
echo "X/Twitter still requires official X API Bearer Token."
