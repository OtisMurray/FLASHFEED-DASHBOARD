import test from 'node:test'
import assert from 'node:assert/strict'

import { scoreLongTerm, longTermLabel, LONG_TERM_WEIGHTS } from '../lib/longTermScore.js'

// A row that sits exactly on the neutral point of all five components.
// P/E 22.5 is the midpoint of the valuation sub-metric's 5..40 band.
const NEUTRAL_ROW = { price: 50, perf_year: 0, sma200: 0, analyst: '3.0', roe: 10, debt_equity: 1, forward_pe: 22.5 }
const NEUTRAL_RAW = { week_52_high: 100, week_52_low: 0, profit_margin: 5 }

test('component weights sum to 1 so renormalization is meaningful', () => {
  const total = Object.values(LONG_TERM_WEIGHTS).reduce((a, b) => a + b, 0)
  assert.ok(Math.abs(total - 1) < 1e-9, `weights sum to ${total}`)
})

test('an all-neutral row scores 50 on every component', () => {
  const result = scoreLongTerm(NEUTRAL_ROW, NEUTRAL_RAW)
  assert.deepEqual(result.components, {
    range_position: 50,
    return_1y: 50,
    trend_200d: 50,
    analyst_rating: 50,
    fundamentals: 50,
  })
  assert.equal(result.score, 50)
  assert.equal(result.components_available, 5)
})

// Guards the first defect in the design this was adapted from: two of its three
// components were the same quantity a day apart, so ~70% of the score tracked a
// single variable. Each component here must respond only to its own input.
test('components are independent measurements, not the same variable twice', () => {
  const returnMoved = scoreLongTerm({ ...NEUTRAL_ROW, perf_year: 40 }, NEUTRAL_RAW)
  assert.equal(returnMoved.components.return_1y, 90, 'return component tracks perf_year')
  assert.equal(returnMoved.components.range_position, 50, 'range position must NOT move with perf_year')

  const priceMoved = scoreLongTerm({ ...NEUTRAL_ROW, price: 90 }, NEUTRAL_RAW)
  assert.equal(priceMoved.components.range_position, 90, 'range position tracks price within its range')
  assert.equal(priceMoved.components.return_1y, 50, 'return component must NOT move with spot price')
})

// Guards the second defect: the original added a component's weight only inside
// an exception handler, so a merely-absent field shrank the total and a coverage
// gap read as bearish. Renormalizing keeps absent data neutral.
test('missing components renormalize to neutral instead of deflating the score', () => {
  const sparse = scoreLongTerm({ price: 50, forward_pe: 22.5 }, { week_52_high: 100, week_52_low: 0 })

  assert.equal(sparse.components_available, 2)
  assert.equal(sparse.components.return_1y, null, 'absent perf_year is null, not 0')
  assert.equal(sparse.components.trend_200d, null, 'absent sma200 is null, not 0')

  assert.equal(sparse.score, 50, 'neutral row stays 50 with only 2 of 5 components')
  assert.equal(longTermLabel(sparse.score), 'Neutral')

  // Without renormalization this same row would have scored 50 * 0.40 = 20 ("Poor")
  // purely because the Elite ingest had not populated two columns.
  const unrenormalized = 50 * (LONG_TERM_WEIGHTS.range_position + LONG_TERM_WEIGHTS.fundamentals)
  assert.equal(unrenormalized, 20)
  assert.ok(sparse.score - unrenormalized > 29, 'renormalization must lift the sparse row off the floor')
})

// Renormalization alone would let a row scored on one component claim a perfect
// 100 and outrank fully-evidenced rows, so ranking shrinks toward neutral by
// coverage. This must be a no-op once every column is populated.
test('ranked_score shrinks thin rows but is an identity at full coverage', () => {
  const full = scoreLongTerm(NEUTRAL_ROW, NEUTRAL_RAW)
  assert.equal(full.coverage, 1)
  assert.equal(full.ranked_score, full.score, 'no shrinkage when all components are present')

  // Only range_position is scorable, and it is a perfect 100.
  const oneComponent = scoreLongTerm({ price: 100 }, { week_52_high: 100, week_52_low: 0 })
  assert.equal(oneComponent.components_available, 1)
  assert.equal(oneComponent.score, 100, 'displayed score stays the honest renormalized value')
  assert.equal(oneComponent.ranked_score, 60, '50 + (100-50) * 0.20 coverage')

  // A well-evidenced strong row must now outrank the one-component perfect score.
  const wellEvidenced = scoreLongTerm(
    { price: 90, perf_year: 30, sma200: 10, analyst: '1.5', roe: 25, debt_equity: 0.3, forward_pe: 12 },
    { week_52_high: 100, week_52_low: 0, profit_margin: 18 },
  )
  assert.ok(wellEvidenced.score < oneComponent.score, 'it scores lower on the raw number')
  assert.ok(
    wellEvidenced.ranked_score > oneComponent.ranked_score,
    'but ranks above it, because its score is actually evidenced',
  )
})

test('a strong sparse row outranks a weak complete row', () => {
  const strongSparse = scoreLongTerm({ price: 95, forward_pe: 8 }, { week_52_high: 100, week_52_low: 0 })
  const weakComplete = scoreLongTerm(
    { price: 10, perf_year: -40, sma200: -18, analyst: '4.5', roe: -5, debt_equity: 1.9, forward_pe: 60 },
    { week_52_high: 100, week_52_low: 0, profit_margin: -10 },
  )
  assert.ok(strongSparse.score > weakComplete.score)
})

test('a row with no scorable field returns null rather than a misleading zero', () => {
  const empty = scoreLongTerm({}, {})
  assert.equal(empty.score, null)
  assert.equal(empty.components_available, 0)
  assert.equal(longTermLabel(empty.score), 'No Data')
})

test('a degenerate 52-week range does not divide by zero', () => {
  const flat = scoreLongTerm({ price: 50 }, { week_52_high: 50, week_52_low: 50 })
  assert.equal(flat.components.range_position, null)
})

test('extreme inputs clamp inside 0..100', () => {
  const extreme = scoreLongTerm(
    { price: 500, perf_year: 900, sma200: 400, analyst: '1.0', roe: 200, debt_equity: 0, forward_pe: 5 },
    { week_52_high: 100, week_52_low: 0, profit_margin: 90 },
  )
  assert.equal(extreme.components.range_position, 100)
  assert.ok(extreme.score <= 100 && extreme.score >= 0)
})

test('analyst scale keeps Finviz orientation: 1 is Strong Buy', () => {
  assert.equal(scoreLongTerm({ analyst: '1.0' }, {}).components.analyst_rating, 100)
  assert.equal(scoreLongTerm({ analyst: '5.0' }, {}).components.analyst_rating, 0)
  assert.equal(scoreLongTerm({ analyst: '9' }, {}).components.analyst_rating, null, 'out-of-range value ignored')
})

test('a non-positive P/E is penalized but not discarded', () => {
  assert.equal(scoreLongTerm({ pe_ratio: -12 }, {}).components.fundamentals, 25)
})

test('percent columns are read as percentage points', () => {
  // Finviz "+25.5%" arrives as 25.5, not 0.255 — a fraction would score ~50.
  assert.equal(scoreLongTerm({ perf_year: 25 }, {}).components.return_1y, 75)
})
