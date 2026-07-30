# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The primary users are the maintainer and a small collaborating team who open FlashFeed
daily, during and around market hours, as a live working instrument. They already know
the data model, the ingest sources, and the vocabulary — they are not being introduced
to the product, they are operating it.

The defining sitting: open the dashboard, scan the screeners, and come away with a short
ranked list of tickers worth acting on today, along with the reason each one qualified.
Speed of scanning and traceability of the reason both matter; whichever is missing makes
the sitting a failure.

Secondary readers exist (capstone reviewers, faculty, collaborators looking at research
output) but they do not set the design brief. The dashboard is a team tool first.

## Product Purpose

FlashFeed ingests financial news, social chatter, screener fundamentals, and price bars
for a universe of US equities, scores them, and surfaces candidate tickers whose measured
sentiment behavior has crossed a backtested threshold.

Success is a user leaving a session with a small, defensible candidate list — not with
maximum information consumed. The product exists to compress a very wide daily universe
into a handful of decisions a person can actually act on, and to show its work when asked.

## Positioning

The load-bearing mechanism is the **sentiment→price threshold engine**: tiered entry and
exit thresholds derived from backtested rolling windows, with position tracking and a
postmortem audit trail over prior predictions.

That is the part a neighboring product could not truthfully copy. Aggregation across many
sources is table stakes; charting is a commodity. What is specific here is that a
candidate appears on screen because a stated, backtested rule fired, and the record of
whether that rule has previously been right is inspectable in the same application.

Consequence for design: the screener and positions surfaces are the center of the product.
News, social, charts, and correlation are inputs and evidence for that engine, not
independent destinations competing for the same attention.

## Operating Context

- Used in a browser on a desktop-class screen, generally during US market hours, often
  alongside a broker and other market tools.
- Sessions are short and repeated rather than long and singular. The user returns to the
  same few surfaces many times a day and expects state (filters, sort, page, ticker) to
  survive the return — several routes already encode this in the URL.
- Deployed as a single origin on Railway; `main` deploys automatically, with no CI gate.
  A change that reaches `main` is live for the team, so shipped states are seen quickly.
- Data arrives continuously through an asynchronous ingest pipeline. What is on screen is
  a snapshot of an incomplete, still-filling store — not a settled dataset.

## Capabilities and Constraints

Confirmed surfaces (routes in `app/src/App.tsx`, nav in `TopBar.tsx`): Overview, AI, News,
Screener, Long Term Fundamentals, Decision Map, Social, Charts, CVD, Positions, Short
Squeeze, Momentum, Correlation, v11 Profile (test), Prediction Audit, System Health,
Settings. Entry Screener and Exit Screener were retired and now redirect to Positions,
which is a strict superset of both; `/window-mirror` redirects to Screener.

Stack: React 18 + TypeScript + Vite with Tailwind (CSS-variable theme tokens), SWR for
fetching, `lightweight-charts` and Chart.js for charts, React Router v6. Express backend
plus a separate `chart-service` proxied at `/api/sentchart/*`. MongoDB, Redis, and Kafka
behind the ingest pipeline.

Durable constraints:

- **Domain vocabulary is fixed.** *tier*, *threshold*, *entry*, *exit*, *squeeze*,
  *overnight_n*, *catalyst*, *window*, *density* are load-bearing terms with precise
  meanings in the engine. They are not renamed, softened, or replaced with friendlier
  language; a rename silently breaks the correspondence between UI and backtest.
- **Partial data is the normal case, not an edge case.** Ingest coverage is genuinely
  incomplete — social coverage has run as low as single-digit tickers out of a universe
  in the thousands. Every surface must read correctly when most cells are empty, and must
  distinguish "no data ingested" from "measured and found to be zero." A screener that
  returns almost nothing is frequently telling the truth about coverage rather than
  reporting a bug.
- **Client-side derivation.** Higher timeframes, indicator recomputation, and overlay
  alignment happen in the browser from 1-minute bars, so timeframe changes are expected
  to be instant with no server round-trip.
- Typecheck runs behind a ratchet (`npm run typecheck:ratchet`) rather than a clean zero,
  so the build tolerates a known, non-increasing error baseline.

Explicitly undecided: whether the product is ever opened to an outside audience. Nothing
in the current design should assume that audience, and nothing should make it impossible.

## Brand Commitments

- Name: **FlashFeed**. The npm package is still `feedflash`; the product name is FlashFeed.
- **Dark, dense, terminal-grade is a commitment, not a default.** The existing theme
  (`--bg: #0F172A`, `--surface: #1E293B`, `--border: #334155`, `--accent: #0EA5E9`,
  `--neutral: #E2E8F0`, `--bull: #10B981`, `--bear: #EF4444`) expresses a deliberate
  position: this is a market instrument and should read like one. High information density
  is correct here. Future work may refine this world; it may not trade it for a lighter,
  airier, more consumer-facing one on taste grounds alone.
- Green/red carry directional meaning (bull/bear) throughout and are not free decorative
  colors.

## Evidence on Hand

- Real, continuously ingested data: news wires (PR Newswire, GlobeNewswire, BusinessWire,
  Benzinga), social (StockTwits, Reddit, Bluesky), screener fundamentals via Finviz Elite,
  and price bars. This is the only legitimate source of anything numeric on screen.
- Backtest and research artifacts live in the repo (`backtests/`, `docs/`,
  `aman_threshold_summary.md`), and a Prediction Audit surface records prior predictions
  against outcomes.
- **Hard rule: never fabricate signals or numbers.** No placeholder tickers, invented P&L,
  sample backtest results, mocked-up win rates, fake testimonials, or illustrative
  screenshots presented as real output. Empty states show emptiness. This is a tool people
  risk money against; a fabricated figure is a defect of the most serious kind, not a
  visual placeholder.
- Honest negative results are part of the record and must not be quietly dropped or
  restyled into looking positive.

## Product Principles

1. **The candidate list is the product.** Every surface is judged by whether it shortens
   the path to a small, defensible set of tickers.
2. **A number on screen must be traceable.** If a ticker qualified, the rule that fired
   and the window it fired on should be reachable without leaving the application.
3. **Density is a feature; noise is not.** Show a great deal at once, but only what
   carries decision weight — volume of pixels is not volume of information.
4. **Absence is information.** Missing, thin, and stale data are reported as themselves,
   never hidden, smoothed, or padded into looking complete.
5. **The vocabulary of the engine is the vocabulary of the interface.** The UI does not
   translate the model into friendlier words that no longer mean the same thing.

## Accessibility & Inclusion

No product-specific standard has been established. One known constraint from the existing
implementation: Google Translate is actively accommodated in the app shell, so the layout
must tolerate injected browser-translation chrome and text expansion.

Directional state is currently carried substantially by green/red hue. Any future work
that adds directional signals should carry them by more than color alone.
