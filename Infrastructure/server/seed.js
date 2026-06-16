/**
 * seed.js — run once to populate MongoDB with mock data
 * Usage: npm run seed
 */
import 'dotenv/config'
import mongoose from 'mongoose'
import { connectDB } from './db.js'
import Article     from './models/Article.js'
import Screener    from './models/Screener.js'
import Social      from './models/Social.js'
import Correlation from './models/Correlation.js'
import Source      from './models/Source.js'
import Keyword     from './models/Keyword.js'

const NOW = Math.floor(Date.now() / 1000)

const ARTICLES = [
  { id:'seed-1',  title:'NVIDIA Reports Record Q1 Revenue as AI Chip Demand Surges 40%',            source:'Reuters',   category:'Earnings',  publish_date:NOW-900,   ticker:'NVDA',  company:'NVIDIA',      sentiment:'bullish', ml_confidence:0.94 },
  { id:'seed-2',  title:'Apple iPhone Sales Miss Estimates in China Amid Huawei Competition',        source:'Bloomberg', category:'Tech',       publish_date:NOW-1800,  ticker:'AAPL',  company:'Apple',       sentiment:'bearish', ml_confidence:0.87 },
  { id:'seed-3',  title:'Federal Reserve Signals Higher-For-Longer Approach to Rate Policy in 2025', source:'WSJ',       category:'Markets',    publish_date:NOW-2700,  ticker:null,    company:null,          sentiment:'neutral', ml_confidence:0.71 },
  { id:'seed-4',  title:'Tesla Q1 Deliveries Beat Wall Street Expectations Despite EV Slowdown',     source:'CNBC',      category:'Earnings',   publish_date:NOW-3600,  ticker:'TSLA',  company:'Tesla',       sentiment:'bullish', ml_confidence:0.91 },
  { id:'seed-5',  title:'Microsoft Azure Revenue Grows 35% on Accelerating AI Enterprise Adoption',  source:'Reuters',   category:'Tech',       publish_date:NOW-4500,  ticker:'MSFT',  company:'Microsoft',   sentiment:'bullish', ml_confidence:0.88 },
  { id:'seed-6',  title:'Meta Raises Revenue Outlook on Record Digital Ad Market Performance',       source:'FT',        category:'Earnings',   publish_date:NOW-5400,  ticker:'META',  company:'Meta',        sentiment:'bullish', ml_confidence:0.92 },
  { id:'seed-7',  title:'JPMorgan Warns of Commercial Real Estate Exposure as Office Defaults Rise', source:'Bloomberg', category:'Finance',    publish_date:NOW-6300,  ticker:'JPM',   company:'JPMorgan',    sentiment:'bearish', ml_confidence:0.83 },
  { id:'seed-8',  title:'Amazon Web Services Wins $10B Pentagon Cloud Contract Extension',          source:'WSJ',       category:'Tech',       publish_date:NOW-7200,  ticker:'AMZN',  company:'Amazon',      sentiment:'bullish', ml_confidence:0.89 },
  { id:'seed-9',  title:'Google Antitrust Trial: DOJ Seeks Chrome Spinoff as Structural Remedy',    source:'NYT',       category:'Markets',    publish_date:NOW-8100,  ticker:'GOOGL', company:'Alphabet',    sentiment:'bearish', ml_confidence:0.76 },
  { id:'seed-10', title:'Netflix Adds 9.3M Subscribers as Password Crackdown Continues Paying Off', source:'CNBC',      category:'Earnings',   publish_date:NOW-9000,  ticker:'NFLX',  company:'Netflix',     sentiment:'bullish', ml_confidence:0.90 },
  { id:'seed-11', title:'Oil Falls as OPEC+ Signals Possible Production Hike for Second Half 2025', source:'Reuters',   category:'Energy',     publish_date:NOW-10800, ticker:'XOM',   company:'ExxonMobil',  sentiment:'bearish', ml_confidence:0.78 },
  { id:'seed-12', title:'AMD Gains GPU Market Share with Strong New Enterprise Data Center Deals',   source:'FT',        category:'Tech',       publish_date:NOW-12600, ticker:'AMD',   company:'AMD',         sentiment:'bullish', ml_confidence:0.86 },
]

const SCREENER = [
  { ticker:'NVDA',  company:'NVIDIA',     structured_sentiment: 0.82, social_sentiment: 0.75, avg_sentiment: 0.79, message_count:1420, price:875.40, change_pct: 3.21, volume: 42800000, market_cap:2160e9, sector:'Technology', industry:'Semiconductors' },
  { ticker:'AAPL',  company:'Apple',      structured_sentiment:-0.31, social_sentiment:-0.24, avg_sentiment:-0.28, message_count:2100, price:178.50, change_pct:-1.45, volume: 68500000, market_cap:2750e9, sector:'Technology', industry:'Consumer Electronics' },
  { ticker:'TSLA',  company:'Tesla',      structured_sentiment: 0.54, social_sentiment: 0.48, avg_sentiment: 0.51, message_count:3840, price:245.20, change_pct: 2.87, volume:115200000, market_cap: 780e9, sector:'Consumer',   industry:'Auto' },
  { ticker:'MSFT',  company:'Microsoft',  structured_sentiment: 0.67, social_sentiment: 0.55, avg_sentiment: 0.61, message_count: 980, price:415.80, change_pct: 1.23, volume: 25600000, market_cap:3090e9, sector:'Technology', industry:'Software' },
  { ticker:'META',  company:'Meta',       structured_sentiment: 0.71, social_sentiment: 0.63, avg_sentiment: 0.67, message_count: 760, price:512.30, change_pct: 2.14, volume: 18900000, market_cap:1310e9, sector:'Technology', industry:'Social Media' },
  { ticker:'AMZN',  company:'Amazon',     structured_sentiment: 0.45, social_sentiment: 0.38, avg_sentiment: 0.42, message_count: 640, price:188.90, change_pct: 0.87, volume: 34200000, market_cap:1970e9, sector:'Consumer',   industry:'E-Commerce' },
  { ticker:'GOOGL', company:'Alphabet',   structured_sentiment:-0.42, social_sentiment:-0.38, avg_sentiment:-0.40, message_count: 890, price:162.40, change_pct:-1.89, volume: 29800000, market_cap:2010e9, sector:'Technology', industry:'Internet Services' },
  { ticker:'NFLX',  company:'Netflix',    structured_sentiment: 0.63, social_sentiment: 0.57, avg_sentiment: 0.60, message_count: 520, price:638.70, change_pct: 1.95, volume:  8700000, market_cap: 278e9, sector:'Media',      industry:'Streaming' },
  { ticker:'JPM',   company:'JPMorgan',   structured_sentiment:-0.28, social_sentiment:-0.15, avg_sentiment:-0.22, message_count: 340, price:198.20, change_pct:-0.62, volume: 12400000, market_cap: 574e9, sector:'Finance',    industry:'Banking' },
  { ticker:'AMD',   company:'AMD',        structured_sentiment: 0.58, social_sentiment: 0.64, avg_sentiment: 0.61, message_count:1160, price:168.90, change_pct: 2.44, volume: 55600000, market_cap: 273e9, sector:'Technology', industry:'Semiconductors' },
  { ticker:'XOM',   company:'ExxonMobil', structured_sentiment:-0.35, social_sentiment:-0.22, avg_sentiment:-0.29, message_count: 280, price:112.40, change_pct:-1.14, volume: 18200000, market_cap: 447e9, sector:'Energy',     industry:'Oil & Gas' },
  { ticker:'PYPL',  company:'PayPal',     structured_sentiment: 0.12, social_sentiment: 0.08, avg_sentiment: 0.10, message_count: 190, price: 62.80, change_pct: 0.32, volume: 14700000, market_cap:  66e9, sector:'Finance',    industry:'Fintech' },
]

const SOCIAL = [
  { post_id:'s1', platform:'reddit',     author:'WallStreetBets_Fan', content:'NVDA calls printing. AI demand not slowing. $900 EOW.', created_at:new Date(Date.now()-600000),  ticker:'NVDA',  sentiment: 0.82 },
  { post_id:'s2', platform:'twitter',    author:'@financetwitter',    content:'AAPL China sales disappointing third consecutive quarter. Bears right.', created_at:new Date(Date.now()-1200000), ticker:'AAPL', sentiment:-0.65 },
  { post_id:'s3', platform:'reddit',     author:'ValueInvestor_Pro',  content:'TSLA delivery beat massive. Shorts destroyed. $300 by summer.', created_at:new Date(Date.now()-2400000), ticker:'TSLA', sentiment: 0.74 },
  { post_id:'s4', platform:'stocktwits', author:'TradingAlgo99',      content:'$GOOGL antitrust risk is severely underpriced here.', created_at:new Date(Date.now()-3600000), ticker:'GOOGL', sentiment:-0.71 },
  { post_id:'s5', platform:'bluesky',    author:'macro_thoughts.bsky',content:'Fed higher for longer. Rate cuts unlikely before Q4. Go defensive.', created_at:new Date(Date.now()-4800000), ticker:null, sentiment:-0.25 },
  { post_id:'s6', platform:'twitter',    author:'@chipsector_alpha',  content:'AMD crushing enterprise GPU share. Both AMD and NVDA worth owning.', created_at:new Date(Date.now()-7200000), ticker:'AMD', sentiment: 0.68 },
  { post_id:'s7', platform:'stocktwits', author:'SwingTrade_Daily',   content:'$NFLX ad-supported tier total game changer. Legs to $700.', created_at:new Date(Date.now()-9000000), ticker:'NFLX', sentiment: 0.77 },
  { post_id:'s8', platform:'reddit',     author:'ETF_Watcher',        content:'META capex weighing on margins but ad business resilient. Neutral.', created_at:new Date(Date.now()-10800000), ticker:'META', sentiment: 0.15 },
]

const CORRELATIONS = [
  { ticker:'NVDA',  correlation: 0.87, p_value:0.001, sample_size:142 },
  { ticker:'TSLA',  correlation: 0.72, p_value:0.003, sample_size:318 },
  { ticker:'AMD',   correlation: 0.68, p_value:0.008, sample_size: 98 },
  { ticker:'META',  correlation: 0.61, p_value:0.012, sample_size: 87 },
  { ticker:'AAPL',  correlation:-0.54, p_value:0.018, sample_size:231 },
  { ticker:'GOOGL', correlation:-0.63, p_value:0.009, sample_size:104 },
  { ticker:'JPM',   correlation:-0.31, p_value:0.089, sample_size: 56 },
  { ticker:'XOM',   correlation:-0.45, p_value:0.034, sample_size: 72 },
]

const SOURCES = [
  'https://feeds.reuters.com/reuters/businessNews',
  'https://feeds.bloomberg.com/markets/news.rss',
  'https://feeds.wsj.com/wsj/xml/rss/3_7085.xml',
  'https://www.cnbc.com/id/10001147/device/rss/rss.html',
  'https://feeds.ft.com/rss/markets',
  'https://feeds.marketwatch.com/marketwatch/topstories/',
]

const KEYWORDS = [
  'earnings','revenue','profit','loss','guidance','outlook','beat','miss',
  'upgrade','downgrade','buyback','dividend','merger','acquisition',
  'IPO','layoffs','rate hike','rate cut','inflation','recession',
]

async function seed() {
  await connectDB()

  console.log('Clearing existing data...')
  await Promise.all([
    Article.deleteMany({}),
    Screener.deleteMany({}),
    Social.deleteMany({}),
    Correlation.deleteMany({}),
    Source.deleteMany({}),
    Keyword.deleteMany({}),
  ])

  console.log('Seeding articles...')
  await Article.insertMany(ARTICLES.map(a => ({
    article_id:   a.id,
    title:        a.title,
    source:       a.source,
    category:     a.category,
    publish_date: new Date(a.publish_date * 1000),
    ticker:       a.ticker,
    company:      a.company,
    sentiment:    a.sentiment,
    ml_confidence:a.ml_confidence,
    url:          '#',
  })))

  console.log('Seeding screener...')
  await Screener.insertMany(SCREENER.map(s => ({ ...s, updated_at: new Date() })))

  console.log('Seeding social posts...')
  await Social.insertMany(SOCIAL)

  console.log('Seeding correlations...')
  await Correlation.insertMany(CORRELATIONS.map(c => ({ ...c, updated_at: new Date() })))

  console.log('Seeding sources...')
  await Source.insertMany(SOURCES.map(url => ({ url, active: true })))

  console.log('Seeding keywords...')
  await Keyword.insertMany(KEYWORDS.map(word => ({ word })))

  console.log()
  console.log('  Seed complete!')
  console.log('  ──────────────────────────────')
  console.log('  Articles:     ' + ARTICLES.length)
  console.log('  Screener:     ' + SCREENER.length + ' tickers')
  console.log('  Social posts: ' + SOCIAL.length)
  console.log('  Correlations: ' + CORRELATIONS.length)
  console.log('  Sources:      ' + SOURCES.length)
  console.log('  Keywords:     ' + KEYWORDS.length)
  console.log()

  await mongoose.connection.close()
  process.exit(0)
}

seed().catch(err => {
  console.error('Seed failed:', err.message)
  process.exit(1)
})
