# Sentiment Scout — Public REST API (v1)

Versioned, token-authenticated, read-only API for consuming the dashboard's
data from other systems. Base URL (default dev server):

```
http://localhost:5050/api/v1
```

The dashboard's own `/api/*` routes (no `v1`) are internal, unauthenticated,
and may change without notice — integrate against `/api/v1/*` only.

## Authentication

Every endpoint except `/api/v1/health` requires an API key, sent either way:

```
Authorization: Bearer <key>
X-API-Key: <key>
```

Keys are configured on the server via the `SENTIMENT_SCOUT_API_KEYS`
environment variable (comma-separated, so each teammate/system gets their own
revocable key). The server also reads a `.env` file next to `dashboard.py` —
see `.env.example`. Generate a key with:

```bash
python3 -c "import secrets; print(secrets.token_urlsafe(32))"
```

| Failure | Status | `error.code` |
|---|---|---|
| No/empty key header | 401 | `unauthorized` |
| Wrong key | 401 | `unauthorized` |
| Server has no keys configured | 503 | `not_configured` |
| Bad/missing required param | 400 | `bad_request` |

## Response envelope

Success (always HTTP 200):

```json
{ "ok": true, "data": { ... } }
```

Error:

```json
{ "ok": false, "error": { "code": "unauthorized", "message": "Invalid API key." } }
```

**Live-Finviz caveat:** `/api/v1/chart` and `/api/v1/correlation` (with
`ticker`+`date`) call Finviz upstream. With a valid API key they return
HTTP 200 even when upstream fails (e.g. the Finviz token expired) — the
payload then carries an `error` field inside `data` instead of bars/r-values.
That is an upstream data condition, not an auth failure.

In the examples below, `$KEY` holds your API key:

```bash
export KEY=<your-api-key>
```

---

## GET /api/v1/health — no auth

Liveness probe.

```bash
curl http://localhost:5050/api/v1/health
```

`data`: `{status: "ok", version: "v1", time: <UTC ISO timestamp>}`

## GET /api/v1/screener

Latest screener run with AI insights: one row per ticker with price,
`change_pct`, `rel_volume`, `rsi`, `direction` (long/short/neutral),
`conviction` (0–10), `news_catalyst`, `summary`, `risk_factors`,
Stocktwits bull/bear counts, and `cap_tier`.

```bash
curl -H "Authorization: Bearer $KEY" http://localhost:5050/api/v1/screener
```

`data`: `{items: [...], count: N}`

## GET /api/v1/momentum

Derived leaderboard (no external calls). Transparent score per ticker:
`score = change_pct + (rel_vol − 1)×10 + (bulls − bears)`, with per-ticker
`components`. Also: `gainers`, `losers`, `unusual_volume` (rel vol ≥ 1.5),
`rsi_overbought` (≥70), `rsi_oversold` (≤30), `social_bullish`,
`social_bearish`, `social_density`, and `added`/`dropped` tickers from the
latest multicap cycle.

```bash
curl -H "Authorization: Bearer $KEY" http://localhost:5050/api/v1/momentum
```

`data`: `{formula, items: [...], gainers, losers, unusual_volume, rsi_overbought, rsi_oversold, social_bullish, social_bearish, social_density, added, dropped, multicap_run}`

## GET /api/v1/social

Stocktwits posts attached to the latest screener run, plus trending
2–3-word phrases across them.

```bash
curl -H "Authorization: Bearer $KEY" http://localhost:5050/api/v1/social
```

`data`: `{posts: [{ticker, platform, text, sentiment, timestamp, bull_count, bear_count}], count: N, trending: [{phrase, count}]}`

## GET /api/v1/news

RSS news items (GlobeNewswire, PRNewswire, BusinessWire, SEC 8-K) with
extracted tickers and keyword-match flags.

| Param | Default | Notes |
|---|---|---|
| `limit` | 200 | max rows returned |
| `source` | all | exact source name, e.g. `PRNewswire` |
| `date_from` / `date_to` | — | `YYYY-MM-DD` |
| `time_from` / `time_to` | 00:00 / 23:59 | `HH:MM`, only with the matching date param |

```bash
curl -H "Authorization: Bearer $KEY" \
  "http://localhost:5050/api/v1/news?limit=20&source=PRNewswire&date_from=2026-06-10"
```

`data`: `{items: [...], count: N}`

## GET /api/v1/multicap

Latest multicap screener cycle across the 6 market-cap tiers
(mega…nano). Each row: ticker, company, `market_cap_tier`,
`status` (`first`/`same`/`added`/`dropped`), price, `change_pct`, volume fields.

```bash
curl -H "Authorization: Bearer $KEY" http://localhost:5050/api/v1/multicap
```

`data`: `{items: [...], count: N}`

## GET /api/v1/correlation

Pearson correlations between 1-min price, 5-min social density, and 5-min
weighted sentiment.

| Param | Default | Notes |
|---|---|---|
| `ticker` | — | with `date`: live Finviz+Stocktwits run for that day |
| `date` | — | `YYYY-MM-DD`; omit to use historical DB fallback instead |
| `time_from` / `time_to` | 09:30 / 16:00 | live mode session window, `HH:MM` |

Without `ticker`+`date` it computes a fallback over the last 100 stored
insights (optionally filtered by `ticker`). Live mode is subject to the
Finviz caveat above.

```bash
curl -H "Authorization: Bearer $KEY" \
  "http://localhost:5050/api/v1/correlation?ticker=AAPL&date=2026-06-11"
```

`data`: `{ticker, n, r_price_sentiment, r_price_density, r_sentiment_density, chart: {labels, prices, sentiment, density}}`

## GET /api/v1/chart

Intraday 1-min price + volume bars for one ticker (live Finviz; subject to
the Finviz caveat above). Serves the most recent session with data, walking
back up to 4 days. Bars cover extended hours (~04:00–20:00 ET).

| Param | Default | Notes |
|---|---|---|
| `ticker` | required | 400 if missing |
| `window` | `full` | `full`, `2h`, or `1h` (relative to the last bar) |

```bash
curl -H "Authorization: Bearer $KEY" \
  "http://localhost:5050/api/v1/chart?ticker=AAPL&window=2h"
```

`data`: `{ticker, date, window, n, labels: ["HH:MM",...], prices: [...], volumes: [...], open, last}`
