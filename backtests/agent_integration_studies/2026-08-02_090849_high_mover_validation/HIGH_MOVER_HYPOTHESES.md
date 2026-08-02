# High-Mover Catalyst Validation Hypotheses

## Purpose

This study tests Catalyst Intelligence as an incremental validation and reranking layer on top of the existing FlashFeed AI ranking. It does not replace the AI score, filter the production universe, alter an entry or exit, or evaluate a new trading policy.

## Frozen design

- Use the existing frozen AI observations from July 29-31, 2026.
- Collapse repeated refreshes to the first causal AI observation per ticker and market date.
- Use real stored one-minute OHLC from the existing `ohlcv_bars` collection.
- For observations before 09:30 ET, measure from the first regular-session bar. Exclude observations at or after 16:00 ET.
- Define high-mover outcomes before inspecting assisted-ranking results:
  - post-signal maximum favorable excursion (MFE) of at least 10%;
  - post-signal MFE of at least 20%;
  - the top 20% of MFE outcomes within each date.
- Keep the existing AI score as the base rank.
- Add only a causal direct-catalyst validation bonus based on alignment, confidence, severity, recency, and catalyst category. Market-wide catalysts are excluded from the bonus because the prior audit showed they were attached to every candidate and therefore could not discriminate.

## Pre-registered score family

Evaluate the existing AI score plus 0%, 10%, 20%, 30%, or 40% of the bounded catalyst-validation score. The 0% version is the unchanged AI baseline. No other weight is added after viewing the test period.

## Primary metrics

For the top 3, top 5, and top 10 candidates per day, measure:

- precision and recall for 10% and 20% MFE movers;
- recall for the date's top MFE quintile;
- mean and median MFE;
- mean official-close aligned return;
- share of total positive MFE captured;
- worst official-close aligned return;
- direct-catalyst coverage.

## Selection discipline

- July 29 is development.
- July 30 is validation.
- July 31 is the untouched test date.
- Development may nominate at most two nonzero weights.
- Validation selects at most one frozen weight.
- The frozen weight is evaluated once on July 31.
- A useful result must improve top-tail capture on validation and test without materially worsening close return or downside.

## Interpretation boundary

This is a small observational study. A positive result can justify continued shadow validation only. It cannot justify a production ranking, threshold, position, or execution change.
