import test from 'node:test'
import assert from 'node:assert/strict'

import {
  INTRADAY_EVALUATION_PROTOCOL,
  INTRADAY_LABEL_VERSION,
  chronologicalDateSplit,
  dedupePurgedSignals,
  evaluateDirectionModel,
  predictIntradayDirection,
  promotionDecision,
  trainAdaBoostDirectionModel,
  trainLogisticDirectionModel,
  transformIntradayFeatures,
} from '../lib/intradayPredictionModel.js'

test('feature transforms clip extreme values and preserve missing correlation explicitly', () => {
  const transformed = transformIntradayFeatures({ change_pct: 99999, rel_volume: 99999, price_density_correlation: null }, 1785331800)
  assert.ok(Object.values(transformed).every(Number.isFinite))
  assert.equal(transformed.correlation_missing, 1)
  assert.equal(transformed.price_density_correlation, 0)
})

test('purging keeps only one signal per ticker per five-minute outcome bucket', () => {
  const rows = dedupePurgedSignals([
    { ticker: 'AAA', signal_sec: 1000 },
    { ticker: 'AAA', signal_sec: 1100 },
    { ticker: 'AAA', signal_sec: 1300 },
    { ticker: 'BBB', signal_sec: 1100 },
  ])
  assert.deepEqual(rows.map(row => `${row.ticker}:${row.signal_sec}`), ['AAA:1000', 'BBB:1100', 'AAA:1300'])
})

test('chronological split holds out entire dates with no overlap', () => {
  const rows = ['01', '02', '03', '04'].flatMap((day, dayIndex) => Array.from({ length: 3 }, (_, index) => ({
    market_date: `2026-07-${day}`,
    ticker: `T${dayIndex}${index}`,
  })))
  const split = chronologicalDateSplit(rows, { validationDates: 1, testDates: 1, minRowsPerDate: 1 })
  assert.deepEqual(split.dates.train, ['2026-07-01', '2026-07-02'])
  assert.deepEqual(split.dates.validation, ['2026-07-03'])
  assert.deepEqual(split.dates.test, ['2026-07-04'])
})

test('logistic direction model learns a deterministic separable signal', () => {
  const rows = Array.from({ length: 100 }, (_, index) => ({
    label: index >= 50 ? 1 : 0,
    return_pct: index >= 50 ? 1 : -1,
    features: { weighted_sentiment: index >= 50 ? 1 : -1 },
  }))
  const classifier = trainLogisticDirectionModel(rows, { featureKeys: ['weighted_sentiment'], iterations: 250 })
  classifier.probability_threshold = 0.55
  const prediction = predictIntradayDirection({ weighted_sentiment: 1 }, classifier)
  const metrics = evaluateDirectionModel(rows, classifier)
  assert.equal(prediction.direction, 'up')
  assert.equal(metrics.directional_accuracy_5m, 1)
})

test('boosted stumps learn a deterministic nonlinear threshold', () => {
  const rows = Array.from({ length: 100 }, (_, index) => ({
    label: index >= 50 ? 1 : 0,
    return_pct: index >= 50 ? 1 : -1,
    features: { trade_watch_score: index / 100 },
  }))
  const classifier = trainAdaBoostDirectionModel(rows, { featureKeys: ['trade_watch_score'], estimators: 10 })
  classifier.probability_threshold = 0.55
  assert.equal(predictIntradayDirection({ trade_watch_score: 0.9 }, classifier).direction, 'up')
  assert.equal(evaluateDirectionModel(rows, classifier).directional_accuracy_5m, 1)
})

test('promotion rejects legacy or in-sample metrics and accepts only strict holdout evidence', () => {
  assert.equal(promotionDecision({ status: 'trained', metrics: { directional_accuracy_5m: 0.99 } }).allow_live_classifier, false)
  const strictModel = {
    status: 'trained',
    metrics: {
      evaluation_protocol: INTRADAY_EVALUATION_PROTOCOL,
      outcome_label_version: INTRADAY_LABEL_VERSION,
      actionable_samples: 150,
      directional_accuracy_5m: 0.64,
      balanced_accuracy_5m: 0.61,
      baseline_directional_accuracy_5m: 0.58,
      coverage: 0.4,
      profit_factor: 1.2,
    },
  }
  assert.equal(promotionDecision(strictModel).allow_live_classifier, true)
})
