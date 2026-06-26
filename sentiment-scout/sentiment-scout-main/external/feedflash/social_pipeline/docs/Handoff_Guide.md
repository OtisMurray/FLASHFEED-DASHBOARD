# Dashboard Handoff Guide (D8-D10)

This document is for the developer (or AI agent) building the Next.js dashboard for the DS440 capstone project. Everything you need to connect to the existing backend and build D8, D9, and D10 is here.

---

## 1. Project Context

**DS440 Capstone: Unstructured News Social Sentiment Pipeline & Dashboard**

The system scrapes Reddit (24 subreddits) and Bluesky (25 cashtag searches) for stock-related posts, scores sentiment, computes rolling aggregates, and displays results in a Finviz-style screener dashboard with three extra columns: structured news sentiment (from Finviz analyst ratings), unstructured social sentiment score, and message density.

**What is done:**
- D1: Reddit scraper (curl_cffi, 24 subreddits)
- D2: Bluesky scraper (AT Protocol, 25 cashtag queries)
- D3: Ticker extraction engine
- D4: Dedup/spam filter (>80% text similarity detection)
- D5: Sentiment scoring engine (rule-based + LLM, range -1.0 to +1.0)
- D6: Rolling window calculator (1m, 3m, 5m, 10m, 15m, 30m, 60m windows)
- D7: Finviz CSV ingestion (price, market cap, P/E, analyst ratings)
- D11: Redis + PostgreSQL integration (cache layer + persistence)

**What needs to be built:**
- **D8:** Screener table (Next.js 14 + TypeScript + shadcn/ui + Tailwind)
- **D9:** Ticker detail view (historical charts, recent posts)
- **D10:** Config panel (data source toggles, settings in localStorage)
- **D12:** End-to-end integration verification

The entire Python backend is complete and running. The dashboard just needs to read from the databases.

---

## 2. Architecture Overview

```
 ┌─────────────────────────┐
 │   D1: Reddit Scraper    │
 │   (24 subreddits)       ├──┐
 └─────────────────────────┘  │
                               ▼
 ┌─────────────────────────┐  ┌──────────────────────────┐
 │   D2: Bluesky Scraper   ├─▶│  MongoDB Atlas            │
 │   (25 cashtag queries)  │  │  db: ds440                │
 └─────────────────────────┘  │  ├─ posts (~4,272 docs)   │
                               │  ├─ rolling_windows       │
 ┌─────────────────────────┐  │  └─ finviz_screener       │
 │   D7: Finviz Ingest     ├─▶│     (10 tickers)          │
 └─────────────────────────┘  └──────────┬───────────────┘
                                          │
                               ┌──────────▼───────────────┐
                               │  Processing Pipeline      │
                               │  D3 → D4 → D5 → D6       │
                               │  (runs every 60 seconds)  │
                               └──────────┬───────────────┘
                                          │
                          ┌───────────────┼───────────────┐
                          ▼                               ▼
               ┌─────────────────────┐        ┌─────────────────────┐
               │  Redis (Upstash)    │        │  PostgreSQL (Neon)  │
               │  - active_tickers   │        │  - window_history   │
               │  - window:{t}:{m}   │        │    (append-only)    │
               │  - pipeline:last_sync│        │                     │
               └─────────┬───────────┘        └─────────┬───────────┘
                         │                              │
                         ▼                              ▼
               ┌──────────────────────────────────────────────────┐
               │            Next.js Dashboard (D8-D10)            │
               │  D8: Screener table ← Redis + MongoDB (Finviz)  │
               │  D9: Ticker detail  ← PostgreSQL + MongoDB       │
               │  D10: Config panel  ← localStorage               │
               └──────────────────────────────────────────────────┘
```

**Data refresh cycle:** The Python pipeline recomputes rolling windows every 60 seconds. Each cycle reads new posts from MongoDB, recomputes all 7 window sizes for every active ticker, then pushes results to both Redis (overwrites current values) and PostgreSQL (appends new rows). The dashboard should poll on the same 60-second cadence.

---

## 3. Data Access Patterns

### 3.1 Redis (Upstash) -- Screener Table (D8)

Redis holds the latest rolling window snapshot for every active ticker. This is what the screener table reads on every refresh.

**Key structure:**

| Key | Type | Description |
|-----|------|-------------|
| `active_tickers` | Sorted Set | Tickers ranked by 60-minute message count (descending) |
| `window:{ticker}:{minutes}` | Hash | Full window stats for one ticker at one window size |
| `pipeline:last_sync` | String | ISO timestamp of the last pipeline run |

**Reading active tickers:**

```typescript
import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.REDIS_URL!,
  token: process.env.REDIS_TOKEN!, // if using Upstash REST
});

// Or with the `redis` npm package (ioredis-compatible):
// import Redis from "ioredis";
// const redis = new Redis(process.env.REDIS_URL!);

// Get top 50 tickers sorted by 60-minute message count
const tickers: [string, number][] = await redis.zrevrange(
  "active_tickers",
  0,
  49,
  { withScores: true }
);
// Returns: [["TSLA", 42], ["AAPL", 31], ["GME", 18], ...]
```

**Reading a window hash:**

```typescript
// Get the 60-minute window for TSLA
const data = await redis.hgetall("window:TSLA:60");
// Returns:
// {
//   ticker: "TSLA",
//   window_minutes: "60",       // <-- string, needs parseInt
//   avg_sentiment: "0.3421",    // <-- string, needs parseFloat
//   message_count: "42",        // <-- string, needs parseInt
//   bullish_count: "28",
//   bearish_count: "8",
//   neutral_count: "6",
//   window_start: "2026-03-27T10:15:00",
//   window_end: "2026-03-27T11:15:00",
//   computed_at: "2026-03-27T11:15:00"
// }

// Parse numeric fields
const parsed = {
  ...data,
  window_minutes: parseInt(data.window_minutes),
  avg_sentiment: parseFloat(data.avg_sentiment),
  message_count: parseInt(data.message_count),
  bullish_count: parseInt(data.bullish_count),
  bearish_count: parseInt(data.bearish_count),
  neutral_count: parseInt(data.neutral_count),
};
```

**Reading last sync time:**

```typescript
const lastSync: string | null = await redis.get("pipeline:last_sync");
// Returns: "2026-03-27T11:15:00.123456" or null
```

**TTL:** All Redis keys expire after 3600 seconds (1 hour). If the pipeline stops running, keys will disappear and the screener will show empty.

**Suggested API route for the screener:**

```
GET /api/screener?window=60
```

Logic:
1. `ZREVRANGE active_tickers 0 49 WITHSCORES` to get ranked ticker list
2. For each ticker, `HGETALL window:{ticker}:{window}` to get window stats
3. Return the combined array

### 3.2 PostgreSQL (Neon) -- Ticker History Charts (D9)

PostgreSQL stores every window computation as a new row, creating an append-only time series. This is what powers the historical charts.

**Table schema:**

```sql
CREATE TABLE window_history (
    id             BIGSERIAL PRIMARY KEY,
    ticker         VARCHAR(10)  NOT NULL,
    window_minutes SMALLINT     NOT NULL,
    avg_sentiment  REAL         NOT NULL,
    message_count  INTEGER      NOT NULL,
    bullish_count  INTEGER      NOT NULL,
    bearish_count  INTEGER      NOT NULL,
    neutral_count  INTEGER      NOT NULL,
    window_start   TIMESTAMPTZ  NOT NULL,
    window_end     TIMESTAMPTZ  NOT NULL,
    computed_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Index for fast lookups by ticker + window + time
CREATE INDEX idx_wh_ticker_window_computed
    ON window_history (ticker, window_minutes, computed_at DESC);
```

**Query for historical chart data:**

```typescript
import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.POSTGRES_DSN!);

// Get the last 24 hours of 60-minute window snapshots for TSLA
const rows = await sql`
  SELECT ticker, window_minutes, avg_sentiment, message_count,
         bullish_count, bearish_count, neutral_count,
         window_start, window_end, computed_at
    FROM window_history
   WHERE ticker = ${ticker}
     AND window_minutes = ${windowMinutes}
     AND computed_at >= NOW() - make_interval(hours => ${hours})
   ORDER BY computed_at DESC
`;
```

**Suggested API route:**

```
GET /api/ticker/[symbol]/history?window=60&hours=24
```

**Note:** Rows accumulate over time (one per ticker per window per pipeline cycle). For a 24-hour chart with 60-second cycles, expect ~1,440 rows per ticker per window size. Always query with a time bound.

### 3.3 MongoDB (Atlas) -- Finviz Data + Recent Posts

MongoDB has two collections relevant to the dashboard:

**`finviz_screener` collection (fundamental data for D8):**

```typescript
import { MongoClient } from "mongodb";

const client = new MongoClient(process.env.MONGO_URI!);
const db = client.db("ds440");

// Get Finviz data for a ticker
const finviz = await db.collection("finviz_screener").findOne(
  { ticker: "TSLA" },
  { projection: { _id: 0 } }
);
// Returns:
// {
//   ticker: "TSLA",
//   company: "Tesla Inc.",
//   sector: "Consumer Cyclical",
//   industry: "Auto Manufacturers",
//   country: "USA",
//   market_cap: 800000000,        // numeric (parsed from "800M")
//   p_e: "65.2",                  // string (raw from CSV)
//   price: "245.30",              // string (raw from CSV)
//   change: -2.10,                // numeric (parsed percentage)
//   volume: "98000000",
//   analyst_recom: -0.1,          // normalized: -1.0 (sell) to +1.0 (buy)
//   structured_sentiment: -0.1,   // same as analyst_recom
//   ingested_at: ISODate(...)
// }
```

Available tickers in Finviz sample: AAPL, TSLA, MSFT, GOOG, AMZN, GME, AMC, NVDA, SPY, META.

**`posts` collection (recent posts for D9):**

```typescript
// Get the 20 most recent posts mentioning TSLA
const posts = await db
  .collection("posts")
  .find(
    { tickers_mentioned: "TSLA" },
    { projection: { _id: 0 } }
  )
  .sort({ published_at: -1 })
  .limit(20)
  .toArray();
// Each post has:
// {
//   id: "t3_1s3abc",
//   source: "reddit" | "bluesky",
//   subreddit: "wallstreetbets" | "bluesky",
//   author: "diamond_hands_42",
//   title: "TSLA to the moon",
//   text: "Just bought 100 shares...",
//   url: "https://...",
//   score: 142,
//   num_comments: 37,
//   published_at: ISODate(...),
//   detected_at: ISODate(...),
//   content_hash: "a1b2c3d4...",
//   tickers_mentioned: ["TSLA"],
//   sentiment_score: 0.75,       // -1.0 to +1.0
//   is_duplicate: false,
//   is_spam: false
// }
```

**Suggested API routes:**

```
GET /api/finviz/[symbol]         -> fundamental data for screener enrichment
GET /api/posts?ticker=TSLA&limit=20  -> recent posts for ticker detail view
```

---

## 4. Environment Variables

```env
# Redis (Upstash) — fast reads for screener table
REDIS_URL=rediss://default:...@...-us1-redis.upstash.io:6379

# PostgreSQL (Neon) — historical time-series for charts
POSTGRES_DSN=postgresql://user:password@...neon.tech/ds440?sslmode=require

# MongoDB (Atlas) — posts + Finviz data
MONGO_URI=mongodb+srv://user:password@cluster.mongodb.net/?retryWrites=true&w=majority
MONGO_DB=ds440
```

All three services are already provisioned and populated with data. The connection strings are in the project root `.env` file.

---

## 5. Connection String Locations

- Python backend reads from `/.env` at the project root (loaded by `python-dotenv`)
- For the Next.js app, copy the relevant variables into `dashboard/.env.local` or configure Next.js to read from the root `.env`
- The `.env` file is gitignored -- never commit it

---

## 6. Deliverable Requirements

### D8: Screener Table

A Finviz-style sortable, filterable data table that combines social sentiment data with fundamental financial data.

**Data sources:**
- Redis `active_tickers` sorted set (which tickers to show)
- Redis `window:{ticker}:{minutes}` hashes (sentiment + message counts)
- MongoDB `finviz_screener` collection (price, market cap, P/E, analyst rating)

**Columns:**

| Column | Source | Notes |
|--------|--------|-------|
| Ticker | Redis active_tickers | Link to D9 detail page |
| Price | MongoDB finviz_screener | String from CSV, display as-is |
| Market Cap | MongoDB finviz_screener | Already parsed to number |
| P/E | MongoDB finviz_screener | May be null (ETFs, unprofitable companies) |
| Analyst Rating | MongoDB finviz_screener | Normalized -1.0 to +1.0 |
| Sentiment Score | Redis window hash | avg_sentiment, -1.0 to +1.0 |
| Message Count | Redis window hash | message_count for selected window |
| Bull/Bear Ratio | Redis window hash | Compute from bullish_count / bearish_count |

**Behavior:**
- Time window selector: dropdown with 1m, 3m, 5m, 10m, 15m, 30m, 60m options
- Changing the window re-fetches from Redis with the new window size
- Sortable by any column (client-side sort is fine)
- Auto-refresh every 60 seconds (matches pipeline cycle)
- Show "Last updated: {pipeline:last_sync}" timestamp
- Each row is clickable, navigates to `/ticker/[symbol]` (D9)

### D9: Ticker Detail View

A detail page for a single ticker showing historical trends and recent posts.

**Components:**

1. **Ticker header:** Ticker symbol, company name, price, sector (from Finviz)
2. **Sentiment chart:** Line chart of avg_sentiment over time (from PostgreSQL window_history)
3. **Message density chart:** Bar chart of message_count over time (from PostgreSQL)
4. **Sentiment breakdown:** Current bullish/bearish/neutral counts (from Redis, current window)
5. **Recent posts list:** 20 most recent posts mentioning this ticker (from MongoDB posts collection), showing source badge (Reddit/Bluesky), title, sentiment score, timestamp

**Controls:**
- Time window selector (1m, 3m, 5m, 10m, 15m, 30m, 60m) -- affects which window_minutes to query
- Time range selector (1hr, 6hr, 24hr) -- affects the `hours` parameter in the PostgreSQL query

### D10: Config Panel

A settings page with no backend persistence (localStorage only).

**Settings:**
- Toggle data sources on/off (individual subreddits, Bluesky) -- these are display filters only, the pipeline still collects everything
- Default time window (which window size loads by default on the screener)
- Refresh interval (how often the dashboard auto-refreshes, default 60s)
- Theme toggle (light/dark) if using shadcn/ui

All settings stored in `localStorage` and read on page load.

---

## 7. Current Data State

| Metric | Value |
|--------|-------|
| Total posts in MongoDB | ~4,272 |
| Posts with extracted tickers | ~2,226 |
| Posts with sentiment scores | ~2,226 |
| Active tickers (last 60 min) | ~5 |
| Rolling windows in Redis | ~35 (5 tickers x 7 window sizes) |
| Finviz tickers | 10 (AAPL, TSLA, MSFT, GOOG, AMZN, GME, AMC, NVDA, SPY, META) |
| Data sources | Reddit (22 active subreddits), Bluesky (25 cashtag queries) |
| Pipeline cycle time | ~60 seconds |

The screener will be sparse -- only tickers active in the last hour show up. This is expected behavior, not a bug.

---

## 8. Suggested Next.js Project Structure

```
dashboard/
├── app/
│   ├── layout.tsx              # Root layout with sidebar nav
│   ├── page.tsx                # D8: Screener table (home page)
│   ├── ticker/
│   │   └── [symbol]/
│   │       └── page.tsx        # D9: Ticker detail view
│   ├── settings/
│   │   └── page.tsx            # D10: Config panel
│   └── api/
│       ├── screener/
│       │   └── route.ts        # GET: active tickers + window data from Redis
│       ├── ticker/
│       │   └── [symbol]/
│       │       ├── route.ts         # GET: single ticker current window from Redis
│       │       └── history/
│       │           └── route.ts     # GET: historical data from PostgreSQL
│       ├── finviz/
│       │   └── [symbol]/
│       │       └── route.ts         # GET: fundamental data from MongoDB
│       └── posts/
│           └── route.ts             # GET: recent posts by ticker from MongoDB
├── components/
│   ├── screener-table.tsx      # Main data table with sorting/filtering
│   ├── sentiment-badge.tsx     # Color-coded sentiment indicator
│   ├── sentiment-chart.tsx     # Line chart for historical sentiment
│   ├── density-chart.tsx       # Bar chart for message counts
│   ├── ticker-header.tsx       # Ticker info banner on detail page
│   ├── posts-list.tsx          # Recent posts feed
│   └── config-panel.tsx        # Settings form
├── lib/
│   ├── redis.ts                # Redis client singleton
│   ├── postgres.ts             # PostgreSQL client
│   ├── mongodb.ts              # MongoDB client singleton
│   └── types.ts                # Shared TypeScript types
├── package.json
├── tailwind.config.ts
├── tsconfig.json
└── .env.local                  # Connection strings (gitignored)
```

---

## 9. TypeScript Types

```typescript
// Window data from Redis (after parsing) or PostgreSQL rows
interface WindowData {
  ticker: string;
  window_minutes: number;
  avg_sentiment: number;       // -1.0 to +1.0
  message_count: number;
  bullish_count: number;
  bearish_count: number;
  neutral_count: number;
  window_start: string;        // ISO 8601 datetime
  window_end: string;          // ISO 8601 datetime
  computed_at: string;         // ISO 8601 datetime
}

// Finviz fundamental data from MongoDB
interface FinvizData {
  ticker: string;
  company: string;
  sector: string;
  industry: string;
  country: string;
  price: string;               // raw string from CSV
  market_cap: number | null;   // parsed: 800M -> 800000000
  p_e: string | null;          // raw string, may be "-" or empty
  change: number | null;       // parsed percentage (e.g., -2.10)
  volume: string;
  analyst_recom: number | null;     // normalized -1.0 to +1.0
  structured_sentiment: number | null; // same value as analyst_recom
  ingested_at: string;
}

// Combined row for the screener table
interface ScreenerRow extends WindowData {
  price?: string;
  market_cap?: number;
  p_e?: string;
  analyst_recom?: number;
  company?: string;
  sector?: string;
}

// Individual post from MongoDB
interface Post {
  id: string;
  source: "reddit" | "bluesky";
  subreddit: string;           // subreddit name or "bluesky"
  author: string;
  title: string;
  text: string;
  url: string;
  score: number;               // upvotes (Reddit) or likes (Bluesky)
  num_comments: number;
  sentiment_score: number;     // -1.0 to +1.0
  tickers_mentioned: string[];
  published_at: string;        // ISO datetime
  detected_at: string;
  content_hash: string;
  is_duplicate: boolean;
  is_spam: boolean;
}

// Response shape for historical chart data
interface TickerHistory {
  ticker: string;
  window_minutes: number;
  points: WindowData[];        // ordered by computed_at DESC
}

// Config panel settings (stored in localStorage)
interface DashboardConfig {
  defaultWindow: number;       // one of: 1, 3, 5, 10, 15, 30, 60
  refreshInterval: number;     // seconds, default 60
  enabledSources: {
    reddit: boolean;
    bluesky: boolean;
  };
  theme: "light" | "dark";
}
```

---

## 10. Key Gotchas

**Redis:**
- ALL values in Redis hashes are strings. You must parse numbers with `parseFloat()` / `parseInt()` after every `HGETALL`.
- Upstash uses TLS: the URL starts with `rediss://` (two s's), not `redis://`.
- Keys expire after 3600 seconds. If the pipeline has not run in the last hour, Redis will be empty.
- The `active_tickers` sorted set only contains tickers with posts in the last 60 minutes. The screener table may show very few rows -- this is normal.

**PostgreSQL:**
- Neon requires `sslmode=require` in the connection string.
- `window_history` is append-only. Rows accumulate every pipeline cycle (~60 seconds). Always query with a time bound (`computed_at >= NOW() - interval`).
- Use `make_interval(hours => $1)` for parameterized interval queries (plain string interpolation in intervals is a SQL injection risk).

**MongoDB:**
- Always use projection `{ _id: 0 }` to exclude ObjectIds, which are not JSON-serializable by default.
- The `finviz_screener` collection has only 10 tickers (AAPL, TSLA, MSFT, GOOG, AMZN, GME, AMC, NVDA, SPY, META). Tickers active in Redis that are not in this set will have no fundamental data -- handle gracefully.
- Some `finviz_screener` fields are strings (price, volume, p_e) because they were not in the special-parsing list. Parse on the frontend or in the API route.

**Sentiment:**
- Sentiment range is **-1.0 (bearish) to +1.0 (bullish)**, NOT 0 to 1.
- Analyst recommendation from Finviz is also normalized to this range: 1.0 (Strong Buy from Finviz) becomes +1.0, 5.0 (Strong Sell) becomes -1.0. The formula is `(3.0 - raw) / 2.0`.
- Bullish threshold: sentiment_score > 0.2. Bearish threshold: sentiment_score < -0.2. Everything in between is neutral.

**General:**
- The pipeline only surfaces tickers that have had posts in the lookback window. If no one has mentioned a ticker in the last 60 minutes, it will not appear in `active_tickers`.
- MongoDB collection names: `posts`, `finviz_screener`, `rolling_windows`. Database name: `ds440`.
- Rolling window sizes available: 1, 3, 5, 10, 15, 30, 60 (minutes).

---

## 11. Recommended Libraries

```json
{
  "dependencies": {
    "next": "^14",
    "@upstash/redis": "^1.28",
    "@neondatabase/serverless": "^0.9",
    "mongodb": "^6.3",
    "recharts": "^2.10",
    "@tanstack/react-table": "^8.11",
    "date-fns": "^3.3"
  },
  "devDependencies": {
    "typescript": "^5",
    "@types/node": "^20",
    "@types/react": "^18",
    "tailwindcss": "^3.4",
    "postcss": "^8",
    "autoprefixer": "^10"
  }
}
```

- **@upstash/redis**: Native Upstash client, works in edge runtime and serverless
- **@neondatabase/serverless**: Neon's serverless driver, works over HTTP (no persistent TCP connection needed)
- **mongodb**: Official MongoDB driver
- **recharts**: React charting library for sentiment/density charts
- **@tanstack/react-table**: Headless table library for sorting/filtering
- **shadcn/ui**: Not installed via npm -- use `npx shadcn-ui@latest init` to scaffold, then add components individually

---

## 12. Quick Start

```bash
# From the project root
cd dashboard  # (after creating the Next.js app)

# Initialize Next.js
npx create-next-app@14 . --typescript --tailwind --eslint --app --src-dir=false

# Add shadcn/ui
npx shadcn-ui@latest init

# Install data clients
npm install @upstash/redis @neondatabase/serverless mongodb

# Install chart + table libraries
npm install recharts @tanstack/react-table date-fns

# Copy connection strings
cp ../.env .env.local
# Edit .env.local to keep only REDIS_URL, POSTGRES_DSN, MONGO_URI, MONGO_DB

# Run dev server
npm run dev
```

Verify connectivity by hitting the API routes directly in the browser:
- `http://localhost:3000/api/screener?window=60` -- should return active tickers with window data
- `http://localhost:3000/api/finviz/TSLA` -- should return Finviz fundamental data
- `http://localhost:3000/api/ticker/TSLA/history?window=60&hours=24` -- should return historical rows
