import type { PositionScreenerRow } from './types'

// ── FIXED-SLOT CAPITAL SIMULATION ────────────────────────────────────────────
//
// Answers one question: if $1,000 had been split across a FIXED number of
// capital slots at the start of a session and traded through that session's
// signals, what would the portfolio be worth at the end of it?
//
// WHY THIS REPLACES THE FLAT PER-TRADE NOTIONAL. lib/notional.ts converts each
// trade's percentage into dollars at a flat $1,000 EACH and sums them. That is
// internally consistent (see its commentary) but it answers a different and
// much weaker question — it assumes capital is infinite and never shared. Two
// positions open at the same minute both got the full $1,000; twenty trades in
// a session deployed $20,000. Nobody has that. The number it produces grows
// with trade COUNT rather than with capital efficiency, so a strategy that
// fires more signals looks better even if every signal is worse.
//
// The slot model fixes exactly that: capital is finite, shared, and reused.
//
// WHY A FIXED SLOT COUNT AND NOT $1,000/N-TRADES-TODAY. Dividing by the day's
// total trade count is not a strategy anyone could run — it needs to know how
// many signals the day will produce BEFORE the first one fires. A slot pool is
// causal: at any minute you either have free capital or you do not, decided by
// what is already open, and that is knowable in real time.
//
// WHY FIVE SLOTS. Measured, not chosen. Replaying the 75 recorded trades in
// screener_position_history (sessions 2026-07-28 .. 07-31, the entire history
// that exists) against a slot pool:
//
//     slots   signals skipped for want of capital
//       3        25/75  (33%)
//       4        13/75  (17%)
//       5         7/75  ( 9%)
//       6         3/75  ( 4%)
//       7         0/75  ( 0%)
//
// Concurrency pooled across those sessions runs median 3, p90 5, max 7. Five
// covers the p90 and holds skips to single digits without slicing $1,000 so
// thin that each trade is a rounding error. Seven reaches zero skips only by
// fitting the exact observed maximum of a FOUR-SESSION sample, which the next
// busy day would break anyway.
//
// THE SLOT COUNT IS PART OF THE RESULT, NOT A DETAIL. On 2026-07-31 the same
// real trades return +19.94% at 4 slots, +15.98% at 5 and +11.57% at 7. An
// eight-point spread on one session means a figure quoted without its slot
// count is not a figure. Every caller-facing label here states N.
//
// STILL A SIMULATION. No order was placed, no capital was committed. This is a
// second assumption layered on the same simulated trades — a more realistic one
// than flat-per-trade, which makes it more dangerous, not less, because a
// plausible number invites belief. It is gross of commission, spread, slippage
// and borrow, it cannot buy fractional shares in reality, and it inherits every
// caveat the underlying trades carry.
//
// CONFIDENTIALITY BOUNDARY: like everything else serving these screeners,
// nothing here may read from or import anything under ~/dev/research-students.

export const SLOT_COUNT = 5
export const SLOT_STARTING_CAPITAL_USD = 1000
export const CAPITAL_PER_SLOT_USD = SLOT_STARTING_CAPITAL_USD / SLOT_COUNT

export const SLOT_ASSUMPTION_LABEL =
  `If $${SLOT_STARTING_CAPITAL_USD.toLocaleString()} had been split across ${SLOT_COUNT} simultaneous position slots `
  + `($${CAPITAL_PER_SLOT_USD.toLocaleString()} each) and traded through this session's signals`

export const SLOT_SHORT_LABEL =
  `${SLOT_COUNT} slots × $${CAPITAL_PER_SLOT_USD.toLocaleString()} = $${SLOT_STARTING_CAPITAL_USD.toLocaleString()}`

// Session close in ET minutes-from-midnight, per row.
//
// This is the minute a slot is released when the trade has no exit of its own.
// It has to be per-row rather than per-day because the two trading-hours
// regimes coexist in history and an exempt ticker keeps the full session even
// after the gate turned on:
//   rth_applied === true  -> flattened at 16:00 by the regular-hours gate
//   anything else         -> pre-gate row or exempt ticker, full 04:00-20:00
// Getting this wrong in the generous direction (releasing early) would hand the
// pool free capacity it never had and under-report skipped signals.
const RTH_CLOSE_MIN = 16 * 60
const EXTENDED_CLOSE_MIN = 20 * 60

export function sessionCloseMinute(row: PositionScreenerRow): number {
  return row.rth_applied === true ? RTH_CLOSE_MIN : EXTENDED_CLOSE_MIN
}

// "HH:MM" (ET) -> minutes from midnight. null for anything unparseable.
//
// USE THE STRINGS, NOT entry_epoch. The stored epoch disagrees with entry_time
// by exactly the UTC offset on every recorded row — CRWV 2026-07-31 stores
// entry_time "15:35" alongside an epoch that renders 11:35 ET / 15:35 UTC, i.e.
// a naive ET timestamp parsed as UTC. The HH:MM strings are the correct ones:
// regular-hours rows span 10:32-15:35 with rth_close exits at 16:00, inside
// 09:30-16:00 ET, and pre-gate rows span 10:11-19:48, inside 04:00-20:00 ET.
// Under the epoch reading, gated rows would sit at 06:32-11:35 ET — hours the
// gate forbids. The epoch is consistent enough to key and dedupe trades by, and
// that is all anything uses it for; ordering a session by it gives the same
// sequence as the strings. It is simply not a wall-clock time.
export function minuteOfDay(hhmm: string | null | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? '').trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return h * 60 + min
}

/** Why a signal did not compound its slot's balance. */
export type SlotOutcome =
  /** Funded a slot and settled to a real percentage. The only case that moves money. */
  | 'taken'
  /** Funded a slot and held it, but never produced a settled figure. Balance carries forward. */
  | 'unresolved'
  /** Never funded: every slot was occupied at its entry minute. */
  | 'skipped'

export interface SlotTrade {
  ticker: string
  entryTime: string | null
  exitTime: string | null
  entryMinute: number
  /** Minute the slot was released — the trade's own exit, or session close. */
  releaseMinute: number
  outcome: SlotOutcome
  /** 0-based slot index, or null when skipped. */
  slot: number | null
  pnlPct: number | null
  /** Slot balance before and after. Equal for an unresolved hold; null when skipped. */
  balanceBefore: number | null
  balanceAfter: number | null
  /** Dollars this trade added to or removed from the pool. 0 when unresolved, null when skipped. */
  pnlUsd: number | null
  dataStatus: PositionScreenerRow['data_status']
  /** Populated for 'unresolved' — which of the two reasons applied. */
  unresolvedReason: 'stale' | 'no_pnl' | null
}

export interface SlotDaySummary {
  date: string | null
  slotCount: number
  startingCapital: number
  capitalPerSlot: number
  /** Total across all slots at session end. */
  endingValue: number
  pnlUsd: number
  pnlPct: number
  /** Per-slot closing balances, in slot order. */
  slotBalances: number[]
  /** Every signal in the session, in entry order. */
  trades: SlotTrade[]
  /** Signals that funded a slot AND settled. */
  takenN: number
  /** Signals that funded a slot but never settled. Held capital, moved nothing. */
  unresolvedN: number
  unresolvedStaleN: number
  unresolvedNoPnlN: number
  /** Signals that never funded a slot because none was free. */
  skippedN: number
  /** takenN + unresolvedN + skippedN. */
  signalN: number
  /**
   * Sum of pnl_pct over skipped signals, in PERCENTAGE POINTS. Deliberately not
   * a dollar figure: a skipped signal was never funded, so it has no slot
   * balance to size against and any dollar amount would be invented. This says
   * what the missed signals did, not what they would have paid.
   */
  skippedPctSum: number
  /** Skipped signals with a settled percentage, i.e. how many skippedPctSum covers. */
  skippedResolvedN: number
}

// Trade identity and dedupe, IDENTICAL to lib/notional.ts.
//
// Deliberately duplicated rather than shared: the two modules must agree today,
// but notional.ts's dedupe is defence-in-depth against a server regression it
// documents in detail, and coupling this module to it would mean a future fix
// there silently changes capital allocation here. Both are checked against the
// same real payload by their verify scripts, which is what actually keeps them
// in step. A trade that appears both live and recorded must fund ONE slot, not
// two — the pool is the scarce thing, so a duplicate here does not merely
// double-count a percentage, it evicts a real signal.
function tradeIdentity(r: PositionScreenerRow): string {
  return [r.ticker, r.date ?? '', r.entry_time ?? '', r.entry_price ?? ''].join('|')
}

function dedupe(rows: PositionScreenerRow[]): PositionScreenerRow[] {
  const byTrade = new Map<string, PositionScreenerRow>()
  for (const row of rows) {
    const k = tradeIdentity(row)
    const held = byTrade.get(k)
    if (!held || (held.data_status !== 'recorded' && row.data_status === 'recorded')) byTrade.set(k, row)
  }
  return [...byTrade.values()]
}

/** Sessions present in the payload that this simulation can run over, newest first. */
export function slotSimDates(rows: PositionScreenerRow[]): string[] {
  const dates = new Set<string>()
  for (const row of rows) {
    if (row.group === 'watch') continue
    if (!row.date || minuteOfDay(row.entry_time) == null) continue
    dates.add(row.date)
  }
  return [...dates].sort().reverse()
}

/**
 * Replay one session's signals through a fixed pool of capital slots.
 *
 * ALLOCATION RULE: at a signal's entry minute, take the lowest-numbered slot
 * whose previous position has already been released. If none has, the signal is
 * SKIPPED and recorded as such — never silently sized down, never dropped. A
 * skipped signal is a real consequence of the capital constraint and is the
 * main thing this model has to say that flat-per-trade cannot.
 *
 * A slot is released at the trade's own exit, or at session close for a
 * position that never exited (see sessionCloseMinute). Release is compared with
 * `<=` against the next entry minute: a position that exits at 11:30 frees its
 * capital for an 11:30 entry, since both are the same 1-minute bar and the sim
 * fills at bar close.
 *
 * COMPOUNDING is within a slot and across the day: a slot that wins goes into
 * its next trade larger, one that loses goes in smaller. That is the point —
 * it is what makes this a portfolio simulation rather than a sum of returns.
 *
 * UNRESOLVED POSITIONS carry the slot balance forward UNCHANGED. They are not
 * zeroed and not compounded. A stale row is a frozen mid-session mark from a
 * position the scheduler stopped observing, so its percentage is not an
 * outcome; treating it as a 0% trade would assert it broke even, and
 * compounding it would assert a result that never settled. It still HELD the
 * slot — real capital was committed and unavailable — so the occupancy is
 * honoured while the P&L is refused, and the count is surfaced separately so
 * the total never implies a resolution it does not have.
 */
export function simulateSlotDay(
  allRows: PositionScreenerRow[],
  date: string | null,
  {
    slotCount = SLOT_COUNT,
    startingCapital = SLOT_STARTING_CAPITAL_USD,
  }: { slotCount?: number; startingCapital?: number } = {},
): SlotDaySummary {
  const capitalPerSlot = startingCapital / slotCount

  // Signals for this session: entered positions only (watch rows never entered),
  // deduplicated, with a usable entry minute. Ordered by entry, then ticker so
  // two entries in the same minute allocate deterministically rather than in
  // whatever order the API happened to serialize them.
  const signals = dedupe(
    allRows.filter(r => r.group !== 'watch' && r.date === date && minuteOfDay(r.entry_time) != null),
  ).sort((a, b) => {
    const am = minuteOfDay(a.entry_time) ?? 0
    const bm = minuteOfDay(b.entry_time) ?? 0
    return am - bm || a.ticker.localeCompare(b.ticker)
  })

  const balances = Array<number>(slotCount).fill(capitalPerSlot)
  // Minute each slot's current position releases it. 0 = free from the start.
  const releasedAt = Array<number>(slotCount).fill(0)
  const trades: SlotTrade[] = []

  for (const row of signals) {
    const entryMinute = minuteOfDay(row.entry_time) as number
    const exitMinute = minuteOfDay(row.exit_time)
    // A trade must occupy its slot for at least the bar it entered on, or two
    // entries in the same minute could share one slot.
    const releaseMinute = Math.max(exitMinute ?? sessionCloseMinute(row), entryMinute + 1)

    const slot = releasedAt.findIndex(released => released <= entryMinute)
    if (slot === -1) {
      trades.push({
        ticker: row.ticker,
        entryTime: row.entry_time ?? null,
        exitTime: row.exit_time ?? null,
        entryMinute,
        releaseMinute,
        outcome: 'skipped',
        slot: null,
        pnlPct: row.pnl_pct ?? null,
        balanceBefore: null,
        balanceAfter: null,
        pnlUsd: null,
        dataStatus: row.data_status,
        unresolvedReason: null,
      })
      continue
    }

    releasedAt[slot] = releaseMinute
    const before = balances[slot]

    // Refuse to compound anything that did not settle. `stale` is the labelled
    // case; a null/non-finite pnl_pct is the withheld case (a split breaks the
    // price basis and the server publishes no percentage rather than a
    // fabricated one). Both hold the slot and move no money.
    const pnlPct = row.pnl_pct
    const unresolvedReason: SlotTrade['unresolvedReason'] =
      row.data_status === 'stale' ? 'stale'
        : (pnlPct == null || !Number.isFinite(pnlPct)) ? 'no_pnl'
          : null

    if (unresolvedReason) {
      trades.push({
        ticker: row.ticker,
        entryTime: row.entry_time ?? null,
        exitTime: row.exit_time ?? null,
        entryMinute,
        releaseMinute,
        outcome: 'unresolved',
        slot,
        pnlPct: pnlPct ?? null,
        balanceBefore: before,
        balanceAfter: before,
        pnlUsd: 0,
        dataStatus: row.data_status,
        unresolvedReason,
      })
      continue
    }

    const after = before * (1 + (pnlPct as number) / 100)
    balances[slot] = after
    trades.push({
      ticker: row.ticker,
      entryTime: row.entry_time ?? null,
      exitTime: row.exit_time ?? null,
      entryMinute,
      releaseMinute,
      outcome: 'taken',
      slot,
      pnlPct: pnlPct as number,
      balanceBefore: before,
      balanceAfter: after,
      pnlUsd: after - before,
      dataStatus: row.data_status,
      unresolvedReason: null,
    })
  }

  const endingValue = balances.reduce((a, b) => a + b, 0)
  const skipped = trades.filter(t => t.outcome === 'skipped')
  const skippedResolved = skipped.filter(t => t.pnlPct != null && Number.isFinite(t.pnlPct))
  const unresolved = trades.filter(t => t.outcome === 'unresolved')

  return {
    date,
    slotCount,
    startingCapital,
    capitalPerSlot,
    endingValue,
    pnlUsd: endingValue - startingCapital,
    pnlPct: startingCapital ? ((endingValue - startingCapital) / startingCapital) * 100 : 0,
    slotBalances: balances,
    trades,
    takenN: trades.filter(t => t.outcome === 'taken').length,
    unresolvedN: unresolved.length,
    unresolvedStaleN: unresolved.filter(t => t.unresolvedReason === 'stale').length,
    unresolvedNoPnlN: unresolved.filter(t => t.unresolvedReason === 'no_pnl').length,
    skippedN: skipped.length,
    signalN: trades.length,
    skippedPctSum: skippedResolved.reduce((a, t) => a + (t.pnlPct as number), 0),
    skippedResolvedN: skippedResolved.length,
  }
}

/** Portfolio value, always with its slot count attached. */
export function fmtSlotUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/** Signed change, for the gain/loss figure. */
export function fmtSlotDelta(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  const sign = n >= 0 ? '+' : '-'
  const body = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return `${sign}$${body}`
}
