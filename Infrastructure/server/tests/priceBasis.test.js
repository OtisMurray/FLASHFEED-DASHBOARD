import test from 'node:test'
import assert from 'node:assert/strict'

import {
  assertComparableBasis,
  detectPriceBasisMismatch,
  priceBasisStamp,
} from '../lib/priceBasis.js'
import { mergeTradeSnapshot } from '../lib/positionHistory.js'

// Stored position history holds AS-TRADED prices; Finviz restates its bars onto
// the current share count after a split. Returns survive that — they are ratios.
// Price LEVELS do not, and any calculation mixing the two fabricates a number:
// NEXR's stored $0.295 entry against a re-fetched $3.243 bar produced a +1022%
// "buy and hold" return during the 2026-07-31 audit.
//
// Real observed values from that audit are used as fixtures throughout.

const NEXR = [
  { stored: 0.295, fresh: 3.243 },   // 2026-07-28 10:42
  { stored: 0.299, fresh: 3.29 },    // 2026-07-28 12:54
  { stored: 0.358, fresh: 3.936 },   // 2026-07-30 10:11
]

test('the real NEXR rows are detected as a 11:1 reverse split', () => {
  for (const { stored, fresh } of NEXR) {
    const r = detectPriceBasisMismatch(stored, fresh)
    assert.ok(r, 'expected a mismatch')
    assert.equal(r.comparable, false)
    assert.equal(r.split_suspected, true)
    assert.equal(r.split_ratio, '11:1')
    assert.equal(r.split_factor, 11)
    assert.equal(r.direction, 'reverse')
    assert.ok(r.relative_error <= 0.02, `relative error ${r.relative_error} should be within tolerance`)
  }
})

test('a forward split is detected and labelled in the other direction', () => {
  const r = detectPriceBasisMismatch(30, 10)     // 1:3 forward
  assert.equal(r.split_suspected, true)
  assert.equal(r.split_ratio, '1:3')
  assert.equal(r.direction, 'forward')
})

test('ordinary drift inside the neutral band is NOT flagged', () => {
  // a few percent between a stored fill and a re-fetched bar is normal
  for (const [a, b] of [[10, 10], [10, 10.5], [10, 9.5], [0.295, 0.298], [100, 109], [100, 91]]) {
    assert.equal(detectPriceBasisMismatch(a, b), null, `${a} -> ${b} should be comparable`)
  }
})

test('a gap that is not a whole-number ratio is flagged but NOT called a split', () => {
  const r = detectPriceBasisMismatch(10, 17.3)   // 1.73x — not near any integer
  assert.equal(r.comparable, false)
  assert.equal(r.split_suspected, false)
  assert.equal(r.kind, 'unexplained')
  assert.equal(r.split_ratio, null)
})

test('a whole-number ratio must be within 2% to count as a split', () => {
  assert.equal(detectPriceBasisMismatch(1, 3.05).split_suspected, true)    // 1.7% off 3
  assert.equal(detectPriceBasisMismatch(1, 3.20).split_suspected, false)   // 6.7% off 3
})

test('fractional splits are a KNOWN GAP, not silently mis-labelled', () => {
  // 3:2 lands at 1.5, inside the range ordinary drift can reach. Admitting it
  // would cost false positives on good rows, so it is deliberately not claimed.
  const r = detectPriceBasisMismatch(10, 15)
  assert.equal(r.comparable, false)
  assert.equal(r.split_suspected, false, '3:2 is reported as unexplained, never as a confirmed split')
})

test('implausible ratios are refused rather than called a 5000:1 split', () => {
  const r = detectPriceBasisMismatch(0.001, 5000)
  assert.equal(r.kind, 'implausible')
  assert.equal(r.split_suspected, false)
})

test('missing or nonsensical prices yield no claim', () => {
  for (const [a, b] of [[null, 3], [3, null], [0, 3], [3, 0], [-1, 3], ['x', 3]]) {
    assert.equal(detectPriceBasisMismatch(a, b), null)
  }
})

test('the stamp records what was observed, not just the verdict', () => {
  const s = priceBasisStamp({ storedPrice: 0.295, freshPrice: 3.243, minute: '10:42' })
  assert.equal(s.comparable, false)
  assert.equal(s.split_suspected, true)
  assert.equal(s.stored_price, 0.295)
  assert.equal(s.fresh_price, 3.243)
  assert.equal(s.sampled_minute, '10:42')
  assert.ok(s.checked_at instanceof Date)
})

test('a comparable pair stamps clean', () => {
  const s = priceBasisStamp({ storedPrice: 10, freshPrice: 10.02, minute: '11:00' })
  assert.equal(s.comparable, true)
  assert.equal(s.split_suspected, false)
})

// ---- the analysis guard (item 5) ----

test('the guard throws on a flagged row so an audit cannot compute through it', () => {
  const row = {
    ticker: 'NEXR', date: '2026-07-28',
    price_basis: priceBasisStamp({ storedPrice: 0.295, freshPrice: 3.243, minute: '10:42' }),
  }
  assert.throws(() => assertComparableBasis(row), /price basis mismatch/)
  assert.throws(() => assertComparableBasis(row), /11:1/)
})

test('the guard passes clean and unstamped rows', () => {
  assert.equal(assertComparableBasis({ ticker: 'AAPL' }), null)
  assert.equal(assertComparableBasis({
    ticker: 'AAPL',
    price_basis: priceBasisStamp({ storedPrice: 10, freshPrice: 10.01 }),
  }), null)
})

test('soft mode returns the reason instead of throwing, for skip-and-tally callers', () => {
  const row = {
    ticker: 'NEXR', date: '2026-07-28',
    price_basis: priceBasisStamp({ storedPrice: 0.295, freshPrice: 3.243 }),
  }
  const reason = assertComparableBasis(row, { soft: true })
  assert.ok(typeof reason === 'string' && reason.includes('NEXR'))
  assert.doesNotThrow(() => assertComparableBasis(row, { soft: true }))
})

// ---- merge hardening (item 4) ----

const BASE = { date: '2026-07-30', threshold: 0.1, stop_pct: 5, exit_reason: 'session_end' }

test('a split-sized entry drift withholds pnl_pct instead of publishing a mixed-basis number', () => {
  const existing = { ...BASE, entry_price: 0.295, peak_price: 0.3, pnl_pct: -5.08, distance_to_stop_pct: -0.09, snapshots: 1 }
  const incoming = { ...BASE, entry_price: 3.243, peak_price: 3.3, current_price: 3.3, observed_at: new Date() }
  const { doc } = mergeTradeSnapshot(existing, incoming, { today: '2026-07-30' })
  // the fabricated value would have been ((3.3 - 0.295)/0.295)*100 = +1018%
  assert.notEqual(doc.pnl_pct, 1018.64)
  assert.equal(doc.pnl_pct, -5.08, 'retains the last figure from a consistent pair')
  assert.equal(doc.pnl_withheld_reason, 'price_basis_mismatch')
  assert.equal(doc.price_basis.split_suspected, true)
  assert.equal(doc.price_basis.split_ratio, '11:1')
  assert.equal(doc.price_basis.source, 'merge_entry_drift')
  assert.equal(doc.entry_price, 0.295, 'the as-traded entry is never rewritten')
  assert.equal(doc.entry_price_drift, 3.243, 'the observed disagreement is recorded')
})

test('an ordinary entry drift still computes pnl_pct as before', () => {
  const existing = { ...BASE, entry_price: 10, peak_price: 11, pnl_pct: 5, snapshots: 1 }
  const incoming = { ...BASE, entry_price: 10.02, peak_price: 11, current_price: 12, observed_at: new Date() }
  const { doc } = mergeTradeSnapshot(existing, incoming, { today: '2026-07-30' })
  assert.equal(doc.pnl_pct, 20)                       // (12 - 10)/10
  assert.equal(doc.pnl_withheld_reason, undefined)
  assert.equal(doc.price_basis, undefined)
  assert.equal(doc.entry_price_drift, 10.02)
})

test('no entry drift at all leaves the row untouched by any of this', () => {
  const existing = { ...BASE, entry_price: 10, peak_price: 11, snapshots: 1 }
  const incoming = { ...BASE, entry_price: 10, peak_price: 12, current_price: 12, observed_at: new Date() }
  const { doc } = mergeTradeSnapshot(existing, incoming, { today: '2026-07-30' })
  assert.equal(doc.pnl_pct, 20)
  assert.equal(doc.entry_price_drift, undefined)
  assert.equal(doc.price_basis, undefined)
})
