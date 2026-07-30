import test from 'node:test'
import assert from 'node:assert/strict'

import { aiArticleSentiment, scoreAiRankingEvidence } from '../lib/aiRankingScore.js'

test('bullish AI suggestions require positive evidence without strong negative pressure', () => {
  const score = scoreAiRankingEvidence({
    tradeScore: 0.78,
    newsAvg: 0.42,
    newsArticleCount: 3,
    bullishNews: 3,
    bearishNews: 0,
    evidenceScore: 0.72,
    socialCount: 24,
    socialSentiment: 0.24,
    predictionScore: 0.64,
    activeSignalDirection: 'up',
    quoteFreshness: 1,
    densityCorrelation: 0.42,
    densitySetupScore: 0.74,
    densityStatus: 'entry_passed',
    changePct: 4.5,
    relVolume: 5.8,
    rsi: 56,
  })

  assert.equal(score.direction, 'bullish')
  assert.equal(score.bullishEvidence, true)
  assert.equal(score.bearishEvidence, false)
  assert.ok(score.aiRankScore >= 60)
})

test('low confidence rows become watch instead of bearish without downside evidence', () => {
  const score = scoreAiRankingEvidence({
    tradeScore: 0.22,
    newsAvg: 0,
    newsArticleCount: 0,
    evidenceScore: 0.10,
    socialCount: 0,
    socialSentiment: 0,
    predictionScore: 0.49,
    activeSignalDirection: 'watch',
    quoteFreshness: 0.35,
    densityCorrelation: null,
    densitySetupScore: 0,
    changePct: 0.2,
    relVolume: 0.9,
  })

  assert.equal(score.direction, 'watch')
  assert.equal(score.bearishEvidence, false)
})

test('bearish AI suggestions require confirmed downside pressure', () => {
  const score = scoreAiRankingEvidence({
    tradeScore: 0.34,
    newsAvg: -0.48,
    newsArticleCount: 4,
    bullishNews: 0,
    bearishNews: 4,
    evidenceScore: 0.28,
    socialCount: 18,
    socialSentiment: -0.36,
    predictionScore: 0.39,
    activeSignalDirection: 'down',
    quoteFreshness: 0.75,
    densityCorrelation: -0.38,
    densitySetupScore: 0.08,
    changePct: -3.4,
    relVolume: 3.1,
  })

  assert.equal(score.direction, 'bearish')
  assert.equal(score.bearishEvidence, true)
  assert.ok(score.bearishPressure > 0.5)
})

test('finance-specific article rules correct common news-source sentiment mistakes', () => {
  assert.equal(
    aiArticleSentiment({ title: 'XYZ announces pricing of public offering', sentiment: 'bullish', sentiment_score: 0.7 }),
    -0.72,
  )
  assert.equal(
    aiArticleSentiment({ title: 'ABC to host earnings conference call', sentiment: 'bullish', sentiment_score: 0.8 }),
    0,
  )
  assert.equal(
    aiArticleSentiment({ title: 'DEF wins multi-year contract with national retailer', sentiment: 'neutral', sentiment_score: 0 }),
    0.62,
  )
})
