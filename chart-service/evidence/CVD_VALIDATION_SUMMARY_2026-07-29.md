# Estimated CVD validation summary

## Decision

Estimated bar-derived CVD remains a **research visualization** and is not added
to AI Rankings, entry automation, or automatic exits. It did not demonstrate
incremental value over the matched price-only baseline on untouched later
sessions. This is a negative result, but it prevents a visually persuasive
indicator from silently weakening the production ranking system.

## Dataset and protocol

- 150 tickers, 42 trading dates, and 6,300 ticker-sessions.
- Five-minute stored OHLCV bars; 4,350 sessions used for selection and 1,950
  later sessions held out in the primary 70/30 replay.
- Features were causal. A completed-session volatility fallback that leaked
  later returns into early BVC estimates was removed before the replay.
- Candidate policy selection occurred only on earlier dates.
- Results include a 10-basis-point round-trip cost assumption.
- Comparisons include price-only momentum, session buy-and-hold, bullish and
  bearish divergence, and 15/30/60-minute forward returns.
- Session-clustered paired differences and a deterministic bootstrap interval
  prevent repeated events in one ticker-session from being treated as fully
  independent evidence.

## Primary untouched holdout

The selected 30-minute estimated-CVD policy produced 15,496 events:

- CVD gross mean: -0.0637%
- CVD net mean: -0.1637%
- CVD hit rate: 41.35%
- Price-only gross mean: -0.0533%
- Price-only net mean: -0.1533%
- Price-only hit rate: 41.77%
- Event-level incremental net mean: -0.0104 percentage points

Across 1,948 matched ticker-sessions, CVD's average lift was -0.0480 percentage
points. The session-clustered 95% bootstrap interval was [-0.0615, -0.0340],
entirely below zero.

## Robustness splits

- 60/40 split: paired lift -0.0449 points; 95% interval [-0.0561, -0.0329].
- 80/20 split: paired lift -0.0327 points; 95% interval [-0.0473, -0.0156].

All three chronological splits reject AI-ranking integration for the estimated
bar implementation.

## What remains useful

The dashboard still provides normalized CVD, BVC/wick agreement, provenance,
reliability, opening-noise safeguards, divergences, and pressure alignment as
research context. The credible next validation is measured aggressor-side tick
flow from an explicitly authorized collector. Measured ticks must be replayed
through the same chronological and baseline protocol before any production
score receives a CVD contribution.

Raw reports are stored beside this summary for the 60/40, 70/30, and 80/20
splits.
