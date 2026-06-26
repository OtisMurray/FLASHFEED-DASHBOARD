# DS440 Sentiment Pipeline — Technical Documentation

## Table of Contents

1. [Project Summary](#project-summary)
2. [How the Pipeline Works (Big Picture)](#how-the-pipeline-works-big-picture)
3. [D1: Reddit Scraper](#d1-reddit-scraper)
4. [D2: Bluesky Scraper](#d2-bluesky-scraper)
5. [D3: Ticker Extraction Engine](#d3-ticker-extraction-engine)
6. [D4: Deduplication & Spam Filter](#d4-deduplication--spam-filter)
7. [D5: Sentiment Scoring Engine](#d5-sentiment-scoring-engine)
8. [D6: Rolling Window Calculator](#d6-rolling-window-calculator)
9. [D7: Finviz Structured Data Ingestion](#d7-finviz-structured-data-ingestion)
10. [D11: Redis & PostgreSQL Integration](#d11-redis--postgresql-integration)
11. [D8-D10: Dashboard](#d8-d10-dashboard)
12. [D12: Autonomous Pipeline & Deployment](#d12-autonomous-pipeline--deployment)
13. [How to Run Everything](#how-to-run-everything)
14. [Test Suite Summary](#test-suite-summary)
15. [Project File Structure](#project-file-structure)

---

## Project Summary

This project builds a real-time pipeline that captures what retail investors are saying about stocks on social media, scores whether the chatter is bullish (optimistic) or bearish (pessimistic), and aggregates that data over rolling time windows so it can be displayed on a dashboard.

Think of it as a listening tool: it watches Reddit and Bluesky around the clock, picks out which stock tickers people are talking about, figures out the overall mood toward each stock, and summarizes that mood over the last 1, 5, 15, or 60 minutes.

The pipeline is built in stages — each "deliverable" (D1 through D7) adds one layer of capability on top of the previous ones.

---

## How the Pipeline Works (Big Picture)

```
 ┌──────────────────────────────────────────────────────────────────────────────┐
 │                          DATA COLLECTION                                     │
 │                                                                              │
 │   D1: Reddit Scraper ──┐                                                    │
 │   (24 subreddits)      ├──▶  MongoDB  ("posts" collection)                 │
 │   D2: Bluesky Scraper ─┘    ~4,200 posts and growing                       │
 │   (25 cashtag searches)                                                      │
 └──────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
 ┌──────────────────────────────────────────────────────────────────────────────┐
 │                          PROCESSING PIPELINE                                 │
 │                                                                              │
 │   D3: Ticker Extraction ─▶ "Which stocks are mentioned in this post?"       │
 │   D4: Dedup & Spam      ─▶ "Is this post a copy-paste of another?"         │
 │   D5: Sentiment Scoring  ─▶ "Is the mood bullish, bearish, or neutral?"    │
 │   D6: Rolling Windows    ─▶ "What's the aggregate mood over the last Xm?"  │
 └──────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
 ┌──────────────────────────────────────────────────────────────────────────────┐
 │                          STRUCTURED DATA                                     │
 │                                                                              │
 │   D7: Finviz Ingestion ──▶  MongoDB  ("finviz_screener" collection)         │
 │   (analyst ratings,          Wall Street's view for comparison               │
 │    market caps, etc.)                                                        │
 └──────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
 ┌──────────────────────────────────────────────────────────────────────────────┐
 │                          CACHE & PERSISTENCE (D11)                           │
 │                                                                              │
 │   D6 compute_all_windows() ──▶ MongoDB ("rolling_windows" collection)       │
 │                │                                                             │
 │                ├──▶ Redis / Upstash    (fast dashboard reads)               │
 │                └──▶ PostgreSQL / Neon  (historical time-series)             │
 └──────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
                              D8–D10: Dashboard (Vercel)
                          (Screener table, charts, config)
                   https://dashboard-seven-mauve-17.vercel.app
```

**D12: Autonomous operation.** GitHub Actions runs the full pipeline (scrape + process + enrich) every 15 minutes. The yfinance enricher fetches live stock prices for all discovered tickers. The Vercel dashboard reads from Redis/PostgreSQL/MongoDB and auto-refreshes every 60 seconds. No manual intervention required.

Each step runs independently. You can re-run any step at any time — they are all designed to skip work that has already been done (idempotent).

---

## D1: Reddit Scraper

### What It Does

Automatically collects posts from 24 finance-related Reddit communities (subreddits) where retail investors discuss stock trades. It runs continuously, checking for new posts every 30–60 seconds, and stores everything in MongoDB.

### How It Works

1. Visits 24 subreddits (r/wallstreetbets, r/stocks, r/options, r/pennystocks, etc.) one at a time.
2. Downloads the 100 most recent posts from each subreddit using Reddit's public JSON endpoints — no API key needed.
3. Cleans and standardizes each post into a consistent format (author, title, text, upvotes, timestamp, content fingerprint).
4. Stores posts in MongoDB. The database has a unique index on post ID, so duplicate posts are automatically skipped.
5. Pauses 4–6 seconds between subreddits to respect Reddit's rate limits.
6. After visiting all 24 subreddits, waits 30–60 seconds and starts over.

### Why curl_cffi?

Reddit blocks standard Python HTTP libraries by checking the browser "fingerprint" of incoming connections — a technique called TLS fingerprinting. The `curl_cffi` library solves this by impersonating a real Chrome 124 browser at the network level. Without it, Reddit returns 403 errors for automated requests. The scraper also uses `old.reddit.com` (the legacy Reddit interface), which has simpler anti-bot protections and cleaner JSON endpoints.

### What Gets Collected

| Field          | Description                              | Example                            |
|----------------|------------------------------------------|------------------------------------|
| `id`           | Reddit's unique post identifier          | `t3_1s3abc`                        |
| `source`       | Always `"reddit"`                        | `reddit`                           |
| `subreddit`    | Which community it came from             | `wallstreetbets`                   |
| `author`       | Username of the poster                   | `diamond_hands_42`                 |
| `title`        | Post title                               | `YOLO'd my savings into GME calls` |
| `text`         | Post body text                           | `Diamond hands forever...`         |
| `url`          | Link to the original post                | `https://www.reddit.com/r/...`     |
| `score`        | Net upvotes (upvotes minus downvotes)    | `142`                              |
| `num_comments` | Number of comments                       | `37`                               |
| `published_at` | When the post was created (UTC)          | `2026-03-27 11:15:00`              |
| `detected_at`  | When our scraper found it (UTC)          | `2026-03-27 11:17:00`              |
| `content_hash` | SHA-256 fingerprint for duplicate checks | `a1b2c3d4...`                      |

This is the **shared post schema** — the Bluesky scraper (D2) uses the same fields, so both sources feed into one unified processing pipeline.

### Reddit Communities Monitored (24)

| Category               | Communities                                                                                                  |
|------------------------|--------------------------------------------------------------------------------------------------------------|
| WallStreetBets family  | wallstreetbets, wallstreetbets2, wallstreetbets_wins, wallstreetbetsELITE, wallstreetbetsnew, wallstreetelite |
| Small/penny stocks     | wallstreetsmallcap, smallstreetbets, pennystocks, pennystock, 10xpennystocks                                 |
| General market          | thewallstreet, stockmarket, stocks, stocks_picks, stocksandtrading, stockstobuytoday                         |
| Trading-focused         | stocktradingalerts, swingtrading, trading, trakstocks, shortsqueeze                                          |
| Other                   | stockaday, options                                                                                           |

### Error Handling

| Situation                      | What Happens                                                                 |
|--------------------------------|-----------------------------------------------------------------------------|
| Rate limited (HTTP 429)        | Backs off with increasing wait times (doubles each time, up to 5 min max)  |
| Private subreddit (HTTP 403)   | Logs a warning and skips to the next community                              |
| Deleted subreddit (HTTP 404)   | Logs a warning and skips to the next community                              |
| Deleted/removed posts          | Filtered out during normalization — never stored                            |
| Network errors                 | Logged and skipped; retried on the next cycle                               |
| Ctrl+C                         | Graceful shutdown — finishes current operation, then exits cleanly          |

### First Run Results (March 27, 2026)

- Scraped 22 of 24 subreddits successfully
- Collected **2,049 posts** in approximately 3 minutes
- Skipped r/wallstreetbets (quarantined) and r/stockaday (no longer exists)

### Key Files

| File              | Purpose                                    |
|-------------------|--------------------------------------------|
| `scrapers/reddit.py`  | Core scraper logic — fetching, normalizing, cycling |
| `scrapers/db.py`      | MongoDB connection, indexes, bulk insert with dedup |
| `scrapers/config.py`  | All settings — subreddit list, delays, DB config     |
| `tests/test_reddit.py`| 27 automated tests                                  |
| `tests/test_db.py`    | 7 database layer tests                               |

---

## D2: Bluesky Scraper

### What It Does

Collects stock-related posts from Bluesky, a newer social media platform built on the open AT Protocol. While Reddit provides discussion-style posts, Bluesky provides shorter, tweet-like posts — often containing cashtag mentions like `$TSLA` or `$GME`.

### How It Works

1. Authenticates with Bluesky using the AT Protocol SDK (a handle and app password).
2. Searches for 25 popular stock cashtags (`$TSLA`, `$AAPL`, `$GOOG`, `$NVDA`, etc.) using Bluesky's search API.
3. For each search query, retrieves up to 100 matching posts.
4. Normalizes each post into the same shared schema used by the Reddit scraper.
5. Stores posts in the same MongoDB `posts` collection — same duplicate detection, same fields.
6. Supports optional account monitoring (watching specific Bluesky users), though no accounts are configured by default.
7. Repeats every 30–60 seconds, just like the Reddit scraper.

### Why Bluesky?

Bluesky's AT Protocol API is completely free and generous — 3,000 requests per 5 minutes with no API key registration hassle. Unlike Reddit's increasingly aggressive anti-bot measures, Bluesky actively encourages third-party access. It's a growing platform where finance accounts are starting to appear, and having two data sources makes the pipeline more robust.

### How It Differs from the Reddit Scraper

| Aspect            | Reddit (D1)                          | Bluesky (D2)                         |
|-------------------|--------------------------------------|--------------------------------------|
| Access method     | Scraping JSON endpoints via curl_cffi | Official AT Protocol API via `atproto` SDK |
| Authentication    | None needed                          | Handle + app password                |
| Rate limit        | Unofficial (~1 req/4-5s to be safe)  | Official: 3,000 req / 5 min         |
| Content type      | Long discussion posts                | Short tweet-style posts              |
| Search strategy   | Browse subreddits                    | Search cashtag queries               |
| Post IDs          | Reddit format (`t3_xxx`)             | AT Protocol URIs                     |
| `subreddit` field | Community name                       | Set to `"bluesky"` (no subreddits)   |

### Cashtag Queries Searched (25)

`$TSLA`, `$AAPL`, `$GOOG`, `$GOOGL`, `$AMZN`, `$MSFT`, `$GME`, `$AMC`, `$NVDA`, `$META`, `$SPY`, `$QQQ`, `$AMD`, `$INTC`, `$NFLX`, `$DIS`, `$BA`, `$PLTR`, `$SOFI`, `$NIO`, `$RIVN`, `$COIN`, `$MARA`, `$SQ`, `$SHOP`

### First Run Results (March 27, 2026)

- Searched all 25 cashtag queries successfully
- Collected **2,169 posts** (bringing the total with Reddit to ~4,218)
- All posts stored in the same MongoDB collection alongside Reddit posts

### Key Files

| File                  | Purpose                                              |
|-----------------------|------------------------------------------------------|
| `scrapers/bluesky.py` | Core scraper — authentication, search, normalization |
| `tests/test_bluesky.py` | 21 automated tests                                |

---

## D3: Ticker Extraction Engine

### What It Does

Reads every post in the database and figures out which stock tickers are being mentioned. A post like *"Just bought $TSLA and AAPL, thoughts on (GME)?"* would produce the list `["AAPL", "GME", "TSLA"]`. This is what connects raw social media text to specific stocks.

### How It Works

The engine uses three detection patterns, applied in order from highest to lowest confidence:

**Pattern A — Cashtags (highest confidence):**
Looks for a dollar sign followed by 1–5 letters, like `$TSLA` or `$gme`. The dollar sign prefix is a strong signal of intent — people specifically write `$TSLA` to mean the stock. Even single-letter tickers like `$F` (Ford) are matched here because the `$` prefix reduces false positives.

**Pattern B — Parenthesized tickers:**
Looks for uppercase letters inside parentheses, like `(AAPL)` or `(CPB)`. Finance writers commonly use this format to clarify which stock they're referencing — e.g., "Campbell's (CPB) reported earnings..."

**Pattern C — Bare uppercase words (lowest confidence):**
Looks for standalone uppercase words with 2–5 letters, like `TSLA` or `AMD`. This catches informal mentions but is the most prone to false positives, so it has strict filtering.

### False Positive Protection

Not every uppercase word is a stock ticker. The engine maintains two lists to prevent false matches:

- **Valid tickers list (~10,000 symbols):** Sourced from SEC EDGAR. If a match isn't in this list, it's rejected. This covers all NYSE, NASDAQ, and major ETF symbols.
- **False positive blocklist (143 words):** Common English words and abbreviations that happen to look like tickers — `IT`, `AM`, `PM`, `CEO`, `NFA` ("not financial advice"), `DD` ("due diligence"), `EPS`, `IPO`, etc.

URLs are also stripped from the text before matching, so tickers embedded in links (like `reddit.com/r/TSLA`) don't create false hits.

### What It Adds to Each Post

| Field               | Description                                       | Example           |
|---------------------|---------------------------------------------------|-------------------|
| `tickers_mentioned` | Alphabetically sorted list of detected tickers    | `["AAPL", "TSLA"]` |

Posts with no detected tickers get an empty list (`[]`) to distinguish "processed, nothing found" from "not yet processed."

### Example Extractions

| Post Text                                          | Tickers Found       |
|----------------------------------------------------|---------------------|
| `"$TSLA to the moon 🚀"`                           | `["TSLA"]`          |
| `"Buying AAPL and $GOOG before earnings"`          | `["AAPL", "GOOG"]`  |
| `"Campbell's (CPB) beat earnings estimates"`       | `["CPB"]`           |
| `"This DD is NFA, just my opinion"`                | `[]` (DD and NFA are blocked) |
| `"Check https://reddit.com/r/TSLA for more info"` | `[]` (URL stripped)  |

### Key Files

| File                            | Purpose                                              |
|---------------------------------|------------------------------------------------------|
| `processing/ticker_extraction.py` | Extraction logic, batch processor, CLI              |
| `processing/ticker_data.py`       | Valid ticker set (~10,000) and false positive blocklist (143) |
| `tests/test_ticker_extraction.py` | 39 automated tests                                  |

---

## D4: Deduplication & Spam Filter

### What It Does

Identifies posts that are near-copies of each other — a common problem on Reddit and Bluesky where bots and spammers re-post the same content across multiple communities. Without this step, duplicate posts would skew sentiment scores by counting the same opinion multiple times.

### How It Works

1. Groups all unprocessed posts by **(source, author)** — meaning it only compares posts from the same person on the same platform. A user posting similar content on Reddit and Bluesky is *not* flagged as a duplicate, since those are genuinely different audiences.

2. Within each group, sorts posts by `published_at` timestamp so the *earliest* post is treated as the original.

3. Compares each post against known originals using **text similarity** (Python's `SequenceMatcher`). If the combined title + body text is **more than 80% similar** to any original, the post is flagged as a duplicate.

4. The 80% threshold was chosen to catch copy-paste spam while allowing legitimate similar discussions. Two posts saying "TSLA is going up" and "I think TSLA is going up" are different enough to both count, but a bot reposting the exact same paragraph across 5 subreddits will be caught.

### What It Adds to Each Post

| Field          | Description                                        | Example |
|----------------|----------------------------------------------------|---------|
| `is_duplicate` | `true` if the post is a near-copy of an earlier one | `false` |
| `is_spam`      | Same value as `is_duplicate` (duplicate = spam)     | `false` |

Both fields are set to the same value. The distinction exists so that future versions could add other spam detection methods (e.g., known spam phrases) that set `is_spam` without `is_duplicate`.

### Why This Matters for the Pipeline

The rolling window calculator (D6) **excludes** posts flagged as duplicates. Without this filter, a bot reposting the same bullish message 10 times would artificially inflate the bullish sentiment score for a ticker. By tagging duplicates here, D6 can count each unique opinion only once.

### Example

Suppose user `stock_bot_99` posts on Reddit:

| Post | Subreddit       | Text                                           | Result       |
|------|-----------------|-------------------------------------------------|--------------|
| #1   | wallstreetbets  | "TSLA is going to $500 by end of month!! 🚀🚀" | **Original** |
| #2   | stocks          | "TSLA is going to $500 by end of month!! 🚀🚀" | **Duplicate** (100% match) |
| #3   | pennystocks     | "TSLA going to $500 by end of month! 🚀"       | **Duplicate** (>80% match) |

Post #1 is kept as the original. Posts #2 and #3 are flagged so D6 won't count them.

### Key Files

| File                          | Purpose                                                  |
|-------------------------------|----------------------------------------------------------|
| `processing/dedup_filter.py`  | Similarity logic, grouping, batch processor, CLI         |
| `tests/test_dedup_filter.py`  | 22 automated tests                                       |

---

## D5: Sentiment Scoring Engine

### What It Does

Reads every post in the database and assigns a sentiment score from **-1.0 (extremely bearish)** to **+1.0 (extremely bullish)**. This is the core analytical output of the pipeline — it turns unstructured social media text into a quantitative signal.

### How It Works

The engine uses a **rule-based lexicon approach** with three layers of signal detection:

**Layer 1 — Multi-word phrases (strongest signal):**
Looks for known financial phrases as substrings in the lowercased text. These are the most reliable signals because multi-word phrases are rarely ambiguous.

| Phrase              | Direction | Weight |
|---------------------|-----------|--------|
| "to the moon"       | Bullish   | 0.9    |
| "diamond hands"     | Bullish   | 0.9    |
| "buy the dip"       | Bullish   | 0.8    |
| "rug pull"          | Bearish   | 0.9    |
| "going to zero"     | Bearish   | 0.9    |
| "dead cat bounce"   | Bearish   | 0.8    |

There are **33 bullish phrases** and **31 bearish phrases** in total.

**Layer 2 — Single words (medium signal):**
Looks for individual words using word-boundary matching, so "sell" matches "I sell" but does *not* accidentally match inside "selling" (which has its own separate entry). Matching is case-insensitive.

| Word       | Direction | Weight |
|------------|-----------|--------|
| "bullish"  | Bullish   | 0.8    |
| "moon"     | Bullish   | 0.6    |
| "bearish"  | Bearish   | 0.8    |
| "crash"    | Bearish   | 0.6    |

There are **26 bullish words** and **27 bearish words**.

**Layer 3 — Emojis (lighter signal):**
Social media finance culture uses emojis heavily. Rocket emojis (🚀) signal bullishness, skull emojis (💀) signal bearishness.

| Emoji | Direction | Weight |
|-------|-----------|--------|
| 🚀    | Bullish   | 0.7    |
| 💎    | Bullish   | 0.6    |
| 📈    | Bullish   | 0.6    |
| 📉    | Bearish   | 0.6    |
| 🐻    | Bearish   | 0.6    |
| 💀    | Bearish   | 0.5    |

There are **14 bullish emojis** and **11 bearish emojis**.

### The Scoring Formula

After scanning the post's title and body through all three layers:

```
score = (bullish_weight_sum - bearish_weight_sum) / (bullish_weight_sum + bearish_weight_sum)
```

- If no signals are found → score is **0.0** (neutral / no signal).
- The result is clamped to the range **[-1.0, +1.0]**.
- The score is rounded to 4 decimal places.

**Intuition:** A post with only bullish signals scores close to +1.0. A post with only bearish signals scores close to -1.0. A post with a mix of both lands somewhere in between, weighted by how strong each signal is.

### What It Adds to Each Post

| Field               | Description                                    | Example        |
|---------------------|------------------------------------------------|----------------|
| `sentiment_score`   | Score from -1.0 (bearish) to +1.0 (bullish)   | `0.7143`       |
| `sentiment_method`  | Always `"rule_based"` for this version         | `"rule_based"` |
| `sentiment_signals` | Number of individual signals detected          | `7`            |

### Example Scores

| Post                                           | Score    | Why                                            |
|------------------------------------------------|----------|-------------------------------------------------|
| `"GME to the moon 🚀🚀🚀 diamond hands!"`     | **+0.85** | Multiple strong bullish signals, no bearish    |
| `"SPY puts printing, crash incoming 📉"`       | **-0.72** | Strong bearish phrases + emoji                 |
| `"AAPL earnings report tomorrow"`              | **0.0**  | No sentiment signals detected                   |
| `"I'm bullish but it could crash"`             | **+0.14** | Mixed — bullish word + bearish word, bullish slightly heavier |

### Design Choice: Why Rule-Based Instead of AI/LLM?

- **Speed:** Scores thousands of posts per second with zero API calls or GPU usage.
- **Transparency:** Every score can be traced back to exactly which words/phrases triggered it.
- **Cost:** Free to run — no OpenAI/Anthropic API costs.
- **Reliability:** No external dependencies that could go down or change behavior.
- **Good enough:** For WSB-style posts with clear language ("to the moon," "rug pull"), a lexicon captures the vast majority of sentiment. The architecture allows swapping in an LLM layer later for ambiguous posts.

### Key Files

| File                              | Purpose                                            |
|-----------------------------------|----------------------------------------------------|
| `processing/sentiment_engine.py`  | Scoring logic, batch processor, CLI                |
| `processing/sentiment_data.py`    | Lexicon data — all phrases, words, emojis + weights |
| `tests/test_sentiment_engine.py`  | 23 automated tests                                 |

---

## D6: Rolling Window Calculator

### What It Does

Aggregates sentiment data across time windows to answer questions like: *"What is the overall mood about TSLA over the last 5 minutes?"* or *"How many bullish vs. bearish posts about GME appeared in the last hour?"*

This is what transforms individual post scores into the dashboard-ready metrics that end users will see.

### How It Works

1. **Discovers active tickers** — finds all tickers that appear in recent, non-duplicate, scored posts.
2. **For each ticker × each window size**, queries MongoDB for qualifying posts within that time range.
3. **Computes aggregate statistics** for each combination.
4. **Upserts results** into a separate `rolling_windows` MongoDB collection, keyed by `(ticker, window_minutes)`. Each combination has exactly one "current" document that gets overwritten on each run.
5. **Skips empty windows** — if a ticker has zero qualifying posts in a given window, no document is written.

### Window Sizes

| Window  | What It Shows                              |
|---------|--------------------------------------------|
| 1 min   | Immediate pulse — real-time spike detection |
| 3 min   | Very short-term trend                      |
| 5 min   | Short-term trend                           |
| 10 min  | Medium short-term trend                    |
| 15 min  | Medium-term trend                          |
| 30 min  | Half-hour overview                         |
| 60 min  | Last-hour summary                          |

### What Gets Computed

For each (ticker, window) combination:

| Field            | Description                                          | Example              |
|------------------|------------------------------------------------------|----------------------|
| `ticker`         | Stock symbol                                         | `"TSLA"`             |
| `window_minutes` | Window duration                                      | `5`                  |
| `window_start`   | Start of the time window (UTC)                       | `2026-03-27 11:55:00` |
| `window_end`     | End of the time window (UTC)                         | `2026-03-27 12:00:00` |
| `computed_at`    | When this calculation was performed                  | `2026-03-27 12:00:00` |
| `avg_sentiment`  | Average sentiment score across all qualifying posts  | `0.42`               |
| `message_count`  | Total number of qualifying posts                     | `12`                 |
| `bullish_count`  | Posts with score > 0.2                               | `8`                  |
| `bearish_count`  | Posts with score < -0.2                              | `2`                  |
| `neutral_count`  | Posts with score between -0.2 and 0.2                | `2`                  |

### What Gets Excluded

- **Duplicate posts** (`is_duplicate = true`) — already flagged by D4, excluded here so copied content doesn't inflate scores.
- **Unscored posts** (no `sentiment_score` field) — posts that haven't been through D5 yet.
- **Posts outside the time window** — only posts with `published_at` within the window are counted.

### Example Output

If TSLA has 12 qualifying posts in the last 5 minutes:

```
{
    "ticker": "TSLA",
    "window_minutes": 5,
    "avg_sentiment": 0.42,
    "message_count": 12,
    "bullish_count": 8,
    "bearish_count": 2,
    "neutral_count": 2
}
```

This tells the dashboard: *"In the last 5 minutes, TSLA has been mentioned 12 times. The average mood is moderately bullish (+0.42). 8 posts were bullish, 2 were bearish, and 2 were neutral."*

### CLI Options

The calculator accepts an optional `--as-of` flag for computing historical windows:

```bash
# Compute windows as of right now (default)
rolling-windows

# Compute windows as of a specific historical time
rolling-windows --as-of "2026-03-27T10:00:00"
```

### Key Files

| File                            | Purpose                                            |
|---------------------------------|----------------------------------------------------|
| `processing/rolling_windows.py` | Window computation, ticker discovery, batch runner, CLI |
| `tests/test_rolling_windows.py` | 18 automated tests                                 |

---

## D7: Finviz Structured Data Ingestion

### What It Does

Imports structured financial data from Finviz, a popular stock screening website used by professional and retail investors. While D1–D6 capture *unstructured* social media sentiment (what people are saying), D7 imports *structured* Wall Street data (analyst ratings, market cap, sector, etc.) so the dashboard can show both side by side.

### How It Works

1. The user downloads a CSV export from [finviz.com](https://finviz.com) (the site provides screener exports).
2. The ingestion script reads the CSV, normalizes all column names to a consistent format, and parses special values (market cap suffixes, percentages, analyst ratings).
3. Each row is upserted into a separate MongoDB collection (`finviz_screener`) by ticker symbol. Re-uploading a newer CSV simply overwrites the old data.

### Column Normalization

Finviz column headers are human-readable but inconsistent. The ingestion script converts them to a clean, machine-friendly format:

| Finviz Header      | Normalized Name     |
|---------------------|---------------------|
| `Market Cap`        | `market_cap`        |
| `Analyst Recom.`    | `analyst_recom`     |
| `P/E`               | `p_e`               |
| `52W High`          | `52w_high`          |
| `Dividend Yield`    | `dividend_yield`    |

### Special Value Parsing

**Market Cap** — Finviz uses shorthand suffixes:

| Finviz Value | Parsed Value        |
|--------------|---------------------|
| `3.5B`       | 3,500,000,000       |
| `800M`       | 800,000,000         |
| `5.2K`       | 5,200               |
| `-`          | `null` (not available) |

**Percentages** — Stored as numeric values:

| Finviz Value | Parsed Value |
|--------------|--------------|
| `1.25%`      | `1.25`       |
| `-2.10%`     | `-2.10`      |
| `-`          | `null`       |

**Analyst Recommendation** — This is the key column. Finviz reports Wall Street analyst consensus on a 1.0–5.0 scale (1 = Strong Buy, 5 = Strong Sell). The ingestion script normalizes this to the same -1.0 to +1.0 scale used by our sentiment engine, and stores it as `structured_sentiment`:

| Finviz Analyst Rating | Meaning    | Normalized Score |
|-----------------------|------------|------------------|
| 1.0                   | Strong Buy | **+1.0**         |
| 2.0                   | Buy        | **+0.5**         |
| 3.0                   | Hold       | **0.0**          |
| 4.0                   | Sell       | **-0.5**         |
| 5.0                   | Strong Sell| **-1.0**         |

Formula: `structured_sentiment = (3.0 - analyst_rating) / 2.0`

This normalization makes it possible to directly compare Wall Street's view (`structured_sentiment`) with social media's view (`avg_sentiment` from D6) on the same scale.

### Sample Data

The project ships with a sample CSV (`data/finviz_sample.csv`) containing 10 tickers for testing and demo purposes: AAPL, TSLA, MSFT, GOOG, AMZN, GME, AMC, NVDA, SPY, META.

### Key Files

| File                           | Purpose                                              |
|--------------------------------|------------------------------------------------------|
| `processing/finviz_ingest.py`  | CSV parser, value normalizers, batch upsert, CLI     |
| `data/finviz_sample.csv`       | Sample Finviz export (10 tickers) for testing        |
| `tests/test_finviz_ingest.py`  | 26 automated tests                                   |

---

## D11: Redis & PostgreSQL Integration

### What It Does

Adds two external storage layers on top of the existing MongoDB-based pipeline. After the rolling window calculator (D6) computes window results and stores them in MongoDB, D11 copies those results to **Redis** (for fast, low-latency dashboard reads) and **PostgreSQL** (for persistent historical time-series that power the ticker detail charts in D9).

This is a "write-through" pattern: MongoDB remains the primary data store and source of truth, while Redis and PostgreSQL serve as optimized read layers for the dashboard.

### Why Two Additional Databases?

| Database     | Hosted On | Purpose                                  | Read Pattern                              |
|--------------|-----------|------------------------------------------|-------------------------------------------|
| MongoDB      | Atlas     | Primary store for raw posts + rolling windows | Processing pipeline reads/writes        |
| Redis        | Upstash   | Fast cache of current window snapshots   | Dashboard screener table (D8) — needs sub-10ms reads for all active tickers |
| PostgreSQL   | Neon      | Append-only history of every window computation | Ticker detail charts (D9) — needs time-series queries over hours/days |

MongoDB is great for flexible document storage but not optimized for the fast key-value lookups the dashboard needs or for time-series queries with SQL. Redis solves the speed problem, PostgreSQL solves the historical query problem.

### How It Works

After `compute_all_windows()` finishes writing to MongoDB, the `main()` function in `rolling_windows.py` reads back all window documents and pushes them to Redis and PostgreSQL in a single pass:

```
compute_all_windows()
    │
    ▼
MongoDB ("rolling_windows" collection)
    │
    │  main() reads back all window docs
    ▼
┌───────────────────────────────┐
│  For each window document:    │
│                               │
│  ├─▶ Redis: HSET per window  │
│  │   + ZADD active_tickers   │
│  │   + SET pipeline:last_sync│
│  │                            │
│  └─▶ PostgreSQL: INSERT INTO │
│      window_history           │
└───────────────────────────────┘
```

### Redis Cache Layer (Upstash)

Redis stores the **current** snapshot of every rolling window so the dashboard can retrieve any ticker's latest stats in a single `HGETALL` call.

**Key scheme:**

| Key Pattern                      | Type       | Description                                              |
|----------------------------------|------------|----------------------------------------------------------|
| `window:{ticker}:{minutes}`      | Hash       | All fields for one ticker/window pair (e.g., `window:TSLA:5`) |
| `active_tickers`                 | Sorted Set | All tickers with data, scored by 60-minute message count |
| `pipeline:last_sync`             | String     | ISO timestamp of the most recent sync                    |

**Hash fields** inside each `window:{ticker}:{minutes}` key:

| Field            | Example Value             |
|------------------|---------------------------|
| `ticker`         | `TSLA`                    |
| `window_minutes` | `5`                       |
| `avg_sentiment`  | `0.42`                    |
| `message_count`  | `10`                      |
| `bullish_count`  | `6`                       |
| `bearish_count`  | `2`                       |
| `neutral_count`  | `2`                       |
| `window_start`   | `2026-03-27T11:55:00+00:00` |
| `window_end`     | `2026-03-27T12:00:00+00:00` |
| `computed_at`    | `2026-03-27T12:00:00+00:00` |

All values are stored as strings (Redis hash requirement). Datetime fields are ISO 8601 formatted.

**TTL:** Every key expires after **3600 seconds** (1 hour) by default. If the pipeline stops running, stale data automatically disappears rather than misleading the dashboard.

**Batched writes:** All Redis commands for a sync cycle are batched into a single `pipeline.execute()` call to minimize round trips to the Upstash endpoint.

**Active tickers sorted set:** The `active_tickers` key is a Redis sorted set where each member is a ticker symbol and the score is its 60-minute message count. This lets the dashboard quickly retrieve the most-talked-about tickers in ranked order using `ZREVRANGE`.

### PostgreSQL Persistence (Neon)

PostgreSQL stores an **append-only history** of every window computation. Each time the pipeline runs, new rows are inserted (never updated or overwritten). This creates a time-series of sentiment data that the ticker detail view (D9) will use to render historical charts.

**Table schema:**

```sql
CREATE TABLE IF NOT EXISTS window_history (
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
```

**Index:**

```sql
CREATE INDEX IF NOT EXISTS idx_wh_ticker_window_computed
    ON window_history (ticker, window_minutes, computed_at DESC);
```

This composite index makes the most common dashboard query efficient: "give me the last N hours of 5-minute window data for TSLA, most recent first." The `DESC` on `computed_at` avoids a reverse scan.

**Append-only pattern:** Rows are only ever inserted, never updated or deleted. This means the table grows over time, but it provides a complete audit trail of how sentiment evolved. If the pipeline runs every 60 seconds with 50 active tickers across 7 window sizes, that is roughly 350 rows per minute, or about 500,000 rows per day. Neon handles this comfortably.

### Graceful Fallback

Both Redis and PostgreSQL are **optional**. If the `REDIS_URL` or `POSTGRES_DSN` environment variables are not set (or if the connection fails at runtime), the pipeline logs a message and continues working with MongoDB only. No error is thrown, and no data is lost.

This means:
- **Development/testing:** The pipeline works out of the box with just MongoDB. No need to set up Redis or PostgreSQL locally.
- **Production:** Set `REDIS_URL` and `POSTGRES_DSN` in `.env` to enable the full data flow.
- **Partial outage:** If Redis goes down but PostgreSQL is fine (or vice versa), the working store still receives data.

### Configuration

Two new environment variables (added to `.env.example`):

| Variable       | Example Value                                                    | Required? |
|----------------|------------------------------------------------------------------|-----------|
| `REDIS_URL`    | `redis://default:your-password@your-endpoint.upstash.io:6379`   | No        |
| `POSTGRES_DSN` | `postgresql://user:password@your-endpoint.neon.tech/ds440?sslmode=require` | No |

### New Dependencies

| Package            | Purpose                                              |
|--------------------|------------------------------------------------------|
| `redis>=5.0,<6.0`  | Python Redis client for Upstash                     |
| `psycopg[binary]>=3.1,<4.0` | Python PostgreSQL driver (psycopg 3)       |
| `fakeredis>=2.21`  | In-memory Redis fake for tests (dev dependency)      |

### Test Coverage

| Test File               | Tests | Approach       | What's Covered                                                  |
|-------------------------|-------|----------------|-----------------------------------------------------------------|
| `test_redis_cache.py`   | 17    | `fakeredis`    | Key generation, hash formatting, sync writes, TTL, active ticker ranking, round-trip reads, None-client safety |
| `test_pg_store.py`      | 5     | `unittest.mock`| Insert execution, None-conn safety, empty docs, missing ticker skip, row value correctness |

All 22 tests run without any external services. Redis tests use `fakeredis` (an in-memory Redis implementation). PostgreSQL tests use `unittest.mock` to verify SQL calls without a real database.

### Key Files

| File                         | Purpose                                                    |
|------------------------------|------------------------------------------------------------|
| `processing/redis_cache.py`  | Redis connection, key helpers, batched sync, read functions |
| `processing/pg_store.py`     | PostgreSQL connection, schema creation, append-only inserts, history query |
| `tests/test_redis_cache.py`  | 17 Redis cache tests (fakeredis)                           |
| `tests/test_pg_store.py`     | 5 PostgreSQL store tests (mock-based)                      |

---

## D8-D10: Dashboard

### What It Does

A real-time web dashboard that displays the sentiment pipeline's output in a Finviz-style screener table, with drill-down pages for individual tickers and a settings panel. The dashboard is built with Next.js 16, TypeScript, Tailwind CSS, and shadcn/ui components, and deployed to Vercel at a public URL.

### Architecture

The dashboard is a standalone Next.js app inside the `dashboard/` directory. It reads from three databases:

| Database   | What the Dashboard Reads                                   | Used By        |
|------------|-----------------------------------------------------------|----------------|
| Redis      | Active tickers list, current rolling window snapshots     | Screener table (D8) |
| PostgreSQL | Historical window_history rows (time-series)              | Ticker charts (D9)  |
| MongoDB    | finviz_screener (stock fundamentals), posts (recent posts)| D8 + D9             |

The dashboard uses Upstash Redis REST API (`@upstash/redis`), Neon serverless driver (`@neondatabase/serverless`), and the official MongoDB Node.js driver — all work in Vercel's serverless environment without persistent TCP connections.

### D8: Screener Table (Home Page)

A sortable data table showing all active tickers with their sentiment data and stock fundamentals.

**Columns:** Ticker, Price, Market Cap, P/E, Analyst Rating, Sentiment Score, Message Count, Bull/Bear Ratio

**Behavior:**
- Time window selector (1m, 3m, 5m, 10m, 15m, 30m, 60m) changes which rolling window data is displayed
- Sortable by any column (click column headers)
- Color-coded sentiment: green for bullish (>0.2), red for bearish (<-0.2), gray for neutral
- Auto-refreshes every 60 seconds to match pipeline cycle
- Shows "Last sync" timestamp from Redis
- Each row links to the ticker detail page

**API Route:** `GET /api/screener?window=60`
- Reads `active_tickers` sorted set from Redis
- Fetches window hash for each ticker from Redis
- Merges with stock fundamentals from MongoDB `finviz_screener` collection

### D9: Ticker Detail View

A detail page for a single ticker at `/ticker/[symbol]` with historical charts and recent posts.

**Components:**
1. **Sentiment Chart** — Line chart (Recharts) showing avg_sentiment over time from PostgreSQL
2. **Message Density Chart** — Bar chart showing message_count over time from PostgreSQL
3. **Sentiment Breakdown** — Cards showing current bullish/bearish/neutral counts from Redis
4. **Recent Posts** — Table of 20 most recent posts mentioning this ticker from MongoDB, with source badge (Reddit/Bluesky), title, sentiment score, and relative timestamp

**API Routes:**
- `GET /api/ticker/[symbol]` — current window data from Redis + MongoDB finviz
- `GET /api/ticker/[symbol]/history?window=60&hours=24` — historical rows from PostgreSQL
- `GET /api/posts?ticker=TSLA&limit=20` — recent posts from MongoDB

### D10: Config Panel

A settings page at `/settings` with localStorage-only persistence (no backend).

**Settings:**
- Data sources: toggle Reddit and Bluesky sources on/off (display filters only)
- Default time window (which window size loads by default)
- Refresh interval (how often the dashboard auto-refreshes, default 60s)
- Display preferences (rows per page, compact mode)

### Dashboard Tech Stack

| Package                      | Purpose                          |
|------------------------------|----------------------------------|
| `next` 16.2                  | React framework (App Router)     |
| `@upstash/redis`             | Redis REST client for Vercel     |
| `@neondatabase/serverless`   | PostgreSQL serverless driver     |
| `mongodb`                    | MongoDB Node.js driver           |
| `recharts`                   | Line and bar charts              |
| `tailwindcss` 4              | Utility CSS framework            |
| 13 shadcn/ui components      | badge, button, card, input, label, select, separator, skeleton, slider, switch, table, tabs, tooltip |

### Key Files

| File                                   | Purpose                                           |
|----------------------------------------|---------------------------------------------------|
| `dashboard/app/page.tsx`               | Home page — renders ScreenerTable component       |
| `dashboard/app/ticker/[symbol]/page.tsx` | Ticker detail page                              |
| `dashboard/app/settings/page.tsx`      | Settings page                                     |
| `dashboard/app/api/screener/route.ts`  | Screener API — Redis + MongoDB                    |
| `dashboard/app/api/ticker/[symbol]/route.ts` | Single ticker API                            |
| `dashboard/app/api/ticker/[symbol]/history/route.ts` | Historical data API — PostgreSQL     |
| `dashboard/app/api/posts/route.ts`     | Recent posts API — MongoDB                        |
| `dashboard/components/screener-table.tsx` | Main screener table with sort/filter/refresh    |
| `dashboard/components/ticker-detail.tsx`  | Charts, breakdown, and posts for one ticker    |
| `dashboard/components/settings-panel.tsx` | Config form with localStorage                  |
| `dashboard/components/sidebar.tsx`     | Navigation sidebar                                |
| `dashboard/lib/redis.ts`              | Upstash Redis client singleton                     |
| `dashboard/lib/postgres.ts`           | Neon serverless SQL client                         |
| `dashboard/lib/mongodb.ts`            | MongoDB client singleton (serverless-safe)         |
| `dashboard/lib/types.ts`              | TypeScript interfaces (TickerData, Post, etc.)     |
| `dashboard/lib/utils.ts`              | Formatting helpers (numbers, prices, sentiment)    |

---

## D12: Autonomous Pipeline & Deployment

### What It Does

Makes the entire system run end-to-end with zero manual intervention:

1. **GitHub Actions cron job** runs the full pipeline (scrape + process + enrich) every 15 minutes
2. **yfinance enricher** auto-fetches live stock prices, market cap, P/E, and analyst recommendations for all discovered tickers
3. **Vercel deployment** hosts the dashboard at a public URL

### GitHub Actions Pipeline

The workflow at `.github/workflows/pipeline.yml` runs on a cron schedule every 15 minutes and can be triggered manually via `workflow_dispatch`.

**What it does each cycle:**
1. Scrapes Reddit (24 subreddits) and Bluesky (25 cashtag searches) for new posts
2. Runs ticker extraction on untagged posts (D3)
3. Runs dedup/spam filter on unfiltered posts (D4)
4. Scores sentiment on unscored posts (D5)
5. Computes rolling windows for all active tickers (D6)
6. Syncs results to Redis and PostgreSQL (D11)

**Entry point:** `python scripts/run_pipeline.py --once --scrape`

**Timing:** A typical cycle takes 3–5 minutes. The first run after a gap may take longer (up to 10 minutes) if there is a backlog of unprocessed posts. Timeout is set to 12 minutes.

**Reddit on GitHub Actions:** GitHub Actions runners use shared IP addresses that Reddit may block (403 errors). This is expected — Bluesky always works as a reliable backup, contributing ~1,000+ posts per cycle. Reddit blocking is intermittent and varies by runner.

**GitHub Secrets required (7):**

| Secret               | Purpose                            |
|----------------------|------------------------------------|
| `MONGO_URI`          | MongoDB Atlas connection string    |
| `MONGO_DB`           | Database name (`ds440`)            |
| `MONGO_COLLECTION`   | Collection name (`posts`)          |
| `REDIS_URL`          | Upstash Redis TCP URL              |
| `POSTGRES_DSN`       | Neon PostgreSQL connection string   |
| `BLUESKY_HANDLE`     | Bluesky account handle             |
| `BLUESKY_APP_PASSWORD` | Bluesky app password             |

### yfinance Enricher

The file `processing/yfinance_enricher.py` fetches live stock data from Yahoo Finance for all tickers discovered by the rolling window calculator.

**Data fetched per ticker:**

| Field            | Source (yfinance)                    | Stored As           |
|------------------|--------------------------------------|---------------------|
| Price            | `currentPrice` or `regularMarketPrice` | `price` (float)   |
| Market Cap       | `marketCap`                          | `market_cap` (float)|
| P/E Ratio        | `trailingPE` or `forwardPE`          | `pe` (float/null)  |
| Analyst Rating   | `recommendationKey`                  | `analyst_recom` (float, -1.0 to +1.0) |

**Analyst recommendation mapping:**

| yfinance Key     | Normalized Value |
|------------------|-----------------|
| `strong_buy`     | +1.0            |
| `buy`            | +0.5            |
| `hold`           | 0.0             |
| `underperform`   | -0.5            |
| `sell` / `strong_sell` | -1.0      |

Results are upserted into MongoDB `finviz_screener` collection (same collection used by the old Finviz CSV ingestion, so the dashboard works without changes). Tickers enriched within the last hour are skipped to avoid redundant API calls. A 1-second delay between lookups prevents rate limiting.

**Invoked automatically** by `rolling_windows.py` after computing windows — no separate cron job needed.

### Vercel Deployment

The dashboard is deployed to Vercel from the `dashboard/` directory.

**Live URL:** https://dashboard-seven-mauve-17.vercel.app

**Vercel environment variables (5):**

| Variable                   | Purpose                           |
|----------------------------|-----------------------------------|
| `UPSTASH_REDIS_REST_URL`   | Upstash Redis REST endpoint       |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis REST auth token     |
| `POSTGRES_DSN`             | Neon PostgreSQL connection string  |
| `MONGO_URI`                | MongoDB Atlas connection string    |
| `MONGO_DB`                 | Database name (`ds440`)            |

**Important:** The Python pipeline uses Redis TCP (`rediss://...`), while the dashboard uses Redis REST (`https://...`). These are different URLs from the Upstash console.

### Key Files

| File                                    | Purpose                                          |
|-----------------------------------------|--------------------------------------------------|
| `.github/workflows/pipeline.yml`        | GitHub Actions cron workflow (every 15 min)      |
| `scripts/run_pipeline.py`               | One-shot pipeline orchestrator (scrape + process)|
| `processing/yfinance_enricher.py`       | Yahoo Finance stock data enricher                |
| `requirements.txt`                      | Flat Python dependency list for CI               |

---

## How to Run Everything

### Prerequisites

- Python 3.11 or later (3.11 recommended — used in CI)
- MongoDB (local installation or cloud via MongoDB Atlas)
- Redis (optional — Upstash recommended for production)
- PostgreSQL (optional — Neon recommended for production)
- Node.js 18+ (for the dashboard)

### Initial Setup (One Time)

```bash
# 1. Clone the repository
git clone <repo-url>
cd social_pipeline

# 2. Create and activate a virtual environment
python3 -m venv .venv
source .venv/bin/activate

# 3. Set up environment variables
cp .env.example .env
# Edit .env with your MongoDB connection string and Bluesky credentials

# 4. Install the project and its dependencies
pip install -e ".[dev]"
```

### Running Each Component

Each deliverable has a CLI command. They should be run in order the first time (since later stages depend on fields set by earlier stages), but after that they can be run independently.

```bash
# D1: Collect Reddit posts (runs continuously — Ctrl+C to stop)
reddit-scraper

# D2: Collect Bluesky posts (runs continuously — Ctrl+C to stop)
bluesky-scraper

# D3: Extract tickers from all untagged posts
ticker-extractor

# D4: Flag duplicate/spam posts
dedup-filter

# D5: Score sentiment on all unscored posts
sentiment-scorer

# D6: Compute rolling windows for all active tickers
rolling-windows

# D7: Import Finviz structured data
finviz-ingest data/finviz_sample.csv

# D12: Run the full pipeline once (scrape + all processing stages)
python scripts/run_pipeline.py --once --scrape

# Dashboard: Start the Next.js dev server
cd dashboard && npm run dev
```

### Running Tests

```bash
# Run all 198 tests
pytest tests/ -v

# Run tests for a specific deliverable
pytest tests/test_sentiment_engine.py -v     # D5 only
pytest tests/test_rolling_windows.py -v      # D6 only
pytest tests/test_finviz_ingest.py -v        # D7 only
```

---

## Test Suite Summary

The project includes **198 automated tests** that run without any external services (using `mongomock` for MongoDB, `fakeredis` for Redis, and `unittest.mock` for PostgreSQL).

| Deliverable | Test File                      | Tests | What's Covered                                                    |
|-------------|-------------------------------|-------|-------------------------------------------------------------------|
| D1          | `test_reddit.py`               | 27    | Post normalization, HTTP errors, rate limits, full scrape cycles  |
| D1          | `test_db.py`                   | 7     | Database insertion, deduplication, index creation                  |
| D2          | `test_bluesky.py`              | 21    | AT Protocol search, post normalization, cycle integration         |
| D3          | `test_ticker_extraction.py`    | 39    | All 3 regex patterns, false positives, real-world examples        |
| D4          | `test_dedup_filter.py`         | 22    | Similarity calculation, grouping, cross-batch detection           |
| D5          | `test_sentiment_engine.py`     | 23    | Signal counting, scoring formula, batch processing                |
| D6          | `test_rolling_windows.py`      | 18    | Window stats, filtering, upsert behavior, ticker discovery        |
| D7          | `test_finviz_ingest.py`        | 26    | Market cap parsing, percentages, analyst normalization, CSV parse |
| D11         | `test_redis_cache.py`          | 17    | Key generation, hash formatting, sync/read, TTL, active tickers  |
| D11         | `test_pg_store.py`             | 5     | Insert execution, None-conn safety, row value correctness         |
|             |                                | **198** | **Total**                                                       |

All tests pass as of March 27, 2026.

---

## Project File Structure

```
social_pipeline/
├── CLAUDE.md                           # AI assistant instructions
├── Rohan_Project_Plan_DS440.md         # Full project plan
├── pyproject.toml                      # Python project config & CLI scripts
├── requirements.txt                    # Flat Python dependencies for CI
├── .env.example                        # Template for credentials
│
├── .github/
│   └── workflows/
│       └── pipeline.yml               # D12: GitHub Actions cron (every 15 min)
│
├── scripts/
│   └── run_pipeline.py                # D12: Full pipeline orchestrator
│
├── docs/
│   ├── Pipeline_Documentation.md      # This document
│   ├── D1_Reddit_Scraper.md           # D1 detailed documentation
│   ├── Handoff_Guide.md              # Dashboard developer handoff guide
│   └── Figma_Make_Prompt.md          # Figma Make design prompt
│
├── data/
│   └── finviz_sample.csv              # Sample Finviz export (10 tickers)
│
├── scrapers/
│   ├── config.py                      # All settings — subreddits, delays, DB, windows
│   ├── db.py                          # MongoDB connection, indexes, bulk insert
│   ├── reddit.py                      # D1: Reddit scraper
│   └── bluesky.py                     # D2: Bluesky scraper
│
├── processing/
│   ├── ticker_data.py                 # D3: Valid tickers (~10,000) & false positive list
│   ├── ticker_extraction.py           # D3: Ticker extraction logic & CLI
│   ├── dedup_filter.py                # D4: Near-duplicate detection & CLI
│   ├── sentiment_data.py              # D5: Bullish/bearish lexicon (phrases, words, emojis)
│   ├── sentiment_engine.py            # D5: Sentiment scoring logic & CLI
│   ├── rolling_windows.py            # D6: Rolling window computation & CLI (+ D11 sync)
│   ├── finviz_ingest.py              # D7: Finviz CSV parser & CLI
│   ├── yfinance_enricher.py          # D12: Yahoo Finance stock data enricher
│   ├── redis_cache.py                # D11: Redis cache sync & read functions
│   └── pg_store.py                   # D11: PostgreSQL append-only history
│
├── dashboard/                          # D8-D10: Next.js dashboard (deployed to Vercel)
│   ├── app/
│   │   ├── layout.tsx                 # Root layout with sidebar, dark theme
│   │   ├── page.tsx                   # D8: Screener table (home page)
│   │   ├── globals.css                # Dark theme CSS variables
│   │   ├── ticker/
│   │   │   └── [symbol]/
│   │   │       └── page.tsx           # D9: Ticker detail view
│   │   ├── settings/
│   │   │   └── page.tsx               # D10: Config panel
│   │   └── api/
│   │       ├── screener/route.ts      # Screener API (Redis + MongoDB)
│   │       ├── posts/route.ts         # Recent posts API (MongoDB)
│   │       └── ticker/[symbol]/
│   │           ├── route.ts           # Single ticker API (Redis + MongoDB)
│   │           └── history/route.ts   # Historical data API (PostgreSQL)
│   ├── components/
│   │   ├── screener-table.tsx         # Main data table with sort/filter/refresh
│   │   ├── ticker-detail.tsx          # Charts + breakdown + posts
│   │   ├── settings-panel.tsx         # Config form (localStorage)
│   │   ├── sidebar.tsx                # Navigation sidebar
│   │   └── ui/                        # 13 shadcn/ui components
│   ├── lib/
│   │   ├── redis.ts                   # Upstash Redis client
│   │   ├── postgres.ts                # Neon serverless SQL client
│   │   ├── mongodb.ts                 # MongoDB client singleton
│   │   ├── types.ts                   # TypeScript interfaces
│   │   └── utils.ts                   # Formatting helpers
│   ├── package.json
│   ├── tailwind.config.ts
│   └── .env.local                     # Dashboard env vars (gitignored)
│
└── tests/
    ├── conftest.py                    # Shared test fixtures (mongomock collections)
    ├── test_db.py                     # D1: Database layer tests (7)
    ├── test_reddit.py                 # D1: Reddit scraper tests (27)
    ├── test_bluesky.py                # D2: Bluesky scraper tests (21)
    ├── test_ticker_extraction.py      # D3: Ticker extraction tests (39)
    ├── test_dedup_filter.py           # D4: Dedup filter tests (22)
    ├── test_sentiment_engine.py       # D5: Sentiment engine tests (23)
    ├── test_rolling_windows.py        # D6: Rolling window tests (18)
    ├── test_finviz_ingest.py          # D7: Finviz ingestion tests (26)
    ├── test_redis_cache.py            # D11: Redis cache tests (17)
    └── test_pg_store.py               # D11: PostgreSQL store tests (5)
```
