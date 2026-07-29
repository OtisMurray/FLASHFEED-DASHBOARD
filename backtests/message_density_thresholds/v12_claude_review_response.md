# v12 Review Response For Aman

## Why The Files Were Missing

The v12 files were intentionally local because Otis required that nothing be pushed before review. The result is reproducible from the config inheritance chain and raw output included in the evidence bundle; it did not come from a separate hidden harness.

## Important Correction Found During Review

Claude's challenge led to a genuine parity finding. The first harness result treated a 4% peak giveback as 4% of accumulated profit, while production treats it as a 4% price decline from the post-entry peak. The harness was corrected to production's formula and the full run was repeated. The earlier `+3.2828%` claim is withdrawn.

Corrected v12 result:

- 38 trades across 18 market days
- 60.53% win rate
- +2.7306% mean and +0.6140% median net return
- 4.4833 profit factor
- -7.8429 percentage-point maximum drawdown
- 25 end-of-day exits, 7 protective stops, and 6 profit-giveback exits

Comparable v11 result:

- 40 trades, 57.50% win rate
- +1.5719% mean and +0.3133% median
- 2.3875 profit factor
- -13.9978 percentage-point maximum drawdown

V12's full path is materially better than v11 in this retrospective sample, but this does not establish future superiority.

## Buy-And-Hold Comparison

Using the exact same 38 entries and costs:

| Path | Mean net | Median net | Win rate | Profit factor |
| --- | ---: | ---: | ---: | ---: |
| v12 strategy | +2.7306% | +0.6140% | 60.53% | 4.4833 |
| Hold to strategy exit-bar close | +3.0054% | +0.6140% | 60.53% | 5.1052 |
| Hold to final session bar | +2.6728% | +0.8676% | 63.16% | 3.8572 |

V12 is `-0.2747` mean points behind the same-exit-bar close and only `+0.0579` ahead of session-end holding. Day-block 95% intervals cross zero for both alphas. The evidence supports the quality of the selected ticker-days more than it supports an independently superior exit.

## Additional Validation

- Sequence dev/validation/test means: +2.8025%, +2.8318%, +2.4317%
- Temporal dev/validation/test means: +2.6685%, +3.1599%, +2.6317%
- Remove best three trades: +1.5814% mean, PF 2.858
- Add 2.00 percentage points of round-trip cost to every trade: +0.7306% mean, PF 1.404
- Positive average return on 13 of 18 historical market days
- Same-ticker/day random-time placebo: actual strategy +2.7306% versus random-time strategy +1.1888%; 1.46% of 5,000 random portfolios matched actual
- The corresponding random-time end-of-day hold averaged +3.1802%, so the selected days themselves were strong and the exit edge remains unproven

## Frozen Later-Day Check

The unchanged rule was run on July 27, after the original cutoff. Only 25 local price/social contexts were available and neither v12 nor v11 generated a trade. This confirms no accidental gate relaxation, but provides no return evidence.

## Full-Runner Semantics

- Omitted `partialExitFraction`: historical v11 default of 0.5
- Explicit `partialExitFraction: 0`: full-position runner
- Explicit `null`: compatibility path that also disables the partial exit

The v12 profile uses explicit `0`, and regression tests cover zero and null behavior.

## Recommendation

Keep the override-threading and opening-window fixes, and expose v12 as a clearly labeled probe/shadow profile. Do not replace live v11 yet. Accumulate at least 60 causally captured trades with adequate temporal buckets, then reassess the entry gate and optimize/validate the exit separately against same-entry passive holds.

No files were committed or pushed during this validation.
