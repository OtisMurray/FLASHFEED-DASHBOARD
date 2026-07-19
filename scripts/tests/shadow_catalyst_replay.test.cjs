const test = require('node:test')
const assert = require('node:assert/strict')

const {
  bestAvailableCatalyst,
  captureMetrics,
  eventSec,
  ingestSec,
  signalCaptureState,
} = require('../shadow_catalyst_replay.js')

test('article timestamps use canonical stored publication and ingestion fields', () => {
  const article = {
    publish_date: 1_780_000_000,
    fetched_date: 1_780_000_120,
    created_at: new Date('2020-01-01T00:00:00Z'),
  }
  assert.equal(eventSec(article), 1_780_000_000)
  assert.equal(ingestSec(article), 1_780_000_120)
})

test('bestAvailableCatalyst excludes evidence unavailable at the decision timestamp', () => {
  const articles = [
    { title: 'future', availability_sec: 200, taxonomy: { score: 100, rejection: null } },
    { title: 'routine', availability_sec: 90, taxonomy: { score: 90, rejection: 'routine_news' } },
    { title: 'direct', availability_sec: 80, taxonomy: { score: 70, rejection: null } },
  ]
  assert.equal(bestAvailableCatalyst(articles, 100)?.title, 'direct')
})

test('signal capture separates pipeline presence from final recommendation', () => {
  assert.deepEqual(signalCaptureState({ decision: 'Monitor' }), {
    pipeline: true,
    high_watch: false,
    recommendation: false,
  })
  assert.deepEqual(signalCaptureState({ decision: 'High Watch' }), {
    pipeline: true,
    high_watch: true,
    recommendation: false,
  })
  assert.deepEqual(signalCaptureState({ decision: 'Monitor', entry_signal: { status: 'entry_ready', entry_ready: true } }), {
    pipeline: true,
    high_watch: false,
    recommendation: true,
  })
})

test('capture metrics use final recommendations for recall', () => {
  const rows = [
    {
      ticker: 'AAA',
      group: 'predictable_catalyst_opportunity',
      pipeline_signal_before_major_move: true,
      high_watch_before_major_move: true,
      recommendation_before_major_move: false,
    },
    {
      ticker: 'BBB',
      group: 'predictable_catalyst_opportunity',
      pipeline_signal_before_major_move: true,
      high_watch_before_major_move: true,
      recommendation_before_major_move: true,
    },
  ]
  assert.deepEqual(captureMetrics(rows), {
    legitimate_major_movers: 2,
    predictable_catalyst_opportunities: 2,
    pipeline_signals_before_major_move: 2,
    high_watch_detections_before_major_move: 2,
    recommendations_before_major_move: 1,
    newly_capturable_missed_movers: 1,
    pipeline_recall_of_predictable_movers: 1,
    recommendation_recall_of_predictable_movers: 0.5,
    newly_capturable_tickers: ['AAA'],
  })
})
