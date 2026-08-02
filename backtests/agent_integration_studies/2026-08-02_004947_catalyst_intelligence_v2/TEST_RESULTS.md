# Catalyst Intelligence v2 Test Results

Tested FlashFeed commit: `2593eb6a8747bd7caa6a4dd03afb5063b1984f26`

## Focused backend tests

Command:

```bash
node --test Infrastructure/server/tests/catalystIntelligence.test.js
```

Result: 16 passed, 0 failed. Coverage includes disabled-by-default behavior,
approved-source filtering, causal timestamps, event deduplication, ticker and
company mapping, direction and severity separation, direct and indirect
effects, prompt-injection handling, malformed or hallucinated provider output,
provider timeout fallback, evidence validation, deterministic reruns, future
mutation safety, and absence of trading side effects.

## Full backend suite

Command:

```bash
cd Infrastructure/server
npm test
```

Result: 184 passed, 0 failed. Existing prediction, threshold, position,
social, watcher, chart, v11, and v12 tests remained green.

## Frontend production build

Command:

```bash
cd app
npm run build
```

Result: succeeded. The TypeScript ratchet reported 54 existing baseline errors
and 54 current errors, so this work introduced no new type errors. Vite emitted
the existing circular vendor-chunk warning; it did not fail the build.

## Local API smoke test

A temporary local Express process mounted only the Catalyst Intelligence route,
connected to `mongodb://127.0.0.1:27017/feedflash`, and did not start workers or
schedulers. The status endpoint reported the feature as enabled for the smoke
test and explicitly reported no ranking, position, or trading effects. A DFNS
ticker request returned one source-grounded, trusted-time, deterministic event
from two queried approved articles. The process and database connection were
closed after the check.

## Historical Mongo study

Commands:

```bash
cd backtests/agent_integration_studies/2026-08-02_004947_catalyst_intelligence_v2
npm test
npm run study
```

Result: study completed successfully against local Mongo data. It processed
108,700 approved articles, produced 7,231 raw structured classifications,
collapsed 1,092 duplicate syndications, retained 6,139 deduplicated events,
and observed zero future-data leakage violations. The deterministic registry
digest matched on rerun.

## Static checks

Commands:

```bash
git diff --check
node --check Infrastructure/server/lib/catalystIntelligence.js
node --check Infrastructure/server/routes/catalystIntelligence.js
```

Result: all passed.

## Evidence verdict

The feature is suitable for a local explanatory demo. It is not supported as a
prediction or trading-policy change because the frozen position history covers
only three distinct dates and has no independent human-labeled catalyst truth
set. The feature remains disabled by default and read-only.
