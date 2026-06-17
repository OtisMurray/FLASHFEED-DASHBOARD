e do #!/bin/bash
# One-shot fix: normalize all social data into the format the backend expects
# Run this after fetching StockTwits/social data
# Fixes: 1) schema mismatch, 2) sentiment scoring, 3) rolling windows

cd "$(dirname "$0")/../.."

echo "=============================================="
echo "   SOCIAL PIPELINE FIX"
echo "=============================================="
echo ""

# Step 1: Force re-score sentiment on all social posts
echo "1. Normalizing social data..."
docker exec feedflash-backend python3 -c "
from pymongo import MongoClient
from datetime import datetime, timezone
import os, sys

client = MongoClient(os.getenv('MONGODB_URI', 'mongodb://localhost:27017/feedflash'))
db = client[os.getenv('MONGO_DB', 'feedflash')]

# Get all social posts that might have schema mismatches
social_posts = list(db['socials'].find())
print(f'Found {len(social_posts)} social posts to normalize')

now = datetime.now(timezone.utc)
fixed = 0

for post in social_posts:
    updates = {}
    
    # Fix: ticker field -> tickers_mentioned (what rolling_windows expects)
    ticker = post.get('ticker') or post.get('symbol')
    if ticker and not post.get('tickers_mentioned'):
        updates['tickers_mentioned'] = [ticker.upper()]
    
    # Fix: created_at -> published_at (what rolling_windows expects)
    if not post.get('published_at'):
        ts = post.get('created_at') or post.get('fetched_at') or int(now.timestamp())
        updates['published_at'] = ts
    
    # Fix: sentiment string -> sentiment_score (what rolling_windows expects)
    if post.get('sentiment_score') is None and post.get('sentiment'):
        s = post['sentiment'].lower() if isinstance(post['sentiment'], str) else ''
        if s == 'bullish':
            updates['sentiment_score'] = 0.5
        elif s == 'bearish':
            updates['sentiment_score'] = -0.5
        else:
            updates['sentiment_score'] = 0.0
        updates['is_duplicate'] = False
    
    # Fix: body -> text (what sentiment scorer expects)
    if not post.get('text') and post.get('body'):
        updates['text'] = post['body']
    
    if updates:
        db['socials'].update_one({'_id': post['_id']}, {'\$set': updates})
        fixed += 1

print(f'Fixed schema for {fixed} posts')

# Step 2: Also check the feedflash DB (some data may be there)
try:
    db2 = client['feedflash']
    posts2 = list(db2['socials'].find())
    print(f'feedflash.feedflash DB has {len(posts2)} posts')
    for post in posts2:
        updates = {}
        ticker = post.get('ticker') or post.get('symbol')
        if ticker and not post.get('tickers_mentioned'):
            updates['tickers_mentioned'] = [ticker.upper()]
        if not post.get('published_at'):
            ts = post.get('created_at') or post.get('fetched_at') or int(now.timestamp())
            updates['published_at'] = ts
        if post.get('sentiment_score') is None and post.get('sentiment'):
            s = post['sentiment'].lower().strip() if isinstance(post['sentiment'], str) else ''
            updates['sentiment_score'] = 0.5 if s in ('bullish','positive','up') else -0.5 if s in ('bearish','negative','down') else 0.0
            updates['is_duplicate'] = False
        if updates:
            db2['socials'].update_one({'_id': post['_id']}, {'\$set': updates})
except Exception as e:
    print(f'feedflash DB check: {e}')

print()
print('Checking final state...')
for coll_name in ['socials']:
    for db_name in ['ds440', 'feedflash']:
        try:
            coll = client[db_name][coll_name]
            total = coll.count_documents({})
            with_score = coll.count_documents({'sentiment_score': {'\$exists': True}})
            with_tickers = coll.count_documents({'tickers_mentioned': {'\$exists': True}})
            print(f'{db_name}.{coll_name}: {total} total, {with_score} with score, {with_tickers} with tickers')
        except:
            pass

client.close()
" 2>&1 | grep -v "^$"

# Step 2: Run rolling windows computation
echo ""
echo "2. Computing rolling windows..."
docker exec feedflash-backend python3 -c "
import sys, os
sys.path.insert(0, '.')
from datetime import datetime, timezone
from pymongo import MongoClient

client = MongoClient(os.getenv('MONGODB_URI', 'mongodb://localhost:27017/feedflash'))

# Try both DBs
for db_name in ['ds440', 'feedflash']:
    db = client[db_name]
    socials = db['socials']
    windows = db['rolling_windows']
    
    # Find all distinct tickers with sentiment scores
    tickers = socials.distinct('tickers_mentioned', {
        'tickers_mentioned': {'\$exists': True, '\$ne': []},
        'sentiment_score': {'\$exists': True},
        'published_at': {'\$exists': True},
    })
    
    print(f'{db_name}: Found {len(tickers)} tickers with scored posts')
    
    if not tickers:
        continue
    
    now = datetime.now(timezone.utc)
    from datetime import timedelta
    
    count = 0
    for ticker in tickers[:100]:  # Limit to 100 to avoid timeout
        for window_min in [1, 3, 5, 10, 15, 30, 60]:
            cutoff = now - timedelta(minutes=window_min)
            posts = list(socials.find({
                'tickers_mentioned': ticker,
                'sentiment_score': {'\$exists': True},
                'published_at': {'\$gte': int(cutoff.timestamp())},
            }))
            
            if not posts:
                continue
            
            scores = [p.get('sentiment_score', 0) for p in posts if p.get('sentiment_score') is not None]
            if not scores:
                continue
            
            avg = sum(scores) / len(scores)
            
            doc = {
                'ticker': ticker,
                'window_minutes': window_min,
                'avg_sentiment': round(avg, 4),
                'message_count': len(scores),
                'bullish_count': sum(1 for s in scores if s > 0.2),
                'bearish_count': sum(1 for s in scores if s < -0.2),
                'window_end': now,
                'computed_at': now,
            }
            
            windows.update_one(
                {'ticker': ticker, 'window_minutes': window_min},
                {'\$set': doc},
                upsert=True
            )
            count += 1
    
    print(f'{db_name}: Wrote {count} rolling windows')

client.close()
" 2>&1 | grep -v "^$"

# Step 3: Verify the screener picks up social data now
echo ""
echo "3. Verifying screener social data..."
docker exec feedflash-backend python3 -c "
from pymongo import MongoClient
import os

client = MongoClient(os.getenv('MONGODB_URI', 'mongodb://localhost:27017/feedflash'))

for db_name in ['ds440', 'feedflash']:
    db = client[db_name]
    windows = list(db['rolling_windows'].find({}).limit(20))
    if windows:
        print(f'{db_name} rolling_windows samples:')
        for w in windows[:5]:
            print(f'  {w[\"ticker\"]} ({w[\"window_minutes\"]}m): {w[\"message_count\"]} posts, sentiment={w[\"avg_sentiment\"]:.3f}')
    else:
        print(f'{db_name} rolling_windows: EMPTY')

client.close()
" 2>&1 | grep -v "^$"

echo ""
echo "=============================================="
echo "   SOCIAL PIPELINE FIX COMPLETE"
echo "=============================================="
echo "Refresh your browser to see changes"