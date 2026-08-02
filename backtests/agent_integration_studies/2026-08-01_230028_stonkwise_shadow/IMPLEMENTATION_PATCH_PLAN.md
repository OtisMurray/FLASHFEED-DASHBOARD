# Implementation Patch Plan (proposal only)

No production file was modified. A future reviewed patch would:

1. Add a backend `lib/catalystIntelligence` module using current `sourceFilter.js` and article causal-time helpers.
2. Add a separate `catalyst_agent_shadow` model/collection with unique event/version keys and source references.
3. Add an idempotent post-ingestion shadow worker behind `FLASHFEED_CATALYST_AGENT_SHADOW=false`.
4. Add read-only ticker and event routes with bounded pagination.
5. Add expandable evidence panels to existing Decision Map and Positions details, not a new top-level page initially.
6. Port this research test suite and add API/component tests.
7. Add monitoring for latency, failures, duplicates, unsupported claims, and provider fallback.
8. Keep ranking, thresholds, and position code untouched until independent labels and frozen forward evidence exist.
