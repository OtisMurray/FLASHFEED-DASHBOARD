# FlashFeed — Bug & Glitch Audit

Scope: static review of the live frontend (`app/`), the Express API (`Infrastructure/server/index.js`), the Python pipelines (`1_News`, `2_Screener`), the Kafka layer, and `docker-compose.yml`. Severity = impact × likelihood. Line numbers are approximate.

Several things were checked and found **correct** (not bugs): the auto‑watch SSE *does* clear its interval on `req.on("close")`; the source‑registry `JSON.parse` *is* inside a try/catch; the client `EventSource` *is* closed on manual stop; the Kafka `KAFKA_ADVERTISED_LISTENERS` are right for local compose; the consumer commits its offset only after both the Redis and Mongo writes succeed; the Kafka producer/consumer/config/models and all 5 hooked fetchers compile clean.

---

## Second-pass update

**H2 (NEW, most important) — the RAM/Kafka layer is write-only relative to the UI.**
The Express API has **no Redis or Kafka client** — `Infrastructure/server/package.json` depends only on `express` + `mongoose`, and every "rolling" view (e.g. `GET /api/social/rolling`, charts density/sentiment) is built by **MongoDB aggregation** on the `socials`/`articles` collections (`db.collection("socials").aggregate(...)`). Meanwhile the Kafka consumer writes the hot rolling window to Redis under `feed:{TICKER}` (plus an `events` Mongo collection). **Nothing in the API reads those `feed:` keys**, so the Kafka→Redis path runs end‑to‑end but is never surfaced to the dashboard.

The publish step I added is correct and additive (it feeds Kafka, which feeds Redis), but for the RAM layer to actually *power* the UI (the "Kafka as RAM, persist to disk every few minutes, minimize I/O" goal) the read side must be connected. The original backend was deliberately left unchanged, so this is a wiring gap, not a regression.
*Fix (additive, no change to existing endpoints):* add a Redis client to the backend and a new `GET /api/feed/:ticker` that returns `feed:{ticker}` from Redis (fast hot read), optionally falling back to the existing Mongo aggregation on a cache miss. I can add this on request.

**✅ RESOLVED.** Wired in: the backend now connects to Redis (`ioredis`), transparently caches the heavy `/api/screener` and `/api/social/rolling` aggregations in RAM (short TTL, identical JSON shape), and serves the consumer's hot rolling window via `GET /api/feed/:ticker` — all with graceful MongoDB fallback if Redis is down. `KAFKA_PUBLISH_NEWS` is now enabled in `docker-compose.yml` so data flows fetch → Kafka → consumer → Redis → API. See `DEPLOY-RAM.md`.

**Correction — L4 below is RETRACTED (false positive).** `Infrastructure/kafka/producer.py` defines `flush(self, timeout: float = 10.0)`, and `news_publisher.publish_articles()` calls `producer.flush()`, so the flush **is** bounded to 10 s. No change needed.

---

## High

**H1 — Duplicate, divergent page components (dead code).**
`ScreenerPage`, `ChartsPage`, `SocialPage`, `MomentumPage`, and `CorrelationPage` each exist **twice**:
- live: `app/src/pages/*.tsx`  ← the only versions `app/src/App.tsx` imports
- dead: `app/src/components/<feature>/*.tsx`  ← imported by nothing

The two copies have **already diverged** — e.g. `components/social/SocialPage.tsx` calls the API through a `VITE_API_BASE_URL` base, while the live `pages/SocialPage.tsx` uses relative `/api`. Risk: edits land in the wrong file, behavior silently differs, and the dead tree bloats/poisons grep results.
*Fix:* delete the unused `components/<feature>/*Page.tsx` duplicates (or re‑export the `pages/` versions from them). Confirm with a build after removal.

---

## Medium

**M1 — Outbound HTTP calls without an explicit timeout (pipeline can hang).**
Several fetcher requests don't pass a `timeout` on the call line, e.g. `1_News/pipeline/fetch_rss_to_mongo.py:166`, `1_News/pipeline/fetch_benzinga_to_mongo.py:74`, `1_News/pipeline/fetch_rss.py:319`. A stalled upstream blocks the request indefinitely. This compounds with the auto‑watch loop: `runFetchCycle` has an `isRunning` guard, so one hung fetch **stalls every later cycle**.
*Fix:* pass `timeout=(5, 15)` (connect, read) to every `requests`/`curl_cffi` call and wrap in a short retry/backoff.

**M2 — `CorrelationPage` blanks the whole tab if the API returns an array.**
`app/src/pages/CorrelationPage.tsx:12` — `const entries = data?.entries ?? data?.results ?? []`. If `data` is ever a bare array, `data.entries` resolves to **`Array.prototype.entries` (a function)**, the `?? results ?? []` fallback never fires, and the later `entries.filter(...)` throws `r.filter is not a function`, leaving the tab blank. (Reproduced during screenshot testing.)
*Fix:* `const entries = Array.isArray(data) ? data : (data?.entries ?? data?.results ?? [])`.

**M3 — News sidebar assumes `stats.sources`/`stats.categories` are arrays.**
`app/src/pages/NewsPage.tsx:26` feeds `stats?.sources ?? []` into `NewsSidebar`, which does `sources.map(...)` (`NewsSidebar.tsx:31,54`). If the stats endpoint returns a non‑array for `sources` (e.g. a count), `.map` throws and the **entire News tab renders blank** (no error boundary). (Reproduced during screenshot testing.)
*Fix:* guard with `Array.isArray(...)` before `.map`, or normalize in `NewsPage` before passing down. Consider adding a React error boundary around `<main>` so one bad payload can't blank a whole route.

**M4 — Committed backup files in the source tree.**
`app/src/pages/SettingsPage.tsx.bak_ryan_settings`, `docker-compose.yml.bak_fetch_button_fix`, `docker-compose.yml.bak_sentiment_worker`. These confuse "which file is real" and ship in the bundle dir.
*Fix:* remove `*.bak*` from the repo and add `*.bak*` to `.gitignore`.

---

## Low / Nits

**L1 — `ChartsPage` shadows the global `setInterval`.**
`app/src/pages/ChartsPage.tsx` — `const [interval, setInterval] = useState(...)`. No live bug today (the component doesn't schedule timers), but any future `setInterval(fn, ms)` in that file would set React state instead of starting a timer.
*Fix:* rename to `[barInterval, setBarInterval]`.

**L2 — `parseInt` without radix + NaN filter wipeout.**
`app/src/pages/ScreenerPage.tsx:102,173` — `parseInt(filters.avg_volume)` / `parseInt(filters.min_posts)`. Missing radix, and if the filter value is `undefined` the result is `NaN`; every `value >= NaN` comparison is `false`, so setting the filter silently removes **all** rows.
*Fix:* `parseInt(x ?? '', 10)` and short‑circuit when the parse is `NaN`.

**L3 — Verify `EventSource` cleanup on unmount.**
`app/src/components/shared/TopBar.tsx:118` — `toggleWatch` closes the stream on manual stop (good), but confirm a `useEffect(() => () => watchRef.current?.close(), [])` exists so navigating away **mid‑watch** doesn't leave an open SSE connection reconnecting in the background.

**L4 — Kafka `flush()` can block the fetcher if the broker is down.**
`Infrastructure/kafka/news_publisher.py` `publish_articles()` calls `producer.flush()` with no timeout. The fetcher hook catches the exception, but a bounded flush avoids a long stall when Kafka is unreachable.
*Fix:* `producer.flush(timeout=10)` (or pass a delivery timeout in producer config). *(This is in the code I added.)*

---

## Secrets / hygiene

**S1 — Live Finviz token exposed.**
The Elite token is in `.env` (correctly gitignored) but has been shared in chat and is bundled in `FlashFeed-complete.zip` so the app runs out‑of‑the‑box. **Rotate the token** after testing and keep the zip private. For deploys, set `FINVIZ_AUTH_TOKEN` as a platform secret rather than committing it.

---

## Suggested quick wins (in order)
1. Delete the duplicate `components/*Page.tsx` files (H1) and rebuild.
2. Add `Array.isArray` guards in `CorrelationPage` and `NewsPage` + one error boundary (M2/M3) — cheap insurance against any one bad payload blanking a tab.
3. Add timeouts to the Python HTTP calls (M1).
4. Remove `*.bak*`, rotate the token (M4/S1).
