# chart-service

Standalone Python (Flask) service that serves our **sentiment-scout chart data**
inside this repo. It is the backend half of the chart port (PORT_PLAN.md §3).

**Phase 1 (this):** candles only, on our real Finviz 1-minute OHLC data path.
The density/sentiment overlay route exists but is **stubbed** (phase 2).

## Endpoints
| Route | Status | Notes |
|---|---|---|
| `GET /api/health` | live | `{ok, finviz_token_configured}` |
| `GET /api/chart?ticker=AAPL&window=full\|2h\|1h` | live | legacy line series (labels/prices/volumes) |
| `GET /api/charts/<ticker>?window=full\|2h\|1h` | live | 1-min OHLC candles + RSI(14)/MACD(12,26,9)/Bollinger(20,2) |
| `GET /api/chart/social?ticker=&date=YYYY-MM-DD` | **read-only (phase 2)** | real density + sentiment series from a point-in-time SQLite snapshot; live backfill = phase 2b |

Data source: Finviz Elite `quote_export?p=i1` (1-min extended-hours bars,
04:00–20:00 ET), fetched via `curl_cffi` with chrome124 impersonation, walked back
up to 5 sessions to find the latest day with data.

## Provenance / cut line
`chart_service.py` is a faithful extraction of the chart slice from
`sentiment-scout/dashboard.py`:
`num`, `_fetch_intraday_bars`, `_latest_session_bars`, `build_chart`, `_ema_list`,
`_rsi_series`, `_macd_series`, `_bollinger_series` — plus the two constants it needs
from `correlation_engine.py` (`EDT`, `CURL_HEADERS`), copied rather than imported
because `correlation_engine` and `dashboard` both pull in the social pipeline / DB /
screener at import time. No SQLite, no numpy/pandas, no teammate adapters.

## Social overlays — live backfill (phase 2b)
`/api/sentchart/chart/social` returns the density + sentiment series in the exact
sentiment-scout shape. It serves from a **walk-once-then-persist** resting store:

- **Live path:** on a store miss it runs a background **StockTwits walk**
  (`social_store.py`) reporting `{status:"walking", count}` until done, then serves
  the series. Compute functions (`_build_social_series`, `_smooth_same`) and the
  walk are faithful ports from sentiment-scout.
- **Store:** MongoDB, **decoupled** — chart-service uses its OWN db/collection
  (default `flashfeed.social_history`, env-overridable) so it does NOT read/write
  sentiment-scout's `sentiment_scout.social_history`. Falls back to an in-memory
  store if Mongo is unreachable.
- **Empty-doc guard:** a walk that returns nothing (and whose seed is empty) does
  **not** persist a 0-message doc, so a failed/rate-limited walk can't cache a 0
  that later reads as authoritative. (`social_store.py` is a deliberate fork of
  sentiment-scout's verbatim copy for these two changes — see its header.)
- **Seed fallback:** when a live walk finds nothing, it seeds from the point-in-time
  **SQLite snapshot** (`social_snapshot.db`, `ticker_insights.stocktwits_posts`).

## Env (see `.env.example`)
- `FINVIZ_TOKEN` — **required** for candles. Canonical name (our convention).
  Legacy `FINVIZ_AUTH_TOKEN` is accepted as a fallback; docker-compose bridges them.
- `MONGO_URI` (default `mongodb://localhost:27017`; compose targets `mongodb://mongo:27017`),
  `MONGO_DB` (default `flashfeed`), `MONGO_COLL` (default `social_history`) — the
  decoupled live-backfill store.
- `SOCIAL_DB_PATH` — SQLite seed-fallback snapshot (default `chart-service/social_snapshot.db`, gitignored).
- `PORT` (default 5050), `FRONTEND_ORIGIN` (default `http://localhost:5173`).

## Run locally
```bash
cd chart-service
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # then put the real FINVIZ_TOKEN in .env
python chart_service.py
# → http://localhost:5050
```

## Run via docker-compose (from repo root)
```bash
docker compose up chart-service
```
The `chart-service` block in `docker-compose.yml` maps `FINVIZ_TOKEN` from your
shell/.env (falling back to `FINVIZ_AUTH_TOKEN`) and publishes port 5050.
