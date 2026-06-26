# Keeping Kafka + Redis — the RAM-speed stack

You asked to keep Kafka and Redis so the app has RAM-based speed. That's now wired end-to-end. This explains what changed, how the speed works, and where to host it (with an honest note on what's free).

## What the RAM layer now does

```
fetchers ──publish──▶ Kafka (flashfeed-events) ──▶ kafka-consumer ──┬─▶ Redis  feed:{TICKER}   (hot RAM window, TTL + trimmed)
  (Run Now / watch)                                                 └─▶ MongoDB events         (durable disk copy)

dashboard ──GET /api/screener, /api/social/rolling──▶ backend ──▶ Redis cache (RAM) ──hit?──▶ instant
                                                                         └─miss─▶ MongoDB aggregation ─▶ compute ─▶ cache in Redis
dashboard ──GET /api/feed/:ticker──────────────────▶ backend ──▶ Redis feed:{TICKER} (RAM) ─▶ rolling events + avg sentiment
```

Code changes (all additive — existing routes untouched, MongoDB stays the source of truth and the fallback):
- **Redis client** added to `Infrastructure/server/index.js` (`ioredis`), with graceful degradation: if Redis is unreachable, every path falls back to Mongo and the app keeps working.
- **Transparent RAM cache** in front of the two heaviest reads (`/api/screener`, `/api/social/rolling`): same JSON, served from RAM within a short TTL (`CACHE_TTL_SCREENER`=20s, `CACHE_TTL_SOCIAL`=15s by default). Responses carry an `X-Cache: HIT|MISS` header so you can see it working.
- **`GET /api/feed/:ticker`** — reads the consumer's hot window straight from Redis (`feed:{TICKER}` ZSet → `event:{id}` hashes) and returns the recent events + a rolling average sentiment.
- **`KAFKA_PUBLISH_NEWS` enabled** in `docker-compose.yml` so fetched news/social actually flows into the pipeline.

## Run it locally / on a server (full stack, no cold starts)

The whole RAM stack is already defined in `docker-compose.yml` (mongo + redis + zookeeper + kafka + kafka-init + backend + kafka-consumer). From the project root with your `.env` present:

```bash
docker compose up -d
# watch the RAM layer come alive:
docker compose logs -f kafka-consumer          # "Redis hit / writing event ..."
curl localhost:3001/api/health
# trigger a fetch (or click Run Now in the UI), then read the hot window:
curl "localhost:3001/api/feed/AAPL?limit=10"   # source:"redis" once events have flowed
# and watch the cache: first call MISS, repeat calls HIT
curl -s -D- "localhost:3001/api/screener" -o /dev/null | grep -i x-cache
```

## Hosting it always-up — the honest reality

The RAM speed comes from **Redis**; **Kafka** is the streaming transport. Their free-hosting stories are very different:

| Component | Free always-up option | Notes |
|---|---|---|
| **Redis** | ✅ **Upstash** (serverless Redis, free tier) or Render Key Value | Easy, always-on. This alone powers the RAM **cache**. |
| **MongoDB** | ✅ Atlas M0 (free) | Always-on, 512 MB. |
| **Frontend** | ✅ Vercel / Netlify / Cloudflare Pages | Always up. |
| **Backend** | ⚠️ Render free (sleeps; keep-warm ping) | Runs the API + fetchers. |
| **Kafka + consumer** | ❌ **No good free managed tier** | Upstash Kafka was discontinued; CloudKarafka shut down; Confluent/Redpanda/Aiven are paid/trial only. |

So there are two realistic paths:

**Path 1 — Full Kafka + Redis, always-up, cheap (recommended for the complete RAM pipeline).**
Run the entire `docker-compose.yml` on one small VPS (e.g. a 1 GB DigitalOcean/Hetzner/Linode droplet, ~$5–6/mo). Everything — Mongo, Redis, Kafka, Zookeeper, backend, consumer — lives on one box, always on, **no cold starts**, full streaming RAM pipeline active. Point your Vercel frontend's `/api` rewrite at the droplet (put Caddy in front for HTTPS, ~6 lines). This is the cleanest home for "keep Kafka + Redis," and it's cheap rather than free because nobody offers free always-on Kafka anymore.

**Path 2 — Free, RAM-speed via the Redis cache (Kafka stays in the code, off in prod).**
Use the free stack from `DEPLOY-FREE.md` **plus a free Upstash Redis**: set `REDIS_URL` on the Render backend to your Upstash URL. You immediately get the **RAM cache** speedup on `/api/screener` and `/api/social/rolling` (the `X-Cache: HIT` path) for free — no Kafka needed for that. Set `KAFKA_PUBLISH_NEWS=false` on the free deploy. The streaming hot-window (`/api/feed/:ticker`) stays empty until you run the consumer (Path 1), but the dashboard reads are already coming from RAM.

> TL;DR: Redis = the RAM speed, and that part can be free (Upstash). The full Kafka streaming pipeline runs great via `docker compose`, and the cheapest always-up home for it is a ~$5/mo VPS — there is no longer a free managed-Kafka tier to put it on.

## Env vars that control the RAM layer
- `REDIS_URL` — where Redis lives (compose sets `redis://redis:6379/0`; for Upstash use their `rediss://…` URL).
- `KAFKA_PUBLISH_NEWS` — `true` to stream fetched data into Kafka→Redis (default in compose), `false` on a Kafka-less free deploy.
- `KAFKA_BOOTSTRAP_SERVERS`, `KAFKA_TOPIC` — broker + topic (compose sets these).
- `CACHE_TTL_SCREENER`, `CACHE_TTL_SOCIAL` — RAM cache freshness in seconds (defaults 20 / 15).
