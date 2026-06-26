#!/bin/zsh
set -e

cd "$(dirname "$0")/.."

source .venv/bin/activate

RSS_MAX_WORKERS="${RSS_MAX_WORKERS:-8}" \
MONGODB_URI="${MONGODB_URI:-mongodb://localhost:27017/feedflash}" \
python3 "1_News/pipeline/fetch_rss_to_mongo.py"
