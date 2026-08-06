import test from 'node:test'
import assert from 'node:assert/strict'
import {
  RESETTABLE_COLLECTIONS,
  RESET_CONFIRM_PHRASE,
  previewReset,
  executeReset,
} from '../lib/dataReset.js'

// The allowlist IS the safety model, so these tests are mostly about what is
// absent from it. A future edit that adds "socials" to make a reset feel more
// thorough should fail here rather than in production.

const MUST_NEVER_RESET = [
  // Credentials, accounts, settings.
  'users', 'apikeys', 'api_keys', 'user_connections', 'app_settings',
  'keywords', 'source_toggles', 'source_favorites', 'rss_sources', 'source_status',
  // Raw ingested observations that cannot be re-fetched.
  'socials', 'articles', 'stocktwits_watcher_snapshots',
  // Trained artefacts.
  'prediction_models', 'next_session_prediction_models',
]

test('allowlist excludes credentials, settings, raw ingest and trained models', () => {
  const names = new Set(RESETTABLE_COLLECTIONS.map(c => c.name))
  for (const forbidden of MUST_NEVER_RESET) {
    assert.equal(names.has(forbidden), false, `${forbidden} must never be resettable`)
  }
})

test('allowlist includes position history and is frozen', () => {
  assert.ok(RESETTABLE_COLLECTIONS.some(c => c.name === 'screener_position_history'))
  assert.ok(Object.isFrozen(RESETTABLE_COLLECTIONS))
  // Every entry needs a recovery note — the dialog shows it, and an entry with
  // no story about how it comes back has not been thought through.
  for (const c of RESETTABLE_COLLECTIONS) {
    assert.ok(c.name && c.label && c.note, `${c.name} is missing label or note`)
  }
})

test('position history is labelled as not rebuildable', () => {
  const hist = RESETTABLE_COLLECTIONS.find(c => c.name === 'screener_position_history')
  assert.match(hist.note, /not rebuildable/i)
})

test('confirm phrase is a non-empty constant', () => {
  assert.equal(typeof RESET_CONFIRM_PHRASE, 'string')
  assert.ok(RESET_CONFIRM_PHRASE.length > 0)
})

// A stand-in for the driver: records which collections were asked for, so the
// tests can assert on the exact set touched without a live mongod.
function fakeDb(present, counts = {}) {
  const touched = []
  return {
    touched,
    listCollections: () => ({ toArray: async () => present.map(name => ({ name })) }),
    collection(name) {
      return {
        countDocuments: async () => counts[name] ?? 0,
        deleteMany: async () => { touched.push(name); return { deletedCount: counts[name] ?? 0 } },
      }
    },
  }
}

test('preview reports every allowlisted collection, present or not', async () => {
  const db = fakeDb(['screener_position_history', 'ohlcv_bars'], { screener_position_history: 34, ohlcv_bars: 900 })
  const out = await previewReset(db)
  assert.equal(out.collections.length, RESETTABLE_COLLECTIONS.length)
  assert.equal(out.total_rows, 934)
  const absent = out.collections.find(c => c.name === 'correlations')
  assert.equal(absent.exists, false)
  assert.equal(absent.count, 0)
})

test('execute only ever deletes from collections that exist and are allowlisted', async () => {
  const present = ['screener_position_history', 'ohlcv_bars', 'users', 'socials', 'user_connections']
  const db = fakeDb(present, { screener_position_history: 34, ohlcv_bars: 900 })
  const out = await executeReset(db, { actor: 'test' })
  assert.deepEqual(db.touched.sort(), ['ohlcv_bars', 'screener_position_history'])
  assert.equal(out.deleted_total, 934)
  assert.equal(out.failed_count, 0)
})

test('one failing collection does not abort the rest', async () => {
  const db = fakeDb(['screener_position_history', 'ohlcv_bars'], { ohlcv_bars: 5 })
  const original = db.collection.bind(db)
  db.collection = (name) => name === 'screener_position_history'
    ? { countDocuments: async () => 1, deleteMany: async () => { throw new Error('boom') } }
    : original(name)
  const out = await executeReset(db, { actor: 'test' })
  assert.equal(out.failed_count, 1)
  assert.equal(out.deleted_total, 5)
  assert.match(out.results.find(r => r.name === 'screener_position_history').error, /boom/)
})
