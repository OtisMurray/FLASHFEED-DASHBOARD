# CVD integration and evidence contract

FlashFeed exposes Cumulative Volume Delta (CVD) as a research feature. CVD is
cumulative estimated aggressive-buy volume minus aggressive-sell volume. The
current bar feed cannot observe the true trade initiator, so the dashboard
labels bar-derived BVC/wick values as **estimated** and caps their confidence.

## Current behavior

- BVC and wick estimates are calculated independently and shown with an
  agreement score.
- CVD is normalized by observed volume so values are comparable across stocks.
- Research classifications require aligned price, CVD pressure, method
  agreement, and reliability. They are not production entry confirmations.
- Selling confirmation and bearish divergence are warnings, not automatic
  orders.
- The first 15 regular-session minutes are blocked from entry confirmation;
  the next 15 minutes use stricter gates.
- Premarket and after-hours values are observe-only.
- CVD remains excluded from AI Rankings unless chronological holdout testing
  proves positive incremental value over a price-only baseline.

## Optional measured-feed contract

A separately authorized collector may write already classified ticks to Mongo.
The chart service reads them only when `CVD_MONGODB_URI` is configured.
Its API reports the source as `disabled`, `empty`, `ready`, or `error`; error
responses include only the exception class and never connection details.

Collection default: `raw_ticks`

```json
{
  "ticker": "META",
  "date": "2026-07-29T14:31:02.123Z",
  "size": 100,
  "delta": 100,
  "cond": "",
  "is_auction": false
}
```

`delta` must be signed classified volume, positive for buyer-initiated and
negative for seller-initiated trades. Auction conditions `6` and `M` are
neutralized. Malformed timestamps and non-finite values are ignored safely.

Do not place Interactive Brokers, TradingView, or other account credentials in
the repository, browser, API response, or Docker image. Account setup belongs
only in the external collector/deployment environment, and Aman-owned accounts
must not be used or changed without his direct authorization.

## Historical replay

Run inside the chart-service container so the tested runtime and Mongo network
are used:

```bash
python cvd_backtest.py --days 75 --tickers 150 --output /tmp/cvd_backtest_report.json
```

The harness selects a policy on earlier dates and evaluates it on untouched
later dates. It reports 15/30/60-minute CVD confirmation results, price-only
momentum, session buy-and-hold, divergence results, coverage, transaction-cost
assumptions, and whether AI-ranking integration is permitted by the evidence.
