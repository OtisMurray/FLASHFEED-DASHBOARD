# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

DS440 capstone project: **Unstructured News Social Sentiment Pipeline & Dashboard**. Scrapes Reddit and Bluesky for stock-related posts, computes rolling sentiment scores and message density, and displays results in a Finviz-style screener dashboard with 3 extra columns (structured news sentiment, unstructured sentiment score, message density).

## Tech Stack

- **Scrapers (Python):** Reddit via `curl_cffi` (curl-impersonate), Bluesky via `atproto` SDK
- **Processing (Python):** Ticker extraction, dedup/spam filtering, sentiment scoring, rolling window calculation
- **Dashboard (Next.js + TypeScript):** Screener table, ticker detail charts, config panel
- **Backend APIs:** TypeScript
- **Databases:** MongoDB (raw posts), PostgreSQL (time-series scores), Redis (rolling window cache, active ticker list)

## Architecture

```
GitHub Actions (cron every 15 min)
├── Scrapers (Python)  → MongoDB (raw posts)
├── Processing Pipeline (Python)
│   ├── D3-D5: ticker extraction, dedup, sentiment
│   ├── D6: rolling windows → MongoDB + Redis + PostgreSQL
│   └── yfinance enricher → MongoDB finviz_screener
└── Dashboard (Vercel / Next.js) reads from Redis, PostgreSQL, MongoDB
```

**Data flow:** GitHub Actions triggers scrapers (Reddit + Bluesky) → posts stored in MongoDB → processing pipeline extracts tickers, deduplicates, scores sentiment, computes rolling windows → results synced to Redis (fast reads) and PostgreSQL (persistence) → yfinance enriches active tickers with live stock data → Vercel dashboard reads from all three databases and auto-refreshes.

## Key Technical Decisions

- **curl_cffi with `impersonate="chrome124"`** is required for Reddit scraping — standard Python requests get blocked by TLS fingerprinting. Always use `old.reddit.com` (less aggressive anti-bot). Sequential requests only, 4-5s delay between subreddits, no parallelism from same IP.
- **Reddit JSON endpoints:** `https://old.reddit.com/r/{subreddit}/new.json?limit=100&raw_json=1` — no API key needed. Pagination via `after` token.
- **Bluesky:** Free AT Protocol API, 3000 requests per 5 minutes. Uses `app.bsky.feed.search_posts` for cashtag searches.
- **Rolling windows:** 1m, 3m, 5m, 10m, 15m, 30m, 1hr. Window rolls forward by 1 minute, recomputed every 60 seconds.
- **Sentiment scoring:** Two-layer approach — rule-based for known financial slang (diamond hands, to the moon, rocket emoji, etc.) + LLM for ambiguous posts. Score range: -1.0 (bearish) to +1.0 (bullish).
- **Near-duplicate detection:** Same author + >80% text similarity = flagged as spam.

## Shared Post Schema (All Sources)

All posts normalized to: `id`, `source`, `subreddit`, `author`, `title`, `text`, `url`, `score`, `num_comments`, `published_at`, `detected_at`, `content_hash`. Processing pipeline appends: `tickers_mentioned`, `sentiment_score`, `is_duplicate`, `is_spam`.

## Deliverables Reference

D1: Reddit scraper | D2: Bluesky scraper | D3: Ticker extraction | D4: Dedup/spam filter | D5: Sentiment engine | D6: Rolling window calc | D7: Finviz CSV ingestion | D8: Screener table | D9: Ticker detail view | D10: Config panel | D11: Redis integration | D12: End-to-end integration

**All deliverables complete.** Dashboard live at https://dashboard-seven-mauve-17.vercel.app

## Deployment

- **Dashboard:** Vercel (Next.js 16, auto-deploys from `dashboard/` directory)
- **Pipeline:** GitHub Actions cron every 15 min (`.github/workflows/pipeline.yml`)
- **Stock data:** yfinance enricher (`processing/yfinance_enricher.py`) auto-fetches prices for discovered tickers
- **Entry point:** `python scripts/run_pipeline.py --once --scrape` (used by CI)

## Target Subreddits (24)

wallstreetbets, wallstreetbets2, wallstreetbets_wins, wallstreetbetsELITE, wallstreetbetsnew, wallstreetelite, wallstreetsmallcap, smallstreetbets, thewallstreet, pennystocks, pennystock, 10xpennystocks, stockmarket, stocks, stocks_picks, stocksandtrading, stockstobuytoday, stocktradingalerts, swingtrading, trading, trakstocks, shortsqueeze, stockaday, options
