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

test('an unscored row reports a null squeeze score, not a measured 0', () => {
  // evidenceContextFor collapses an absent short_squeeze_score to 0 before the
  // gate sees it. The check's `observed` therefore has to be read off the row,
  // or a row nothing ever scored gets reported as a measured 0.0 — a
  // measurement that never happened. Mirrors what the short-interest check
  // beside it already does with its own missing case.
  const unscored = { ...SQUEEZED }
  delete unscored.short_squeeze_score
  const { gate } = evaluate(unscored)
  const check = gate.checks.find(c => c.key === 'squeeze_score')

  assert.equal(check.observed, null)
  assert.equal(check.ok, false)
})

test('a genuinely-zero squeeze score stays distinguishable from an unscored one', () => {
  // The point of the change: these two rows used to be byte-identical in the
  // trace. A real 0 is evidence; an absent score is not.
  const { gate: measured } = evaluate({ ...SQUEEZED, short_squeeze_score: 0 })
  const unscored = { ...SQUEEZED }
  delete unscored.short_squeeze_score
  const { gate: absent } = evaluate(unscored)

  assert.equal(measured.checks.find(c => c.key === 'squeeze_score').observed, 0)
  assert.equal(absent.checks.find(c => c.key === 'squeeze_score').observed, null)

  // Reporting only — both still fail the check, and both still fail the gate.
  assert.equal(measured.checks.find(c => c.key === 'squeeze_score').ok, false)
  assert.equal(absent.checks.find(c => c.key === 'squeeze_score').ok, false)
  assert.equal(measured.passed, false)
  assert.equal(absent.passed, false)
  assert.equal(measured.trace_in_sync, true)
  assert.equal(absent.trace_in_sync, true)
})

// ── squeezeEvidenceState ──────────────────────────────────────────────────
// The gate is a conjunction, so a failing leg returns the same `false` whether
// it was measured or never ingested. These pin the states that undo that
// collapse. The field is reporting only: no boolean beside it may move.

test('squeezeEvidenceState separates a measured failure from an unmeasured one', () => {
  // Both rows are blocked and both were byte-identical before this field
  // existed: same passed, same status, same failed[].
  const measuredLow = { ...SQUEEZED, short_interest_pct: 4, float_short: 3.9 }
  const neverIngested = { ...SQUEEZED }
  delete neverIngested.short_interest_pct
  delete neverIngested.float_short

  const low = evaluate(measuredLow)
  const absent = evaluate(neverIngested)

  assert.equal(low.gate.passed, false)
  assert.equal(absent.gate.passed, false)
  assert.deepEqual(low.gate.failed, absent.gate.failed)   // still indistinguishable here

  assert.equal(low.validation.squeezeEvidenceState, 'FAIL')
  assert.equal(absent.validation.squeezeEvidenceState, 'INSUFFICIENT_DATA')
  assert.deepEqual(absent.validation.squeezeEvidenceUnmeasuredLegs, ['verified_short_interest'])
  assert.deepEqual(low.validation.squeezeEvidenceUnmeasuredLegs, [])
})

test('an unfitted live estimate blocks a row as UNKNOWN, a settlement figure as FAIL', () => {
  // Identical measured value (4%). The only difference is whether the number
  // was fitted against a realised settlement — which is the difference between
  // a verdict and a guess.
  const estimate = evaluate({
    ...SQUEEZED, short_interest_pct: 4, float_short: 3.9,
    short_interest_data_mode: 'live_estimated', short_interest_estimate_uncalibrated: true,
  })
  const settlement = evaluate({
    ...SQUEEZED, short_interest_pct: 4, float_short: 3.9,
    short_interest_data_mode: 'settlement_only', short_interest_estimate_uncalibrated: null,
  })

  assert.equal(estimate.validation.squeezeEvidenceState, 'UNKNOWN')
  assert.equal(settlement.validation.squeezeEvidenceState, 'FAIL')
  // Reporting only — both are still blocked.
  assert.equal(estimate.gate.passed, false)
  assert.equal(settlement.gate.passed, false)
})

test('a genuine measured failure outranks an unfitted estimate', () => {
  // Social is measured at 0, which is real evidence and enough to block on its
  // own. The short-interest estimate being unfitted no longer buys UNKNOWN —
  // this is the production case, where 195 of 198 blocked rows fail on social.
  const row = {
    ...SQUEEZED, message_count: 0, short_interest_pct: 4, float_short: 3.9,
    short_interest_data_mode: 'live_estimated', short_interest_estimate_uncalibrated: true,
  }
  assert.equal(evaluate(row).validation.squeezeEvidenceState, 'FAIL')
})

test('squeezeEvidenceState PASS is exactly the authoritative gate, never broader', () => {
  // Drift guard, in the spirit of trace_in_sync: if the legs ever stop
  // reproducing recognizedSqueezeCatalyst, this field is describing a gate that
  // no longer exists.
  for (const row of [
    SQUEEZED,
    { ...SQUEEZED, message_count: 0 },
    { ...SQUEEZED, short_squeeze_score: 12 },
    { ...SQUEEZED, catalyst_summary: 'bankruptcy risk dilution offering' },
    { ...SQUEEZED, short_interest_pct: 2, float_short: 1 },
  ]) {
    const { validation } = evaluate(row)
    const authoritative = Boolean(validation.recognizedSqueezeCatalyst && validation.verifiedShortInterest)
    assert.equal(validation.squeezeEvidenceState === 'PASS', authoritative)
  }
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
