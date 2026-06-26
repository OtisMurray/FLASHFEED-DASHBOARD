# FlashFeed — Docker Setup (Redis + Kafka RAM stack)

Step-by-step instructions to run the whole stack — MongoDB, **Redis**, **Kafka** (+ Zookeeper), the Express backend, and the Kafka→Redis consumer — with one command. Everything is defined in `docker-compose.yml` at the project root.

---

## 1. What you're starting

| Service | Container | Port (host) | Role |
|---|---|---|---|
| `mongo` | feedflash-mongo | 27017 | Durable store (articles, social, events) |
| `redis` | feedflash-redis | 6379 | **RAM layer** — hot per-ticker feed + response cache (pure in-memory, no disk) |
| `zookeeper` | feedflash-zookeeper | — | Kafka coordination |
| `kafka` | feedflash-kafka | 9092 | **RAM-buffered event log**, flushes to disk every ~5 min |
| `kafka-init` | feedflash-kafka-init | — | Creates the `flashfeed-events` topic, then exits (this is normal) |
| `backend` | feedflash-backend | 3001 | Express API + Run Now fetchers; reads Redis, writes Kafka |
| `kafka-consumer` | feedflash-kafka-consumer | — | Streams Kafka → Redis (`feed:{TICKER}`) + Mongo |
| `rss-worker` | feedflash-rss-worker | — | *(optional, `worker` profile)* background RSS ingestion |
| `sentiment-worker` | feedflash-sentiment-worker | — | *(optional, `worker` profile)* FinBERT sentiment |

**Data flow (the RAM pipeline):**
```
Run Now → backend fetchers → Kafka (flashfeed-events) → kafka-consumer ─┬→ Redis feed:{TICKER}  (hot, RAM)
                                                                        └→ MongoDB events       (durable)
dashboard → backend → Redis cache (RAM) ─hit→ instant ; miss→ Mongo → compute → cache
```

---

## 2. Prerequisites

- **Docker Desktop** (or Docker Engine) with the **Compose v2** plugin. Verify:
  ```bash
  docker --version
  docker compose version
  ```
- About **3–4 GB free RAM** for the full stack (Kafka + Zookeeper + Mongo are the heavy ones).
- A **`.env` file in the project root** (same folder as `docker-compose.yml`). Compose reads it automatically for the `${...}` values. Minimum:
  ```dotenv
  # required for the screener / Finviz Elite
  FINVIZ_AUTH_TOKEN=your-finviz-elite-token

  # RAM pipeline: publish fetched news into Kafka→Redis (default true)
  KAFKA_PUBLISH_NEWS=true

  # fast Run Now by default
  DEFAULT_FETCH_MODE=fast
  ```
  All other keys (Benzinga, Reddit, Schwab, etc.) are optional — leave them unset and those sources are skipped. `REDIS_URL`, `KAFKA_BOOTSTRAP_SERVERS`, and `MONGODB_URI` are already wired between containers in the compose file; you don't set those yourself.

---

## 3. Start it

From the project root:

```bash
# core stack: mongo + redis + zookeeper + kafka + kafka-init + backend + kafka-consumer
docker compose up -d --build
```

First run pulls images and builds the backend/consumer — give it a few minutes. Check everything is up:

```bash
docker compose ps
```

You want `feedflash-backend`, `feedflash-redis`, `feedflash-kafka`, and `feedflash-kafka-consumer` showing **Up**. `feedflash-kafka-init` will show **Exited (0)** — that's correct, it only creates the topic and stops.

To also run the optional background workers (RSS + FinBERT sentiment), add the profile:

```bash
docker compose --profile worker up -d --build
```

---

## 4. Verify Redis is working

```bash
# 1) Redis is alive
docker compose exec redis redis-cli ping            # → PONG

# 2) confirm it's pure in-memory (no disk persistence)
docker compose exec redis redis-cli config get save          # → "" (empty)
docker compose exec redis redis-cli config get appendonly    # → "no"

# 3) the response cache: first call MISS, repeat within the TTL is HIT (served from RAM)
curl -s -D- "http://localhost:3001/api/screener" -o /dev/null | grep -i x-cache   # X-Cache: MISS
curl -s -D- "http://localhost:3001/api/screener" -o /dev/null | grep -i x-cache   # X-Cache: HIT

# 4) the hot per-ticker feed the consumer streams in (after a fetch has run)
docker compose exec redis redis-cli keys 'feed:*'
docker compose exec redis redis-cli zrevrange feed:AAPL 0 5
curl "http://localhost:3001/api/feed/AAPL?limit=10"          # source:"redis" once events have flowed
```

---

## 5. Verify Kafka is working

```bash
# 1) the topic exists (created by kafka-init)
docker compose exec kafka kafka-topics --bootstrap-server kafka:29092 --list      # → flashfeed-events

# 2) watch the consumer stream Kafka → Redis + Mongo
docker compose logs -f kafka-consumer
#   look for lines like: "Redis: wrote N events." and "Batch of N committed."

# 3) peek at raw events on the topic (Ctrl-C to stop)
docker compose exec kafka kafka-console-consumer \
  --bootstrap-server kafka:29092 --topic flashfeed-events --from-beginning --max-messages 5
```

To generate data end-to-end: open the UI and click **Run Now** (Fast), or trigger a fetch:
```bash
curl -X POST "http://localhost:3001/api/fetch?mode=fast"
```
Then re-check step 4.4 / 5.2 — you should see events land in Redis and Mongo.

---

## 6. Everyday commands

```bash
docker compose logs -f backend            # tail the API logs
docker compose logs -f kafka-consumer     # tail the RAM pipeline
docker compose restart backend            # restart one service
docker compose down                       # stop everything (keeps data volumes)
docker compose down -v                    # stop AND wipe all data (Mongo + Redis volumes)
docker compose up -d --build backend      # rebuild + restart just the backend after a code change
```

Health check: `curl http://localhost:3001/api/health` → `{"status":"ok"}`.

---

## 7. RAM / I-O notes (how this is tuned)

- **Redis is pure in-memory** — launched with `--save "" --appendonly no`, so it never writes RDB or AOF to disk. Zero Redis disk I/O; MongoDB is the durable store. LRU eviction caps it at 512 MB.
- **Kafka is RAM-first** — `KAFKA_LOG_FLUSH_INTERVAL_MS=300000` means it buffers in the OS page cache and only flushes segments to disk every ~5 minutes (or 1B messages), minimizing constant fsync I/O while still persisting periodically.
- **Trade-off:** if the Redis or Kafka container restarts, anything not yet flushed is rebuilt from MongoDB / re-consumed from Kafka — a small durability window in exchange for near-zero steady-state I/O.
- Cache freshness and pipeline size are env-tunable: `CACHE_TTL_SCREENER`, `CACHE_TTL_SOCIAL`, `CACHE_TTL_CHARTS`, `CACHE_TTL_AI`, and on the consumer `REDIS_TTL` (hot-event expiry, default 3600s) and `REDIS_FEED_MAX` (events kept per ticker, default 100).

---

## 8. Troubleshooting

- **`X-Cache` header never appears / always MISS** → Redis isn't reachable from the backend. Check `docker compose ps` shows `feedflash-redis` Up, and `docker compose logs backend` for a Redis connection line. The app still works (it falls back to Mongo), just without the RAM cache.
- **`/api/feed/:ticker` returns `count: 0`** → no events have flowed yet. Make sure `KAFKA_PUBLISH_NEWS=true` in `.env`, the consumer is Up, then run a fetch (step 5).
- **Topic missing** → re-run init: `docker compose up kafka-init`. Confirm Kafka is healthy first (`docker compose logs kafka`).
- **Port already in use (6379 / 9092 / 27017 / 3001)** → stop the local service using it, or change the host side of the port mapping in `docker-compose.yml` (e.g. `"6380:6379"`).
- **Kafka won't start / keeps restarting** → it depends on Zookeeper; give it ~30–60s on first boot, and ensure you have enough free RAM. `docker compose logs kafka` shows the cause.
- **Backend can't reach Mongo on boot** → Mongo is slow to accept connections on first run; the backend retries. If it persists, `docker compose restart backend`.
- **Reset to a clean slate** → `docker compose down -v && docker compose up -d --build` (wipes Mongo + Redis volumes).
