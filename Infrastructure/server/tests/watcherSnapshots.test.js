import test from 'node:test'
import assert from 'node:assert/strict'

import {
  dedupeWatcherSeries,
  loadWatcherFeatureMap,
  persistWatcherSnapshot,
  watcherRankScore,
  WATCHER_MAX_RANK_POINTS,
} from '../lib/watcherSnapshots.js'
import { attachWatcherSqueezeEvidence, predictionPeopleAttention } from '../routes/screener.js'

test('watcher totals alone cannot create people attention or score points', () => {
  const attention = predictionPeopleAttention({ stocktwits_watcher_count: 2_000_000 }, { watcherCount: 2_000_000 })
  assert.equal(attention.active, false)
  assert.equal(watcherRankScore({ status: 'fresh', age_seconds: 1, current_count: 2_000_000, sample_count: 1 }), 0)
})

test('watcher contribution uses positive growth and stays capped', () => {
  const modest = watcherRankScore({ status: 'fresh', age_seconds: 30, sample_count: 3, delta: 5, growth_pct: 1.25 })
  const extreme = watcherRankScore({ status: 'fresh', age_seconds: 30, sample_count: 20, delta: 100_000, growth_pct: 500 })
  assert.ok(modest > 0)
  assert.ok(modest <= WATCHER_MAX_RANK_POINTS)
  assert.equal(extreme, WATCHER_MAX_RANK_POINTS)
  assert.equal(watcherRankScore({ status: 'stale', age_seconds: 999_999, sample_count: 3, delta: 10, growth_pct: 5 }), 0)
  assert.equal(watcherRankScore({ status: 'fresh', age_seconds: -5, sample_count: 3, delta: 10, growth_pct: 5 }), 0)
})

test('duplicate snapshots collapse to one real point per minute and future rows are excluded', () => {
  const rows = dedupeWatcherSeries([
    { ticker: 'TEST', fetched_sec: 1_000, watcher_count: 10 },
    { ticker: 'TEST', fetched_sec: 1_010, watcher_count: 11 },
    { ticker: 'TEST', fetched_sec: 1_070, watcher_count: 12 },
    { ticker: 'TEST', fetched_sec: 2_000, watcher_count: 999 },
  ], { startSec: 900, endSec: 1_100, nowSec: 1_100 })
  assert.deepEqual(rows.map(row => row.watcher_count), [11, 12])
})

test('feature loader computes causal growth from deduplicated non-future rows', async () => {
  const docs = [
    { ticker: 'TEST', fetched_sec: 9_900, watcher_count: 100, source: 'real' },
    { ticker: 'TEST', fetched_sec: 9_910, watcher_count: 101, source: 'real' },
    { ticker: 'TEST', fetched_sec: 9_970, watcher_count: 104, source: 'real' },
    { ticker: 'TEST', fetched_sec: 10_100, watcher_count: 900, source: 'future' },
  ]
  const db = {
    collection() {
      return {
        find() {
          return { sort() { return { async toArray() { return docs } } } }
        },
      }
    },
  }
  const result = await loadWatcherFeatureMap(db, ['TEST'], {
    nowSec: 10_000,
    maxAgeSeconds: 1_000,
    growthWindowSeconds: 1_000,
  })
  const row = result.get('TEST')
  assert.equal(row.watcher_count, 104)
  assert.equal(row.watcher_feature.baseline_count, 101)
  assert.equal(row.watcher_feature.delta, 3)
  assert.equal(row.watcher_feature.sample_count, 2)
  assert.ok(row.watcher_feature.score_points > 0)
})

test('feature loader keeps watcher histories isolated by ticker', async () => {
  const docs = [
    { ticker: 'AAA', fetched_sec: 9_900, watcher_count: 100 },
    { ticker: 'BBB', fetched_sec: 9_900, watcher_count: 1_000 },
    { ticker: 'AAA', fetched_sec: 9_970, watcher_count: 105 },
    { ticker: 'BBB', fetched_sec: 9_970, watcher_count: 900 },
  ]
  const db = {
    collection() {
      return {
        find() {
          return { sort() { return { async toArray() { return docs } } } }
        },
      }
    },
  }
  const result = await loadWatcherFeatureMap(db, ['AAA', 'BBB'], {
    nowSec: 10_000,
    maxAgeSeconds: 1_000,
    growthWindowSeconds: 1_000,
  })
  assert.equal(result.get('AAA').watcher_feature.delta, 5)
  assert.ok(result.get('AAA').watcher_feature.score_points > 0)
  assert.equal(result.get('BBB').watcher_feature.delta, -100)
  assert.equal(result.get('BBB').watcher_feature.score_points, 0)
})

test('future writes are clamped and minute-keyed upserts are idempotent', async () => {
  const calls = []
  const db = {
    collection() {
      return { async updateOne(...args) { calls.push(args) } }
    },
  }
  const nowSec = Math.floor(Date.now() / 1000)
  await persistWatcherSnapshot(db, { ticker: 'test', watcher_count: 0, source: 'real' }, { fetched_sec: nowSec + 500 })
  const [selector, update, options] = calls[0]
  assert.equal(selector.ticker, 'TEST')
  assert.equal(selector.snapshot_minute, Math.floor(nowSec / 60) * 60)
  assert.equal(update.$set.watcher_count, 0)
  assert.ok(update.$set.fetched_sec <= nowSec)
  assert.equal(options.upsert, true)
})

test('attaching watcher context preserves valid zero and cannot manufacture squeeze evidence', () => {
  const row = attachWatcherSqueezeEvidence({ ticker: 'TEST', short_squeeze_score: 0 }, {
    ticker: 'TEST',
    watcher_count: 0,
    watcher_snapshot_age_seconds: 30,
    watcher_feature: { status: 'fresh', age_seconds: 30, sample_count: 2, delta: 0, growth_pct: 0 },
  })
  assert.equal(row.stocktwits_watcher_count, 0)
  assert.equal(row.watcher_attention_score, 0)
  assert.equal(row.short_squeeze_score, 0)
  assert.equal(row.short_squeeze_available, false)
})

test('attaching missing watcher context does not fabricate a zero observation', () => {
  const row = attachWatcherSqueezeEvidence({ ticker: 'TEST', short_squeeze_score: 0 })
  assert.equal(row.stocktwits_watcher_count, null)
  assert.equal(row.watcher_feature.status, 'missing_or_expired')
  assert.equal(row.watcher_attention_score, 0)
})
