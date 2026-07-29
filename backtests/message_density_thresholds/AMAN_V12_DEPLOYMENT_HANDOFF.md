# Aman / Claude v12 Deployment Handoff

## Decision Required Before Deployment

This package is technically ready to deploy, but one product decision remains explicit: the shared prediction-threshold policy is v12, so deploying these runtime files will make v12 the backend's active threshold classification policy. It is visibly labeled `historically_validated_probe_requires_forward_evidence`; it is not presented as proven trading advice.

The evidence supports v12 as a better retrospective entry profile than v11. It does **not** prove that v12's exit overlay is better than passive holding from the same entries. If Claude wants v12 to remain isolated like `/v11-screener`, do not deploy the shared policy file until a separate v12 probe route is added.

## Direct Responses To Claude's Review

1. **Missing config, harness, and raw outputs:** Included. The final config is `config_v12_final_confirmation_mongo_ohlc.json`, the harness is `run_backtest.mjs`, and the raw output directory is `outputs_v12_final_confirmation_mongo_ohlc`.
2. **Opening-window logic absent from the harness:** Present now and exercised by the final run. The rule blocks new entries during the first 20 regular-session minutes. The live v11 replay route now passes each signal bar's timestamp into the shared policy so its opening guard is evaluated rather than skipped.
3. **Buy-and-hold comparison:** Added for all 38 exact v12 entries with identical costs. V12 returned `+2.7306%` mean; hold to the strategy exit-bar close returned `+3.0054%`; hold to session end returned `+2.6728%`.
4. **Full-runner null fallthrough:** Fixed. V12 uses explicit `partialExitFraction: 0`. Omission keeps the legacy v11 `0.5` partial exit, while explicit `0` or `null` disables it. Regression tests cover all three cases.
5. **Override keys silently dropped:** Fixed in the shared profile merger using explicit own-property checks. Tests prove a supplied override changes the evaluated gate and that explicit null survives the merge.
6. **Unverifiable original result:** Claude's review exposed a real harness mismatch. The earlier `+3.2828%` claim is withdrawn. Every number below is from the corrected production-parity rerun.

## Corrected Evidence

| Metric | v11 parity | v12 candidate |
| --- | ---: | ---: |
| Trades | 40 | 38 |
| Win rate | 57.50% | 60.53% |
| Mean net return | +1.5719% | +2.7306% |
| Median net return | +0.3133% | +0.6140% |
| Profit factor | 2.3875 | 4.4833 |
| Max drawdown | -13.9978 pp | -7.8429 pp |

The corrected v12 exit mix is 25 end-of-day exits, 7 protective stops, and 6 profit-giveback exits.

## Validation Beyond The Selected Run

- Sequence development/validation/test means: `+2.8025%`, `+2.8318%`, `+2.4317%`.
- Temporal development/validation/test means: `+2.6685%`, `+3.1599%`, `+2.6317%`.
- Removing the best three trades leaves `+1.5814%` mean and PF `2.858`.
- Adding 2.00 percentage points of extra round-trip cost leaves `+0.7306%` mean and PF `1.404`.
- Thirteen of 18 historical market days have positive average returns.
- In 5,000 same-ticker/day random-time simulations, only `1.46%` matched v12's strategy mean.
- The corresponding random-time end-of-day hold averaged `+3.1802%`; ticker-day selection was favorable and exit alpha remains unproven.
- Day-block bootstrap intervals for alpha versus both passive comparisons cross zero.
- The frozen July 27 replay had 25 matched contexts and generated zero v12 and zero v11 trades. That verifies no gate relaxation but provides no forward return evidence.
- Promotion criteria remain unmet: 38 total trades versus 60 required, 16 temporal-development trades versus 20 required, and 6 temporal-validation trades versus 8 required.

## Final v12 Rule

- Causal 180-minute rolling Pearson correlation between price and trailing-smoothed message density.
- Fresh cross above `0.40`.
- Prior 60-minute return no greater than `4%`.
- At least 5 trailing-60-minute messages; Small requires 8 and Nano requires 12.
- Active-session move between `0%` and `20%`.
- No new entries during the first 20 regular-session minutes.
- Existing float, evidence, short-interest, overextension, and liquidity gates remain active.
- Entry occurs on the next real bar after the completed signal bar.
- Full-position runner, 3% protective stop, 4% decline from peak after reaching +10%, and end-of-day flattening.

## Runtime Changes

- `Infrastructure/server/lib/predictionThresholdPolicy.js`: corrected v12 profile, metadata, opening guard, and override semantics.
- `Infrastructure/server/lib/payoffCapture.js`: production full-runner semantics and peak-decline giveback behavior.
- `Infrastructure/server/routes/v11Screener.js`: signal timestamps now reach the opening guard.
- `scripts/label_next_day_prediction_outcomes.js`: outcome labeling uses matching exit semantics.
- `Infrastructure/server/tests/predictionThresholdPolicy.test.js`: policy, opening guard, override, and null-preservation regression coverage.
- `Infrastructure/server/tests/payoffCapture.test.js`: omitted/zero/null partial-exit and giveback regression coverage.
- `Infrastructure/server/tests/v11ScreenerProfile.test.js`: v11 opening-window integration coverage.

## Evidence Files

- `v12_threshold_summary.md`: complete corrected analysis and limitations.
- `v12_claude_review_response.md`: short response to the original review.
- `validate_v12_candidate.mjs`: passive benchmarks, placebo, bootstrap, and stress validation.
- `config_v12_*_mongo_ohlc.json`: search, confirmation, and frozen later-day configs.
- `outputs_v12_*_mongo_ohlc`: raw summaries, trades, sweeps, and diagnostics.

Runtime does not read the output directories; they are evidence only.

## Verification Completed

- Backend tests: `33/33` passed.
- Backtest feature tests: `6/6` passed.
- Frontend production build: passed; only the pre-existing circular vendor-chunk warning remains.
- Backend Docker image build: passed.
- Rebuilt local backend health check: HTTP `200`, MongoDB and Redis healthy.
- Prediction audit: HTTP `200`, reports v12 probe status and corrected `2.7306` / `4.4833` metrics.
- v11 probe: HTTP `200`; explicit v11 profile remains available.
- No unresolved merge markers or whitespace errors.
- No credentials, environment files, caches, or unrelated archives are part of the handoff bundle.

## Deployment And Rollback

- No database migration and no new environment variable are required.
- Redeploy the **backend** from `Infrastructure/server/Dockerfile`.
- The chart-service has no threshold-package code change and does not need a dedicated redeploy for this work.
- After deploy, check `/api/health`, `/api/prediction/audit?limit=1`, and `/api/v11-screener?limit=1&maxCandidates=1`.
- Confirm the audit response reports policy version ending in `_v12`, status `historically_validated_probe_requires_forward_evidence`, mean `2.7306`, and PF `4.4833`.
- Roll back by reverting the eventual deployment commit and redeploying the backend. Do not alter thresholds in Railway environment variables to imitate a rollback.

## Recommendation

Approve deployment only with the probe label and the limitations above intact. Continue collecting causally captured forward trades; do not claim the exit is validated or optimize it again until the predefined sample gates are met.

Nothing in this handoff has been committed or pushed.
