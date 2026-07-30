import test from 'node:test'
import assert from 'node:assert/strict'

import { loadAiPositionCandidates, selectAiPositionCandidates } from '../lib/aiPositionCandidates.js'

function row(ticker, score, direction = 'watch', predictionDirection = 'watch', entryReady = false) {
  return {
    ticker,
    company: `${ticker} Inc`,
    ai_rank_score: score,
    direction,
    prediction_signal: {
      direction: predictionDirection,
      probability_up: predictionDirection === 'up' ? 0.64 : 0.5,
      entry_ready: entryReady,
      model: 'test-model',
    },
  }
}

test('positions candidates exclude bearish and down-prediction rows', () => {
  const selected = selectAiPositionCandidates([
    row('GOOD', 70, 'bullish', 'up'),
    row('BEAR', 90, 'bearish', 'up'),
    row('DOWN', 85, 'watch', 'down'),
    row('LOW', 49, 'bullish', 'up'),
  ], { minScore: 50, limit: 30 })

  assert.deepEqual(selected.map(candidate => candidate.ticker), ['GOOD'])
})
test('entry-ready AI suggestions are prioritized without inventing eligibility', () => {
  const selected = selectAiPositionCandidates([
    row('HIGH', 78, 'bullish', 'up', false),
    row('READY', 62, 'watch', 'up', true),
  ], { minScore: 50, limit: 30 })

  assert.deepEqual(selected.map(candidate => candidate.ticker), ['READY', 'HIGH'])
  assert.equal(selected[0].candidate_source, 'ai_suggestion')
})

test('AI loader uses the canonical rankings response and preserves provenance', async () => {
  let requestedUrl = null
  const fetchImpl = async url => {
    requestedUrl = String(url)
    return {
      ok: true,
      json: async () => ({
        ok: true,
        generated_at: '2026-07-29T12:00:00.000Z',
        model: { name: 'validated-model', status: 'validated' },
        rows: [row('TEST', 67, 'bullish', 'up', true)],
      }),
    }
  }
  const result = await loadAiPositionCandidates({
    limit: 30,
    minScore: 50,
    fetchImpl,
    url: 'http://127.0.0.1:3999/api/ai/rankings',
  })

  assert.match(requestedUrl, /\/api\/ai\/rankings\?/)
  assert.equal(result.candidates[0].ticker, 'TEST')
  assert.equal(result.candidates[0].ai_model, 'test-model')
  assert.equal(result.generated_at, '2026-07-29T12:00:00.000Z')
})
