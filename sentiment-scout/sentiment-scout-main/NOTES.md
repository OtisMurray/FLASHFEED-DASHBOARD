# NOTES — non-obvious gotchas for future tasks

## Data
- **`rel_volume` and `rsi` are empty in every stored row** of both `ticker_insights`
  and `multicap_screener` (checked 2026-06-11 across all runs). The multicap export
  URL uses `v=111`, which doesn't include RelVol/RSI columns at all; the main
  screener fetch (`v=152`) maps them but no stored run has values. Consequences:
  the Momentum score's `(rel_vol − 1)×10` term contributes 0 (missing rel_vol is
  treated as 1.0), and the Unusual Volume / RSI Overbought / RSI Oversold cards
  show empty states until the data pipeline actually captures those columns.
- `change_pct` is stored as a string with `%` (e.g. `"-11.43%"`); `rel_volume`,
  `rsi`, `volume` are TEXT. `dashboard.num()` parses all Finviz-style numerics.

## Finviz token
- Token died again on 2026-06-11 (`Invalid export API token`, HTTP 401) — the
  second token in two days. Per project memory, the 60s background multicap loop
  is the suspected killer (sustained polling → 429s → hard 401). `/api/chart` and
  the Correlation tab's live analyze are both down until the token is refreshed
  in the 3 usual files; both surface the error gracefully in the UI.

## Frontend / testing
- Top-level `let`/`const` in the inline `<script>` are **not** `window` properties
  (module-like scoping of `let`). When probing chart instances from Playwright,
  use `Chart.getChart(canvasEl)` — `window._corrChart` is always undefined.
- `.mom-card-title` (and other headers) use `text-transform: uppercase`, and
  Playwright's `innerText` returns the *transformed* text — match case-insensitively.
- Multiple Chart.js instances now live on one page (`_ovChart`, `_corrChart`,
  `_chartsChart`). Each build function destroys its own instance before
  `new Chart(...)` — keep that pattern for any new canvas or you get
  "Canvas is already in use".
- New top-level JS state must go in the early-globals block (~line 1620,
  "declared early — initTab may activate ... before the later sections") —
  `initTab()` runs `onTabActivated` synchronously mid-script, and a `let` declared
  below that point throws a temporal-dead-zone ReferenceError that blanks the tab.

## Finviz quote_export quirks (verified 2026-06-11 with fresh token)
- `quote_export?p=i1` **ignores the `s`/`e` date params** and always returns
  ~11 calendar days of 1-min bars (~960/day, 04:00–20:00 ET extended hours).
  Anything charting "a day" must filter rows to the wanted date itself.
  (`correlation_engine` is immune by accident — it looks up exact datetimes.)
- Timestamps are **24-hour with a decorative AM/PM suffix** ("19:55 PM",
  "04:00 AM"). Stripping the suffix and parsing `%H:%M` is correct; do NOT
  "fix" it to `%I:%M %p` — that breaks on "19:55 PM".

## Finviz export column codes (probed 2026-06-12, for the sessions feature)
- `c=71` After-Hours Close, `c=72` After-Hours Change — Finviz's single
  extended-hours pair: it reflects pre-market change before the open and
  after-hours change after the close (no separate pre-market column).
- `c=81` Prev Close, `c=86` Open — pre-market gap is derivable as Open vs
  Prev Close. `c=90`–`99` are Performance (1 Minute … 4 Hours) windows.

## /api/chart behavior
- One quote_export fetch returns all ~11 days; the route groups bars by day and
  caches **every day** per ticker for 60s (`_chart_cache`), so Full Day / 2h / 1h
  toggles and the date walk-back cost zero extra requests.
- Walks back up to 4 calendar days to find the latest session with bars
  (weekends/holidays); auth errors abort the walk-back immediately.
