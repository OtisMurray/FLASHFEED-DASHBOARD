import test from 'node:test'
import assert from 'node:assert/strict'
import {
  predictionModelStatus,
  PREDICTION_MODEL_ABSENT,
  PREDICTION_MODEL_NO_STATUS,
} from '../lib/predictionModelStatus.js'

// runDataRefreshCycle read `predictionModel.status` unguarded. Since 2fac48a
// (2026-07-29) repointed PREDICTION_MODEL_ID at 'trade_watch_direction_v2',
// which no document has ever used, that value was null on every cycle and the
// read threw. It threw at the tail of the function, after all ingestion had
// completed, so data kept flowing while /api/fetch answered 500 and
// autoGrabTick swallowed the error in silence for a week.

test('a null model reports the absence instead of throwing', () => {
  // The exact production state: no document matches PREDICTION_MODEL_ID.
  assert.doesNotThrow(() => predictionModelStatus(null))
  assert.equal(predictionModelStatus(null), PREDICTION_MODEL_ABSENT)
})

test('undefined is treated the same as null', () => {
  assert.equal(predictionModelStatus(undefined), PREDICTION_MODEL_ABSENT)
})

test('a model that declares a status keeps it', () => {
  // trainPredictionModel() synthesises this one.
  assert.equal(
    predictionModelStatus({ _id: 'trade_watch_direction_v2', status: 'strict_offline_training_required' }),
    'strict_offline_training_required',
  )
})

test('a stored document with no status of its own is distinguishable from an absent one', () => {
  // The real v1 document in production: { _id, samples, updated_at } — no status.
  const stored = { _id: 'trade_watch_linear_v1', samples: 3000, updated_at: '2026-07-31T18:29:22.061Z' }
  assert.equal(predictionModelStatus(stored), PREDICTION_MODEL_NO_STATUS)
  assert.notEqual(predictionModelStatus(stored), PREDICTION_MODEL_ABSENT)
})

test('the absent state is a named value, not an empty one', () => {
  // Guarding with `?.` alone would have replaced the crash with an empty field,
  // which reads as "unknown" rather than "there is no model".
  const absent = predictionModelStatus(null)
  assert.ok(absent)
  assert.notEqual(absent, '')
  assert.notEqual(absent, undefined)
})

test('a falsy-but-present status is not mistaken for absence', () => {
  assert.equal(predictionModelStatus({ status: '' }), '')
  assert.equal(predictionModelStatus({ status: 0 }), 0)
})
