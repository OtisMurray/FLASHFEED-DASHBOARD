# Sentiment Scout

Real-time financial sentiment screener and dashboard. Pulls tickers from the
Finviz Elite screener, enriches them with RSS news, Stocktwits sentiment, and AI
analysis (Claude via OpenRouter), scores news with FinBERT/VADER, and persists
everything to SQLite + MongoDB. A Python/Flask backend (port 5050) is the single
source of truth; a React + Vite frontend (`frontend/`, port 5173) is the UI.

## Components

| Path | Purpose |
|------|---------|
| `dashboard.py` | Flask backend + API on **:5050** (also serves the legacy inline dashboard) |
| `sentiment_screener.py` | AI ranking pipeline: Finviz screener → news/Stocktwits enrichment → Claude insight → SQLite |
| `multicap_screener.py` | Polls 6 Finviz market-cap tiers with add/drop detection |
| `correlation_engine.py` | Pearson correlation of 1-min price vs Stocktwits sentiment/density |
| `config.py` | Loads `.env` and exposes required secrets (fails loudly if missing) |
| `database.py` / `rss_poller.py` / `keyword_filter.py` / `stocktwits_scraper.py` / `article_processor.py` | SQLite layer, RSS feeds, noise filter, Stocktwits + article text |
| `priyanshu_adapter.py` / `yosef_adapter.py` / `jeff_adapter.py` | Bridges to teammates' components (FeedFlash scoring, Yosef social, IBKR scanners) |
| `tradingview_adapter.py` | Fetches TradingView news-headlines (curl_cffi impersonation), scores via FinBERT/VADER, stores headline+metadata+link in `var/tradingview/`; a selectable News Source |
| `frontend/` | React 18 + TypeScript + Vite + Tailwind UI (proxies `/api` → :5050) |
| `external/feedflash/` | Vendored — Priyanshu's FinBERT/VADER news scorer (see its `ATTRIBUTION.md`) |
| `external/yosef/` | Vendored — Yosef's Stocktwits → MongoDB scraper (see its `ATTRIBUTION.md`) |

## Prerequisites

- **Python 3.12** (3.9+ works — `zoneinfo` is stdlib there).
- **Node 18+** (for the Vite frontend).
- **MongoDB** running on `localhost:27017` — Yosef's social scraper and the rumor
  classification use it. Start it with `mongod` (or Docker). The app degrades
  gracefully if it's absent, but social/rumor features need it.
- **Run from a normal local path** like `~/dev` — **not** an iCloud-synced
  `Desktop`/`Documents` folder. iCloud evicts the live SQLite DB to a dataless
  placeholder, which hangs the app (its DB reads block) and stalls `git`.

## Setup

```bash
# 1. Clone (into ~/dev or similar — NOT iCloud Desktop/Documents)
git clone https://github.com/Amansome/sentiment-scout.git ~/dev/sentiment-scout
cd ~/dev/sentiment-scout

# 2. Python deps (one shared venv; torch/transformers are large)
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# 3. Frontend deps
cd frontend && npm install && cd ..

# 4. Secrets — copy the template and fill in the three keys
cp .env.example .env
```

Edit `.env` and set:

| Var | Where it comes from |
|-----|---------------------|
| `OPENROUTER_API_KEY` | [openrouter.ai](https://openrouter.ai) → Keys (powers the AI ranking) |
| `FINVIZ_TOKEN` | the team's Finviz Elite token — elite.finviz.com → Account → API Token |
| `SENTIMENT_SCOUT_API_KEYS` | generate one: `python3 -c "import secrets; print(secrets.token_urlsafe(32))"` (for the `/api/v1` public API) |

`.env` is gitignored. The optional `*_ROOT` / `*_DB` / `*_CSV` overrides in
`.env.example` have repo-relative defaults — leave them unset.

## Run

Two terminals (venv active in the backend one):

```bash
# Backend — Flask API on :5050 (also starts the background screener schedulers)
python3 dashboard.py

# Frontend — Vite dev server on :5173 (proxies /api → :5050)
cd frontend && npm run dev
```

Then open **http://localhost:5173**.

## First run

- **Runtime data is empty on a fresh clone** and populates on first use: the
  SQLite DB, the FeedFlash scored-article DB, and the Yosef ticker CSV all live
  in the gitignored `var/` dir and are created on demand. The **FinBERT model
  (`ProsusAI/finbert`) downloads on first scoring run** (~hundreds of MB, cached).
- **Fill the boards:** trigger a run so the Screener / Overview / News views have
  data — click **Fetch** in the top bar, or `curl -X POST http://localhost:5050/run`
  for an AI screener cycle. The multicap/social schedulers also tick automatically.
- **The teammate codebases are bundled** under `external/feedflash` and
  `external/yosef` — no extra checkout needed. See each `ATTRIBUTION.md`.

## Deployment

Three pieces: the **backend** on an always-on host, **MongoDB** on Atlas, and the
**frontend** on Vercel. Every new env var defaults to local behavior, so nothing
below changes local dev.

### 1. Backend (Docker, always-on host)

The backend is the Flask API **plus** the background schedulers, so it needs an
always-on host (a container service like Render / Railway / Fly.io / a VM) — **not**
a serverless platform. Budget **~2 GB RAM** for the FinBERT (`ProsusAI/finbert`)
scorer.

```bash
docker build -t sentiment-scout .
docker run -p 5050:5050 \
  -e OPENROUTER_API_KEY=...  -e FINVIZ_TOKEN=...  -e SENTIMENT_SCOUT_API_KEYS=... \
  -e MONGO_URI="mongodb+srv://USER:PASS@cluster.mongodb.net/?retryWrites=true&w=majority" \
  -e FRONTEND_ORIGIN="https://YOUR-APP.vercel.app" \
  -v sentiment_scout_var:/app/var \
  sentiment-scout
```

- The volume at **`/app/var`** persists the SQLite DBs, the encrypted credentials
  store, and the cached FinBERT model (`VAR_ROOT` / `HF_HOME` default there).
- `FRONTEND_ORIGIN` is the CORS allowlist (comma-separated for multiple origins).
- The container entry is the same `python3 dashboard.py` used locally.

### 2. MongoDB (Atlas)

Create a free/shared MongoDB Atlas cluster, allow the backend host's IP, and set
`MONGO_URI` to the cluster's SRV connection string. Social/Stocktwits and rumor
features use it; the app degrades gracefully if it's unreachable.

### 3. Frontend (Vercel)

Deploy the `frontend/` directory (Vercel auto-detects Vite; `frontend/vercel.json`
adds the SPA rewrite). Set **one build-time env var** in the Vercel project:

| Var | Value |
|-----|-------|
| `VITE_API_BASE` | the backend's public URL, e.g. `https://sentiment-scout-api.onrender.com` |

The built bundle then calls `${VITE_API_BASE}/api/...` directly. Leave it unset for
local dev and the relative `/api` path falls back to the Vite proxy.

### Env var summary

| Var | Where | Default | Purpose |
|-----|-------|---------|---------|
| `OPENROUTER_API_KEY` | backend | — (required) | AI ranking |
| `FINVIZ_TOKEN` | backend | — (required) | Finviz Elite data |
| `SENTIMENT_SCOUT_API_KEYS` | backend | — (required) | `/api/v1` public API |
| `MONGO_URI` | backend | `mongodb://localhost:27017` | MongoDB / Atlas |
| `FRONTEND_ORIGIN` | backend | `http://localhost:5173` | CORS allowlist |
| `VAR_ROOT` | backend | `./var` | runtime data dir (mount a volume) |
| `VITE_API_BASE` | frontend (Vercel) | unset → `/api` proxy | backend public URL |
