import test from 'node:test'
import assert from 'node:assert/strict'

import {
  classifyRow,
  isFillExitReason,
  isFinalTrade,
  normalizeTrade,
  rowsFromPositionsBatch,
} from '../lib/positionHistory.js'

// The regular-hours restriction flattens a non-exempt position at 16:00 ET with
// exit_reason 'rth_close'. That is a REAL FILL at a real bar — not a mid-session
// mark — so every "did this conclude?" question has to answer yes for it, or the
// row shows up as a still-running position that closed hours ago.
//
// The rth_rule_version / rth_applied stamp exists because history now spans a
// rule change: pre-gate trades could enter and exit across 04:00-20:00, post-gate
// ones cannot. Without the stamp the two regimes are indistinguishable in any
// later analysis.

const TODAY = '2026-07-30'

test('rth_close counts as a fill', () => {
  assert.equal(isFillExitReason('rth_close'), true)
  assert.equal(isFillExitReason('price_trailing_stop'), true)
  assert.equal(isFillExitReason('correlation_break'), true)
})

test('session_end is still the only reason that leaves a position running', () => {
  assert.equal(isFillExitReason('session_end'), false)
  assert.equal(isFillExitReason(''), false)
  assert.equal(isFillExitReason(null), false)
  assert.equal(isFillExitReason(undefined), false)
})

test('a 16:00 flatten is final on the day it happened', () => {
  assert.equal(isFinalTrade({ exit_reason: 'rth_close', date: TODAY }, { today: TODAY }), true)
  // contrast: a session_end row today is NOT final — it is still running
  assert.equal(isFinalTrade({ exit_reason: 'session_end', date: TODAY }, { today: TODAY }), false)
})

test('a 16:00 flatten groups as closed, not open', () => {
  assert.equal(classifyRow({ exit_reason: 'rth_close', date: TODAY }, { today: TODAY }), 'closed_today')
  assert.equal(classifyRow({ exit_reason: 'rth_close', date: '2026-07-29' }, { today: TODAY }), 'closed_earlier')
  // the same row under session_end would still read as open today
  assert.equal(classifyRow({ exit_reason: 'session_end', date: TODAY }, { today: TODAY }), 'open')
})

test('a flatten settles as a realized P&L at the 16:00 fill', () => {
  const row = normalizeTrade(
    {
      entry_epoch: 1785000000,
      entry_price: 100,
      exit_price: 104,
      exit_time: '16:00',
      exit_reason: 'rth_close',
      peak_price: 106,
    },
    { ticker: 'TEST', date: TODAY, threshold: 0.1, stopPct: 5, currentPrice: 111 },
  )
  assert.equal(row.exit_reason, 'rth_close')
  assert.equal(row.pnl_is_realized, true)
  assert.equal(row.exit_is_session_end, false)
  // measured to the 16:00 fill, NOT to the later after-hours mark of 111
  assert.equal(row.exit_price, 104)
  assert.equal(row.exit_time, '16:00')
  assert.equal(row.session_end_price, null)
  assert.equal(row.pnl_pct, 4)
})

test('the RTH rule version is stamped on the row', () => {
  const row = normalizeTrade(
    { entry_epoch: 1785000000, entry_price: 10, exit_reason: 'rth_close', exit_price: 11 },
    {
      ticker: 'TEST', date: TODAY, threshold: 0.1, stopPct: 5,
      rthRuleVersion: 'rth_v1_0930_1600_et', rthApplied: true,
    },
  )
  assert.equal(row.rth_rule_version, 'rth_v1_0930_1600_et')
  assert.equal(row.rth_applied, true)
})

test('an exempt ticker records that the gate did NOT bind it', () => {
  const row = normalizeTrade(
    { entry_epoch: 1785000000, entry_price: 10, exit_reason: 'session_end' },
    {
      ticker: 'AAPL', date: TODAY, threshold: 0.1, stopPct: 5,
      rthRuleVersion: null, rthApplied: false,
    },
  )
  assert.equal(row.rth_applied, false)
  assert.equal(row.rth_rule_version, null)
})

test('a pre-gate row keeps null stamps rather than claiming a regime', () => {
  // Rows written before the gate existed have neither field. null must not be
  // read as "unrestricted" — it means "not recorded", which is the honest answer
  // and the thing that makes mixed-regime history separable.
  const row = normalizeTrade(
    { entry_epoch: 1785000000, entry_price: 10, exit_reason: 'session_end' },
    { ticker: 'TEST', date: TODAY, threshold: 0.1, stopPct: 5 },
  )
  assert.equal(row.rth_rule_version, null)
  assert.equal(row.rth_applied, null)
})

test('the batch carries each ticker OWN regime, not the batch-level one', () => {
  const { rows } = rowsFromPositionsBatch(
    {
      GATED: {
        status: 'ok', date: TODAY, current_price: 12,
        rth_applied: true, rth_rule_version: 'rth_v1_0930_1600_et',
        trades: [{ entry_epoch: 1785000000, entry_price: 10, exit_reason: 'rth_close', exit_price: 12 }],
      },
      EXEMPT: {
        status: 'ok', date: TODAY, current_price: 22,
        rth_applied: false, rth_rule_version: null,
        trades: [{ entry_epoch: 1785000100, entry_price: 20, exit_reason: 'session_end' }],
      },
    },
    { threshold: 0.1, stopPct: 5, policyId: 'test_policy' },
  )
  const byTicker = new Map(rows.map(r => [r.ticker, r]))
  assert.equal(byTicker.get('GATED').rth_applied, true)
  assert.equal(byTicker.get('GATED').rth_rule_version, 'rth_v1_0930_1600_et')
  assert.equal(byTicker.get('EXEMPT').rth_applied, false)
  assert.equal(byTicker.get('EXEMPT').rth_rule_version, null)
})

// The stored peak ratchets up and never down, because a lower incoming peak
// normally means a truncated bar fetch rather than a high that went away. That
// assumption breaks exactly once: when the regular-hours gate turns on, the new
// sim correctly reports a LOWER peak because it stopped counting after-hours
// prints. Holding the old high there would pin the stop to a price the strategy
// could never have worked — the freeze would be defeated at the storage layer.

test('the peak ratchet still holds within one regime', async () => {
  const { mergeTradeSnapshot } = await import('../lib/positionHistory.js')
  const existing = {
    entry_price: 10, peak_price: 12, stop_pct: 5, date: TODAY,
    exit_reason: 'session_end', rth_rule_version: 'rth_v1_0930_1600_et',
  }
  const incoming = {
    entry_price: 10, peak_price: 11, stop_pct: 5, date: TODAY,
    exit_reason: 'session_end', rth_rule_version: 'rth_v1_0930_1600_et',
  }
  const { doc } = mergeTradeSnapshot(existing, incoming, { today: TODAY })
  assert.equal(doc.peak_price, 12, 'a truncated fetch must not lower the peak')
})

test('a regime change lets the peak come down to the actionable high', async () => {
  const { mergeTradeSnapshot } = await import('../lib/positionHistory.js')
  const existing = {
    // stored before the gate: peak includes an after-hours print
    entry_price: 10, peak_price: 12, stop_pct: 5, date: TODAY,
    exit_reason: 'session_end', rth_rule_version: null,
  }
  const incoming = {
    // re-simulated under the gate: after-hours high no longer counts
    entry_price: 10, peak_price: 11, stop_pct: 5, date: TODAY,
    exit_reason: 'session_end', rth_rule_version: 'rth_v1_0930_1600_et',
  }
  const { doc } = mergeTradeSnapshot(existing, incoming, { today: TODAY })
  assert.equal(doc.peak_price, 11, 'regime change must adopt the frozen peak')
  // and the stop follows the corrected peak rather than the stale one
  assert.equal(doc.stop_price, 10.45)
})
