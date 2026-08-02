import test from 'node:test'
import assert from 'node:assert/strict'

import { attachShortInterestEvidence } from '../routes/screener.js'
import { shortInterestCalibrationNote, calibrationStatusCounts } from '../routes/squeezeScreener.js'

// Documents shaped exactly as 2_Screener/pipeline/fetch_short_interest_estimates_to_mongo.py
// writes them into short_interest_snapshots.
const LIVE_ESTIMATE_DOC = {
  ticker: 'AMC',
  as_of_date: '2026-07-28',
  short_interest_pct: 9.2301,
  short_interest_pct_float: 9.2301,
  short_interest_shares: 23998260,
  days_to_cover: 1.4,
  source: 'finra_daily_short_volume_estimate',
  si_data_mode: 'live_estimated',
  si_official_pct: 6.5,
  si_settlement_date: '2026-06-30',
  si_delta_pct: 2.7301,
  si_uncalibrated: true,
  si_estimate_note: 'FINRA daily short volume layered on the 2026-06-30 settlement figure; k=0.25 (uncalibrated_fallback)',
}

const SETTLEMENT_ONLY_DOC = {
  ticker: 'THINLY',
  as_of_date: '2026-07-28',
  short_interest_pct: 30,
  short_interest_pct_float: 30,
  short_interest_shares: 300000,
  days_to_cover: 9,
  source: 'finviz_settlement_passthrough',
  si_data_mode: 'settlement_only',
  si_official_pct: 30,
  si_settlement_date: '2026-06-30',
  si_uncalibrated: null,
  si_estimate_note: 'no FINRA daily coverage since settlement; passing through the official settlement figure unchanged',
}

test('a live estimate flows into the field the evidence gate already reads', () => {
  const row = attachShortInterestEvidence({ ticker: 'AMC' }, LIVE_ESTIMATE_DOC)
  // verifiedShortInterest reads short_interest_pct; it must see the live number.
  assert.equal(row.short_interest_pct, 9.2301)
  assert.equal(row.days_to_cover, 1.4)
  assert.equal(row.short_squeeze_available, true)
})

test('provenance distinguishes a live estimate from a settlement passthrough', () => {
  const live = attachShortInterestEvidence({ ticker: 'AMC' }, LIVE_ESTIMATE_DOC)
  assert.equal(live.short_interest_data_mode, 'live_estimated')
  assert.equal(live.short_interest_source, 'finra_daily_short_volume_estimate')
  assert.equal(live.short_interest_official_pct, 6.5)
  assert.equal(live.short_interest_settlement_date, '2026-06-30')
  assert.equal(live.short_interest_estimate_delta_pct, 2.7301)

  const settlement = attachShortInterestEvidence({ ticker: 'THINLY' }, SETTLEMENT_ONLY_DOC)
  assert.equal(settlement.short_interest_data_mode, 'settlement_only')
  assert.equal(settlement.short_interest_source, 'finviz_settlement_passthrough')
  // Nothing was estimated, so there is no delta to report.
  assert.equal(settlement.short_interest_estimate_delta_pct, null)
})

test('an uncalibrated estimate is flagged as such on the row', () => {
  const live = attachShortInterestEvidence({ ticker: 'AMC' }, LIVE_ESTIMATE_DOC)
  assert.equal(live.short_interest_estimate_uncalibrated, true)
  assert.match(live.short_interest_estimate_note, /uncalibrated_fallback/)

  const settlement = attachShortInterestEvidence({ ticker: 'THINLY' }, SETTLEMENT_ONLY_DOC)
  assert.equal(settlement.short_interest_estimate_uncalibrated, null)
})

test('the squeeze evidence score still derives from short interest and days to cover', () => {
  // Unchanged behaviour: 9.2301 * 2.2 + 1.4 * 5 = 27.31, no covering bonus.
  // 9.23 sits below the 10% mark, so no high-short-interest signal is raised.
  const row = attachShortInterestEvidence({ ticker: 'AMC' }, LIVE_ESTIMATE_DOC)
  assert.equal(row.short_squeeze_score, 27.3)
  assert.equal(row.short_covering_signal, null)
})

test('a fresher estimate can move a ticker across the 10% evidence threshold', () => {
  // The whole point of the enrichment: same gate logic, better input. A stale
  // 9.1% settlement figure and a live 11.4% estimate land on opposite sides of
  // the threshold that verifiedShortInterest and v11's evidence gate read.
  const stale = attachShortInterestEvidence({ ticker: 'MOVER' }, {
    short_interest_pct: 9.1, days_to_cover: 2, source: 'finviz_settlement_passthrough',
    si_data_mode: 'settlement_only', as_of_date: '2026-06-30',
  })
  const live = attachShortInterestEvidence({ ticker: 'MOVER' }, {
    short_interest_pct: 11.4, days_to_cover: 2, source: 'finra_daily_short_volume_estimate',
    si_data_mode: 'live_estimated', si_official_pct: 9.1, as_of_date: '2026-07-28',
  })
  assert.equal(stale.short_covering_signal, null)
  assert.equal(live.short_covering_signal, 'high_short_interest_remaining')
  // …and the row still says which of the two it is.
  assert.equal(live.short_interest_data_mode, 'live_estimated')
  assert.equal(live.short_interest_official_pct, 9.1)
})

test('a row with no snapshot is returned untouched', () => {
  const original = { ticker: 'NONE', short_squeeze_score: 12 }
  const row = attachShortInterestEvidence(original, null)
  assert.deepEqual(row, original)
  assert.equal(row.short_interest_data_mode, undefined)
})

test('legacy snapshots without the new provenance fields still work', () => {
  // Pre-existing documents (if any) carry none of the si_* keys.
  const row = attachShortInterestEvidence({ ticker: 'OLD' }, {
    short_interest_pct_shares_out: 14.2,
    days_to_cover: 3.1,
    as_of_date: '2026-06-30',
  })
  assert.equal(row.short_interest_pct, 14.2)
  assert.equal(row.short_interest_source, 'short_interest_snapshot')
  assert.equal(row.short_interest_data_mode, 'settlement_only')
  assert.equal(row.short_interest_official_pct, null)
})

// ---------------------------------------------------------------------------
// The calibration disclosure must be DERIVED, not asserted. The previous version
// hardcoded "no config/si_calibration.json exists ... k=0.25" into the response,
// which would have kept describing live numbers as uncalibrated the moment any
// calibration file was installed. These pin the note to what the rows carry.
// ---------------------------------------------------------------------------

const live = (over = {}) => ({
  si_coverage: 'live_estimate',
  si_uncalibrated: true,
  si_calibration_status: 'uncalibrated_fallback',
  si_k: 0.25,
  ...over,
})

test('note reports the real fallback reason and constant when no file exists', () => {
  const note = shortInterestCalibrationNote([live(), live()])
  assert.match(note, /UNCALIBRATED/)
  assert.match(note, /no calibration file exists/)
  assert.match(note, /k=0\.25/)
})

test('note flips to CALIBRATED and stops claiming a fallback once rows are fitted', () => {
  const note = shortInterestCalibrationNote([
    live({ si_uncalibrated: false, si_calibration_status: 'calibrated', si_k: 0.4 }),
    live({ si_uncalibrated: false, si_calibration_status: 'calibrated', si_k: 0.4 }),
  ])
  assert.match(note, /CALIBRATED/)
  assert.doesNotMatch(note, /UNCALIBRATED/)
  assert.doesNotMatch(note, /no calibration file exists/)
  assert.doesNotMatch(note, /k=0\.25/)
  assert.match(note, /k=0\.4/)
})

test('note reports the fitted range when buckets give rows different constants', () => {
  const note = shortInterestCalibrationNote([
    live({ si_uncalibrated: false, si_calibration_status: 'calibrated', si_k: 0.06 }),
    live({ si_uncalibrated: false, si_calibration_status: 'calibrated', si_k: 0.4 }),
  ])
  assert.match(note, /k=0\.06–0\.4/)
})

test('note distinguishes a rejected calibration file from having none', () => {
  const note = shortInterestCalibrationNote([live({ si_calibration_status: 'calibration_rejected' })])
  assert.match(note, /a calibration file exists but nothing in it was usable/)
  assert.doesNotMatch(note, /no calibration file exists/)
})

test('note quantifies a partially calibrated pool instead of over-claiming', () => {
  const note = shortInterestCalibrationNote([
    live(),
    live({ si_uncalibrated: false, si_calibration_status: 'calibrated', si_k: 0.4 }),
  ])
  assert.match(note, /1 of 2/)
})

test('note falls back to passthrough wording when there are no live estimates', () => {
  const note = shortInterestCalibrationNote([{ si_coverage: 'settlement_only' }])
  assert.match(note, /settlement-only/)
  assert.doesNotMatch(note, /UNCALIBRATED/)
  assert.doesNotMatch(note, /CALIBRATED/)
})

test('calibration status counts cover only live estimates', () => {
  const counts = calibrationStatusCounts([
    live(),
    live(),
    live({ si_uncalibrated: false, si_calibration_status: 'calibrated' }),
    { si_coverage: 'settlement_only', si_calibration_status: 'calibrated' },
  ])
  assert.deepEqual(counts, { uncalibrated_fallback: 2, calibrated: 1 })
})
