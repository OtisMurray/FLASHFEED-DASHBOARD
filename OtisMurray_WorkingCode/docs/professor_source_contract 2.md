# Professor Source Contract

This dashboard should maximize legally accessible market news, social sentiment,
screeners, and derived signals without scraping paywalled/licensed data or
pretending placeholders are live integrations.

## Current Working Sources

- Platform news: Finviz public news, TradingView public news, TradingView ticker
  news flow.
- Global wires: PR Newswire, PR Newswire Financial, GlobeNewswire public-company
  feed, ACCESS Newswire public newsroom.
- Regulatory: SEC EDGAR current/8-K/10-Q/10-K and FDA press/recall/MedWatch
  feeds.
- Social: StockTwits, Bluesky, Reddit public fallback, and X/Twitter when a
  bearer token is supplied.
- Numeric screeners: TradingView public numeric screener; Finviz Elite when
  `FINVIZ_AUTH_TOKEN` is supplied.
- Derived rankings: deterministic keyword scoring, news/social correlation,
  prediction snapshots, and AI numeric ranking models already have API surfaces.

## Credential Or License Gated

- Benzinga requires `BENZINGA_API_KEY`.
- Dow Jones Newswires requires a licensed feed or broker entitlement such as an
  IBKR news subscription.
- Interactive Brokers news requires TWS/IB Gateway, enabled news permissions,
  and `IBKR_ENABLE_NEWS=true`.
- Schwab/TD Ameritrade news, movers, and trading require Schwab API OAuth tokens;
  TD Ameritrade is handled through Schwab after the migration.
- X/Twitter requires `X_BEARER_TOKEN` for reliable API access.
- Options, futures, arbitrage, and high-resolution CVD require legal market data
  providers before they can be treated as production signals.

## Performance Contract

- The backend scheduler, not the browser tab, performs the recurring fetch.
- Redis is the hot RAM cache for dashboard reads and rolling feed windows.
- Kafka carries new/updated events to the Redis hot feed; Kafka remains
  disk-backed but configured to avoid constant flushes.
- MongoDB is the resting database.
- Fetch cycles are non-overlapping, throttled, and token-protectable.

## API Security Contract

- `ADMIN_TOKEN` protects admin fetch endpoints.
- `API_TOKEN` with `API_TOKEN_SCOPE=write` protects mutating API calls.
- `API_TOKEN_SCOPE=all` protects read APIs too, except health checks.
- Tokens are accepted through `X-API-Token`, `X-Admin-Token`, or
  `Authorization: Bearer`.

## Planned Modules

- CVD calculations from high-resolution chart/trade signals.
- Long-term scans for investment candidates.
- Arbitrage across legally available venues.
- Google Trends ingestion.
- Short-squeeze signals.
- Alert engine for short squeeze, social/message density, news velocity, and
  market-session rising stars.
- Guardrailed AI agent/learning loop.
- Research-only broker bracket-order planning until live broker trading is
  explicitly authorized and isolated.
