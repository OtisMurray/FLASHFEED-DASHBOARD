import test from 'node:test'
import assert from 'node:assert/strict'

import { pnlPendingFor, recordedPositionRow } from '../routes/positionScreener.js'

// HONESTY CONVENTION: a 0.00% that means "no elapsed session" must not render as
// a flat outcome.
//
// The chart-service now stops the strategy at the last real bar, so an entry can
// still legitimately land ON that bar — the position is real, it just has no tape
// behind it yet. Its mark IS its fill, so pnl_pct is 0 by construction. That is
// the same class of gap as the Unsettled badge: the figure is arithmetically
// true and tells the reader something false, so it gets a label, not a number.
//
// This is deliberately NOT "hide rows whose P&L is 0". A position that really did
// go nowhere over two hours of tape has earned its 0.00%.

test('an entry on the newest bar has no elapsed session', () => {
  assert.equal(pnlPendingFor({ bars_since_entry: 0 }), true)
})

test('a position with tape behind it reports a real P&L', () => {
  assert.equal(pnlPendingFor({ bars_since_entry: 1 }), false)
  assert.equal(pnlPendingFor({ bars_since_entry: 177 }), false)
})

test('a genuine 0.00% over elapsed tape is NOT pending', () => {
  // entered 177 bars ago and went exactly nowhere — a real, if boring, outcome
  assert.equal(pnlPendingFor({ bars_since_entry: 177, pnl_pct: 0 }), false)
})

test('a risk exit is never pending, however few bars it took', () => {
  assert.equal(pnlPendingFor({ bars_since_entry: 0 }, { riskExit: true }), false)
  assert.equal(pnlPendingFor({ bars_since_entry: 1 }, { riskExit: true }), false)
})

test('an unknown bar count is not pending', () => {
  // An older chart-service, or a history row predating the field. Unknown must
  // not read as pending: an unlabelled real P&L beats a labelled fake one.
  assert.equal(pnlPendingFor({}), false)
  assert.equal(pnlPendingFor({ bars_since_entry: null }), false)
  assert.equal(pnlPendingFor({ bars_since_entry: undefined }), false)
})

test('a recorded row is never pending — stale rows are the Unsettled badge instead', () => {
  const row = recordedPositionRow(
    { ticker: 'TEST', date: '2026-07-29', entry_epoch: 1785000000, pnl_pct: 0, finalized: true },
    { today: '2026-07-30' },
  )
  assert.equal(row.pnl_pending, false)
})

test('a recorded row carries bars_since_entry through when history has it', () => {
  const row = recordedPositionRow(
    { ticker: 'TEST', date: '2026-07-29', entry_epoch: 1785000000, bars_since_entry: 42 },
    { today: '2026-07-30' },
  )
  assert.equal(row.bars_since_entry, 42)
})
