import test from 'node:test'
import assert from 'node:assert/strict'

import {
  normalizeRollingWindowMinutes,
  recordIsInsideRollingWindow,
  sliceCandlesToRollingWindow,
} from '../lib/rollingWindow.js'
import { stableDecisionMapQuerySignature } from '../routes/decisionMap.js'

test('every supported Mirror window remains distinct', () => {
  assert.deepEqual(
    ['5', '15', '30', '60', '120', '1440'].map(normalizeRollingWindowMinutes),
    [5, 15, 30, 60, 120, 1440],
  )
  assert.equal(normalizeRollingWindowMinutes('adaptive'), 1440)
})

test('candle windows use an exclusive start and inclusive latest bar', () => {
  const candles = Array.from({ length: 10 }, (_, index) => ({ time: 1_000 + index * 60, close: index }))
  const sliced = sliceCandlesToRollingWindow(candles, 5)
  assert.deepEqual(sliced.map(row => row.time), [1_300, 1_360, 1_420, 1_480, 1_540])
})

test('record boundaries exclude future values and include the exact start', () => {
  assert.equal(recordIsInsideRollingWindow(700, 5, 1_000), true)
  assert.equal(recordIsInsideRollingWindow(699, 5, 1_000), false)
  assert.equal(recordIsInsideRollingWindow(1_001, 5, 1_000), false)
})

test('Decision Map cache signatures include ticker and complete window values', () => {
  const base = { ticker: 'AAPL', cache_scope: 'single-AAPL' }
  const five = stableDecisionMapQuerySignature({ ...base, rolling_window_hours: String(5 / 60) })
  const fifteen = stableDecisionMapQuerySignature({ ...base, rolling_window_hours: String(15 / 60) })
  const otherTicker = stableDecisionMapQuerySignature({ ...base, ticker: 'MSFT', rolling_window_hours: String(5 / 60) })
  assert.notEqual(five, fifteen)
  assert.notEqual(five, otherTicker)
  assert.equal(five, stableDecisionMapQuerySignature({ rolling_window_hours: String(5 / 60), ...base }))
})

test('Decision Map refresh nonces invalidate data without creating a second cache identity', () => {
  const base = { ticker: 'AAPL', single: '1', rolling_window_hours: '2', path_window_hours: '2' }
  const signature = stableDecisionMapQuerySignature(base)
  assert.equal(signature, stableDecisionMapQuerySignature({ ...base, fresh: '1' }))
  assert.equal(signature, stableDecisionMapQuerySignature({ ...base, _r: '12345' }))
  assert.equal(signature, stableDecisionMapQuerySignature({ ...base, cache_bust: '67890' }))
})
