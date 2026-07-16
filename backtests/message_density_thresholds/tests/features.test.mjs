import assert from 'node:assert/strict'
import test from 'node:test'
import {
  causalRollingMean,
  marketCapTier,
  nextRealBarAfter,
  pearson,
  thresholdCrossed,
  trailingSum,
} from '../features.mjs'

test('causalRollingMean only uses current and previous values', () => {
  assert.deepEqual(causalRollingMean([0, 0, 9], 3), [0, 0, 3])
  assert.deepEqual(causalRollingMean([3, 6, 9, 12], 2), [3, 4.5, 7.5, 10.5])
})

test('trailingSum keeps a causal fixed window', () => {
  assert.deepEqual(trailingSum([1, 2, 3, 4], 2), [1, 3, 5, 7])
})

test('pearson rejects constant series', () => {
  assert.equal(pearson([1, 1, 1], [1, 2, 3]), null)
  assert.equal(pearson([1, 2, 3], [5, 5, 5]), null)
  assert.equal(Math.round(pearson([1, 2, 3], [1, 2, 3]) * 1000) / 1000, 1)
})

test('thresholdCrossed fires only on a true crossing', () => {
  assert.equal(thresholdCrossed(0.4, 0.6, 0.5), true)
  assert.equal(thresholdCrossed(0.6, 0.7, 0.5), false)
  assert.equal(thresholdCrossed(0.4, 0.5, 0.5), false)
})

test('FinViz market cap values are treated as millions', () => {
  assert.equal(marketCapTier(250000, 'finviz_elite_screener'), 'Mega')
  assert.equal(marketCapTier(5984.29, 'finviz_elite_screener'), 'Mid')
  assert.equal(marketCapTier(15.97, 'finviz_elite_screener'), 'Nano')
})

test('nextRealBarAfter uses the next later bar, not signal bar', () => {
  const bars = [
    { minute: 100, close: 10 },
    { minute: 160, close: 11 },
    { minute: 220, close: 12 },
  ]
  assert.deepEqual(nextRealBarAfter(bars, 100, { regularOnly: false }), bars[1])
})
