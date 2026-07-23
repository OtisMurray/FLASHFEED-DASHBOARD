import test from 'node:test'
import assert from 'node:assert/strict'

import {
  analyzeDecisionMapPath,
  analyzeDecisionMapRows,
  decisionMapPathScope,
  decisionMapRowLimit,
  decisionMapRowExclusionReasons,
} from '../lib/decisionMapRows.js'

test('valid zero coordinates remain plottable', () => {
  const result = analyzeDecisionMapRows([
    { ticker: 'ZERO', combinedSentiment: 0, priceChangePct: 0, relativeVolume: 0 },
  ])

  assert.equal(result.valid_coordinate_rows, 1)
  assert.equal(result.unique_tickers, 1)
  assert.equal(result.excluded_rows, 0)
})

test('duplicate tickers and invalid coordinates are diagnosed without fabrication', () => {
  const result = analyzeDecisionMapRows([
    { ticker: 'AAPL', combinedSentiment: 0.2, priceChangePct: 1.5, relativeVolume: 2 },
    { ticker: 'aapl', combinedSentiment: 0.3, priceChangePct: 2, relativeVolume: 3 },
    { ticker: 'MISS', combinedSentiment: null, priceChangePct: 1, relativeVolume: 1 },
    { ticker: '', combinedSentiment: 0, priceChangePct: 0, relativeVolume: 0 },
  ])

  assert.equal(result.input_rows, 4)
  assert.equal(result.valid_coordinate_rows, 1)
  assert.equal(result.unique_tickers, 1)
  assert.equal(result.duplicate_ticker_rows, 1)
  assert.equal(result.excluded_rows, 3)
  assert.deepEqual(result.excluded[0], { ticker: 'AAPL', reasons: ['duplicate_ticker'] })
  assert.deepEqual(result.excluded[1], { ticker: 'MISS', reasons: ['invalid_x_sentiment'] })
  assert.deepEqual(result.excluded[2], { ticker: null, reasons: ['missing_ticker'] })
})

test('missing values are not silently converted into valid origin coordinates', () => {
  assert.deepEqual(
    decisionMapRowExclusionReasons({ ticker: 'TEST' }),
    ['invalid_x_sentiment', 'invalid_y_price_change', 'invalid_z_relative_volume'],
  )
})

test('individual path scopes isolate windows, volume timeframes, and session modes', () => {
  assert.equal(decisionMapPathScope({ windowHours: 0.25, volumeTimeframe: '5m', marketDayOnly: true }), 'w15-v5m-market')
  assert.notEqual(
    decisionMapPathScope({ windowHours: 0.25, volumeTimeframe: '5m', marketDayOnly: true }),
    decisionMapPathScope({ windowHours: 2, volumeTimeframe: '5m', marketDayOnly: true }),
  )
  assert.notEqual(
    decisionMapPathScope({ windowHours: 2, volumeTimeframe: '5m', marketDayOnly: true }),
    decisionMapPathScope({ windowHours: 2, volumeTimeframe: '1m', marketDayOnly: true }),
  )
  assert.notEqual(
    decisionMapPathScope({ windowHours: 2, volumeTimeframe: '5m', marketDayOnly: true }),
    decisionMapPathScope({ windowHours: 2, volumeTimeframe: '5m', marketDayOnly: false }),
  )
})

test('multi-ticker requests are capped at 30 while ticker searches request one row', () => {
  assert.equal(decisionMapRowLimit({}), 30)
  assert.equal(decisionMapRowLimit({ limit: 180 }), 30)
  assert.equal(decisionMapRowLimit({ limit: 12 }), 12)
  assert.equal(decisionMapRowLimit({ limit: 'invalid' }), 30)
  assert.equal(decisionMapRowLimit({ limit: 30, ticker: 'LCID' }), 1)
  assert.equal(decisionMapRowLimit({ limit: 30, search: 'SDOT' }), 1)
})

test('individual paths report chronology and ticker leakage', () => {
  const valid = analyzeDecisionMapPath([
    { ticker: 'AAPL', timestamp: 100 },
    { ticker: 'AAPL', timestamp: 200 },
  ], 'AAPL')
  assert.equal(valid.chronological, true)
  assert.equal(valid.wrong_ticker_rows, 0)
  assert.equal(valid.latest_timestamp, 200)

  const contaminated = analyzeDecisionMapPath([
    { ticker: 'MSFT', timestamp: 200 },
    { ticker: 'AAPL', timestamp: 100 },
  ], 'AAPL')
  assert.equal(contaminated.chronological, false)
  assert.equal(contaminated.wrong_ticker_rows, 1)
})
