#!/usr/bin/env node --experimental-strip-types
/**
 * Verifies the illustrative $1,000-notional display on the Positions page.
 *
 * Run against a live API response, not a fixture:
 *   curl -s 'http://localhost:3001/api/position-screener?historyDays=90' -o /tmp/positions.json
 *   node --experimental-strip-types app/scripts/verify-notional.mjs /tmp/positions.json
 *
 * It imports src/lib/notional.ts DIRECTLY — the same module the page renders
 * from — so this cannot pass while the page computes something else.
 *
 * Four things are checked, in descending order of how badly they would hurt:
 *
 *  1. NO REGRESSION. The P&L aggregation was moved out of PositionsPage into
 *     lib/notional.ts. The pre-change implementation is reproduced verbatim
 *     below from git HEAD and both are run over the same real rows; every
 *     percentage-domain field must match EXACTLY. This is the check that earns
 *     the right to have refactored working financial code.
 *  2. PER-ROW MATH. dollars === 1000 * pnl_pct / 100 for every row.
 *  3. AGGREGATE MATH. Same identity for realized/unrealized/combined, plus
 *     internal consistency: the dollar total must equal the sum of the per-row
 *     dollars, and realized + unrealized must equal combined.
 *  4. REFUSAL CASES. Rows with no honest percentage must not acquire a dollar
 *     amount. Driven by synthetic rows, because a real response will not
 *     reliably contain a pending or null-P&L row on any given day.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const {
  ILLUSTRATIVE_NOTIONAL_USD,
  computePnlSummary,
  dollarsFromPct,
  fmtDollars,
} = await import(join(HERE, '../src/lib/notional.ts'))

const N = ILLUSTRATIVE_NOTIONAL_USD
const EPS = 1e-9

let failures = 0
let checks = 0
function check(label, condition, detail = '') {
  checks += 1
  if (!condition) {
    failures += 1
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}
function section(title) { console.log(`\n${title}`) }

// ── the pre-change implementation, verbatim from git HEAD ────────────────────
// PositionsPage.tsx, the `pnl` useMemo, before the extraction. Kept in JS form
// so it can be diffed against the new module over identical input.
function pnlSummaryBeforeChange(allRows) {
  const rows = allRows.filter(row => row.data_status !== 'stale')
  const identity = r => [r.ticker, r.date ?? '', r.entry_time ?? '', r.entry_price ?? ''].join('|')
  const dedupe = subset => {
    const byTrade = new Map()
    for (const row of subset) {
      const k = identity(row)
      const held = byTrade.get(k)
      if (!held || (held.data_status !== 'recorded' && row.data_status === 'recorded')) byTrade.set(k, row)
    }
    return [...byTrade.values()]
  }
  const bucket = subset => {
    const unique = dedupe(subset)
    const values = unique.map(r => r.pnl_pct).filter(v => v != null)
    const sum = values.reduce((a, b) => a + b, 0)
    return {
      n: values.length,
      sum,
      mean: values.length ? sum / values.length : null,
      wins: values.filter(v => v > 0).length,
      collapsed: subset.length - unique.length,
    }
  }
  const realized = bucket(rows.filter(r => r.pnl_is_realized === true))
  const unrealized = bucket(rows.filter(r => r.group === 'open' && r.pnl_is_realized !== true))
  const counted = [
    ...dedupe(rows.filter(r => r.pnl_is_realized === true)),
    ...dedupe(rows.filter(r => r.group === 'open' && r.pnl_is_realized !== true)),
  ].filter(r => r.pnl_pct != null)
  const priorRegime = counted.filter(r => !r.rth_rule_version)
  return {
    realized,
    unrealized,
    combined: realized.sum + unrealized.sum,
    collapsed: realized.collapsed + unrealized.collapsed,
    sessions: new Set(rows.map(r => r.date).filter(Boolean)).size,
    countedN: counted.length,
    priorRegimeN: priorRegime.length,
    priorRegimeSum: priorRegime.reduce((a, r) => a + (r.pnl_pct ?? 0), 0),
  }
}

// ── input ────────────────────────────────────────────────────────────────────
const payloadPath = resolve(process.argv[2] || '/tmp/positions.json')
const payload = JSON.parse(readFileSync(payloadPath, 'utf8'))
const rows = payload.rows ?? []
if (!rows.length) {
  console.error(`No rows in ${payloadPath} — nothing to verify against.`)
  process.exit(1)
}
console.log(`Positions payload: ${payloadPath}`)
console.log(`  rows=${rows.length}  with pnl_pct=${rows.filter(r => r.pnl_pct != null).length}`
  + `  stale=${rows.filter(r => r.data_status === 'stale').length}`
  + `  pending=${rows.filter(r => r.pnl_pending).length}`
  + `  notional=$${N.toLocaleString()}`)

const before = pnlSummaryBeforeChange(rows)
const after = computePnlSummary(rows)

// ── 1. no regression on the percentage displays ──────────────────────────────
section('1. No regression — percentage-domain fields vs the pre-change implementation')
for (const b of ['realized', 'unrealized']) {
  for (const f of ['n', 'sum', 'mean', 'wins', 'collapsed']) {
    check(`${b}.${f}`, Object.is(before[b][f], after[b][f]),
      `before=${before[b][f]} after=${after[b][f]}`)
  }
}
for (const f of ['combined', 'collapsed', 'sessions', 'countedN', 'priorRegimeN', 'priorRegimeSum']) {
  check(f, Object.is(before[f], after[f]), `before=${before[f]} after=${after[f]}`)
}
console.log(`  realized: n=${after.realized.n} sum=${after.realized.sum.toFixed(4)}%`
  + `  unrealized: n=${after.unrealized.n} sum=${after.unrealized.sum.toFixed(4)}%`
  + `  combined=${after.combined.toFixed(4)}%`)

// ── 2. per-row math ──────────────────────────────────────────────────────────
section(`2. Per-row math — dollars === ${N} × pnl_pct / 100, for every row`)
let converted = 0
for (const row of rows) {
  const got = dollarsFromPct(row.pnl_pct)
  if (row.pnl_pct == null) {
    check(`${row.ticker} ${row.date}: null pct yields null`, got === null, `got ${got}`)
    continue
  }
  const want = (N * row.pnl_pct) / 100
  check(`${row.ticker} ${row.date}: ${row.pnl_pct}% -> ${fmtDollars(got)}`,
    Math.abs(got - want) < EPS, `got ${got} want ${want}`)
  converted += 1
}
console.log(`  ${converted} rows converted, all exact`)

// ── 3. aggregate math + internal consistency ─────────────────────────────────
section('3. Aggregate math and internal consistency')
for (const b of ['realized', 'unrealized']) {
  check(`${b}.sumUsd === ${N} × sum / 100`,
    Math.abs(after[b].sumUsd - (N * after[b].sum) / 100) < EPS,
    `sumUsd=${after[b].sumUsd} sum=${after[b].sum}`)
  if (after[b].mean == null) {
    check(`${b}.meanUsd is null when mean is null`, after[b].meanUsd === null)
  } else {
    check(`${b}.meanUsd === ${N} × mean / 100`,
      Math.abs(after[b].meanUsd - (N * after[b].mean) / 100) < EPS)
  }
}
check(`combinedUsd === ${N} × combined / 100`,
  Math.abs(after.combinedUsd - (N * after.combined) / 100) < EPS,
  `combinedUsd=${after.combinedUsd} combined=${after.combined}`)
check('realized.sumUsd + unrealized.sumUsd === combinedUsd',
  Math.abs(after.realized.sumUsd + after.unrealized.sumUsd - after.combinedUsd) < 1e-6,
  `${after.realized.sumUsd} + ${after.unrealized.sumUsd} != ${after.combinedUsd}`)

// The dollar total must equal the sum of the dollars shown on the rows that
// feed it. Computed here by re-walking the rows the bucket would have kept, so
// a divergence between "what the total says" and "what the table shows" fails.
const identity = r => [r.ticker, r.date ?? '', r.entry_time ?? '', r.entry_price ?? ''].join('|')
const dedupe = subset => {
  const m = new Map()
  for (const row of subset) {
    const k = identity(row)
    const held = m.get(k)
    if (!held || (held.data_status !== 'recorded' && row.data_status === 'recorded')) m.set(k, row)
  }
  return [...m.values()]
}
const live = rows.filter(r => r.data_status !== 'stale')
for (const [label, subset] of [
  ['realized', live.filter(r => r.pnl_is_realized === true)],
  ['unrealized', live.filter(r => r.group === 'open' && r.pnl_is_realized !== true)],
]) {
  const rowDollars = dedupe(subset)
    .map(r => dollarsFromPct(r.pnl_pct))
    .filter(v => v != null)
    .reduce((a, b) => a + b, 0)
  check(`${label}: total dollars === sum of per-row dollars`,
    Math.abs(rowDollars - after[label].sumUsd) < 1e-6,
    `rows=${rowDollars} total=${after[label].sumUsd}`)
}
console.log(`  realized=${fmtDollars(after.realized.sumUsd)}`
  + `  unrealized=${fmtDollars(after.unrealized.sumUsd)}`
  + `  combined=${fmtDollars(after.combinedUsd)}`)

// ── 3b. the unrealized path, on real numbers ─────────────────────────────────
// A live response only contains open positions when the tape has actually
// produced one, so on a quiet session the unrealized bucket is empty and its
// dollar path goes unexercised. Rather than assert nothing, the real rows are
// RE-ROUTED into the open/unrealized bucket: the percentages are the genuine
// ones from the API, only their group and realized flag are changed. This
// covers the bucket the live response could not reach, using real values.
section('3b. Unrealized path exercised with real percentages (rows re-routed to open)')
const asOpen = rows
  .filter(r => r.pnl_pct != null && r.data_status !== 'stale')
  .map(r => ({ ...r, group: 'open', pnl_is_realized: false }))
if (asOpen.length) {
  const openSummary = computePnlSummary(asOpen)
  check('re-routed rows land in the unrealized bucket',
    openSummary.unrealized.n === asOpen.length && openSummary.realized.n === 0,
    `unreal=${openSummary.unrealized.n} real=${openSummary.realized.n} expected=${asOpen.length}`)
  check(`unrealized.sumUsd === ${N} × sum / 100 on real values`,
    Math.abs(openSummary.unrealized.sumUsd - (N * openSummary.unrealized.sum) / 100) < EPS)
  check('combined equals the unrealized bucket alone',
    Math.abs(openSummary.combinedUsd - openSummary.unrealized.sumUsd) < 1e-6)
  const rowSum = asOpen.map(r => dollarsFromPct(r.pnl_pct)).reduce((a, b) => a + b, 0)
  check('unrealized total === sum of per-row dollars',
    Math.abs(rowSum - openSummary.unrealized.sumUsd) < 1e-6,
    `rows=${rowSum} total=${openSummary.unrealized.sumUsd}`)
  console.log(`  ${openSummary.unrealized.n} rows -> ${openSummary.unrealized.sum.toFixed(4)}%`
    + ` = ${fmtDollars(openSummary.unrealized.sumUsd)}`)
} else {
  console.log('  skipped: no convertible rows in payload')
}

// ── 4. refusal cases ─────────────────────────────────────────────────────────
section('4. Refusal cases — rows with no honest percentage get no dollar amount')
check('null pct -> null', dollarsFromPct(null) === null)
check('undefined pct -> null', dollarsFromPct(undefined) === null)
check('NaN pct -> null', dollarsFromPct(NaN) === null)
check('Infinity pct -> null', dollarsFromPct(Infinity) === null)
check('null formats as em dash', fmtDollars(null) === '—', `got ${fmtDollars(null)}`)
// A pending row carries pnl_pct 0 by construction (its mark IS its fill). The
// page renders "just entered" and no percentage; the dollar branch sits inside
// that same else-branch, so it is never reached. What must NOT happen is the
// value 0 quietly becoming a displayable "+$0.00" total.
const pendingRow = {
  ticker: 'PEND', date: '2026-08-01', group: 'open', data_status: 'live',
  entry_time: '10:00', entry_price: 10, pnl_pct: 0, pnl_pending: true, pnl_is_realized: false,
}
const pendingSummary = computePnlSummary([pendingRow])
check('a lone pending row contributes 0 dollars, not a fabricated amount',
  pendingSummary.unrealized.sumUsd === 0 && pendingSummary.unrealized.n === 1)
// Stale rows are excluded from every total, so their dollars are too.
const staleRow = { ...pendingRow, ticker: 'STL', data_status: 'stale', pnl_pct: 42, pnl_pending: false }
const staleSummary = computePnlSummary([staleRow])
check('stale row excluded from totals (and so from dollar totals)',
  staleSummary.realized.n === 0 && staleSummary.unrealized.n === 0 && staleSummary.combinedUsd === 0,
  JSON.stringify(staleSummary.unrealized))
// Sign, rounding and dedupe.
check('negative pct -> negative dollars', Math.abs(dollarsFromPct(-2.5) - -25) < EPS)
check('formats negative with sign', fmtDollars(-25) === '-$25.00', `got ${fmtDollars(-25)}`)
check('formats positive with sign', fmtDollars(25) === '+$25.00', `got ${fmtDollars(25)}`)
check('formats thousands', fmtDollars(1234.5) === '+$1,234.50', `got ${fmtDollars(1234.5)}`)
check('approx prefix for unsettled', fmtDollars(25, { approx: true }) === '≈+$25.00',
  `got ${fmtDollars(25, { approx: true })}`)
const dupe = [
  { ticker: 'D', date: '2026-08-01', entry_time: '10:00', entry_price: 5, group: 'closed_earlier', data_status: 'live', pnl_pct: 10, pnl_is_realized: true },
  { ticker: 'D', date: '2026-08-01', entry_time: '10:00', entry_price: 5, group: 'closed_earlier', data_status: 'recorded', pnl_pct: 10, pnl_is_realized: true },
]
const dupeSummary = computePnlSummary(dupe)
check('duplicate trade counted once in dollars too',
  dupeSummary.realized.n === 1 && Math.abs(dupeSummary.realized.sumUsd - 100) < EPS,
  `n=${dupeSummary.realized.n} usd=${dupeSummary.realized.sumUsd}`)
const empty = computePnlSummary([])
check('empty input -> zero dollars, zero trades',
  empty.realized.n === 0 && empty.combinedUsd === 0 && empty.realized.meanUsd === null)

// ── result ───────────────────────────────────────────────────────────────────
console.log('')
if (failures) {
  console.error(`✗ verify-notional: ${failures} of ${checks} checks FAILED`)
  process.exit(1)
}
console.log(`✓ verify-notional: ${checks} checks passed`)
