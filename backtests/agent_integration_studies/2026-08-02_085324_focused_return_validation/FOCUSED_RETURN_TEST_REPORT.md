# Focused Catalyst Return Test

## Verdict

**No catalyst policy demonstrated a reliable return improvement. Keep Catalyst Intelligence explanatory-only.**

The test used 558 frozen observations, but only 41 were finalized simulated positions. The remaining 517 rows are unresolved frozen marks and were not treated as realized evidence in the primary conclusion.

## Finalized-position results

| Policy | Trades | Coverage | Mean | Median | Opportunity-adjusted | Max drawdown |
|---|---:|---:|---:|---:|---:|---:|
| baseline_all | 41 | 100% | 1.0854% | 0.14% | 1.0854% | -31.1222% |
| any_verified_catalyst | 41 | 100% | 1.0854% | 0.14% | 1.0854% | -31.1222% |
| direct_catalyst | 3 | 7.32% | -0.3767% | -2.79% | -0.0276% | -6.0757% |
| aligned_high_confidence | 0 | 0% | n/a | n/a | 0% | 0% |
| reject_capital_structure | 39 | 95.12% | 1.0985% | 0.14% | 1.0449% | -32.5433% |
| reject_contradiction | 41 | 100% | 1.0854% | 0.14% | 1.0854% | -31.1222% |
| direct_aligned_no_capital_structure | 0 | 0% | n/a | n/a | 0% | 0% |

Opportunity-adjusted return assigns a zero return to skipped baseline opportunities. This prevents a tiny selected subset from appearing superior solely because most trades were omitted.

## Robustness

The study used one date each for development, validation, and test, added 0.25, 0.50, and 1.00 percentage-point cost stress, removed the best and worst one and three trades, ran 5,000 deterministic day-block bootstrap samples per policy, and measured ticker/date concentration. No non-baseline policy met the pre-registered evidence rule.

## Interpretation

The structured catalyst layer measurably improves explanation, deduplication, and traceability. This dataset does not show that filtering entries with those fields improves returns. Three dates and 41 finalized positions are not enough to separate a repeatable edge from selection noise.

No ranking, threshold, entry, exit, position, or production file was changed by this focused test.
