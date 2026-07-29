# Threshold v12 Production-Parity Validation

## Recommendation

Keep v12 as a shadow/probe profile and continue forward validation. Do not replace the live v11 policy yet.

The candidate gate is:

- 180-minute causal rolling Pearson correlation between price and trailing-smoothed message density
- Fresh cross above `0.40`
- Prior 60-minute return no greater than `4%`
- At least 5 messages in the trailing 60 minutes; Small requires 8 and Nano requires 12
- Active-session move from `0%` through `20%`
- No new entries during the first 20 regular-session minutes
- Existing float, catalyst/social, short-interest, overextension, and liquidity gates remain in force
- Entry on the next real bar after the completed signal bar
- Full-position runner with a 3% protective stop, 4% decline from a post-entry peak after reaching +10%, and end-of-day flattening

The production profile encodes the full runner as `partialExitFraction: 0`. An omitted value retains the historical v11 50% partial default; explicit `0` or `null` disables the partial exit.

## Production-Parity Correction

The first local report overstated v12 returns because the backtest interpreted a 4% giveback as 4% of accumulated profit. Production uses a 4% price decline from the post-entry peak. The harness now uses production's `peak * (1 - givebackPct / 100)` rule, and every result below comes from a complete rerun after that correction.

## Data And Execution

- Price source: Mongo `ohlcv_bars`, source `yahoo_chart_ohlcv`
- Configured analysis range: June 10 through July 27, 2026; usable retrospective data ended July 24
- Requested social-capable tickers: 696; eligible price histories: 513; matched price/social contexts: 406
- Accepted OHLC rows: 1,308,126; matched social documents: 103,187
- Social mix: 100,729 StockTwits, 2,370 Bluesky, 87 Reddit, and 1 unstructured row
- Matched catalyst documents: 9,405
- Prices are never fabricated or forward-filled; missing social minutes are causally zero-filled
- Signals use information available by minute `t`, enter on the next real bar, use conservative intrabar stop ordering, and include tier-specific round-trip slippage

## v11 Versus v12

| Metric | Current v11 exact | Proposed v12 probe |
| --- | ---: | ---: |
| Trades | 40 | 38 |
| Win rate | 57.50% | 60.53% |
| Mean net return/trade | +1.5719% | +2.7306% |
| Median net return/trade | +0.3133% | +0.6140% |
| Profit factor | 2.3875 | 4.4833 |
| Max drawdown, percentage points | -13.9978 | -7.8429 |

V12 improves the complete simulated strategy path by +1.1587 mean percentage points per trade, with higher win rate and profit factor and lower drawdown. This is encouraging retrospective evidence, not sufficient promotion evidence.

## Same-Entry Passive Benchmarks

All paths use the same 38 entries and configured round-trip slippage.

| Path | Win rate | Mean net | Median net | Profit factor | Max drawdown |
| --- | ---: | ---: | ---: | ---: | ---: |
| v12 strategy | 60.53% | +2.7306% | +0.6140% | 4.4833 | -7.8429 pp |
| Hold to strategy exit-bar close | 60.53% | +3.0054% | +0.6140% | 5.1052 | -8.7945 pp |
| Hold to final session bar | 63.16% | +2.6728% | +0.8676% | 3.8572 | -13.7589 pp |

V12 trails the same-exit-bar close by `-0.2747` mean points and exceeds the session-end hold by only `+0.0579` points. Day-block 95% bootstrap intervals cross zero for both comparisons: `[-0.7185, +0.0833]` versus the same exit bar and `[-2.0918, +1.7753]` versus session end. The entries appear useful; the exit overlay has not demonstrated independent alpha.

## Historical Splits

| Split | Trades | Mean net return | Profit factor |
| --- | ---: | ---: | ---: |
| Sequence development | 22 | +2.8025% | 4.3812 |
| Sequence validation | 8 | +2.8318% | 7.6601 |
| Sequence test | 8 | +2.4317% | 3.3861 |
| Temporal development | 16 | +2.6685% | n/a |
| Temporal validation | 6 | +3.1599% | n/a |
| Temporal test | 16 | +2.6317% | n/a |

All measured historical segments are positive. The promotion gate still rejects promotion because it requires 60 trades, 20 temporal-development trades, and 8 temporal-validation trades; v12 has 38, 16, and 6 respectively.

## Same-Day Timing Placebo

A deterministic 5,000-iteration placebo selected random entry times from 9:50 AM through 3:30 PM on the exact same ticker-days, then applied the same production-parity exit and costs.

- Actual v12 strategy mean: `+2.7306%`
- Random-time strategy mean: `+1.1888%`; 95% simulation range `[-0.0526%, +2.5645%]`
- Only 1.46% of random portfolios matched or exceeded the actual strategy mean
- Actual signal-time end-of-day hold: `+2.6728%`
- Random-time end-of-day hold: `+3.1802%`; 73.10% of random portfolios matched or exceeded the actual end-of-day result

This supports the signal timing when paired with the v12 stop logic, but it also shows that these were generally strong ticker-days and that passive intraday timing could capture more of the full-day move. Ticker-day selection remains conditioned on the historical signal, so this is not a substitute for future out-of-sample testing.

## Stability And Stress

- Neighbor `C=0.36`: 28 trades, 75.00% wins, +3.2467% mean, PF 7.7833, drawdown -4.2288; thinner and `-0.4629` points behind its session-end hold
- Neighbor `C=0.42`: 37 trades, 56.76% wins, +2.6665% mean, PF 4.2509, drawdown -7.6615; +0.7333 points over its session-end hold
- Removing the best trade leaves +2.1839% mean; removing the best three leaves +1.5814% mean and PF 2.858
- Winsorizing returns at the 5th/95th percentiles leaves +2.2730% mean and PF 3.965
- Thirteen of 18 historical market days have positive average v12 returns
- Extra round-trip cost stress leaves mean return at +2.4806% for 0.25 points, +2.2306% for 0.50, +1.7306% for 1.00, and +0.7306% for 2.00
- Mega and Mid tiers are strongest; Large has only six trades and Small only one, so tier conclusions remain weak

## Frozen Later-Day Check

The final candidate was frozen and run on July 27 only, after the original study cutoff. Local storage had 33 eligible price histories and 25 price/social contexts for that day. V12 and v11 both generated zero trades.

That is not a negative return or false positive, but it is also not performance evidence. It mainly confirms the frozen rule can be replayed without silently relaxing its gates. Wider forward capture is still required.

## Remaining Risks

- Only 38 selected trades across 18 historical market days
- Parameter exploration and short-period regime-selection risk
- Social coverage is overwhelmingly StockTwits; Reddit coverage is especially thin
- The placebo conditions on ticker-day selection and cannot prove market-wide generalization
- Simulated OHLC stop ordering and slippage cannot reproduce halts, spreads, partial fills, or queue position
- No later-day trade has yet completed under the frozen rule

## Reproduction

```bash
MESSAGE_DENSITY_BACKTEST_CONFIG=backtests/message_density_thresholds/config_v12_final_confirmation_mongo_ohlc.json \
  node backtests/message_density_thresholds/run_backtest.mjs

node backtests/message_density_thresholds/validate_v12_candidate.mjs

MESSAGE_DENSITY_BACKTEST_CONFIG=backtests/message_density_thresholds/config_v12_frozen_oos_july27_mongo_ohlc.json \
  node backtests/message_density_thresholds/run_backtest.mjs
```

No commit or push was performed.
