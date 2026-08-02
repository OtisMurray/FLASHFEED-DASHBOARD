# Catalyst Intelligence v2 Local Integration Report

## Outcome

The strongest defensible StonkWise improvement is now implemented locally as a
read-only Catalyst Intelligence disclosure in the Decision Map. It consumes
FlashFeed's existing approved articles and ticker universe, produces structured
and source-grounded catalyst records, collapses duplicate syndications, and
shows a concise explanation only when the user opens it for a selected ticker.

It does not alter AI rankings, prediction thresholds, entry or exit logic,
positions, schedulers, or trading behavior. The feature flag
`FLASHFEED_CATALYST_AGENT_SHADOW` defaults to `false`.

## Measured improvement

- Existing FlashFeed catalyst coverage: 21,970 of 108,700 articles (20.21%).
- Improved deterministic classifier coverage: 7,231 articles (6.65%).
- Combined existing plus improved coverage: 25,515 articles (23.47%).
- Incremental combined coverage: 3,545 articles, or 3.26 percentage points.
- Duplicate syndications collapsed: 1,092 (15.10% of classified articles).
- Deduplicated structured events: 6,139.
- Source citation validity in generated records: 100%.
- Future-data leakage violations: 0.
- Deterministic rerun digest match: yes.
- Processing time: 0.0307 milliseconds per article on this local run.

The coverage figures measure structured recognition, not classification
precision. No independent human-labeled truth set was available, so precision
must not be inferred from coverage.

## Historical strategy check

Seven small pre-registered catalyst research variants were evaluated on 558
stored simulated positions. The position history covers only July 29 through
July 31, 2026, which is three distinct dates and is not an independent temporal
validation set. No candidate passed the minimum evidence requirements, and no
positive prediction or trading recommendation was produced.

The correct verdict is:

`local_demo_ready_explanatory_shadow_not_prediction_ready`

## Dashboard impact

The Decision Map can show a compact catalyst brief containing direction,
confidence, severity, directness, horizon, causal timestamp basis, and a link
to supporting evidence. Data is fetched only when the disclosure is opened,
which avoids another polling loop and keeps the map responsive.

Positions and prediction screens were intentionally left unchanged. Extending
the feature into those workflows before independent labeling and a larger
forward period would imply predictive value that this study did not establish.

## Next evidence needed

1. Independently label the prepared review sample for category, direction,
   ticker mapping, and evidence validity.
2. Accumulate a longer frozen forward period with more market dates.
3. Re-run the pre-registered variants once without retuning.
4. Consider prediction shadow mode only if temporal results are positive and
   robust; do not change production policy based on this study.

## Safety

All work was local. No commit, branch, push, pull request, merge, deployment,
Railway change, live threshold change, or trade action was performed.
