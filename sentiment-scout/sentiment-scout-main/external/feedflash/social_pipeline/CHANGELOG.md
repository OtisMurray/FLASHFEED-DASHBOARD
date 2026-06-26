# FeedFlash — Full Implementation Changelog

> **All 6 development phases** covering the complete data pipeline: Screener, Admin CRUD, Additional Sources, Twitter/X Scraping, Ticker Detail, and Data Quality.
>
> **12 new files** created, **5 existing files** modified.

---

## Table of Contents

- [Phase 3: Screener + 3 Extra Columns](#phase-3-screener--3-extra-columns)
- [Phase 5: Admin CRUD](#phase-5-admin-crud)
- [Phase 1: Additional Structured News Sources](#phase-1-additional-structured-news-sources)
- [Phase 2: Twitter/X Scraping](#phase-2-twitterx-scraping)
- [Phase 4: Ticker Detail Popup](#phase-4-ticker-detail-popup)
- [Phase 6: Data Quality](#phase-6-data-quality)
- [Setup Instructions](#setup-instructions)

---

## Phase 3: Screener + 3 Extra Columns

### Modified: `dashboard/lib/types.ts`

Extended `TickerData` interface with four new fields for the screener's extra columns:

```typescript
// New fields added to TickerData
structured_sentiment?: number | null;   // news-based sentiment from RSS articles
social_sentiment?: number | null;       // social media sentiment from Reddit/Bluesky/Twitter
message_density?: number | null;        // normalized post volume per time window
news_article_count?: number;            // number of matching articles

// Added to Post interface
is_rumor?: boolean;

// Added 'twitter' as valid source type
source: "reddit" | "bluesky" | "twitter";
```

### Modified: `dashboard/app/api/screener/route.ts`

Rewrote the screener API to aggregate data from three stores:
- **MongoDB** — Finviz screener fundamentals (price, market cap, P/E, analyst rating)
- **Redis** — Rolling window stats (social sentiment, message density)
- **Redis** — News sentiment per ticker (from `news_sentiment:{TICKER}` keys)

Uses a Redis pipeline for efficient batch-fetching of news sentiment across all active tickers.

```typescript
// Key aggregation logic
const newsKey = `news_sentiment:${ticker}`;
const newsData = await redis.hgetall(newsKey);
// Returns: { avg_score, article_count, bullish, bearish, neutral }

// Final row shape
{
  ticker, price, market_cap, pe, analyst_recom, sources,
  avg_sentiment, message_count, bullish_count, bearish_count,
  structured_sentiment,  // from news RSS
  social_sentiment,      // from rolling windows
  message_density,       // posts / time_window_minutes
  news_article_count,
}
```

### New: `dashboard/app/api/screener/upload/route.ts`

POST endpoint that handles Finviz CSV uploads:
1. Parses multipart form data
2. Normalizes columns (Market Cap strings like `"1.5B"` → numeric, Analyst Recom → float)
3. Upserts rows into MongoDB `finviz_screener` collection by ticker

```typescript
// Handles Market Cap normalization
function parseMarketCap(val: string): number | null {
  // "1.5B" → 1_500_000_000
  // "340M" → 340_000_000
  // "2.1T" → 2_100_000_000_000
}
```

### New: `dashboard/app/screener/page.tsx`

Full screener page featuring:
- **11-column sortable table**: Ticker, Price, MCap, P/E, Rating, Sentiment, Posts, Sources, News Sentiment, Social Sentiment, Msg Density
- **Real-time**: Auto-refresh every 10 seconds
- **Time window selector**: 1m, 5m, 15m, 1hr dropdown
- **CSV upload**: Drag-and-drop or click to upload Finviz exports
- **Visual sentiment bars**: Color-coded bullish/bearish/neutral bars

---

## Phase 5: Admin CRUD

### Modified: `scripts/db_migrate.py`

Added two new PostgreSQL tables and seeds:

```sql
-- RSS feed sources (managed from admin UI)
CREATE TABLE IF NOT EXISTS rss_sources (
  id         SERIAL  PRIMARY KEY,
  name       TEXT    NOT NULL,
  url        TEXT    UNIQUE NOT NULL,
  category   TEXT    NOT NULL DEFAULT 'markets',
  enabled    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at BIGINT  NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
);

-- 22 default RSS sources seeded (CNBC, MarketWatch, Yahoo, Benzinga, etc.)

-- Watched social accounts (for Twitter, Bluesky handles)
CREATE TABLE IF NOT EXISTS watched_accounts (
  id         SERIAL  PRIMARY KEY,
  platform   TEXT    NOT NULL,
  handle     TEXT    NOT NULL,
  enabled    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at BIGINT  NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
  UNIQUE(platform, handle)
);

-- 15 default Twitter accounts seeded (@Benzinga, @CNBC, @unusual_whales, etc.)

-- Source latency tracking
ALTER TABLE articles ADD COLUMN IF NOT EXISTS detected_at BIGINT;
```

### New: `dashboard/app/api/settings/keywords/route.ts`

CRUD API for financial signal keywords:

| Method | Action | Body/Params |
|--------|--------|-------------|
| `GET` | List all keywords grouped by category | — |
| `POST` | Add new keyword | `{ keyword, category }` |
| `PATCH` | Toggle enabled/disabled | `{ id, enabled }` |
| `DELETE` | Remove keyword | `?id=N` |

### New: `dashboard/app/api/settings/sources/route.ts`

CRUD API for RSS feed sources:

| Method | Action | Body/Params |
|--------|--------|-------------|
| `GET` | List all RSS sources | — |
| `POST` | Add new source | `{ name, url, category }` |
| `PATCH` | Toggle enabled/disabled | `{ id, enabled }` |
| `DELETE` | Remove source | `?id=N` |

### New: `dashboard/app/api/settings/accounts/route.ts`

CRUD API for watched social accounts:

| Method | Action | Body/Params |
|--------|--------|-------------|
| `GET` | List accounts, optionally by platform | `?platform=twitter` |
| `POST` | Add account | `{ platform, handle }` |
| `PATCH` | Toggle enabled/disabled | `{ id, enabled }` |
| `DELETE` | Remove account | `?id=N` |

Validates platform against: `twitter`, `bluesky`, `reddit`.

### New: `dashboard/app/settings/page.tsx`

Admin settings page with 3 tabbed sections:

1. **Keywords Tab** — Filter keywords grouped by category (fundamental, regulatory, analyst, momentum). Inline add form with keyword + category dropdown. Toggle switches and delete buttons per keyword.

2. **RSS Sources Tab** — All RSS feeds grouped by category (markets, equities, economy, filings, press_releases, crypto, commodities, fda). Inline add form with name, URL, and category fields. Shows truncated URL.

3. **Accounts Tab** — Watched social accounts grouped by platform (Twitter 𝕏, Bluesky 🦋, Reddit 📡). Inline add with platform picker and handle input.

### Modified: `dashboard/components/nav-bar.tsx`

Added navigation links for `/screener` (Screener) and `/settings` (Settings) with the same active-path highlighting pattern.

---

## Phase 1: Additional Structured News Sources

### Modified: `scripts/fetch_rss.py`

Two key changes:

1. **DB-backed feed loading** — New `_load_feeds_from_db()` function queries `rss_sources` PostgreSQL table for enabled feeds. Falls back to hardcoded `RSS_FEEDS` list if the table doesn't exist or returns empty.

```python
def _load_feeds_from_db(dsn: str) -> list[tuple[str, str, str]]:
    """Load enabled RSS sources from the rss_sources PostgreSQL table."""
    try:
        with psycopg.connect(dsn) as conn:
            rows = conn.execute(
                "SELECT name, url, category FROM rss_sources WHERE enabled = TRUE ORDER BY name"
            ).fetchall()
        if rows:
            return [(r[0], r[1], r[2]) for r in rows]
    except Exception:
        pass
    return RSS_FEEDS  # fallback
```

2. **Source latency tracking** — Each article now gets a `detected_at` timestamp set at fetch time, enabling latency analysis between publish and detection.

3. **AccessWire** added to both the hardcoded fallback list and DB seeds.

---

## Phase 2: Twitter/X Scraping

### New: `scrapers/twitter.py`

Full Twitter/X scraper using `ntscraper` (Nitter-based, **no API key required**):

```python
# Architecture:
# 1. Load enabled handles from watched_accounts DB table (fallback to defaults)
# 2. For each handle, scrape last 20 tweets via Nitter
# 3. Store in MongoDB posts collection with source="twitter"
# 4. Pipeline stages 1-8 handle ticker extraction, sentiment, dedup, etc.

# Default handles (seeded in DB):
DEFAULT_HANDLES = [
    "Benzinga", "CNBC", "unusual_whales", "ewhispers",
    "DeItaone", "FirstSquawk", "LiveSquawk", "MarketWatch",
    "WSJ", "Reuters", "Investingcom", "StockMKTNewz",
    "realwillmeade", "zerohedge", "BreakingMarkets",
]

# Post schema matches Reddit/Bluesky scrapers:
{
    "id": sha1("twitter:{handle}:{text[:100]}"),
    "source": "twitter",
    "author": "@{handle}",
    "title": text[:200],
    "text": text,
    "url": tweet_link,
    "published_at": datetime,
    "tickers_mentioned": [],      # filled by pipeline Stage 1
    "is_processed": False,
    "is_scored": False,
    "is_duplicate": False,
    "is_rumor": False,
}
```

**Usage:**
```bash
python scrapers/twitter.py              # one-shot
python scrapers/twitter.py --loop 300   # repeat every 5 minutes
```

### Modified: `scripts/run_pipeline.py`

Added Twitter scraping to the `run_scrapers()` function (runs after Bluesky):

```python
# Twitter / X scrape (one cycle via ntscraper)
try:
    from scrapers.twitter import scrape_cycle as twitter_cycle
    twitter_cycle(collection)
except ImportError:
    log.info("ntscraper not installed — skipping Twitter scrape")
```

---

## Phase 4: Ticker Detail Popup

### New: `dashboard/app/ticker/[symbol]/page.tsx`

Full ticker detail page with:

1. **Header** — Ticker symbol, price, market cap, P/E ratio
2. **ComposedChart** (Recharts) — Overlays:
   - Sentiment line (avg_sentiment over time)
   - Bullish/Bearish stacked bars (volume breakdown)
   - Posts area fill (total volume)
3. **Rolling Window Cards** — Summary stats for each active window (1m, 5m, 15m, 60m)
4. **Recent Posts Feed** — Last 30 posts mentioning this ticker with:
   - Source icons (📡 Reddit, 🦋 Bluesky, 𝕏 Twitter)
   - Rumor badges (`RUMOR` tag in amber)
   - Sentiment labels (bullish/bearish/neutral colored text)

### Modified: `dashboard/app/api/ticker/[symbol]/route.ts`

Enriched the API response to serve the detail page:

```typescript
// Before: single window, flat TickerData
// After: multi-window + recent_posts

{
  data: {
    ticker: "AAPL",
    price: 178.50,
    market_cap: 2800000000000,
    pe: 28.5,
    analyst_recom: 1.8,
    last_updated: "2026-03-30T...",
    windows: {
      "1m":  { avg_sentiment: 0.12, total_posts: 5, bullish: 3, bearish: 1, neutral: 1 },
      "5m":  { avg_sentiment: 0.08, total_posts: 15, ... },
      "15m": { avg_sentiment: 0.05, total_posts: 32, ... },
      "60m": { avg_sentiment: 0.03, total_posts: 89, ... },
    },
    recent_posts: [
      { id, title, source, author, sentiment_label, published_at, is_rumor },
      ...
    ]
  }
}
```

---

## Phase 6: Data Quality

### New: `processing/data_quality.py`

Two data quality functions that plug into the pipeline:

#### 1. Cross-Source Deduplication

Finds posts from different sources with near-identical titles (normalized hash matching). The earliest post is kept as the original; later cross-source duplicates are flagged.

```python
def cross_source_dedup(collection, lookback_hours=24) -> int:
    # 1. Normalize titles: lowercase, strip punctuation, collapse whitespace
    # 2. SHA1 hash the normalized title
    # 3. Group posts by hash
    # 4. For groups with 2+ different sources, flag later posts
    # Sets: is_cross_dup=True, cross_dup_original=<original_post_id>
```

#### 2. Rumor Detection

Scans post text for speculative/unconfirmed language using 16 regex patterns:

```python
RUMOR_PHRASES = [
    r"\brumou?red?\b",           r"\ballegedly\b",
    r"\bunconfirmed\b",          r"\bunverified\b",
    r"\bsources?\s+say\b",      r"\baccording\s+to\s+sources?\b",
    r"\breportedly\b",           r"\bmay\s+be\s+(?:planning|considering|exploring)\b",
    r"\bis\s+(?:said|believed|thought)\s+to\b",
    r"\bwhisper(?:s|ed)?\b",     r"\bspeculat(?:ion|ed|ing)\b",
    r"\bin\s+talks?\b",          r"\bnot\s+(?:yet\s+)?confirmed\b",
    r"\bcould\s+(?:soon|potentially)\b",
    r"\bpeople?\s+familiar\s+with\b",
    r"\bnot\s+(?:been\s+)?verified\b",
]

def detect_rumors(collection, batch_size=500) -> int:
    # Sets: is_rumor=True on matches, is_rumor=False on clean posts
```

### Modified: `scripts/run_pipeline.py`

Added two new pipeline stages and updated total from 6 to 8:

```
Pipeline Stages:
  1. Ticker extraction        (D3)
  2. Dedup/spam filter         (D4)
  3. Sentiment scoring         (D5)
  4. Rolling windows           (D6)
  5. Redis sync                (D11)
  6. PostgreSQL sync           (D11)
  7. Cross-source dedup        (NEW — Phase 6)
  8. Rumor detection           (NEW — Phase 6)
```

---

## Setup Instructions

```bash
# 1. Install dashboard dependencies
cd social_pipeline/dashboard
npm install

# 2. Install Python pipeline dependencies (add ntscraper for Twitter)
pip install ntscraper

# 3. Run database migration (creates new tables + seeds)
cd social_pipeline
python scripts/db_migrate.py

# 4. Start the dashboard
cd dashboard
npm run dev

# 5. Run the pipeline (with scrapers including Twitter)
python scripts/run_pipeline.py --scrape --interval 60
```

### Environment Variables Required

```env
# MongoDB
MONGO_URI=mongodb+srv://...
MONGO_DB=flashfeed

# Redis (Upstash REST)
UPSTASH_REDIS_REST_URL=https://...
UPSTASH_REDIS_REST_TOKEN=...

# PostgreSQL (Neon)
POSTGRES_DSN=postgresql://...

# Optional
SENTIMENT_SERVICE_URL=https://...   # FinBERT deep NLP
BLUESKY_HANDLE=...                  # Bluesky scraper
BLUESKY_APP_PASSWORD=...
```

---

## File Index

### New Files (12)
| # | Path | Purpose |
|---|------|---------|
| 1 | `dashboard/app/api/screener/upload/route.ts` | Finviz CSV upload endpoint |
| 2 | `dashboard/app/screener/page.tsx` | Screener page UI |
| 3 | `dashboard/app/api/settings/keywords/route.ts` | Keywords CRUD API |
| 4 | `dashboard/app/api/settings/sources/route.ts` | RSS Sources CRUD API |
| 5 | `dashboard/app/api/settings/accounts/route.ts` | Watched Accounts CRUD API |
| 6 | `dashboard/app/settings/page.tsx` | Admin settings page |
| 7 | `scrapers/twitter.py` | Twitter/X scraper via Nitter |
| 8 | `processing/data_quality.py` | Cross-source dedup + rumor detection |
| 9 | `dashboard/app/ticker/[symbol]/page.tsx` | Ticker detail page with charts |

### Modified Files (5)
| # | Path | Changes |
|---|------|---------|
| 1 | `dashboard/lib/types.ts` | Extended TickerData + Post interfaces |
| 2 | `dashboard/app/api/screener/route.ts` | Added 3 extra sentiment columns |
| 3 | `dashboard/components/nav-bar.tsx` | Added Screener + Settings nav links |
| 4 | `scripts/db_migrate.py` | Added rss_sources, watched_accounts tables |
| 5 | `scripts/fetch_rss.py` | DB-backed feed loading + detected_at |
| 6 | `scripts/run_pipeline.py` | Added Twitter scrape + stages 7 & 8 |
| 7 | `dashboard/app/api/ticker/[symbol]/route.ts` | Multi-window + recent_posts response |
