# FlashFeed — Full Technical Breakdown for SOP

## Overview

FlashFeed is a **real-time stock market intelligence dashboard** that aggregates financial news, social media sentiment, technical indicators, and momentum signals into a single unified platform. Think of it as a customizable Bloomberg Terminal for retail investors — ingesting data from 30+ sources across news wires, social platforms, and market data providers, running it through ML-based sentiment analysis, and presenting actionable insights through an interactive React frontend.

---

## 1. What It Does (Core Functionality)

### Real-Time Data Aggregation
- **News Pipeline**: Continuously fetches from PR Newswire, GlobeNewswire, BusinessWire, Benzinga, TradingView, and unstructured web sources via RSS feeds
- **Social Media Pipeline**: Collects posts from StockTwits, Reddit, Bluesky, and Twitter — filtering for stock ticker mentions and financial discussion
- **Screener Pipeline**: Pulls fundamental/technical data from Finviz Elite, TradingView, and Charles Schwab — covering 8,000+ US equities
- **Price Data**: Live quotes via CNBC's API, cached at 60s intervals with automatic 5-min backoff on failure

### Machine Learning & Sentiment Analysis
- **FinBERT Sentiment**: Fine-tuned BERT model for financial text classification (bullish/bearish/neutral)
- **VADER Sentiment**: Rule-based sentiment as a lightweight fallback
- **Rule-Based Engine (DS440)**: Fast heuristic sentiment scoring for high-throughput batch processing
- **Ticker Extraction**: Named Entity Recognition (NER) to identify stock symbols from unstructured text
- **AI Catalyst Scoring**: Multi-factor ranking scoring news articles by relevance, sentiment conviction, and source credibility

### Technical Analysis
- **Candlestick Charts**: Interactive OHLC charts via TradingView's lightweight-charts library
- **Bollinger Bands (20,2)**: Volatility-based price envelopes
- **RSI (14)**: Wilder's Relative Strength Index — overbought/oversold detection
- **MACD (12,26,9)**: Moving Average Convergence Divergence — trend following
- **Client-Side Resampling**: 1-minute intraday bars re-aggregated into 5m/15m/30m/1h buckets instantly in-browser
- **Social Overlays**: Message density and sentiment plotted directly on the price chart with independent axis scales

### Academic Research Views
Three specialized research visualizations developed in collaboration with high school researchers:
1. **Price + Density**: Stock price overlaid with social media message volume — reveals correlation between chatter and price movement
2. **Sentiment Score**: Rolling sentiment score from social platforms with 15-min smoothed average — detects shifts in retail investor mood
3. **Density vs Sentiment**: Dual-axis chart comparing message volume against sentiment — identifies divergence signals (high volume + negative sentiment = potential sell-off)

### Momentum Detection
- **Trade Watch**: Multi-factor scoring combining price momentum, social volume, news sentiment, and technical patterns
- **Bracket Order Recommendations**: ML-based entry/exit suggestions with stop-loss and take-profit levels
- **Live Intraday Signals**: Real-time scanning for unusual volume, social spikes, and breaking news catalysts

---

## 2. How It's Built (Technical Architecture)

### Frontend
```
React 18 + TypeScript + Vite
├── React Router v6 (7 pages + routing)
├── lightweight-charts (TradingView — candlestick, RSI, MACD)
├── Chart.js (Research views — price/density, sentiment)
├── SWR (data fetching + caching + auto-refresh)
├── Tailwind CSS (dark theme UI)
├── clsx (conditional class utilities)
└── Recharts (momentum sparklines)
```

### Backend
```
Dual-stack: Express.js + Hono (TypeScript)
├── REST API at localhost:3001
├── MongoDB (primary store for articles, social posts, screeners)
├── Redis (fast caching layer — 60s TTL for quotes, 300s for failures)
├── Kafka (event streaming — real-time pipeline processing)
├── SQLite (lightweight cache for AI reports)
└── Python microservice (sentiment analysis on port 5001)
```

### Infrastructure
```
Docker Compose
├── mongo (MongoDB 7)
├── redis (Redis 7)
├── zookeeper + kafka (event streaming)
├── kafka-init + kafka-consumer (pipeline workers)
├── backend (Express/Hono API server)
└── sentiment_service (Python FinBERT)
```

### Data Pipeline
```
RSS Workers → Kafka → Sentiment Engine → MongoDB → Redis → Frontend
                                ↓
Social Scrapers → Kafka → Dedup Filter → MongoDB → Redis → Frontend
                                ↓
Screener Workers → Kafka → Enricher → MongoDB → Redis → Frontend
```

---

## 3. Key Technical Intricacies & Design Decisions

### Caching Strategy
- **Price quotes**: 60-second TTL. If Yahoo/CNBC fails, back off for 5 minutes — prevents hammering external APIs during outages
- **Screener data**: 45-second cache. Refreshed on demand via SWR's `refreshInterval`
- **Social data**: Lazy-loaded with polling. When a chart is opened, the server walks backward through social history (1.5s polling) until it accumulates enough data for meaningful overlays
- **Browser cache**: Social series are cached per (ticker, date) key so timeframe changes and overlay toggles never re-fetch

### Client-Side Computation
The server serves only 1-minute intraday bars. All higher timeframes (5m, 15m, 30m, 1h) are computed client-side:
- OHLC resampling (open/first, high/max, low/min, close/last)
- Bollinger band recomputation (SMA ± 2σ on resampled closes)
- RSI recomputation (Wilder's smoothing on resampled closes)
- MACD recomputation (EMA chain on resampled closes)
- Density overlay alignment (time-bucket averaging to match candle x-axis)

This means timeframe changes are instant — zero server round-trip.

### Sentiment Pipeline Architecture
- **Fast path**: Rule-based keyword scoring (DS440 engine) — processes 500 articles in under 30 seconds
- **Accurate path**: FinBERT deep learning — 120 seconds for 30 articles but with higher accuracy
- **Results** are written back to the database as (sentiment_label, confidence_score, timestamp) so subsequent reads are instant
- **Aggregation**: For per-asset analysis, individual article sentiments are combined via majority vote with average confidence weighting

### Charts Grid Performance
- Only the visible page of 12 charts is rendered in the DOM
- Chart images served via a dedicated backend endpoint with cache-busting nonce
- Automatic pagination with URL-preserved state (bookmarkable)
- Mirrors the Screener's filter/sort state via shared URL parameters

### Ticker Enrichment System
When a user views any chart, the backend simultaneously queries:
1. **News DB**: 3-day article history with sentiment scores
2. **Social DB**: Stocktwits/Bluesky/Reddit metrics (sentiment, density, bull/bear counts)
3. **AI Cache**: Pre-computed catalyst summaries from the momentum engine
4. **Rumor DB**: Detected unconfirmed news from social sources

All queries are parallelized and the results stream in as they arrive.

---

## 4. ML/AI Components (Directly Relevant to Data Science)

### 1. FinBERT Sentiment Classification
- **Model**: `ProsusAI/finbert` — BERT fine-tuned on financial news
- **Input**: Article title + content
- **Output**: `bullish | bearish | neutral` + confidence score (0-1)
- **Thresholding**: Confidence < 0.5 → marked as 'neutral' regardless of prediction

### 2. VADER Sentiment
- **Library**: `vaderSentiment`
- **Input**: Social media posts, short-form content
- **Output**: Compound score (-1 to +1), mapped to bullish/bearish/neutral
- **Use case**: High-throughput social media analysis where BERT would be too slow

### 3. Rule-Based Engine (DS440)
- **Method**: Keyword lexicon + pattern matching
- **Input**: Article title
- **Output**: Same format as FinBERT but without GPU requirements
- **Use case**: Quick initial pass before ML refinement; fallback when ML service is down

### 4. Ticker Extraction (NER)
- **Method**: Regex-based symbol matching against a curated ticker map (10,000+ symbols)
- **Fallback**: Company name → ticker resolution via fuzzy string matching
- **Output**: Array of ticker symbols found in text

### 5. AI Catalyst Scoring
- **Multi-factor ranking**: 
  - Sentiment strength (FinBERT confidence)
  - Source credibility (weighted by historical accuracy)
  - Recency (exponential time decay)
  - Social amplification (message volume multiplier)
- **Output**: Top-k articles with (catalyst text, direction, conviction score /10)

---

## 5. What It Will Do (Planned Features)

### Alert System
- Configurable triggers: price thresholds, sentiment shifts, volume spikes
- Real-time notifications via WebSocket
- Historical backtest of alert performance

### Correlation Engine
- Pearson correlation between sentiment and price movement
- Configurable lookback windows (1h, 1d, 3d, 1wk)
- Statistical significance testing (p-values)

### Prediction Models
- Short-term price direction prediction (5-min horizon)
- Feature engineering from social density, sentiment velocity, and technical indicators
- Bracket order confidence scoring

### Multi-Agent AI Sentiment
- Ensemble of specialized models per asset class
- Cross-validation between news, social, and technical signals
- Disagreement detection (model divergence as a signal itself)

---

## 6. Data Flow Summary

```
External APIs → Kafka Workers → Sentiment Pipeline → MongoDB
                                                         ↓
User opens app → React fetches via REST → Express resolves from MongoDB/Redis
                                                     ↓
Chart renders with lightweight-charts ← client-side resampling ← 1-min bars
                                                     ↓
User toggles overlays → cached social data overlaid on chart (no server call)
                                                     ↓
TickerEnrichPanels load in parallel → 4 simultaneous DB queries → social+news UI
```

## 7. Scale & Performance

- **Articles processed**: 10,000+ per day from 15+ news sources
- **Social posts**: 50,000+ per day across 4 platforms
- **Ticker coverage**: 8,000+ US equities in screener universe
- **API response times**: Most endpoints under 50ms (Redis cache hit) or 200ms (MongoDB)
- **Chart render**: Sub-100ms after initial data load (client-side resampling)
- **Research chart polling**: 1.5s intervals until social history is complete (~15-30 seconds typical)