# Integration Options

## 1. Minimal and low-risk

- **Purpose:** add deterministic catalyst tags and source links to an existing ticker detail response.
- **Files/services affected:** one future isolated backend library, one read-only route, and an existing Decision Map or Positions detail component.
- **Data flow:** existing Mongo articles -> approved-source and causal-time filter -> deterministic rules -> validated response.
- **Mongo/API/UI:** no persistent collection required initially; one bounded ticker endpoint; one expandable evidence section.
- **Schedule and flags:** request-time or post-refresh calculation, guarded by `FLASHFEED_CATALYST_AGENT_SHADOW=false`.
- **Dependencies/cost/latency:** existing Node/Mongo only, no paid provider, approximately the measured deterministic latency.
- **Failure behavior:** omit enrichment and preserve the dashboard response.
- **Testing/deployment:** source, timestamp, taxonomy, evidence, and no-side-effect tests; normal backend build only after separate approval.
- **Main risk:** repeated request-time work and no durable review/audit history.

## 2. Moderate useful integration (recommended)

- **Purpose:** create deduplicated, versioned Catalyst Intelligence shadow records with source-grounded deterministic briefs and explicitly uncertain macro/sector effects.
- **Files/services affected:** proposed backend classifier/deduper/worker/model/route modules plus existing Decision Map and Positions details. Production policy modules remain untouched.
- **Data flow:** existing article refresh -> approved causal records -> rule classification -> ticker/sector effects -> event dedup -> strict schema -> optional model brief -> validation -> separate shadow collection -> read-only UI.
- **Mongo schema:** separate `catalyst_agent_shadow` with event/version uniqueness, source documents, causal timestamps, duplicate group, affected assets, evidence, and method versions.
- **API/UI:** proposed `GET /api/agent/catalysts` and `GET /api/agent/ticker/:ticker`; expandable “Why this ticker?” in Decision Map first, Positions second.
- **Schedule and flags:** idempotent bounded batch after the existing refresh; disabled by default; no second global polling loop.
- **Dependencies/cost/latency:** existing Mongo/Redis for deterministic mode; zero model cost. An optional provider is a later flag with strict timeout/cache/budget.
- **Failure behavior:** retain deterministic records or return no enrichment; never block ranking, charts, or positions.
- **Testing/deployment:** prototype tests plus model/API/component, idempotence, timeout, monitoring, and migration tests; shadow deployment only after human labels and review.
- **Main risks:** dedup errors, indirect-effect overclaiming, unsupported mapping, time leakage, and UI trust exceeding evidence.

## 3. Full future Agent architecture

- **Purpose:** a versioned cross-asset event/effect graph with commodities, ETFs, geopolitical context, optional validated model synthesis, review workflow, and historical feature research.
- **Files/services affected:** dedicated worker, event/effect collections, model gateway, audit/review API and UI, monitoring, and data-quality jobs.
- **Data flow:** moderate design plus licensed cross-asset inputs, entity graph, effect hypotheses, human labels, provider ensemble/fallback, and frozen evaluation sets.
- **Mongo/API/UI:** separate event, effect, model-run, label, and audit records; dedicated research views may become justified.
- **Schedule and flags:** queue-based, versioned, replayable jobs with strict budgets and provider circuit breakers.
- **Dependencies/cost/latency:** highest. Railway CPU/memory, model expense, data licenses, and operational ownership require measurement before design approval. Local Ollama is not assumed feasible.
- **Failure behavior:** degrade to deterministic records; stale/model-failed states remain visible; no policy dependency.
- **Testing/deployment:** independent labeled benchmark, security review, load test, observability, replay/determinism, and frozen forward evaluation.
- **Main risks:** cost, licensing, model drift, causal overclaiming, prompt injection, and architecture complexity.

None of the options permit autonomous trading or a live threshold change. Option 2 is the strongest balance of usefulness, traceability, and operational risk.
