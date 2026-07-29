import test from 'node:test'
import assert from 'node:assert/strict'

import {
  evaluatePredictionEntryThreshold,
  predictionThresholdProfile,
  PREDICTION_THRESHOLD_POLICY,
  PREDICTION_THRESHOLD_POLICY_VERSION,
  PREDICTION_THRESHOLD_FEATURE_SOURCE,
} from '../lib/predictionThresholdPolicy.js'
import { V12_PROFILE } from '../routes/v12Screener.js'

// GUARD TEST — the live default threshold policy must be v11.
//
// v12 is a probe. It is reachable ONLY by passing V12_PROFILE explicitly as a
// profileOverride, which is what /api/v12-screener does. Every call that omits
// the override — the main screener, the prediction pipeline, the squeeze
// screener — must resolve v11's parameters.
//
// This exists because dropping a v12 policy file over the shared one silently
// made v12 the no-override default for all of those callers at once, and
// rotated the prediction cache namespace with it. Nothing in the test suite
// caught that. This does.

const baseRow = {
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

test('the exported policy identity is v11, not v12', () => {
  assert.match(PREDICTION_THRESHOLD_POLICY_VERSION, /_v11$/)
  assert.equal(PREDICTION_THRESHOLD_FEATURE_SOURCE, 'mongo_ohlc_social_density_v11')
  assert.doesNotMatch(PREDICTION_THRESHOLD_POLICY_VERSION, /v12/)
  assert.equal(PREDICTION_THRESHOLD_POLICY.version, PREDICTION_THRESHOLD_POLICY_VERSION)
})

test('evaluatePredictionEntryThreshold(row) with NO override resolves v11', () => {
  const result = evaluatePredictionEntryThreshold(baseRow)
  assert.equal(result.thresholdC, 0.38)                 // v12 would be 0.40
  assert.equal(result.profile.windowMinutes, 120)       // v12 would be 180
  assert.equal(result.profile.smoothingMinutes, 120)    // v12 would be 180
  assert.equal(result.minTrailing60Messages, 3)         // v12 would be 5
  assert.equal(result.maxSignalChangePct, 12)           // v12 would be 20
  assert.equal(result.profile.partialExitFraction, 0.5) // v12 would be 0
  assert.equal(result.profile.profitGivebackPct, 5)     // v12 would be 4
  assert.equal(result.policyVersion, PREDICTION_THRESHOLD_POLICY_VERSION)
})

test('every no-override call shape resolves v11', () => {
  // Callers in the wild use (row), (row, features) and (row, features, null).
  const { price_density_correlation, previous_price_density_correlation, ...rest } = baseRow
  const features = { price_density_correlation, previous_price_density_correlation }
  for (const result of [
    evaluatePredictionEntryThreshold(baseRow),
    evaluatePredictionEntryThreshold(rest, features),
    evaluatePredictionEntryThreshold(rest, features, null),
  ]) {
    assert.equal(result.thresholdC, 0.38)
    assert.equal(result.profile.windowMinutes, 120)
  }
})

test('predictionThresholdProfile with no override is v11 across every tier', () => {
  for (const bucket of ['Mega', 'Large', 'Mid', 'Small', 'Micro']) {
    const { profile } = predictionThresholdProfile({ ...baseRow, market_cap_bucket: bucket })
    assert.equal(profile.windowMinutes, 120, `${bucket} window`)
    assert.equal(profile.thresholdC, 0.38, `${bucket} thresholdC`)
    assert.equal(profile.maxSignalChangePct, 12, `${bucket} maxSignalChangePct`)
  }
})

test('no-override evaluation never applies a first-20-minute no-entry block', () => {
  // v12's defining entry rule must not leak into default evaluation.
  const early = evaluatePredictionEntryThreshold({
    ...baseRow,
    threshold_feature_snapshot_sec: Date.UTC(2026, 6, 24, 13, 35, 0) / 1000, // 09:35 ET
  })
  assert.equal(early.openingVolatilityGuard.no_entry_active, false)
  assert.equal(early.openingVolatilityGuard.no_entry_minutes, 0)
})

test('v12 is reachable, but only through an explicit override', () => {
  const probe = evaluatePredictionEntryThreshold({
    ...baseRow,
    threshold_feature_snapshot_sec: Date.UTC(2026, 6, 24, 13, 51, 0) / 1000, // 09:51 ET
  }, V12_PROFILE)
  assert.equal(probe.thresholdC, 0.4)
  assert.equal(probe.profile.windowMinutes, 180)
  assert.equal(probe.policyVersion, 'v12_experimental_profile')

  // And passing it changes nothing about the next unqualified call.
  assert.equal(evaluatePredictionEntryThreshold(baseRow).thresholdC, 0.38)
})
