# StonkWise Integration Report

## Verdict

**The result is ready for a local explanatory demo only. It is not ready to influence predictions, positions, or production.** Keep all live policies unchanged.

## Reproduction scope

- FlashFeed commit: `2593eb6a8747bd7caa6a4dd03afb5063b1984f26`
- StonkWise audit commit: `fe14c61ac7bd19a95dcec6c34e5cc4019f662dda`
- Mongo database: `feedflash` through the redacted URI in `data_audit.json`
- Article causal range: 2023-06-05T11:27:49.000Z through 2026-07-31T21:15:08.000Z
- Command: `npm test && npm run study` from this research directory
- Feature flag: research scripts require `--enable-research`; production files and policies are not imported or modified

## Historical catalyst evaluation

| Method | Detected | Approved coverage | What can be concluded |
|---|---:|---:|---|
| Existing FlashFeed catalyst fields | 21,970 | 20.21% | Existing coverage benchmark, not a precision score |
| StonkWise keyword rules | 2,488 | 2.29% | Narrow and context-sensitive; broad fragments can be wrong |
| Improved deterministic rules | 7,231 | 6.65% | Structured, traceable local prototype output |
| Combined existing plus improved | 25,515 | 23.47% | Coverage union only; not independent evidence |
| Optional AI structured classifier | 0 | 0.00% | Provider unavailable; fallback passed, no model quality claimed |

The improved method produced 7231 raw structured classifications and 6139 event records after collapsing 1092 syndications, a 15.10% duplicate rate before collapse. All retained records carry source-document evidence. Ticker mapping coverage was 78.29%; sector mapping coverage was 4.15%. These are coverage measures, not precision. No independent human labels exist, so category, direction, ticker, and sector precision remain unknown.

## Forward price context

174 event/ticker rows were joined to real stored OHLC after each causal detection time. Returns at 15, 30, 60, and 120 minutes, official close, and next supported session are in `forward_price_context.csv`. They are descriptive context only. The study does not claim that an event caused a move.

## Frozen-entry research

Seven hypotheses were registered before the run in `RESEARCH_HYPOTHESES.md`; entry and exit behavior was not optimized. The source contained 558 recorded simulated positions but only 3 distinct dates. The row-sequence development/validation/test split therefore does not create independent temporal days: both validation and test are concentrated on one date.

| Variant | Test rows | Mean return | Key result |
|---|---:|---:|---|
| Explanation only baseline | 112 | -0.0023% | Reference frozen entries |
| Direct catalyst required | 37 | -0.0065% | Did not improve baseline and was highly ticker concentrated |
| Aligned high confidence | 9 | 0.0000% | Only 9 rows; insufficient evidence |
| Reject contradictory catalyst | 91 | -0.0002% | Near baseline, not an independent improvement |
| Affected-sector macro | 70 | -0.0213% | Underperformed baseline |

“Any verified catalyst” selected every entry because at least one broad market event existed in each 72-hour window. That makes it non-discriminating and proves broad macro presence cannot be used as a generic gate. aligned_high_confidence selected 9 test rows with mean 0.0000%. No candidate passed a minimum-count, independent-temporal-test standard.

## Validation and safety

- Deterministic registry digests matched on rerun.
- Causal candidate joins had 0 future-data violations.
- The prototype test suite covers source policy, timestamp trust, deduplication, direct/indirect and multi-ticker mapping, direction classes, geopolitical/offering/FDA/earnings rules, prompt injection, malformed or hallucinated model output, evidence validation, timeout fallback, deterministic mutation, feature flag default, and absence of trading side effects.
- No local LLM provider was available. One bounded attempt failed safely into deterministic output.

## Required answers

1. **What parts still work?** Agent orchestration, event-expiration and macro-context concepts, report presentation, and basic pipeline structure.
2. **What is broken or unreliable?** Broad substring classification, weak model-output validation, prompt safety, citation ambiguity, event deduplication, narrow ticker mapping, cooldown arithmetic, and directional interpretation of risk.
3. **What does FlashFeed already do better?** Approved ingestion, causal timestamps, its listed-US universe, Mongo/Redis persistence, weighted sentiment, OHLC, ranking, positions, and React presentation.
4. **Which parts should be reused?** Concepts for orchestration, macro context, optional provider abstraction, and evidence reports. No subsystem should be copied wholesale.
5. **Which parts should be rewritten?** Classifiers, schemas, event identity, evidence links, ticker/sector effects, model validation, persistence, APIs, and UI.
6. **Best integration point?** A separate read-only enrichment after existing article ingestion, displayed inside existing Decision Map details first.
7. **Is catalyst recognition the strongest use?** Yes. Deduplicated, structured, source-grounded catalyst explanation is the clearest incremental value.
8. **Include macro/geopolitical context?** Yes, cautiously, with directness, asset-specific direction, confidence, horizon, and evidence.
9. **Prediction influence or explanation?** Explanation only. Historical strategy evidence is not independent or positive enough.
10. **Measurable historical value?** Deduplication, traceability, schema validity, and coverage improved measurably. Predictive value was not demonstrated.
11. **Smallest useful integration?** Deterministic tags and citations in an expandable existing candidate detail panel.
12. **Full future requirements?** Independent labels, a versioned event/effect graph, optional validated model gateway, monitoring, licensing review, resource planning, and frozen forward evaluation.
13. **Operational/data-source risks?** Source compliance, duplicate inflation, time leakage, hallucinated mapping, prompt injection, model cost/latency, indirect-effect overclaiming, and accidental policy coupling.
14. **Readiness?** Local explanatory demo. Not prediction shadow and not production.

## Limitations and next step

The review sample is intentionally blank for independent human labels. The optional AI path was not evaluated. Position outcomes are simulated, concentrated in three dates, and observational. The next valid step is to label `labeled_review_sample.csv`, calculate real precision and unsupported-claim rates, then freeze the design for a later date-separated evaluation. Do not change thresholds or positions.
