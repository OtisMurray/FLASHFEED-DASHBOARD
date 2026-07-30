import test from 'node:test'
import assert from 'node:assert/strict'

import { nextSessionModelProductionReady } from '../routes/screener.js'

const validModel = {
  status: 'trained_production',
  live_enabled: true,
  validation_protocol: 'purged_market_date_train_validation_test_v2',
  split_mode: 'market_date',
  metrics: {
    independent_test: {
      actionable_samples: 120,
      accuracy: 0.64,
      balanced_accuracy: 0.59,
      baseline_majority_accuracy: 0.57,
      coverage: 0.2,
      profit_factor: 1.2,
    },
  },
}

test('rejects legacy next-session records without independent chronological evidence', () => {
  assert.equal(nextSessionModelProductionReady({
    status: 'trained_production',
    live_enabled: true,
    metrics: { selected: { accuracy: 0.9, profit_factor: 5 } },
  }), false)
})

test('accepts a next-session model only after every production gate passes', () => {
  assert.equal(nextSessionModelProductionReady(validModel), true)
  assert.equal(nextSessionModelProductionReady({
    ...validModel,
    metrics: {
      independent_test: {
        ...validModel.metrics.independent_test,
        accuracy: 0.58,
      },
    },
  }), false)
})
