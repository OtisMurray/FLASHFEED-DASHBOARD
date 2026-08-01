import type { PositionScreenerRow } from './types'

// ── ILLUSTRATIVE NOTIONAL ────────────────────────────────────────────────────
//
// Converts the Positions page's percentage-point figures into dollars under an
// ASSUMED, FIXED $1,000 per trade. There is no real position sizing anywhere in
// this system, and this module does not create any.
//
// WHY THIS LIVES IN THE CLIENT, NOT THE API. The response from
// /api/position-screener carries no position size — that is a true statement
// about the data, and the page has always said so out loud. Adding a
// `dollar_pnl` field to the route would make it false: a downstream consumer
// reading that field has no way to know the dollars were invented by a display
// constant rather than measured from a real position. So the conversion is a
// presentation-layer transform over a number the API already returns, and the
// API keeps carrying exactly what it did before.
//
// The arithmetic is deliberately trivial — dollars = notional × pct / 100 — and
// it is NOT where the risk lives. The risk is applying it to rows that have no
// honest percentage to convert. Two cases, both load-bearing:
//
//   pnl_pending  an open position entered on the newest real bar. The page
//                refuses to print 0.00% there because the mark IS the fill;
//                printing "$0.00" would reassert the same false outcome in a
//                second unit. Callers must not convert a pending row.
//   stale        a frozen mid-session mark from a position that never closed.
//                The page renders it drained of win/loss signal and prefixed
//                with "~". A dollar figure carries the same qualification or
//                it launders an unsettled mark into a settled-looking amount.
//
// SUMMING. Percentage points may only be summed across trades if every trade
// got the same capital — which is exactly the assumption named here, so the
// dollar total is internally consistent with the percentage total by
// construction. That does not make either one a real P&L.
export const ILLUSTRATIVE_NOTIONAL_USD = 1000

export const NOTIONAL_ASSUMPTION_LABEL =
  `Assuming $${ILLUSTRATIVE_NOTIONAL_USD.toLocaleString()} per trade (illustrative, not real position sizing)`

// Dollars for one percentage figure. null in -> null out, so a row with no
// honest percentage cannot acquire a dollar amount on the way through.
export function dollarsFromPct(
  pct: number | null | undefined,
  notional: number = ILLUSTRATIVE_NOTIONAL_USD,
): number | null {
  if (pct == null || !Number.isFinite(pct)) return null
  return (notional * pct) / 100
}

// Signed, two-decimal, thousands-separated. `approx` prefixes "≈" for figures
// that are illustrative-on-top-of-unsettled — the dollar analogue of the "~"
// the P&L cell already uses for a mark that never concluded.
export function fmtDollars(n: number | null | undefined, { approx = false } = {}): string {
  if (n == null || !Number.isFinite(n)) return '—'
  const sign = n >= 0 ? '+' : '-'
  const body = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return `${approx ? '≈' : ''}${sign}$${body}`
}

export interface PnlBucket {
  n: number
  sum: number
  mean: number | null
  wins: number
  collapsed: number
  /** sum, expressed under the illustrative notional. Never a real amount. */
  sumUsd: number
  /** mean, expressed under the illustrative notional. Never a real amount. */
  meanUsd: number | null
}

export interface PnlSummary {
  realized: PnlBucket
  unrealized: PnlBucket
  combined: number
  combinedUsd: number
  collapsed: number
  sessions: number
  countedN: number
  priorRegimeN: number
  priorRegimeSum: number
}

// Overall P&L. Two buckets, kept apart on purpose:
//
//   realized   — pnl_is_realized === true. The trade reached a conclusion, so
//                the number is final. Covers today's closed rows (simulated
//                live) and earlier sessions (read back from history).
//   unrealized — still open, marked to the latest bar. Moves until it closes.
// Watch rows have no P&L at all and fall out naturally.
//
// DEDUPLICATION IS NOW DEFENCE IN DEPTH. It was originally load-bearing: the
// route hardcoded live rows as closed_today regardless of which session the
// simulator had actually covered, so after midnight ET the same trade came
// back twice — once live, once from recorded history — and summing them
// reported +5.46% where the truth was +24.94%.
//
// positionScreener.js now classifies live rows by their real session date and
// drops any that recorded history already describes, so the response should no
// longer contain a duplicate at all. This stays because the cost is one Map
// and the failure it prevents is silent and financial: a total that
// double-counts looks entirely plausible. `collapsed` is surfaced in the UI,
// so if the server ever regresses, the page says so instead of quietly
// inflating. Expect it to read 0.
//
// Identity is ticker + session + entry time + entry price: the same strategy
// entry, however it was reconstructed. Where a trade appears as both, the
// RECORDED row wins — it is the settled figure written at the canonical
// parameters, whereas the live row reflects whatever the sliders currently say.
//
// UNITS: every pnl_pct is a per-trade percentage return, and the API carries no
// position size. Summing them is only meaningful if each trade got the same
// capital, so the total is labelled in percentage points and any dollar figure
// alongside it is explicitly an assumption, never a measured amount.
//
// Extracted from PositionsPage so the aggregate is verifiable against a real
// API response by scripts/verify-notional.mjs rather than only by eye.
export function computePnlSummary(
  allRows: PositionScreenerRow[],
  notional: number = ILLUSTRATIVE_NOTIONAL_USD,
): PnlSummary {
  const rows = allRows.filter(row => row.data_status !== 'stale')
  const identity = (r: PositionScreenerRow) =>
    [r.ticker, r.date ?? '', r.entry_time ?? '', r.entry_price ?? ''].join('|')
  const dedupe = (subset: PositionScreenerRow[]) => {
    const byTrade = new Map<string, PositionScreenerRow>()
    for (const row of subset) {
      const k = identity(row)
      const held = byTrade.get(k)
      if (!held || (held.data_status !== 'recorded' && row.data_status === 'recorded')) byTrade.set(k, row)
    }
    return [...byTrade.values()]
  }
  const bucket = (subset: PositionScreenerRow[]): PnlBucket => {
    const unique = dedupe(subset)
    const values = unique.map(r => r.pnl_pct).filter((v): v is number => v != null)
    const sum = values.reduce((a, b) => a + b, 0)
    const mean = values.length ? sum / values.length : null
    return {
      n: values.length,
      sum,
      mean,
      wins: values.filter(v => v > 0).length,
      collapsed: subset.length - unique.length,
      // Derived from the SAME summed percentage, not re-accumulated from
      // per-row dollars: two different summation orders would drift by
      // fractions of a cent and make the page contradict itself.
      sumUsd: (notional * sum) / 100,
      meanUsd: mean == null ? null : (notional * mean) / 100,
    }
  }
  const realized = bucket(rows.filter(r => r.pnl_is_realized === true))
  const unrealized = bucket(rows.filter(r => r.group === 'open' && r.pnl_is_realized !== true))

  // WHICH RULE SET PRODUCED THESE TRADES. History spans rule changes — the
  // data-frontier bound and then the regular-hours gate — and a past session is
  // never re-simulated, so its rows keep whatever rules were live when they were
  // written. Counted here rather than hardcoded so the caveat shrinks on its own
  // as pre-gate sessions age out of the retention window, and disappears when
  // every remaining row is on one rule set.
  const counted = [
    ...dedupe(rows.filter(r => r.pnl_is_realized === true)),
    ...dedupe(rows.filter(r => r.group === 'open' && r.pnl_is_realized !== true)),
  ].filter(r => r.pnl_pct != null)
  const priorRegime = counted.filter(r => !r.rth_rule_version)
  const priorRegimeSum = priorRegime.reduce((a, r) => a + (r.pnl_pct ?? 0), 0)

  const combined = realized.sum + unrealized.sum
  return {
    realized,
    unrealized,
    combined,
    combinedUsd: (notional * combined) / 100,
    collapsed: realized.collapsed + unrealized.collapsed,
    sessions: new Set(rows.map(r => r.date).filter(Boolean)).size,
    countedN: counted.length,
    priorRegimeN: priorRegime.length,
    priorRegimeSum,
  }
}
