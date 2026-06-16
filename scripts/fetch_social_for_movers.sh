#!/bin/bash
# Fetch Finviz top movers, then scrape StockTwits for those tickers
# This focuses social collection on tickers that are actually moving

set -e

echo "📊 Fetching Finviz top movers..."
cd Infrastructure/server

# Fetch top movers from Finviz
node -e "
const mongoose = require('mongoose');
async function getMovers() {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/feedflash');
  const tickers = await mongoose.connection.db.collection('screeners')
    .find({ price: { \$ne: null }, change_pct: { \$exists: true } })
    .sort({ change_pct: -1 })
    .limit(50)
    .toArray()
    .then(rows => rows.map(r => r.ticker));
  console.log(tickers.join(','));
  await mongoose.disconnect();
}
getMovers().catch(console.error);
" | tr ',' '\n' | head -50 > /tmp/top_movers.txt

echo "✓ Found $(wc -l < /tmp/top_movers.txt) top movers"

echo "🐦 Scraping StockTwits for top movers..."
cd ../../3_Social

# Scrape StockTwits for those tickers
python3 -c "
import sys
sys.path.insert(0, '.')
from scrapers.stocktwits import scrape_tickers
from scrapers.db import get_client, get_collection, upsert_posts

with open('/tmp/top_movers.txt') as f:
    tickers = [line.strip() for line in f if line.strip()]

if not tickers:
    print('No tickers found, exiting')
    sys.exit(0)

print(f'Scraping StockTwits for {len(tickers)} tickers...')
posts = scrape_tickers(tickers[:30])  # Limit to 30 to avoid rate limits
print(f'Got {len(posts)} posts')

if posts:
    client = get_client()
    db = client['ds440']
    result = upsert_posts(db, posts)
    print(f'Upserted: {result}')
    client.close()
"

echo "✅ Social fetch complete!"
echo "   Check the Social page to see posts for top movers"