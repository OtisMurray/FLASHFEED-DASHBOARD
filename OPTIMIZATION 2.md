# FlashFeed — Optimization & Changes (one document)

This covers everything from this round: making **Run Now** fast, the **Kafka + Redis RAM layer**, the **Charts top‑50 dropdown**, **Settings custom stocks**, the bug check, and how to run it.

---

## 1. Run Now speed — what I found and what I changed

**Run Now** → `POST /api/fetch` → `runDataRefreshCycle()` → runs the Python fetchers. Good news from the audit: the pipeline was **already parallel** — the orchestrator fires every fetcher at once with `Promise.all`, each via `execFile`, and the RSS fetcher already uses a `ThreadPoolExecutor` with per‑request HTTP timeouts. So the work was **tuning**, not a rewrite. Total fast‑fetch time = the *slowest single fetcher*, and that was the RSS step (28 feeds, only 8 workers, 15 s per‑feed timeout, 45 s script cap).

Changes applied (all additive, fallbacks preserved):

| Knob | Before | After | Why |
|---|---|---|---|
| RSS workers (`RSS_MAX_WORKERS`) | 8 | **16** default, **24** in fast mode | 28 feeds now fetch effectively all at once → total ≈ slowest *single* feed, not batches |
| Per‑feed HTTP timeout (`RSS_HTTP_TIMEOUT`) | hard‑coded 15 s | **tunable; 7 s in fast mode** | a slow/dead feed is abandoned in 7 s instead of stalling the batch |
| RSS script cap (fast) | 45 s | **25 s** | bounds the worst case for the whole cycle |
| Reads (`/api/screener`, `/api/social/rolling`) | Mongo aggregation every call | **Redis RAM cache** (20 s / 15 s TTL) | repeat dashboard reads are served from memory, not recomputed |

**Expected impact:** with healthy feeds, the fast cycle is dominated by the few slowest sources; raising concurrency to ≥ the feed count and cutting the per‑feed timeout to 7 s puts a typical fast Run Now in the **single‑digit‑seconds** range, with a hard ceiling well under the old 45 s. The dashboard reads that follow are near‑instant from the Redis cache (look for `X‑Cache: HIT`).

> Honest caveat: I can't put a stopwatch on it in this sandbox (no live Mongo/Redis/Kafka/network here). The numbers above are the levers; actual wall‑clock depends on your network and how fast each news source responds. Tune the env knobs below to trade freshness vs. speed.

### Tuning knobs (env vars)
- `RSS_MAX_WORKERS` — feed concurrency (default 16; fast mode 24). Set to ≥ number of feeds for max parallelism.
- `RSS_HTTP_TIMEOUT` — seconds per feed before giving up (fast mode 7). Lower = faster, but very slow feeds may be skipped.
- `CACHE_TTL_SCREENER` / `CACHE_TTL_SOCIAL` — RAM cache freshness (default 20 / 15 s).
- Fast mode already caps quote tickers to ~25 and social to ~10–12 movers, skips the TradingView numeric screener, and skips Benzinga/IBKR/Schwab when no API key is set. For the very fastest Run Now, leave it in **Fast** mode.

---

## 2. Kafka + Redis RAM layer (kept, and now wired end‑to‑end)

```
fetchers ─publish→ Kafka ─→ consumer ─┬→ Redis feed:{TICKER}  (hot RAM window, TTL+trim)
                                       └→ MongoDB events       (durable)
dashboard → /api/screener, /api/social/rolling → Redis cache (RAM) ─hit→ instant ; miss→ Mongo→compute→cache
dashboard → /api/feed/:ticker → Redis feed:{TICKER} → recent events + avg sentiment
```

- Backend now has an `ioredis` client with **graceful fallback** (Redis down → Mongo, never breaks).
- New endpoint **`GET /api/feed/:ticker`** reads the consumer's hot window.
- `KAFKA_PUBLISH_NEWS=true` in `docker-compose.yml` so data flows into the pipeline.
- See `DEPLOY-RAM.md` for hosting. (Redis hosts free on Upstash; full Kafka stack runs via `docker compose` or a ~$5/mo VPS — there is no free managed‑Kafka tier anymore.)

---

## 2b. RAM-first I/O minimization (Redis + Kafka)

Per the "keep critical data in RAM, minimize disk I/O" goal:

- **Redis is now pure in-memory** — started with `--save "" --appendonly no`, so it never writes RDB snapshots or an AOF to disk. Zero Redis disk I/O; MongoDB stays the durable store. (LRU eviction at 512 MB is kept so it can't grow unbounded.)
- **Kafka buffers in the OS page cache (RAM) and only flushes to disk every ~5 minutes** — `KAFKA_LOG_FLUSH_INTERVAL_MS=300000` plus a very high `KAFKA_LOG_FLUSH_INTERVAL_MESSAGES`. Kafka already leaned on the page cache; this makes the "RAM database that persists every few minutes" behavior explicit and infrequent.
- **Producer reuse + bounded flush** — the news publisher reuses one Kafka producer (no per-call connect/metadata handshake) and caps `flush(5)`, so a slow/unreachable broker can't add more than ~5 s to Run Now.
- **Wider RAM read cache + auto-pipelining** — the Redis response cache now also covers `/api/charts/*`, `/api/momentum`, `/api/correlation`, `/api/articles`, and the new `/api/ai/*` (60 s), and the ioredis client has `enableAutoPipelining` on for fewer round-trips.

> Trade-off (by design): if Redis or the broker restarts, anything not yet flushed is rebuilt from MongoDB / re-consumed from Kafka — a small durability window in exchange for near-zero steady-state I/O.

## 2c. AI features

**AI Overview (Overview tab).** A card calling `GET /api/ai/overview` that shows the market mood (risk-on / risk-off / mixed), a one-paragraph summary, and the strongest bullish/bearish tickers from the last few days of news.

**AI tab.** A new top-nav tab calling `GET /api/ai/scores` — a per-ticker **directional score (−100…+100)** with an up/down arrow, a confidence bar (scaled by how many articles back it), article count, and the bullish/bearish split, with a 3 / 7 / 14-day window selector.

How the score works: it aggregates the per-article sentiment the FinBERT + LLM stage already produced, over the chosen window, into a volume-weighted directional score per ticker. It runs off existing data (no extra paid API required) and is cached in Redis for 60 s. The endpoints are defensive about field names and degrade gracefully on an empty collection; set `ARTICLES_COLLECTION` if your news collection isn't named `articles`. (Natural next step: an LLM-written one-line rationale per ticker — the endpoints are structured to drop that in.)

## 3. New features

**Charts → top‑50 dropdown.** A ticker dropdown (top‑50 large caps) sits left of the symbol box in the Charts toolbar; picking one loads that chart instantly. Your **custom stocks appear at the top** of this list.

**Settings → Custom Stocks.** A new section to add/remove your own tickers (chips with an ×). They're saved in the browser and immediately show up in the Charts dropdown. (Shared module: `app/src/lib/stocks.ts`.)

Both verified end‑to‑end in the screenshots: a custom stock added in Settings (SHOP/COIN/RBLX) was then selected from the Charts dropdown and its chart loaded.

---

## 4. Bug check (this round)

- ✅ `node --check` passes on the modified `index.js`; `py_compile` passes on the modified RSS fetcher.
- ✅ Redis cache keys (`/api/screener`, `/api/social/rolling`) exactly match the real mounted routes, and the cache middleware is registered before them so it actually intercepts.
- ✅ `/api/feed/:ticker` isn't shadowed by the routers.
- ✅ Frontend builds clean (`vite build`) with the new dropdown + Settings section.
- ✅ All 8 tabs render with data (Overview, News, Screener, Social, Charts, Momentum, Correlation, Settings).
- ✅ Retracted a prior false positive: `producer.flush()` is bounded (10 s default).
- Still open from `BUG_REPORT.md` (not auto‑fixed, low risk): duplicate `pages/` vs `components/` page files (dead code), a couple of `Array.isArray` guards worth adding defensively, committed `*.bak` files. Say the word and I'll clean these.

---

## 5. How to run it

```bash
# from the project root, with .env present (Atlas/local Mongo URI + FINVIZ_AUTH_TOKEN)
docker compose up -d                         # mongo + redis + kafka + zookeeper + backend + consumer
curl localhost:3001/api/health               # {status: ok}
# open the UI (frontend dev or your deploy), click Run Now (Fast) → news refreshes in seconds
curl -s -D- localhost:3001/api/screener -o /dev/null | grep -i x-cache   # MISS then HIT
curl "localhost:3001/api/feed/AAPL?limit=10"                              # hot RAM window
```

Free/always‑up hosting paths are in `DEPLOY-FREE.md` (free) and `DEPLOY-RAM.md` (full Kafka+Redis). Everything is in `FlashFeed-complete.zip`.
