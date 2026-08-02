# FlashFeed Dashboard

FlashFeed is a full-stack financial intelligence dashboard that combines market news, social sentiment, stock screening, technical charts, AI-assisted rankings, simulated position tracking, short-squeeze research, and cumulative volume delta (CVD) analysis.

> **Research and educational software only.** FlashFeed does not provide investment advice. The Positions page simulates trades and does not place orders. Broker trading is disabled by default.

**Live dashboard:** [https://backend-production-da72.up.railway.app](https://backend-production-da72.up.railway.app)

**Public repository:** [https://github.com/OtisMurray/FLASHFEED-DASHBOARD](https://github.com/OtisMurray/FLASHFEED-DASHBOARD)

## Contents

- [What FlashFeed Includes](#what-flashfeed-includes)
- [System Requirements](#system-requirements)
- [Quick Start: Complete Docker Setup](#quick-start-complete-docker-setup)
- [Confirm the Installation](#confirm-the-installation)
- [Configuration and Data Sources](#configuration-and-data-sources)
- [Architecture](#architecture)
- [Repository Map](#repository-map)
- [Local Development](#local-development)
- [Tests and Validation](#tests-and-validation)
- [Common Problems](#common-problems)
- [Stopping or Resetting FlashFeed](#stopping-or-resetting-flashfeed)
- [Railway Deployment](#railway-deployment)
- [Data and Model Notes](#data-and-model-notes)

## What FlashFeed Includes

| Page | Purpose |
| --- | --- |
| **Overview** | Market-wide news, social, sentiment, and correlation summary |
| **AI** | Evidence-weighted bullish, watch, and bearish stock rankings |
| **News** | Multi-source financial news feed with ticker matching and sentiment |
| **Screener** | Broad listed-US market universe, movers, catalysts, technicals, sentiment, and Mirror views |
| **Long Term** | Long-term fundamental research and AI-assisted reasoning |
| **Decision Map** | Interactive 3D stock journeys across sentiment, price movement, and volume pressure |
| **Social** | StockTwits, Reddit, Bluesky, and other supported social evidence with continuous sentiment scoring |
| **Charts** | Candles, indicators, volume, news markers, rolling message density, sentiment, and watcher overlays |
| **CVD** | Measured or provenance-labeled estimated cumulative volume delta research |
| **Positions** | AI-qualified, regular-hours-only simulated entries and trailing-stop exits |
| **Short Squeeze** | Short-squeeze candidate research and gating |
| **Momentum** | Momentum candidates and supporting market evidence |
| **Correlation** | Rolling relationships between price, density, sentiment, and related signals |
| **Settings** | Configuration plus links to the v11 test profile, prediction audit, and system health |

## System Requirements

The recommended setup uses Docker and does not require Node.js or Python to be installed directly on the host.

- Git
- Docker Desktop with Docker Compose v2 (`docker compose`)
- At least 8 GB of available memory recommended for MongoDB, Redis, Kafka, the application services, and image builds
- Internet access for container images, package installation, and public market/news sources
- Free local ports `3001`, `5050`, and `5173`

Node.js 22+ and Python 3.12+ are only needed when running services directly outside Docker.

## Quick Start: Complete Docker Setup

These steps are the supported clean-machine installation path.

### 1. Clone the public repository

```bash
git clone https://github.com/OtisMurray/FLASHFEED-DASHBOARD.git
cd FLASHFEED-DASHBOARD
```

The production branch is `main`; no alternate branch checkout is required.

### 2. Create a local environment file

```bash
cp .env.example .env
```

The local infrastructure and public-source paths can start without paid API keys. Optional authenticated sources remain unavailable until their variables are supplied. Before using SEC EDGAR, replace the placeholder `SEC_CONTACT_EMAIL` and `SEC_USER_AGENT` values in `.env` with a real contact address.

Never commit `.env`, login cookies, broker credentials, API keys, or passwords. `.env` is ignored by Git; `.env.example` contains documentation and blank placeholders only.

### 3. Build and start FlashFeed

Make sure Docker Desktop is running, then execute:

```bash
docker compose up -d --build
```

The first build downloads images and installs JavaScript and Python dependencies, so it can take several minutes. Later starts reuse the build cache.

### 4. Wait for the services to become healthy

```bash
docker compose ps
```

Wait until `feedflash-backend` and `feedflash-frontend` report healthy. Kafka can take longer than the other services during its first startup.

### 5. Open the dashboard

Visit [http://localhost:5173](http://localhost:5173).

The database begins empty on a new machine. Use **Run Now** in the top bar to collect the currently available public data. Premium sources will only populate when their credentials are configured.

## Confirm the Installation

Run these checks from the repository root:

```bash
# Backend and dependency health
curl http://localhost:3001/api/health

# Frontend response
curl -I http://localhost:5173/overview

# Chart/CVD service response
curl -I http://localhost:5050/api/health

# Container state
docker compose ps
```

Useful service-level checks:

```bash
docker exec feedflash-redis redis-cli ping
docker exec feedflash-mongo mongosh --quiet --eval "db.adminCommand('ping').ok"
docker exec feedflash-kafka kafka-topics --bootstrap-server localhost:29092 --list
```

Expected results include `PONG` from Redis, `1` from MongoDB, and `flashfeed-events` in the Kafka topic list.

## Configuration and Data Sources

All supported variables and safe defaults are documented in [`.env.example`](.env.example). Keep configuration in the local `.env` file or the deployment platform's secret-variable store.

### Core settings

| Variable | Default | Purpose |
| --- | --- | --- |
| `MONGODB_URI` | `mongodb://mongo:27017/feedflash` | Application database connection |
| `REDIS_URL` | `redis://redis:6379/0` | Cache and hot-feed connection |
| `KAFKA_BOOTSTRAP_SERVERS` | `kafka:29092` | Internal Kafka broker |
| `CORS_ORIGIN` | `*` | Allowed frontend origin(s) |
| `DEFAULT_FETCH_MODE` | `fast` | Default data refresh mode |
| `ONSITE_FETCH_INTERVAL_MS` | `60000` | Presence-aware refresh interval; clamped to at least one minute |
| `POSITION_HISTORY_ENABLED` | `true` | Enables simulated position history |
| `POSITION_AI_MIN_SCORE` | `50` | Minimum AI score used to select position candidates |

### Optional authenticated integrations

| Integration | Variables | Behavior when absent |
| --- | --- | --- |
| Finviz Elite | `FINVIZ_LOGIN`, `FINVIZ_PASSWORD`, optional legacy token/cookie | Elite exports and some chart/screener enrichment are unavailable |
| TradingView | `TV_USERNAME`, `TV_PASSWORD` | Overnight chart data falls back to a clearly labeled prior-close carry |
| Benzinga / Dow Jones | `BENZINGA_API_KEY`, `DOW_JONES_API_KEY` | Those news sources are skipped |
| Reddit | `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `REDDIT_ACCESS_TOKEN` | Public fallback is used when available |
| X / Grok | `X_BEARER_TOKEN`, `GROK_API_KEY` | Those source/enrichment paths are skipped |
| Interactive Brokers | `IBKR_HOST`, `IBKR_PORT` | Measured broker data is unavailable; trading remains disabled |
| SEC EDGAR | `SEC_CONTACT_EMAIL`, `SEC_USER_AGENT` | Set a valid identity before requesting SEC data |

`IBKR_ENABLE_TRADING` and `SCHWAB_TRADING_ENABLED` default to `false`. Do not enable broker actions for a demonstration or grading run.

## Architecture

```text
Browser
  |
  v
React/Vite frontend (:5173 locally)
  |-- /api/* ----------> Express backend (:3001)
  |                         |-- MongoDB: durable application data
  |                         |-- Redis: cache, hot feed, Decision Map paths
  |                         `-- Kafka: event stream
  |
  `-- /api/sentchart/* -> Flask chart/CVD service (:5050)
                            |-- candles and technical indicators
                            |-- rolling social density/sentiment
                            `-- measured or estimated CVD
```

In Railway, the Express `backend` image also builds and serves the React application from the same origin. It proxies `/api/sentchart/*` to the separately deployed chart service.

### Docker services

| Compose service | Container | Role | Host port |
| --- | --- | --- | --- |
| `frontend` | `feedflash-frontend` | Production React build served by Nginx | `5173` |
| `backend` | `feedflash-backend` | Express API, data orchestration, and prediction services | `3001` |
| `chart-service` | `feedflash-chart-service` | Flask chart, social-overlay, strategy, and CVD APIs | `5050` |
| `mongo` | `feedflash-mongo` | Durable local database | `27017`, loopback only |
| `redis` | `feedflash-redis` | Cache and hot state | `6379`, loopback only |
| `zookeeper`, `kafka`, `kafka-init` | `feedflash-*` | Event broker and topic initialization | `9092`, loopback only |
| `kafka-consumer` | `feedflash-kafka-consumer` | Persists and caches streamed events | none |
| `news-source-guard` | `feedflash-news-source-guard` | Normalizes stored source labels | none |
| `auto-refresh-worker` | `feedflash-auto-refresh` | Legacy external scheduler, disabled by default | none |

Optional `rss-worker` and `sentiment-worker` services are behind the `worker` Compose profile. The backend's one-minute presence-aware refresh is authoritative by default; do not start duplicate refresh loops unless deliberately testing them.

## Repository Map

| Path | Contents |
| --- | --- |
| `app/` | Primary React/TypeScript dashboard, routes, pages, shared components, styling, and Nginx config |
| `Infrastructure/server/` | Primary Express backend, API routes, prediction/position services, and Node tests |
| `chart-service/` | Flask chart and CVD service, Finviz authentication, social store, overnight-price integration, and Python tests |
| `Infrastructure/kafka/` | Kafka consumer and container configuration |
| `Infrastructure/pipeline/` | Shared pipeline support used by the backend image |
| `1_News/` | News ingestion, normalization, and news feature modules |
| `2_Screener/` | Screener ingestion and feature modules |
| `3_Social/`, `5_Social/` | Social collectors, processing, and historical pipeline modules |
| `4_Charts/` | Chart-related supporting modules and retained source organization |
| `5_Momentum/` | Momentum pipeline and feature modules |
| `6_AI/` | Sentiment and AI support modules |
| `6_Correlation/` | Correlation pipeline and feature modules |
| `backtests/` | Reproducible threshold/backtest code and evidence artifacts |
| `scripts/` | Data maintenance, audits, validation, and operational scripts |
| `config/` | Shared source and application configuration |
| `docs/` | Additional technical and source-contract documentation |
| `docker-compose.yml` | Complete local multi-service deployment |
| `.env.example` | Safe environment-variable template |

The active dashboard runtime is `app/` + `Infrastructure/server/` + `chart-service/`. The numbered folders preserve feature ownership and provide pipeline modules that are copied into the backend container where required.

## Local Development

The complete Docker setup above is the easiest reproducible path. For frontend hot reload, keep the backend dependencies in Docker and run Vite on the host.

### Start backend dependencies and APIs

```bash
docker compose up -d mongo redis zookeeper kafka kafka-init kafka-consumer chart-service backend news-source-guard
```

### Start the Vite frontend

```bash
cd app
npm ci
npm run dev
```

Open [http://localhost:5173](http://localhost:5173). Vite proxies `/api/*` to port `3001` and `/api/sentchart/*` to port `5050`.

Use `npm ci`, not `npm install`, to reproduce the versions recorded in `package-lock.json`.

## Tests and Validation

### Frontend build and TypeScript ratchet

```bash
cd app
npm ci
npm run build
```

The production build runs the project's type-check ratchet before Vite emits `dist/`.

### Backend tests

```bash
cd Infrastructure/server
npm ci
npm test
```

The suite covers ranking, prediction thresholds, rolling windows, position grouping/history, regular-hours gates, price-basis validation, Decision Map rows, squeeze logic, watcher snapshots, and repository hygiene.

### Chart and CVD tests

```bash
cd chart-service
python3 -m venv .venv
source .venv/bin/activate       # Windows PowerShell: .venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python -m unittest discover -p 'test_*.py'
```

The virtual environment is ignored by Git and tests the current checkout against the service's pinned Python dependencies.

### Compose validation

```bash
docker compose config --quiet
```

This validates the merged Compose configuration without starting containers.

## Common Problems

### Docker is not running

Start Docker Desktop and wait until its engine reports ready, then retry `docker compose up -d --build`.

### A port is already in use

Check for an older FlashFeed stack:

```bash
docker compose ps
docker ps --format 'table {{.Names}}\t{{.Ports}}'
```

Stop the older stack or the process using ports `3001`, `5050`, or `5173`.

### The dashboard opens but contains little or no data

A clean MongoDB has no historical rows. Click **Run Now**, inspect `docker compose logs -f backend`, and allow the collectors to finish. Public and authenticated source totals will differ. Missing premium credentials must produce partial-data states, not fabricated rows.

### Charts or CVD do not load

```bash
docker compose logs --tail=200 chart-service
curl -I http://localhost:5050/api/health
```

Confirm that `chart-service` is running and that Finviz credentials are present if the requested endpoint requires Elite data.

### Backend health fails

```bash
docker compose logs --tail=200 backend
docker compose logs --tail=100 mongo redis kafka
```

MongoDB and Redis must be healthy, and `kafka-init` must complete before the backend starts.

### Rebuild after pulling new code

```bash
git pull --ff-only
docker compose up -d --build
```

### `docker compose` is unavailable

Install a current Docker Desktop release. Older installations may expose `docker-compose`, but Compose v2 is the supported command.

## Stopping or Resetting FlashFeed

Stop the application while preserving MongoDB and named volumes:

```bash
docker compose down
```

Start it again with:

```bash
docker compose up -d
```

To remove all local FlashFeed data and begin with an empty database:

```bash
docker compose down -v
```

`docker compose down -v` is destructive. It deletes the local MongoDB, Redis, authentication-session, and model-cache volumes.

## Railway Deployment

Production uses two Railway services connected to this public repository's `main` branch:

| Railway service | Dockerfile path | Purpose |
| --- | --- | --- |
| `backend` | `Infrastructure/server/Dockerfile` | Builds the React app and serves the dashboard plus Express API |
| `chart-service` | `chart-service/Dockerfile` | Serves chart, social-overlay, strategy, and CVD endpoints |

Required Railway infrastructure variables include a persistent `MONGODB_URI`, `REDIS_URL`, and `CHART_SERVICE_URL` on the backend. Configure optional source credentials separately in Railway's variable store; never place them in the repository.

Both services currently auto-deploy from `OtisMurray/FLASHFEED-DASHBOARD` on `main`. A commit to `main` can therefore rebuild production. Confirm both Dockerfile paths and review deployment logs after every release.

Production checks:

```bash
curl https://backend-production-da72.up.railway.app/api/health
curl -I https://backend-production-da72.up.railway.app/overview
```

## Data and Model Notes

- FlashFeed never creates fake screener or news rows to fill the interface. A missing source is shown as missing or partial data.
- AI rankings combine market movement, news, social evidence, freshness, density, and validated model evidence. They are research rankings, not guaranteed forecasts.
- Position entries and exits are simulations. They use AI-qualified candidates with the current correlation and trailing-stop strategy, are restricted to regular market hours, and place no live orders.
- Position percentage totals sum equal-capital trade percentage points. They are not dollar returns unless a notional amount is explicitly selected in the interface.
- CVD uses measured classified ticks when a compatible tick store is configured. Without measured ticks, it displays deterministic bar-based estimates with lower reliability and explicit provenance labels.
- Social sentiment uses continuous weighted scores and rolling-window aggregation. Source coverage depends on credentials, public endpoint availability, and rate limits.
- Historical and live outputs can change as source data is corrected, delayed bars arrive, or stricter quality gates exclude incomplete records.

## License and Ownership

This repository was developed as an internship/capstone research project by the FlashFeed team. No separate open-source license is currently granted; the public repository is provided for review, reproducibility, and course evaluation.
