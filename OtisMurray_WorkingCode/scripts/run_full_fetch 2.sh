#!/bin/bash
# Full pipeline: Run everything once, collect from all sources
# Run this after start_flashfeed.sh

set -e
cd "$(dirname "$0")/.."

echo "⏰ $(date)"
echo "=============================================="
echo "   FLASHFEED - Full Data Pipeline"
echo "=============================================="
echo ""

# 1. Fetch Finviz top movers into screener
echo "📊 1. Fetching Finviz screener data..."
docker exec feedflash-backend python3 2_Screener/pipeline/fetch_finviz_elite_to_mongo.py 2>&1 | tail -1

# 2. Fetch RSS news articles
echo "📰 2. Fetching RSS news articles..."
cd 1_News/pipeline && python3 fetch_rss_to_mongo.py 2>&1 | tail -1 && cd ../..

# 3. Fetch StockTwits social data for top movers
echo "🐦 3. Scraping StockTwits..."
docker exec feedflash-backend python3 -c "
import sys, json
sys.path.insert(0, '3_Social')
from scrapers.stocktwits import scrape_tickers
from pymongo import MongoClient
import os

client = MongoClient(os.getenv('MONGODB_URI', 'mongodb://localhost:27017/feedflash'))
db = client[os.getenv('MONGO_DB', 'feedflash')]

# Get top 50 movers with price data
movers = list(db['screeners'].find(
    {'price': {'\$ne': None}, 'change_pct': {'\$exists': True}},
    {'ticker': 1}
).sort('change_pct', -1).limit(50))

tickers = [m['ticker'] for m in movers if m.get('ticker')]
print(f'Top movers: {len(tickers)}')

# Scrape StockTwits — now returns posts with tickers_mentioned + sentiment_score
posts = scrape_tickers(tickers[:25])  # 25 to avoid rate limits
print(f'Got {len(posts)} StockTwits posts')

# Save directly — they're already in the correct schema
if posts:
    for p in posts:
        db['socials'].update_one(
            {'id': p['id']},
            {'\$set': p},
            upsert=True
        )
    print(f'Saved {len(posts)} posts')

client.close()
" 2>&1 | grep -v "^$"

# 5. Update rolling windows
echo "📈 5. Updating rolling windows..."
docker exec feedflash-backend python3 -c "
from pymongo import MongoClient
import os
client = MongoClient(os.getenv('MONGODB_URI', 'mongodb://localhost:27017/feedflash'))
db = client[os.getenv('MONGO_DB', 'feedflash')]

# Aggregate social stats per ticker for the last 60 minutes
from datetime import datetime, timedelta, timezone
cutoff = datetime.now(timezone.utc) - timedelta(hours=24)

# Get article stats
article_stats = list(db['articles'].aggregate([
    {'\$match': {'ticker': {'\$exists': True, '\$ne': ''}}},
    {'\$group': {
        '_id': '\$ticker',
        'article_count': {'\$sum': 1},
        'bullish': {'\$sum': {'\$cond': [{'\$eq': ['\$sentiment', 'bullish']}, 1, 0]}},
        'bearish': {'\$sum': {'\$cond': [{'\$eq': ['\$sentiment', 'bearish']}, 1, 0]}},
        'latest': {'\$max': '\$fetched_date'}
    }}
]))

# Get social stats  
social_stats = list(db['socials'].aggregate([
    {'\$match': {'fetched_at': {'\$gte': int(cutoff.timestamp())}}},
    {'\$group': {
        '_id': '\$ticker',
        'message_count': {'\$sum': 1},
        'social_bullish': {'\$sum': {'\$cond': [{'\$eq': ['\$sentiment', 'bullish']}, 1, 0]}},
        'social_bearish': {'\$sum': {'\$cond': [{'\$eq': ['\$sentiment', 'bearish']}, 1, 0]}},
        'latest_post': {'\$max': '\$fetched_at'},
        'platforms': {'\$addToSet': '\$platform'},
    }}
]))

# Log results
print(f'Article stats: {len(article_stats)} tickers')
print(f'Social stats: {len(social_stats)} tickers')
print(f'Total articles with tickers: {sum(a[\"article_count\"] for a in article_stats)}')

# Check if sentiment scored
sentiment_count = sum(1 for a in article_stats if a.get('bullish', 0) > 0 or a.get('bearish', 0) > 0)
print(f'Tickers with non-neutral sentiment: {sentiment_count}')

client.close()
" 2>&1 | grep -v "^$"

echo ""
echo "✅ Pipeline complete!"
echo "=============================================="
echo "  Refresh your browser to see new data"
echo "=============================================="