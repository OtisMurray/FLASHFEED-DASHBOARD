# Test Results

## Versions

- FlashFeed commit: `2593eb6a8747bd7caa6a4dd03afb5063b1984f26`
- StonkWise commit: `fe14c61ac7bd19a95dcec6c34e5cc4019f662dda`
- Study command: `npm test && npm run study`

## Research prototype

`npm test` completed with 14 passing tests, 0 failures, 0 skips, and 0 cancellations.

The suite verifies:

- feature flag disabled by default;
- approved-source filtering;
- trusted publication versus first-seen timestamps;
- duplicate syndication collapse;
- direct, indirect, alias, and multi-ticker mapping;
- separate direction and severity;
- geopolitical, offering/dilution, FDA/clinical, and earnings categories;
- prompt-injection content treated as untrusted data;
- malformed JSON, invalid confidence, hallucinated tickers, and invalid evidence rejection;
- provider timeout and unavailable-provider fallback;
- deterministic rerun and future-data mutation protection;
- no trading methods or side effects.

The Mongo-backed study completed successfully. The event-registry digest matched an immediate deterministic rerun, and causal frozen-entry joins reported 0 future-data violations.

## StonkWise reference project

`python3 -m compileall -q app tests` completed successfully.

The StonkWise pytest suite was not executed because the isolated host does not have pytest or the project's Python dependency stack installed. The exact failure was `No module named pytest`. Heavy model and framework dependencies were intentionally not downloaded for this read-only audit.

## Model-provider check

No local Ollama or other LLM provider was configured. One bounded provider attempt followed the deterministic fallback path as designed. Therefore, no optional-AI accuracy, latency, or unsupported-claim performance is reported.

## Interpretation

Passing prototype tests demonstrate deterministic mechanics and safety properties. They do not establish catalyst-classification precision or predictive value. Those require an independently labeled review set and a later date-separated frozen evaluation.
