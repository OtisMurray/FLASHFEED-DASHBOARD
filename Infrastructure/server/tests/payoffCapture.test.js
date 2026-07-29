import test from 'node:test'
import assert from 'node:assert/strict'

import { simulatePayoffCapture } from '../lib/payoffCapture.js'

const candles = [
  { time: 1, high: 106, low: 100, close: 106 },
  { time: 2, high: 112, low: 108, close: 111 },
  { time: 3, high: 111, low: 107, close: 108 },
]

test('legacy payoff simulation keeps the v11 50 percent partial default', () => {
  const result = simulatePayoffCapture(100, candles, {
    profitGivebackPct: 4,
    profitGivebackActivationPct: 10,
    protectiveStopPct: 3,
  })
  assert.equal(result.partial_exit_price, 105)
  assert.equal(result.exit_reason, 'profit_giveback_stop')
  assert.equal(result.return_pct, 6.26)
})

test('explicit null partial fraction produces a full-position runner exit', () => {
  const result = simulatePayoffCapture(100, candles, {
    partialExitFraction: null,
    partialProfitTargetPct: null,
    profitGivebackPct: 4,
    profitGivebackActivationPct: 10,
    protectiveStopPct: 3,
  })
  assert.equal(result.partial_exit_price, null)
  assert.equal(result.exit_reason, 'profit_giveback_stop')
  assert.equal(result.return_pct, 7.52)
})

test('explicit zero partial fraction produces a full-position runner exit', () => {
  const result = simulatePayoffCapture(100, candles, {
    partialExitFraction: 0,
    partialProfitTargetPct: 5,
    profitGivebackPct: 4,
    profitGivebackActivationPct: 10,
    protectiveStopPct: 3,
  })
  assert.equal(result.partial_exit_price, null)
  assert.equal(result.exit_reason, 'profit_giveback_stop')
  assert.equal(result.return_pct, 7.52)
})
