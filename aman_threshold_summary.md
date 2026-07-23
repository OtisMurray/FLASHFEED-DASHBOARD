# Project

Generated: 2026-07-22

## Aman Threshold Backtest Summary

### Backtest Scope

- Source: Mongo OHLC backtest, final v11 candidate sweep
- Coverage: 597 eligible tickers, 4,250,370 accepted OHLC rows, 57,793 social docs, 7,555 catalyst docs
- Execution assumption: signal at end of minute `t`, entry at next real bar close, 3% protective stop, end-of-day flatten
- Aman baseline tested exactly as submitted by market-cap tier:
  - Mega: 240m window, C=0.10, 3% trailing stop
  - Large: 480m window, C=0.10, 2% trailing stop
  - Mid: 60m window, C=0.30, 2% trailing stop
  - Small: 240m window, C=0.10, 2% trailing stop
  - Nano: 60m window, C=0.10, 5% trailing stop

### Aman Baseline Results

| Tier | Trades | Win Rate | Mean Net | Median Net | Profit Factor | Max Drawdown |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Mega | 21 | 38.10% | +0.7037% | -0.1275% | 1.5685 | -11.4406 |
| Large | 1 | 100.00% | +0.3109% | +0.3109% | n/a | 0.0000 |
| Mid | 9 | 55.56% | +0.3622% | +0.3198% | 1.5215 | -4.8109 |
| Small | 1 | 0.00% | -0.0429% | -0.0429% | 0.0000 | -0.0429 |
| Nano | 31 | 9.68% | -2.0782% | -3.9000% | 0.2815 | -64.4241 |
| Overall exact tier mix | 63 | 31.75% | -0.7320% | mixed | weak | materially dragged down by Nano |

Readout: Aman's larger-cap rules were not terrible, but the exact submitted set fails as a total policy because Nano generated almost half the trades and was strongly negative.

### Best Promoted Rule

Selected live profile: `float_guarded_w120_c0.38_pre60le4_msg3_partial50_runner_v11`

- Entry: 120m rolling corr(price, message density) crosses above 0.38
- Pre-entry control: prior 60m return must be <= +4%
- Message gate: at least 3 messages in trailing 60m, with stricter low-float/Nano evidence gates
- Active move gate: session change must be between 0% and 12%
- Float guard: low-float/Nano rows need catalyst, positive social support, or short-interest support
- Exit: sell 50% at +5%; hold the runner until it gives back 5% after reaching +10%; keep 3% protective stop and flatten end of day

| Rule | Trades | Win Rate | Mean Net | Median Net | Profit Factor | Max Drawdown |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Promoted v11, controlled momentum | 30 | 66.67% | +1.6465% | +0.8541% | 3.0116 | -7.8000 |
| Same v11 gate, full runner | 30 | 63.33% | +2.0447% | +0.8541% | 3.1558 | -7.8000 |
| Broader any-momentum companion | 89 | 50.56% | +0.9534% | +0.1000% | 1.6963 | -17.2000 |
| Stricter pre60<=1 companion | 60 | 45.00% | +1.6572% | -0.1274% | 2.0447 | -17.4133 |
| Current live v10 runner, any momentum | 28 | 50.00% | +3.4193% | +0.0744% | 3.6036 | -11.9090 |

Recommendation: promote v11 instead of chasing the 28-trade high-mean current-live variant. The current-live runner has higher average return, but the median is barely positive and trade count is thinner. The v11 controlled-momentum profile has the cleaner win rate, positive median, smaller drawdown, and still strong expectancy.

### Conclusion

Aman's thresholds identified some valid larger-cap setups, but the full submitted policy is not ready to run unchanged because Nano was deeply negative and dominated the sample. The improved v11 policy is materially better: +1.6465% mean net per trade, 66.67% win rate, 3.0116 profit factor, and -7.8 max drawdown in the selected final-candidate sweep. I would present v11 as the stronger policy while noting that live monitoring should continue before widening the gate.
