import test from 'node:test'
import assert from 'node:assert/strict'

import { predictionEvidenceValidation, attachShortInterestEvidence } from '../routes/screener.js'
import { squeezeGateTrace, shortInterestCoverage, evidenceContextFor } from '../routes/squeezeScreener.js'

// GET /api/squeeze-screener adds no scoring: it reports what
// predictionEvidenceValidation already decided. These tests pin the two
// properties that keeps true — the trace never disagrees with the verdict beside
// it, and the trace never invents a pass — plus the per-row honesty labels.
//
// The passing branch is covered with constructed rows on purpose. It needs a real
// squeeze WITH live social traffic inside the same short rolling window, which is
// not something a live-data run can be made to produce on demand: on the
// production universe of 2026-07-28, 368 candidates carried short interest and
// zero cleared the social leg.

// Runs the real gate the way the route does, then the real trace over it.
function evaluate(row) {
  const context = evidenceContextFor(row, row.threshold_setup_status || '')
  const validation = predictionEvidenceValidation(row, context)
  return { validation, gate: squeezeGateTrace(validation, context, row, 30) }
}

// Clears every leg: squeeze score 73, 31% short interest, 40 messages, no
// bearish catalyst text.
const SQUEEZED = {
  ticker: 'SQZ',
  company: 'Squeeze Co',
  price: 12.4,
  change_pct: 6.1,
  rel_volume: 3.2,
  short_squeeze_score: 73,
  short_interest_pct: 31.2,
  float_short: 30.9,
  message_count: 40,
  news_article_count: 0,
  avg_sentiment: 0.2,
}

test('a row clearing every leg passes, and the trace agrees with the gate', () => {
  const { validation, gate } = evaluate(SQUEEZED)

  assert.equal(validation.recognizedSqueezeCatalyst, true)
  assert.equal(validation.verifiedShortInterest, true)
  assert.equal(gate.passed, true)
  assert.equal(gate.status, 'squeeze_catalyst_confirmed')
  assert.deepEqual(gate.failed, [])
  assert.equal(gate.trace_in_sync, true)
  assert.ok(gate.checks.every(check => check.ok))
})

test('the gate is the primary-catalyst standard, not just recognizedSqueezeCatalyst', () => {
  // hasPrimaryPredictionCatalyst (screener.js) requires BOTH terms. Anything this
  // page calls "passing" must satisfy the same bar the prediction tabs use.
  const { validation, gate } = evaluate(SQUEEZED)
  assert.equal(gate.passed, Boolean(validation.recognizedSqueezeCatalyst && validation.verifiedShortInterest))
})

test('failing only the social leg reports exactly that leg — the live-data case', () => {
  const { gate } = evaluate({ ...SQUEEZED, message_count: 0 })

  assert.equal(gate.passed, false)
  assert.deepEqual(gate.failed, ['social'])
  assert.equal(gate.trace_in_sync, true)
  const social = gate.checks.find(check => check.key === 'social')
  assert.equal(social.observed, 0)
  assert.equal(social.required, 3)
  assert.equal(social.window_minutes, 30)
  // The other three legs stay green so the row reads as a near miss, not a reject.
  assert.equal(gate.checks.filter(check => check.ok).length, 3)
})

test('short interest below the bar fails the verified leg and reports the observed value', () => {
  const { validation, gate } = evaluate({ ...SQUEEZED, short_interest_pct: 4.1, float_short: 3.9 })

  assert.equal(validation.verifiedShortInterest, false)
  assert.equal(gate.passed, false)
  assert.ok(gate.failed.includes('verified_short_interest'))
  const check = gate.checks.find(c => c.key === 'verified_short_interest')
  assert.equal(check.observed, 4.1)
  assert.equal(check.required, 10)
})

test('a squeeze score under 70 fails even with heavy short interest and social', () => {
  const { gate } = evaluate({ ...SQUEEZED, short_squeeze_score: 55.3 })

  assert.equal(gate.passed, false)
  assert.deepEqual(gate.failed, ['squeeze_score'])
  assert.equal(gate.checks.find(c => c.key === 'squeeze_score').observed, 55.3)
})

test('a bearish catalyst blocks the row and the trace still matches the gate', () => {
  const { validation, gate } = evaluate({
    ...SQUEEZED,
    news_article_count: 2,
    main_catalyst: { title: 'SQZ announces dilutive offering amid SEC investigation' },
  })

  assert.equal(validation.bearishCatalyst, true)
  assert.equal(validation.recognizedSqueezeCatalyst, false)
  assert.equal(gate.passed, false)
  assert.ok(gate.failed.includes('not_bearish_catalyst'))
  assert.equal(gate.trace_in_sync, true)
})

test('the drift guard trips when the mirrored thresholds stop reproducing the verdict', () => {
  // Simulates screener.js's recognizedSqueezeCatalyst changing without
  // squeezeScreener.js's mirrored literals following: every displayed check is
  // green but the authoritative boolean says no. The row must be reported as a
  // failure with trace_in_sync=false, never as a pass.
  const context = evidenceContextFor(SQUEEZED, '')
  const drifted = {
    ...predictionEvidenceValidation(SQUEEZED, context),
    recognizedSqueezeCatalyst: false,
  }
  const gate = squeezeGateTrace(drifted, context, SQUEEZED, 30)

  assert.equal(gate.passed, false)
  assert.equal(gate.trace_in_sync, false)
  assert.equal(gate.status, 'blocked_upstream')
})

test('coverage labels keep a live estimate, a settlement passthrough, and Finviz-only apart', () => {
  const live = attachShortInterestEvidence({ ticker: 'A' }, {
    short_interest_pct: 31.2, days_to_cover: 5, si_data_mode: 'live_estimated',
    si_official_pct: 22, si_uncalibrated: true, source: 'finra_daily_short_volume_estimate',
  })
  assert.equal(shortInterestCoverage(live, { si_data_mode: 'live_estimated' }), 'live_estimate')

  const settlement = attachShortInterestEvidence({ ticker: 'B' }, {
    short_interest_pct: 30, days_to_cover: 9, si_data_mode: 'settlement_only',
    si_official_pct: 30, si_uncalibrated: null, source: 'finviz_settlement_passthrough',
  })
  assert.equal(shortInterestCoverage(settlement, { si_data_mode: 'settlement_only' }), 'settlement_only')

  // No snapshot at all: the stale pre-estimator behaviour, and it must say so
  // rather than borrowing the "live estimate" label from its neighbours.
  assert.equal(shortInterestCoverage({ ticker: 'C', float_short: 18.2 }, null), 'finviz_only')
  assert.equal(shortInterestCoverage({ ticker: 'D' }, null), 'none')
})

test('a settlement-only row is never labelled as an uncalibrated live estimate', () => {
  // si_uncalibrated is null (not false) on a passthrough — the calibration
  // question does not apply, because nothing was estimated.
  const row = attachShortInterestEvidence({ ticker: 'B' }, {
    short_interest_pct: 30, si_data_mode: 'settlement_only', si_uncalibrated: null,
    source: 'finviz_settlement_passthrough',
  })
  assert.equal(row.short_interest_estimate_uncalibrated, null)
  assert.equal(shortInterestCoverage(row, { si_data_mode: 'settlement_only' }), 'settlement_only')
})
