import test from 'node:test'
import assert from 'node:assert/strict'

import { evaluatePredictionEntryThreshold } from '../lib/predictionThresholdPolicy.js'
import { simulatePayoffCapture } from '../lib/payoffCapture.js'
import { V12_PROFILE } from '../routes/v12Screener.js'
import { V11_PROFILE } from '../routes/v11Screener.js'

const row = {
  ticker: 'TEST',
  market_cap_bucket: 'Mid',
  market_cap: 3_000_000_000,
  shares_float: 60_000_000,
  change_pct: 5,
  rel_volume: 3,
  article_count: 1,
  message_count: 8,
  social_sentiment: 0.2,
  price_density_correlation: 0.42,
  previous_price_density_correlation: 0.37,
  threshold_pre_return_60m_pct: 2,
  threshold_trailing_60m_messages: 8,
}

const FIVE_MINUTES_AFTER_OPEN = Date.UTC(2026, 6, 24, 13, 35, 0) / 1000  // 09:35 ET
const AFTER_OPENING_WINDOW = Date.UTC(2026, 6, 24, 13, 51, 0) / 1000     // 09:51 ET

test('v12 blocks new entries inside the first 20 regular-session minutes', () => {
  const early = evaluatePredictionEntryThreshold({
    ...row,
    threshold_feature_snapshot_sec: FIVE_MINUTES_AFTER_OPEN,
  }, V12_PROFILE)
  assert.equal(early.passed, false)
  assert.equal(early.status, 'opening_volatility_rejected')
  assert.equal(early.openingVolatilityGuard.no_entry_active, true)
  assert.equal(early.openingVolatilityGuard.minutes_since_regular_open, 5)
})

test('v12 takes the same cross once the opening block expires', () => {
  const later = evaluatePredictionEntryThreshold({
    ...row,
    threshold_feature_snapshot_sec: AFTER_OPENING_WINDOW,
  }, V12_PROFILE)
  assert.equal(later.passed, true)
  assert.equal(later.status, 'entry_passed')
  assert.equal(later.thresholdC, 0.4)
  assert.equal(later.maxSignalChangePct, 20)
  assert.equal(later.minTrailing60Messages, 5)
  assert.equal(later.policyVersion, 'v12_experimental_profile')
})

test('the two probes disagree on the same early-session row, which is the point', () => {
  const synthetic = { ...row, threshold_feature_snapshot_sec: FIVE_MINUTES_AFTER_OPEN }
  assert.equal(evaluatePredictionEntryThreshold(synthetic, V11_PROFILE).passed, true)
  assert.equal(evaluatePredictionEntryThreshold(synthetic, V12_PROFILE).passed, false)
})

test('v12 simulates a full-position runner, never v11 legacy partial leg', () => {
  const candles = [
    { time: 1, high: 106, low: 100, close: 106 },
    { time: 2, high: 112, low: 108, close: 111 },
    { time: 3, high: 111, low: 107, close: 108 },
  ]
  const v12Exit = simulatePayoffCapture(100, candles, V12_PROFILE)
  assert.equal(v12Exit.partial_exit_price, null)
  assert.equal(v12Exit.exit_reason, 'profit_giveback_stop')

  // Why partialExitFraction is an explicit 0: dropping the key makes
  // simulatePayoffCapture fall back to v11's 0.5 partial and silently price a
  // different strategy under the v12 label.
  const { partialExitFraction, ...withoutKey } = V12_PROFILE
  const accidental = simulatePayoffCapture(100, candles, withoutKey)
  assert.equal(accidental.partial_exit_price, 105)
  assert.notEqual(accidental.return_pct, v12Exit.return_pct)
})

test('v12 profile pins every field that differs from v11', () => {
  assert.equal(V12_PROFILE.windowMinutes, 180)
  assert.equal(V12_PROFILE.smoothingMinutes, 180)
  assert.equal(V12_PROFILE.thresholdC, 0.4)
  assert.equal(V12_PROFILE.minTrailing60Messages, 5)
  assert.equal(V12_PROFILE.maxSignalChangePct, 20)
  assert.equal(V12_PROFILE.activeMoveMaxPct, 20)
  assert.equal(V12_PROFILE.openingNoEntryMinutes, 20)
  assert.equal(V12_PROFILE.profitGivebackPct, 4)

  // Explicit 0, not null and not absent. null would also disable the partial leg,
  // but 0 is what the backtest ran and what the evidence records.
  assert.equal(V12_PROFILE.partialExitFraction, 0)
  assert.notEqual(V12_PROFILE.partialExitFraction, null)
  assert.ok(Object.prototype.hasOwnProperty.call(V12_PROFILE, 'partialExitFraction'))
})

test('the probe does not inherit gates from whatever the live base happens to be', () => {
  // V12_PROFILE must carry its own opening parameters rather than relying on the
  // shared policy, which is v11 and has no opening block at all.
  for (const key of [
    'openingNoEntryMinutes',
    'openingVolatilityGuardMinutes',
    'openingMaxPreSignalReturn60mPct',
    'openingMinTrailing60MessagesMultiplier',
    'openingMaxSignalAbsChangePct',
  ]) {
    assert.ok(Object.prototype.hasOwnProperty.call(V12_PROFILE, key), `V12_PROFILE must pin ${key}`)
  }
})
