# D1: Reddit Scraper — Technical Documentation

## Overview

The Reddit scraper is the first data collection component of the sentiment pipeline. It automatically and continuously collects stock-related posts from 24 finance-focused subreddit communities, normalizes them into a shared schema, and stores them in MongoDB with automatic deduplication. It is designed to run indefinitely, cycling through all target subreddits every few minutes.

---

## Technical Approach

### Why curl_cffi?

Reddit actively blocks standard Python HTTP libraries (like `requests` or `urllib3`) by inspecting the **TLS fingerprint** of incoming connections. Every HTTP client has a unique fingerprint based on how it negotiates the TLS handshake (cipher suites, extensions, ordering). Reddit compares this fingerprint against known browser profiles and returns HTTP 403 for anything that looks automated.

The `curl_cffi` library solves this by wrapping libcurl with the `impersonate` feature, which mimics the exact TLS fingerprint of a real browser. The scraper uses `impersonate="chrome124"` to present itself as Google Chrome 124. Combined with a realistic `User-Agent` header, this makes the scraper's requests indistinguishable from a human browsing with Chrome.

### Why old.reddit.com?

The scraper uses `old.reddit.com` (Reddit's legacy interface) instead of `www.reddit.com` for two reasons:

1. **Simpler anti-bot protections.** The new Reddit frontend has more aggressive JavaScript challenges and fingerprinting. The old interface relies primarily on rate limiting.
2. **Cleaner JSON endpoints.** Appending `.json` to any old.reddit.com URL returns structured data without needing API keys or OAuth tokens.

### JSON Endpoints

Each subreddit is fetched using this URL pattern:

```
https://old.reddit.com/r/{subreddit}/new.json?limit=100&raw_json=1
```

- `new` sorts by newest first, so the most recent posts are always captured.
- `limit=100` fetches the maximum number of posts per request.
- `raw_json=1` disables Reddit's HTML entity encoding, giving clean text.
- Pagination is supported via the `after` query parameter (though the scraper currently fetches only the first page per cycle, which is sufficient for continuous monitoring).

No API key, OAuth token, or Reddit account is required.

---

## Rate Limiting Strategy

Reddit does not publish official rate limits for its JSON endpoints, but empirical testing shows that requests spaced 4-6 seconds apart are reliable. The scraper implements a multi-layer rate limiting strategy:

| Mechanism                  | Details                                                              |
|----------------------------|----------------------------------------------------------------------|
| **Base delay**             | 4.0 seconds between subreddit fetches                                |
| **Random jitter**          | 0.5-2.0 seconds of additional random delay (prevents predictable patterns) |
| **Cycle delay**            | 30-60 seconds of random wait between full cycles through all subreddits |
| **Escalating backoff**     | On 3+ consecutive HTTP 429 errors, the delay doubles each time (up to 5 minutes max) |
| **Backoff reset**          | Any successful request resets the backoff counter and delay to normal |
| **Sequential only**        | One request at a time, no parallelism from the same IP               |

A full cycle through all 24 subreddits takes approximately 2-3 minutes. With the cycle delay, the scraper checks each subreddit roughly once every 3-4 minutes.

---

## Post Normalization and Filtering

Every raw Reddit JSON "thing" is converted into the project's shared post schema before storage. This normalization ensures that posts from Reddit and Bluesky (D2) have identical field structures, so the entire processing pipeline (D3-D7) works identically regardless of source.

### Fields Collected

| Field          | Source                                     | Example                            |
|----------------|--------------------------------------------|------------------------------------|
| `id`           | Reddit's fullname (`data.name`)            | `t3_1s3abc`                        |
| `source`       | Hardcoded                                  | `"reddit"`                         |
| `subreddit`    | Passed from the scrape loop                | `"wallstreetbets"`                 |
| `author`       | `data.author`                              | `"diamond_hands_42"`               |
| `title`        | `data.title`                               | `"YOLO'd my savings into GME"`     |
| `text`         | `data.selftext`                            | `"Diamond hands forever..."`       |
| `url`          | Built from `data.permalink`                | `"https://www.reddit.com/r/..."`   |
| `score`        | `data.score` (net upvotes)                 | `142`                              |
| `num_comments` | `data.num_comments`                        | `37`                               |
| `published_at` | `data.created_utc` converted to UTC datetime | `2026-03-27 11:15:00+00:00`     |
| `detected_at`  | Current UTC time when the scraper finds it | `2026-03-27 11:17:00+00:00`       |
| `content_hash` | SHA-256 of title + text                    | `a1b2c3d4...`                      |

### Filtering Rules

Posts are filtered out (not stored) if any of these conditions are true:

| Condition                         | Why                                                      |
|-----------------------------------|----------------------------------------------------------|
| Author is `[deleted]`             | The user deleted their account or post                   |
| Author is `[removed]`             | A moderator removed the post                             |
| Author is empty                   | Malformed data                                           |
| Selftext is `[removed]`           | Post body was removed by moderators                      |
| Selftext is `[deleted]`           | Post body was deleted by the author                      |

These checks happen during normalization. The `normalize_post` function returns `None` for filtered posts, so they are silently excluded before any database operation.

### Content Hashing

Each post gets a SHA-256 hash of its title and body text (separated by a null byte). This `content_hash` field is used later by the deduplication filter (D4) for near-duplicate detection. It also provides a fast way to check if a post's content has changed between scrape cycles.

---

## MongoDB Storage and Dedup

### Connection

The scraper connects to MongoDB using the `MONGO_URI` environment variable (defaults to `mongodb://localhost:27017`). The database name and collection name are also configurable via `MONGO_DB` and `MONGO_COLLECTION`.

### Indexes

On startup, the database layer creates five indexes (idempotently, so re-running is safe):

| Index Name          | Fields                  | Properties | Purpose                                           |
|---------------------|-------------------------|------------|---------------------------------------------------|
| `idx_id_unique`     | `id`                    | Unique     | Primary dedup mechanism — prevents duplicate posts |
| `idx_source`        | `source`                |            | Fast filtering by platform (reddit vs. bluesky)   |
| `idx_detected_at`   | `detected_at`           |            | Time-range queries for the processing pipeline    |
| `idx_subreddit`     | `subreddit`             |            | Per-community queries                             |
| `idx_source_author` | `(source, author)`      | Compound   | Used by the dedup filter (D4) for author grouping |

### Bulk Insert with Dedup

Posts are inserted using `insert_many(ordered=False)`. The `ordered=False` flag is critical: it tells MongoDB to attempt every insert in the batch, even if some fail. When a post's `id` collides with the unique index (because it was already stored in a previous cycle), MongoDB raises a duplicate key error for that document but still inserts all the other documents in the batch.

The `upsert_posts` function catches these `BulkWriteError` exceptions, counts how many were duplicate-key errors (error code 11000) versus unexpected errors, and returns the number of newly inserted documents. Unexpected errors are re-raised.

This approach means the scraper is **idempotent** — running it multiple times over the same posts simply skips the duplicates with zero data loss.

---

## Error Handling

The scraper is built to run unattended for hours or days. Every error condition is handled to prevent crashes:

| Situation                      | Behavior                                                                |
|--------------------------------|-------------------------------------------------------------------------|
| HTTP 429 (rate limited)        | Logs a warning, increments the consecutive-429 counter. After 3+ consecutive 429s, doubles the backoff delay (capped at 5 minutes). Retries on the next cycle. |
| HTTP 403 (private/quarantined) | Logs a warning and skips to the next subreddit. Does not retry.         |
| HTTP 404 (subreddit not found) | Logs a warning and skips to the next subreddit. Does not retry.         |
| Network error (connection refused, timeout) | Logs the exception and skips to the next subreddit. Retried on the next cycle. |
| Unexpected exception           | Logs the full traceback and skips to the next subreddit. The cycle continues. |
| SIGINT / SIGTERM (Ctrl+C)      | Sets a shutdown event. The current operation finishes, then the scraper exits cleanly. No abrupt termination. |

### Graceful Shutdown

The scraper uses a `threading.Event` for graceful shutdown. When `SIGINT` or `SIGTERM` is received:

1. The signal handler sets the shutdown event.
2. All `time.sleep` calls are replaced with `event.wait(timeout=...)`, which returns immediately when the event is set.
3. The cycle loop checks the event before each subreddit and aborts early if set.
4. The MongoDB connection is closed in a `finally` block.

This means pressing Ctrl+C always results in a clean exit — no orphaned connections, no partial writes.

---

## Target Subreddits (24)

| Category               | Communities                                                                                                  |
|------------------------|--------------------------------------------------------------------------------------------------------------|
| WallStreetBets family  | wallstreetbets, wallstreetbets2, wallstreetbets_wins, wallstreetbetsELITE, wallstreetbetsnew, wallstreetelite |
| Small/penny stocks     | wallstreetsmallcap, smallstreetbets, pennystocks, pennystock, 10xpennystocks                                 |
| General market          | thewallstreet, stockmarket, stocks, stocks_picks, stocksandtrading, stockstobuytoday                         |
| Trading-focused         | stocktradingalerts, swingtrading, trading, trakstocks, shortsqueeze                                          |
| Other                   | stockaday, options                                                                                           |

---

## First Run Results (March 27, 2026)

- Scraped 22 of 24 subreddits successfully
- Collected **2,049 posts** in approximately 3 minutes
- Skipped r/wallstreetbets (quarantined, HTTP 403) and r/stockaday (no longer exists, HTTP 404)

---

## Test Coverage

The scraper has **34 automated tests** across two test files. All tests run without any external services — HTTP calls are mocked with `unittest.mock` and MongoDB uses `mongomock` (an in-memory MongoDB implementation).

### test_reddit.py (27 tests)

| Test Class               | Tests | What's Covered                                                          |
|--------------------------|-------|-------------------------------------------------------------------------|
| `TestNormalizePost`      | 8     | Happy path field mapping, deleted/removed author filtering, removed selftext filtering, empty author filtering, missing optional fields, empty data dict |
| `TestFetchSubredditPosts`| 5     | Successful 200 response parsing, HTTP 429 raising `RateLimitError`, HTTP 403 raising `PrivateSubredditError`, network error propagation, pagination `after` parameter |
| `TestScrapeCycle`        | 14    | Multi-subreddit insertion, dedup across cycles, rate limit skip-and-continue, private subreddit skip, shutdown event abort, deleted post filtering during cycles, unexpected error logging and continuation |

### test_db.py (7 tests)

| Test Class            | Tests | What's Covered                                                          |
|-----------------------|-------|-------------------------------------------------------------------------|
| `TestUpsertPosts`     | 4     | Inserting new posts, duplicate skipping, mixed new+duplicate batches, empty list handling |
| `TestEnsureIndexes`   | 3     | Correct index creation (5 indexes + _id), unique constraint on id index, idempotent re-creation |

---

## Key Files

| File                | Purpose                                                    |
|---------------------|------------------------------------------------------------|
| `scrapers/reddit.py`   | Core scraper — fetching, normalization, cycle loop, graceful shutdown |
| `scrapers/db.py`       | MongoDB connection, index creation, bulk insert with dedup  |
| `scrapers/config.py`   | All settings — subreddit list, delays, timeouts, DB config  |
| `tests/test_reddit.py` | 27 automated tests for scraper logic                        |
| `tests/test_db.py`     | 7 automated tests for the database layer                    |
