# DS440 — Social Sentiment Pipeline & Dashboard

Real-time pipeline that scrapes Reddit (24 subreddits) and Bluesky (25 cashtag searches) for stock-related posts, scores sentiment (bullish/bearish), computes rolling aggregates, and displays results in a Finviz-style screener dashboard with three extra columns: social sentiment score, structured news sentiment, and message density.

**Live dashboard:** https://dashboard-seven-mauve-17.vercel.app

## Architecture

```
GitHub Actions (every 15 min)
├── Scrapers (Python)  → MongoDB (raw posts)
├── Processing Pipeline (Python)
│   ├── Ticker extraction, dedup/spam, sentiment scoring
│   ├── Rolling windows → MongoDB + Redis + PostgreSQL
│   └── yfinance enricher → MongoDB finviz_screener
└── Dashboard (Vercel / Next.js) reads from all three databases
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Reddit scraper | Python, `curl_cffi` (Chrome 124 TLS impersonation) |
| Bluesky scraper | Python, `atproto` SDK |
| Processing | Python (ticker extraction, dedup, sentiment, rolling windows) |
| Dashboard | Next.js 16, React 19, TypeScript, Tailwind CSS, shadcn/ui |
| Databases | MongoDB Atlas, PostgreSQL (Neon), Redis (Upstash) |
| CI/CD | GitHub Actions (pipeline), Vercel (dashboard) |

## Quick Start

### Python pipeline

```bash
pip install -e ".[dev]"       # Install dependencies
cp .env.example .env          # Fill in credentials (see comments in file)
python scripts/run_pipeline.py --once --scrape   # Run one full cycle
```

### Dashboard

```bash
cd dashboard
npm install
cp .env.example .env.local    # Fill in credentials
npm run dev                   # http://localhost:3000
```

### Tests

```bash
pytest tests/ -v              # 198 tests, all should pass
```

## Environment Variables

See [`.env.example`](.env.example) for the Python pipeline and [`dashboard/.env.example`](dashboard/.env.example) for the dashboard. Key detail: **Redis uses two different protocols** — the Python pipeline connects via TCP (`rediss://...`), while the Next.js dashboard uses Upstash's REST API (`UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`). Both point to the same Upstash instance.

## Known Limitations

| Area | Limitation |
|------|-----------|
| **Redis TTL** | All keys expire after 4 hours. If the pipeline stops running, the dashboard goes blank. This is intentional to prevent stale data. |
| **Reddit IP blocking** | GitHub Actions runner IPs get 403'd intermittently. Bluesky is the reliable fallback. Reddit requires `curl_cffi` with `impersonate="chrome124"` — standard `requests` is always blocked. |
| **Sentiment scoring** | Rule-based lexicon only (64 bullish phrases, 31 bearish). No LLM calls. Fast but misses nuance. |
| **Finviz data** | Only 10 tickers have fundamental data (AAPL, TSLA, MSFT, GOOG, AMZN, GME, AMC, NVDA, SPY, META). Others show nulls for price/analyst fields. |
| **Redis string types** | All Redis hash values are strings. Frontend must use `parseFloat()` / `parseInt()` on every `hgetall()` response. |
| **MongoDB field types** | Some Finviz fields are strings from CSV parsing, others are numbers. Parse on read. |
| **Bluesky auth** | Requires a real Bluesky account with an app password (free to create). |
| **Data freshness** | Pipeline runs every 15 minutes via cron. Data is up to 15 minutes stale by design. |
| **Active tickers** | The `active_tickers` sorted set only contains tickers mentioned in the last 60 minutes. Quiet tickers disappear from the screener. |

## Project Structure

```
├── scrapers/           Reddit + Bluesky scrapers (D1, D2)
├── processing/         Ticker extraction, dedup, sentiment, rolling windows (D3-D7, D11)
├── dashboard/          Next.js frontend (D8-D10)
├── scripts/            Pipeline orchestrator (D12)
├── tests/              198 automated tests
├── docs/               Handoff guide, pipeline docs, scraper deep-dives
├── data/               Sample Finviz CSV
└── .github/workflows/  CI/CD pipeline config
```

## Detailed Documentation

- **[Handoff Guide](docs/Handoff_Guide.md)** — Integration guide for dashboard builders
- **[Pipeline Documentation](docs/Pipeline_Documentation.md)** — Technical reference for each processing stage
- **[D1 Reddit Scraper](docs/D1_Reddit_Scraper.md)** — Deep dive on curl-cffi, rate limits, error handling
- **[Project Plan](Rohan_Project_Plan_DS440.md)** — Full deliverable breakdown and implementation details

## Deployment

- **Dashboard:** Deployed to Vercel. Env vars configured in Vercel project settings.
- **Pipeline:** GitHub Actions cron (`.github/workflows/pipeline.yml`). Requires 7 secrets: `MONGO_URI`, `MONGO_DB`, `MONGO_COLLECTION`, `REDIS_URL`, `POSTGRES_DSN`, `BLUESKY_HANDLE`, `BLUESKY_APP_PASSWORD`.
- **Databases:** MongoDB Atlas, Neon PostgreSQL, Upstash Redis — all managed cloud services.
