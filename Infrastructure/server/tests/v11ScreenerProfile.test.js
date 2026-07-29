import test from 'node:test'
import assert from 'node:assert/strict'

import { evaluatePredictionEntryThreshold, PREDICTION_THRESHOLD_POLICY } from '../lib/predictionThresholdPolicy.js'
import { V11_PROFILE } from '../routes/v11Screener.js'

// The v11 probe replays a FIXED historical profile. The shared gate it borrows
// can express opening rules v11 never had, so those rules must not reach a v11
// replay — otherwise the probe reports different history than the backtest it
// exists to reproduce.
//
// This row is the one that exposed the gap: it passes v11's gate cleanly, but
// its signal lands 5 minutes after the regular open, and its 2% pre-move is over
// the volatility guard's tightened 1.5% ceiling.
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

test('v11 replay still takes an early-session signal', () => {
  const early = evaluatePredictionEntryThreshold({
    ...row,
    threshold_feature_snapshot_sec: FIVE_MINUTES_AFTER_OPEN,
  }, V11_PROFILE)

  assert.equal(early.openingVolatilityGuard.no_entry_active, false)
  assert.equal(early.openingVolatilityGuard.active, false)
  assert.equal(early.passed, true)
  assert.equal(early.status, 'entry_passed')
})

test('pinning only the no-entry block would still change v11 verdicts', () => {
  assert.equal(V11_PROFILE.openingNoEntryMinutes, 0)
  assert.equal(V11_PROFILE.openingVolatilityGuardMinutes, 0)

  // Half-pinned: the hard block is off but the volatility guard is not, which is
  // enough on its own to reject. This is the regression this pin closes.
  const halfPinned = { ...V11_PROFILE, openingVolatilityGuardMinutes: 20 }
  const rejected = evaluatePredictionEntryThreshold({
    ...row,
    threshold_feature_snapshot_sec: FIVE_MINUTES_AFTER_OPEN,
  }, halfPinned)
  assert.equal(rejected.passed, false)
  assert.equal(rejected.status, 'opening_volatility_rejected')
})

test('the live policy is v11 and carries the guard v11 replay pins away', () => {
  assert.equal(PREDICTION_THRESHOLD_POLICY.candidateRule.windowMinutes, 120)
  assert.equal(PREDICTION_THRESHOLD_POLICY.candidateRule.thresholdC, 0.38)

  // openingVolatilityGuardMinutes IS in the live base, so V11_PROFILE's 0 is
  // load-bearing rather than decorative.
  assert.equal(PREDICTION_THRESHOLD_POLICY.candidateRule.openingVolatilityGuardMinutes, 20)

  // openingNoEntryMinutes is NOT in the live v11 base; the engine supports the
  // key but defaults it to 0.
  assert.equal(PREDICTION_THRESHOLD_POLICY.candidateRule.openingNoEntryMinutes, undefined)
  assert.equal(evaluatePredictionEntryThreshold(row, {}).openingVolatilityGuard.no_entry_minutes, 0)
})

test('supplying the signal minute changed nothing for v11', () => {
  const later = evaluatePredictionEntryThreshold({
    ...row,
    threshold_feature_snapshot_sec: AFTER_OPENING_WINDOW,
  }, V11_PROFILE)
  assert.equal(later.passed, true)

  // The pre-merge call shape, with no timestamp at all.
  const untimed = evaluatePredictionEntryThreshold(row, V11_PROFILE)
  assert.equal(untimed.passed, true)
  assert.equal(untimed.status, 'entry_passed')
})

test('v11 keeps its own thresholds when borrowing the shared gate', () => {
  const result = evaluatePredictionEntryThreshold(row, V11_PROFILE)
  assert.equal(result.thresholdC, 0.38)
  assert.equal(result.maxSignalChangePct, 12)
  assert.equal(result.minTrailing60Messages, 3)
  assert.equal(result.policyVersion, 'v11_experimental_profile')
})
