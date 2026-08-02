# FlashFeed Agent Integration Map

## Current architecture and data sources

| Stage | Current FlashFeed source of truth | Agent rule |
|---|---|---|
| Process and refresh ownership | `Infrastructure/server/index.js` | Reuse the existing process and refresh path; do not add a second scheduler. |
| Approved news policy | `Infrastructure/server/sourceFilter.js` | Reject sources before classification. Do not import the StonkWise source list. |
| Article persistence | `Infrastructure/server/models/Article.js`, Mongo `articles` | Read existing document IDs, URLs, publication/first-seen fields, tickers, and source metadata. |
| Article APIs and catalyst windows | `Infrastructure/server/routes/articles.js` | Reuse current bounded, causal article windows. |
| Social persistence | `Infrastructure/server/models/Social.js`, Mongo `socials` | Read only if a future brief needs supporting context; preserve weighted FlashFeed sentiment. |
| Screener universe/fundamentals | `Infrastructure/server/routes/screener.js`, Mongo `screeners` | Validate every ticker and read existing company/sector/market-cap data. |
| OHLC | Mongo `ohlcv_bars` and existing chart routes | Use only real stored bars for historical context; never create a price provider. |
| Ranking and thresholds | `Infrastructure/server/lib/aiRankingScore.js`, `predictionThresholdPolicy.js`, `thresholdFeatures.js` | No write or invocation path from the prototype. |
| Decision Map | `Infrastructure/server/lib/decisionMapRows.js`, `Infrastructure/server/routes/decisionMap.js`, `app/src/pages/DecisionMapPanel.tsx` | Candidate future read-only evidence panel. |
| Position monitoring | `Infrastructure/server/routes/positionScreener.js`, `positionPolicy.js`, `positionHistory.js`, Mongo `screener_position_history` | Candidate future read-only explanation; never place or change a trade. |
| API/UI shell | Express plus `app/src/App.tsx` and `app/src/components/shared/TopBar.tsx` | Prefer an existing detail panel over a new top-level page. |
| Cache | Existing Redis integration in the backend | Cache read-only event responses only after correctness is proven. |

## Candidate insertion points

1. An idempotent shadow worker runs after the existing article refresh and reads only articles whose causal detection time is at or before the worker cutoff.
2. It applies the current approved-source policy, deterministic high-confidence rules, validated ticker/sector mapping, and event-level deduplication.
3. It writes versioned records to a separate proposed `catalyst_agent_shadow` collection. A unique key should combine classifier version and event identity.
4. Proposed read-only routes are `GET /api/agent/catalysts` and `GET /api/agent/ticker/:ticker`, both paginated and evidence preserving.
5. The first UI placement should be an expandable “Why this ticker?” panel in Decision Map or Positions. It should show direction, confidence, directness, horizon, sources, and uncertainty.

## Proposed shadow record

The schema is defined in `catalyst_schema.json`. Required operational fields include event ID, source document IDs and URLs, trusted publication time, first-seen time, detected time, source approval, category/subtype, severity, direction, confidence, directness, horizon, affected tickers/sectors, evidence text, duplicate group, and classifier/model version.

## Services that must not be duplicated

News and social collectors, source approval, ticker extraction already stored on articles, screener universe, Finviz fundamentals, weighted sentiment, OHLC retrieval, Redis refresh ownership, rankings, thresholds, position simulation, and market-hours restrictions remain exclusively owned by FlashFeed.

## Failure and safety boundary

If classification, Mongo writes, or an optional model fails, the endpoint returns no enrichment and the normal dashboard continues. The feature flag defaults off. There is no import of entry/exit policy functions and no trade mutation capability. Main risks are time leakage, syndication inflation, unsupported ticker/effect claims, prompt injection, provider latency/cost, source-policy drift, and accidental future coupling to live policy.
