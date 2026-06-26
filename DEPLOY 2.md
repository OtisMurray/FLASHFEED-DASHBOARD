# Deploying FeedFlash — getting a public URL

## What you're deploying

This is a **stateful multi-service stack**, not a static site:

- **Frontend** — the Vite SPA in `app/`. Static; goes on **Vercel**.
- **Backend stack** (needs a container host): **MongoDB**, **Redis**, **Zookeeper + Kafka**, the **Node API** (`:3001`), the **Kafka consumer**, and optional Python workers.

Vercel cannot host Mongo/Redis/Kafka — those go on Railway or any Docker host.

The frontend calls the API with **relative `/api/...` paths everywhere**, so the single rewrite in `app/vercel.json` wires the whole app to your backend with **no frontend code changes**.

Prereq: your `.env` (already created — it has `FINVIZ_AUTH_TOKEN` and `KAFKA_PUBLISH_NEWS=true`). Keep it private; it's gitignored.

---

## Path A — Fastest public test URL (start here)

Run the existing `docker-compose.yml` anywhere with Docker (laptop or VPS), expose the backend with a Cloudflare quick tunnel, put the frontend on Vercel.

1. **Start the full stack** (from the project root, `.env` present):
   ```bash
   docker compose up -d                 # add --profile worker to also run the Python rss/sentiment workers
   curl localhost:3001/api/health       # expect {"status":"ok","db":"connected"}
   ```
   Kafka/Redis/Mongo "just work" here — compose handles the internal networking, so the Kafka path is live with no extra config.

2. **Public HTTPS URL for the backend** (no domain or TLS setup needed):
   ```bash
   cloudflared tunnel --url http://localhost:3001
   ```
   It prints something like `https://xxxx.trycloudflare.com` (ephemeral — perfect for testing).

3. **Deploy the frontend to Vercel:**
   - Vercel → *Add New Project* → import the repo → set **Root Directory = `app`**.
   - `app/vercel.json` is already there; edit the `/api/:path*` **destination** to the backend URL from step 2.
   - Deploy → Vercel gives you `https://your-app.vercel.app`. **That's your public URL.**

---

## Path B — Durable managed hosting (Vercel + Railway)

Frontend on Vercel; backend services on Railway (both get automatic HTTPS; Railway provides managed Mongo + Redis).

1. **Data stores:** New Railway project → add **MongoDB** and **Redis** from Railway's templates. Note their private connection strings.

2. **Kafka + Zookeeper** (Railway has no managed Kafka, so run them as services):
   - **Zookeeper** — image `confluentinc/cp-zookeeper:7.6.0`, env `ZOOKEEPER_CLIENT_PORT=2181`.
   - **Kafka** — image `confluentinc/cp-kafka:7.6.0`, env:
     - `KAFKA_ZOOKEEPER_CONNECT=zookeeper.railway.internal:2181`
     - `KAFKA_LISTENERS=PLAINTEXT://0.0.0.0:29092`
     - `KAFKA_ADVERTISED_LISTENERS=PLAINTEXT://kafka.railway.internal:29092`  ← **must** be the Railway private hostname, or internal clients can't connect (the #1 Kafka-on-Railway mistake)
     - `KAFKA_LISTENER_SECURITY_PROTOCOL_MAP=PLAINTEXT:PLAINTEXT`
     - `KAFKA_INTER_BROKER_LISTENER_NAME=PLAINTEXT`
     - `KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR=1`
     - `KAFKA_AUTO_CREATE_TOPICS_ENABLE=true`
   - Topic `flashfeed-events` is auto-created on first publish.

3. **API service** — new service from the repo, **Dockerfile = `Infrastructure/server/Dockerfile`**. Env (your `.env` values, but use Railway private hosts):
   - `MONGODB_URI=<railway-mongo-private-url>/feedflash`
   - `REDIS_URL=redis://<railway-redis-private-host>:6379/0`
   - `KAFKA_BOOTSTRAP_SERVERS=kafka.railway.internal:29092`
   - `KAFKA_TOPIC=flashfeed-events`
   - `KAFKA_PUBLISH_NEWS=true`
   - `FINVIZ_AUTH_TOKEN=<your-token>`  (plus the rest of your `.env`)
   - Railway exposes it at `https://<service>.up.railway.app`. Test `/api/health`.

4. **Kafka consumer** — new service from the repo, **Dockerfile = `Infrastructure/kafka/Dockerfile`**. Env: `KAFKA_BOOTSTRAP_SERVERS=kafka.railway.internal:29092`, `KAFKA_TOPIC=flashfeed-events`, `REDIS_HOST=<redis-private-host>`, `REDIS_PORT=6379`, `MONGODB_URI=<mongo-private-url>`, `MONGODB_DB=feedflash`.

5. **Frontend on Vercel** — same as Path A step 3, but set the `/api` rewrite destination to your Railway API URL.

Optional Python workers (`Dockerfile.rss` / `Dockerfile.sentiment`) can be added as extra services with the same Mongo/Redis/Kafka env — not required, since the API runs the fetchers itself on `/api/fetch` and `/api/watch`.

---

## Notes

- **HTTPS is required end-to-end.** The frontend is HTTPS, so the backend must be too. Railway and the Cloudflare tunnel give this automatically; a bare VPS needs a domain + Caddy (or Cloudflare).
- **CORS:** with the Vercel rewrite, the browser talks only to your Vercel domain and Vercel proxies to the backend server-side, so the backend's existing localhost-only CORS is fine — no change needed. (Only if you instead point the browser directly at the backend via `VITE_API_BASE_URL` would you need to widen CORS in `Infrastructure/server/index.js`.)
- **Image fixes already applied:** `Infrastructure/server/Dockerfile` and `Dockerfile.rss` now install `confluent-kafka` + `redis` and copy `Infrastructure/kafka/`, so the Kafka publish actually runs in the deployed containers (otherwise it silently no-ops).
- **Rotate the Finviz token** after testing, since it has been shared in chat. Keep `.env` out of git (already gitignored).
