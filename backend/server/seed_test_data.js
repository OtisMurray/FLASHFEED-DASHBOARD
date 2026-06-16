import 'dotenv/config'
import mongoose from 'mongoose'

import Article from './models/Article.js'
import Screener from './models/Screener.js'
import Social from './models/Social.js'

const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/feedflash'

await mongoose.connect(uri)

console.log('Connected to MongoDB')

const now = new Date()

await Article.deleteMany({})
await Screener.deleteMany({})
await Social.deleteMany({})

await Article.insertMany([
  {
    article_id: 'news-1',
    title: 'NVIDIA shares rise after strong AI chip demand outlook',
    source: 'Reuters',
    category: 'Earnings',
    publish_date: new Date(now.getTime() - 1000 * 60 * 15),
    ticker: 'NVDA',
    company: 'NVIDIA',
    sentiment: 'bullish',
    ml_confidence: 0.91,
    url: '#',
  },
  {
    article_id: 'news-2',
    title: 'Tesla falls after analysts question delivery growth',
    source: 'MarketWatch',
    category: 'Analyst',
    publish_date: new Date(now.getTime() - 1000 * 60 * 45),
    ticker: 'TSLA',
    company: 'Tesla',
    sentiment: 'bearish',
    ml_confidence: 0.84,
    url: '#',
  },
  {
    article_id: 'news-3',
    title: 'Apple announces new partnership focused on on-device AI',
    source: 'CNBC',
    category: 'Partnership',
    publish_date: new Date(now.getTime() - 1000 * 60 * 90),
    ticker: 'AAPL',
    company: 'Apple',
    sentiment: 'bullish',
    ml_confidence: 0.88,
    url: '#',
  },
])

await Screener.insertMany([
  {
    ticker: 'NVDA',
    company: 'NVIDIA',
    sector: 'Technology',
    price: 125.42,
    change_percent: 3.2,
    volume: 42000000,
    market_cap: 3100000000000,
    social_sentiment: 0.72,
    news_sentiment: 0.81,
    signal_score: 92,
  },
  {
    ticker: 'TSLA',
    company: 'Tesla',
    sector: 'Consumer Cyclical',
    price: 184.55,
    change_percent: -2.4,
    volume: 68000000,
    market_cap: 590000000000,
    social_sentiment: -0.31,
    news_sentiment: -0.42,
    signal_score: 48,
  },
  {
    ticker: 'AAPL',
    company: 'Apple',
    sector: 'Technology',
    price: 214.11,
    change_percent: 1.1,
    volume: 35000000,
    market_cap: 3300000000000,
    social_sentiment: 0.44,
    news_sentiment: 0.58,
    signal_score: 76,
  },
])

await Social.insertMany([
  {
    platform: 'reddit',
    ticker: 'NVDA',
    author: 'sample_user_1',
    text: 'NVDA momentum looks strong after the latest AI news.',
    sentiment: 'bullish',
    sentiment_score: 0.77,
    created_at: new Date(now.getTime() - 1000 * 60 * 10),
    url: '#',
  },
  {
    platform: 'stocktwits',
    ticker: 'TSLA',
    author: 'sample_user_2',
    text: 'TSLA sentiment is mixed today after delivery concerns.',
    sentiment: 'bearish',
    sentiment_score: -0.38,
    created_at: new Date(now.getTime() - 1000 * 60 * 20),
    url: '#',
  },
  {
    platform: 'reddit',
    ticker: 'AAPL',
    author: 'sample_user_3',
    text: 'AAPL AI partnership could be a strong catalyst.',
    sentiment: 'bullish',
    sentiment_score: 0.61,
    created_at: new Date(now.getTime() - 1000 * 60 * 30),
    url: '#',
  },
])

console.log('Seed data inserted successfully')

await mongoose.disconnect()
