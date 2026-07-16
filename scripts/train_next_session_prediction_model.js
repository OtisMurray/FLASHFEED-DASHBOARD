#!/usr/bin/env node

const path = require('path')
let mongoose
try {
  mongoose = require('mongoose')
} catch (_) {
  try {
    mongoose = require(path.join('/app', 'node_modules', 'mongoose'))
  } catch (_) {
    mongoose = require(path.join(__dirname, '..', 'Infrastructure', 'server', 'node_modules', 'mongoose'))
  }
}

const MODEL_ID = 'next_session_outcome_calibrator_v1'
const FEATURE_KEYS = [
  'final_prediction_score',
  'prediction_confidence',
  'probability_up',
  'predicted_return',
  'change_pct',
  'abs_change_pct',
  'rel_volume',
  'risk_count',
  'has_no_risk_flags',
  'has_large_move_flag',
  'has_extreme_volatility_flag',
  'has_catalyst_mismatch_flag',
  'has_private_exposure_flag',
  'ai_score',
  'ai_confidence',
  'ai_article_count',
  'momentum_score',
  'correlation_score',
  'news_sentiment',
  'social_sentiment',
  'filing_sentiment',
  'catalyst_alignment',
  'catalyst_power_score',
  'catalyst_window_article_count',
  'top_catalyst_power',
  'has_session_window_catalyst',
  'positive_catalyst_gate',
  'evidence_items',
  'reliability',
  'is_premarket_signal',
  'is_regular_signal',
  'is_afterhours_signal',
  'is_weekend_carry_signal',
]

function argValue(name, fallback = '') {
  const prefix = `--${name}=`
  const inline = process.argv.find(arg => arg.startsWith(prefix))
  if (inline) return inline.slice(prefix.length)
  const index = process.argv.indexOf(`--${name}`)
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1]
  return fallback
}

function toNumber(value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function clamp(value, min = 0, max = 1) {
  const n = Number(value)
  if (!Number.isFinite(n)) return min
  return Math.max(min, Math.min(max, n))
}

function sigmoid(value) {
  const n = clamp(value, -20, 20)
  return 1 / (1 + Math.exp(-n))
}

function outcomeReturn(outcome = {}, target = 'close') {
  if (!outcome || outcome.outcome_status !== 'labeled') return null
  if (target === 'payoff' || target === 'payoff_capture') {
    const n = Number(outcome.payoff_capture_return_pct)
    if (Number.isFinite(n)) return n
  }
  if (target === 'tradable' || target === 'professor_win') {
    const high = Number(outcome.high_return_pct ?? outcome.max_gain_pct)
    const close = Number(outcome.close_return_pct ?? outcome.last_return_pct)
    if (Number.isFinite(high) && high >= 2) return high
    if (Number.isFinite(close)) return close
    return null
  }
  const preferred = target === 'open'
    ? outcome.open_return_pct
    : target === 'high'
      ? outcome.high_return_pct ?? outcome.max_gain_pct
      : target === 'session'
        ? outcome.close_return_pct ?? outcome.last_return_pct
        : outcome.close_return_pct
  const n = Number(preferred)
  return Number.isFinite(n) ? n : null
}

function sessionFlags(row = {}) {
  const session = String(row.prediction_session || row.prediction?.predictionSession || row.prediction?.prediction_session || '').toLowerCase()
  return {
    is_premarket_signal: session === 'premarket' || session === 'overnight' ? 1 : 0,
    is_regular_signal: session === 'regular' ? 1 : 0,
    is_afterhours_signal: session === 'afterhours' || session === 'closed_post_afterhours' ? 1 : 0,
    is_weekend_carry_signal: session === 'weekend' ? 1 : 0,
  }
}

function rowFeatures(row = {}) {
  const riskFlags = Array.isArray(row.risk_flags) ? row.risk_flags : []
  const components = row.dashboard_assessment?.components || {}
  const flags = sessionFlags(row)
  return {
    final_prediction_score: toNumber(row.final_prediction_score, 0),
    prediction_confidence: toNumber(row.prediction_confidence ?? row.prediction?.confidence, 0),
    probability_up: toNumber(row.probability_up ?? row.prediction?.probabilityUp, 0.5),
    predicted_return: toNumber(row.predicted_return ?? row.prediction?.predictedReturn, 0),
    change_pct: toNumber(row.change_pct, 0),
    abs_change_pct: Math.abs(toNumber(row.change_pct, 0)),
    rel_volume: toNumber(row.rel_volume ?? row.prediction?.features?.rel_volume, 0),
    risk_count: riskFlags.length,
    has_no_risk_flags: riskFlags.length ? 0 : 1,
    has_large_move_flag: riskFlags.some(flag => ['RECENT_LARGE_MOVE', 'RECENT_EXTREME_MOVE_ALREADY_OCCURRED'].includes(flag)) ? 1 : 0,
    has_extreme_volatility_flag: riskFlags.includes('EXTREME_VOLATILITY') ? 1 : 0,
    has_catalyst_mismatch_flag: riskFlags.includes('CATALYST_TICKER_MISMATCH') ? 1 : 0,
    has_private_exposure_flag: riskFlags.includes('NON_ACTIONABLE_PRIVATE_EXPOSURE') ? 1 : 0,
    ai_score: toNumber(row.ai_score, 50),
    ai_confidence: toNumber(row.ai_context?.ai_confidence ?? components.aiConfidence, 0),
    ai_article_count: toNumber(row.ai_context?.ai_article_count ?? row.prediction?.features?.ai_article_count, 0),
    momentum_score: toNumber(row.momentum_score, 50),
    correlation_score: toNumber(row.correlation_score, 0),
    news_sentiment: toNumber(row.sentiment_breakdown?.newsSentiment ?? components.newsSentiment, 0),
    social_sentiment: toNumber(row.sentiment_breakdown?.socialSentiment ?? components.socialSentiment, 0),
    filing_sentiment: toNumber(row.sentiment_breakdown?.filingSentiment ?? components.filingSentiment, 0),
    catalyst_alignment: toNumber(components.catalystAlignment, 0),
    catalyst_power_score: toNumber(row.catalyst_power_score ?? row.catalystScore ?? row.catalyst_score, 0),
    catalyst_window_article_count: toNumber(row.catalyst_window_article_count, 0),
    top_catalyst_power: Array.isArray(row.catalysts) && row.catalysts.length ? toNumber(row.catalysts[0]?.catalyst_power, 0) : 0,
    has_session_window_catalyst: toNumber(row.catalyst_window_article_count, 0) > 0 ? 1 : 0,
    positive_catalyst_gate: components.positiveCatalystGate ? 1 : 0,
    evidence_items: toNumber(row.dashboard_assessment?.evidenceItems, 0),
    reliability: toNumber(row.dashboard_assessment?.reliability, 0),
    ...flags,
  }
}

function featureStats(samples = [], keys = FEATURE_KEYS) {
  const stats = {}
  for (const key of keys) {
    const values = samples.map(row => toNumber(row.features?.[key], 0))
    const mean = values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)
    const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, values.length - 1)
    stats[key] = { mean, std: Math.sqrt(variance) || 1 }
  }
  return stats
}

function vector(features = {}, stats = {}, keys = FEATURE_KEYS) {
  return keys.map(key => {
    const stat = stats[key] || { mean: 0, std: 1 }
    return (toNumber(features[key], 0) - toNumber(stat.mean, 0)) / (toNumber(stat.std, 1) || 1)
  })
}

function shuffle(array = []) {
  for (let i = array.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    const tmp = array[i]
    array[i] = array[j]
    array[j] = tmp
  }
  return array
}

function trainLogistic(samples = [], keys = FEATURE_KEYS) {
  const stats = featureStats(samples, keys)
  const rows = samples.map(sample => ({ ...sample, v: vector(sample.features, stats, keys) }))
  const upCount = rows.filter(row => row.y === 1).length
  const downCount = rows.length - upCount
  const weights = Array.from({ length: keys.length }, () => 0)
  let intercept = Math.log(Math.max(1, upCount) / Math.max(1, downCount))
  const epochs = Math.max(100, Math.min(1000, toNumber(argValue('epochs', '320'), 320)))
  const learningRate = Math.max(0.001, Math.min(0.2, toNumber(argValue('learningRate', '0.04'), 0.04)))
  const l2 = Math.max(0, Math.min(1, toNumber(argValue('l2', '0.035'), 0.035)))
  const upWeight = rows.length / Math.max(1, 2 * upCount)
  const downWeight = rows.length / Math.max(1, 2 * downCount)

  for (let epoch = 0; epoch < epochs; epoch += 1) {
    const grad = Array.from({ length: keys.length }, () => 0)
    let interceptGrad = 0
    let totalWeight = 0
    for (const row of rows) {
      let z = intercept
      for (let i = 0; i < keys.length; i += 1) z += weights[i] * row.v[i]
      const p = sigmoid(z)
      const sampleWeight = row.y ? upWeight : downWeight
      const err = (p - row.y) * sampleWeight
      totalWeight += sampleWeight
      interceptGrad += err
      for (let i = 0; i < keys.length; i += 1) grad[i] += err * row.v[i]
    }
    const denom = Math.max(1, totalWeight)
    intercept -= learningRate * (interceptGrad / denom)
    for (let i = 0; i < keys.length; i += 1) {
      weights[i] -= learningRate * ((grad[i] / denom) + l2 * weights[i])
      weights[i] = clamp(weights[i], -5, 5)
    }
  }

  const topFeatures = weights
    .map((weight, index) => ({ key: keys[index], weight: Number(weight.toFixed(5)), abs: Math.abs(weight) }))
    .sort((a, b) => b.abs - a.abs)
    .slice(0, 12)
    .map(({ key, weight }) => ({ key, weight }))

  return {
    feature_stats: Object.fromEntries(Object.entries(stats).map(([key, value]) => [key, {
      mean: Number(value.mean.toFixed(5)),
      std: Number(value.std.toFixed(5)),
    }])),
    feature_keys: keys,
    intercept: Number(intercept.toFixed(6)),
    weights: weights.map(weight => Number(weight.toFixed(6))),
    top_features: topFeatures,
    class_counts: { up: upCount, down: downCount },
  }
}

function predict(features = {}, model = {}) {
  let z = toNumber(model.intercept, 0)
  const stats = model.feature_stats || {}
  const keys = model.feature_keys || FEATURE_KEYS
  const weights = model.weights || []
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i]
    const stat = stats[key] || { mean: 0, std: 1 }
    z += toNumber(weights[i], 0) * ((toNumber(features[key], 0) - toNumber(stat.mean, 0)) / (toNumber(stat.std, 1) || 1))
  }
  return sigmoid(z)
}

function evaluate(samples = [], model = {}, thresholds = []) {
  return thresholds.map(threshold => {
    const rows = samples.map(sample => {
      const p = predict(sample.features, model)
      const direction = p >= threshold ? 'up' : p <= 1 - threshold ? 'down' : 'watch'
      const correct = direction === 'watch' ? null : direction === 'up' ? sample.y === 1 : sample.y === 0
      return { p, direction, correct, target: sample.target }
    })
    const actionable = rows.filter(row => row.correct != null)
    const accuracy = actionable.length
      ? actionable.reduce((sum, row) => sum + (row.correct ? 1 : 0), 0) / actionable.length
      : null
    const avgReturn = actionable.length
      ? actionable.reduce((sum, row) => sum + Number(row.target || 0), 0) / actionable.length
      : null
    const grossWin = actionable.reduce((sum, row) => sum + Math.max(0, Number(row.target || 0)), 0)
    const grossLoss = Math.abs(actionable.reduce((sum, row) => sum + Math.min(0, Number(row.target || 0)), 0))
    const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : null
    return {
      threshold,
      actionable_samples: actionable.length,
      accuracy: accuracy == null ? null : Number(accuracy.toFixed(3)),
      coverage: samples.length ? Number((actionable.length / samples.length).toFixed(3)) : 0,
      avg_labeled_return: avgReturn == null ? null : Number(avgReturn.toFixed(3)),
      profit_factor: profitFactor == null ? null : Number.isFinite(profitFactor) ? Number(profitFactor.toFixed(3)) : 'infinite',
    }
  })
}

async function loadSamples(db, { target = 'close', minMovePct = 0.0, limit = 5000 } = {}) {
  const snapshots = await db.collection('daily_prediction_snapshots')
    .find({}, { projection: { _id: 1, raw_rows: 1, high_conviction_rows: 1, generated_at_sec: 1, prediction_session_context: 1 } })
    .sort({ generated_at_sec: -1 })
    .limit(Math.max(1, Math.min(500, limit)))
    .toArray()

  const samples = []
  const seen = new Set()
  for (const snapshot of snapshots) {
    for (const [group, rows] of [['raw_rows', snapshot.raw_rows || []], ['high_conviction_rows', snapshot.high_conviction_rows || []]]) {
      for (const row of rows) {
        const ticker = String(row.ticker || '').toUpperCase()
        if (!ticker) continue
        const key = `${snapshot._id}:${group}:${ticker}`
        if (seen.has(key)) continue
        seen.add(key)
        let outcome = row.outcome || null
        if (!outcome || outcome.outcome_status !== 'labeled') {
          const stored = await db.collection('prediction_outcomes').findOne({ _id: key }, { projection: { outcome: 1 } })
          outcome = stored?.outcome || outcome
        }
        const targetReturn = outcomeReturn(outcome, target)
        if (targetReturn == null || Math.abs(targetReturn) < minMovePct) continue
        const features = rowFeatures(row)
        samples.push({
          snapshot_id: snapshot._id,
          row_group: group,
          ticker,
          snapshot_sec: toNumber(snapshot.generated_at_sec, 0),
          target: Number(targetReturn.toFixed(3)),
          y: targetReturn > 0 ? 1 : 0,
          features,
        })
      }
    }
  }
  return samples
}

async function main() {
  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI || argValue('mongo', 'mongodb://localhost:27017/feedflash')
  const minSamples = Math.max(20, Math.min(1000, toNumber(argValue('minSamples', process.env.NEXT_SESSION_MIN_SAMPLES || '80'), 80)))
  const limit = Math.max(50, Math.min(10000, toNumber(argValue('limit', '5000'), 5000)))
  const target = argValue('target', process.env.NEXT_SESSION_TRAINING_TARGET || 'payoff_capture')
  const minMovePct = Math.max(0, Math.min(2, toNumber(argValue('minMovePct', '0'), 0)))
  const requiredAccuracy = Math.max(0.5, Math.min(0.9, toNumber(argValue('requiredAccuracy', process.env.MIN_NEXT_SESSION_ACCURACY || '0.60'), 0.60)))
  const requiredHoldout = Math.max(5, Math.min(500, toNumber(argValue('requiredHoldout', process.env.MIN_NEXT_SESSION_HOLDOUT || '20'), 20)))
  const requiredAvgReturn = Math.max(0, Math.min(10, toNumber(argValue('requiredAvgReturn', process.env.MIN_NEXT_SESSION_AVG_RETURN || '0.10'), 0.10)))
  const requiredProfitFactor = Math.max(1, Math.min(10, toNumber(argValue('requiredProfitFactor', process.env.MIN_NEXT_SESSION_PROFIT_FACTOR || '1.10'), 1.10)))
  const exploratoryMinSamples = Math.max(20, Math.min(minSamples, toNumber(argValue('exploratoryMinSamples', '40'), 40)))
  const splitMode = String(argValue('splitMode', process.env.NEXT_SESSION_SPLIT_MODE || 'temporal')).toLowerCase()

  await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 10000 })
  const db = mongoose.connection.db
  const samples = await loadSamples(db, { target, minMovePct, limit })
  const now = new Date()

  if (samples.length < exploratoryMinSamples) {
    const doc = {
      _id: MODEL_ID,
      model_id: MODEL_ID,
      status: 'insufficient_samples',
      algorithm: 'regularized_logistic_next_session_v1',
      samples: samples.length,
      min_samples: minSamples,
      exploratory_min_samples: exploratoryMinSamples,
      target,
      min_move_pct: minMovePct,
      required_accuracy: requiredAccuracy,
      required_holdout: requiredHoldout,
      required_avg_return_pct: requiredAvgReturn,
      required_profit_factor: requiredProfitFactor,
      split_mode: splitMode,
      feature_keys: FEATURE_KEYS,
      live_enabled: false,
      reason: `needs_at_least_${exploratoryMinSamples}_labeled_next_session_outcomes_for_shadow_training_and_${minSamples}_for_live_use`,
      updated_at: now,
      note: 'This model trains only on saved prediction snapshots after their next-session outcomes are labeled. No fake labels are created. Default target is payoff_capture so faded-but-tradable moves are judged by the audited exit structure.',
    }
    await db.collection('next_session_prediction_models').updateOne({ _id: MODEL_ID }, { $set: doc }, { upsert: true })
    console.log(JSON.stringify({ ok: true, model: doc }, null, 2))
    await mongoose.disconnect()
    return
  }

  const holdoutSize = samples.length >= 200 ? Math.max(requiredHoldout, Math.floor(samples.length * 0.2)) : Math.min(requiredHoldout, Math.floor(samples.length * 0.35))
  const ordered = samples.slice().sort((a, b) => Number(a.snapshot_sec || 0) - Number(b.snapshot_sec || 0) || String(a.snapshot_id).localeCompare(String(b.snapshot_id)) || String(a.ticker).localeCompare(String(b.ticker)))
  const shuffled = splitMode === 'random' ? shuffle(samples.slice()) : ordered
  const holdout = splitMode === 'random' ? shuffled.slice(0, holdoutSize) : ordered.slice(-holdoutSize)
  const training = splitMode === 'random' ? shuffled.slice(holdoutSize) : ordered.slice(0, Math.max(0, ordered.length - holdoutSize))
  const trainingSet = training.length >= exploratoryMinSamples ? training : shuffled
  const modelParts = trainLogistic(trainingSet)
  const thresholds = []
  for (let value = 0.52; value <= 0.9; value += 0.01) thresholds.push(Number(value.toFixed(2)))
  const evaluated = evaluate(holdout, modelParts, thresholds)
  const profitFactorValue = row => row.profit_factor === 'infinite' ? Infinity : Number(row.profit_factor)
  const baselineUpRate = holdout.length ? holdout.reduce((sum, row) => sum + (row.y === 1 ? 1 : 0), 0) / holdout.length : null
  const baselineAccuracy = baselineUpRate == null ? null : Math.max(baselineUpRate, 1 - baselineUpRate)
  const viable = evaluated.filter(row =>
    row.actionable_samples >= requiredHoldout &&
    row.accuracy != null &&
    row.accuracy >= requiredAccuracy &&
    (baselineAccuracy == null || row.accuracy >= baselineAccuracy) &&
    row.avg_labeled_return != null &&
    row.avg_labeled_return >= requiredAvgReturn &&
    profitFactorValue(row) != null &&
    profitFactorValue(row) >= requiredProfitFactor
  )
  const shadowRequiredHoldout = Math.min(requiredHoldout, Math.max(5, Math.floor(holdout.length * 0.5)))
  const shadowViable = evaluated.filter(row => row.actionable_samples >= shadowRequiredHoldout && row.accuracy != null)
  const best = (viable.length ? viable : shadowViable.length ? shadowViable : evaluated.filter(row => row.accuracy != null))
    .sort((a, b) => {
      const aPf = Math.min(3, profitFactorValue(a) || 0)
      const bPf = Math.min(3, profitFactorValue(b) || 0)
      const aObj = (a.accuracy || 0) * 1.2 + Math.min(0.08, a.coverage * 0.1) + Math.max(-0.2, Math.min(0.2, Number(a.avg_labeled_return || 0) / 10)) + aPf * 0.05
      const bObj = (b.accuracy || 0) * 1.2 + Math.min(0.08, b.coverage * 0.1) + Math.max(-0.2, Math.min(0.2, Number(b.avg_labeled_return || 0) / 10)) + bPf * 0.05
      return bObj - aObj
    })[0] || null

  const enoughLiveSamples = samples.length >= minSamples
  const bestProfitFactor = best ? profitFactorValue(best) : null
  const liveEnabled = Boolean(
    enoughLiveSamples &&
    best &&
    best.actionable_samples >= requiredHoldout &&
    best.accuracy >= requiredAccuracy &&
    best.avg_labeled_return != null &&
    best.avg_labeled_return >= requiredAvgReturn &&
    bestProfitFactor != null &&
    bestProfitFactor >= requiredProfitFactor &&
    (baselineAccuracy == null || best.accuracy >= baselineAccuracy)
  )

  const doc = {
    _id: MODEL_ID,
    model_id: MODEL_ID,
    status: liveEnabled ? 'trained_production' : enoughLiveSamples ? 'trained_shadow_not_validated' : 'trained_shadow_insufficient_samples',
    algorithm: 'regularized_logistic_next_session_v1',
    target,
    min_move_pct: minMovePct,
    samples: samples.length,
    min_samples: minSamples,
    exploratory_min_samples: exploratoryMinSamples,
    training_samples: Math.max(0, samples.length - holdout.length),
    holdout_samples: holdout.length,
    split_mode: splitMode === 'random' ? 'random' : 'temporal',
    holdout_start_snapshot_sec: holdout.length ? Math.min(...holdout.map(row => Number(row.snapshot_sec || 0)).filter(Number.isFinite)) : null,
    holdout_end_snapshot_sec: holdout.length ? Math.max(...holdout.map(row => Number(row.snapshot_sec || 0)).filter(Number.isFinite)) : null,
    training_start_snapshot_sec: trainingSet.length ? Math.min(...trainingSet.map(row => Number(row.snapshot_sec || 0)).filter(Number.isFinite)) : null,
    training_end_snapshot_sec: trainingSet.length ? Math.max(...trainingSet.map(row => Number(row.snapshot_sec || 0)).filter(Number.isFinite)) : null,
    feature_keys: FEATURE_KEYS,
    ...modelParts,
    selected_threshold: best?.threshold ?? null,
    live_enabled: liveEnabled,
    required_accuracy: requiredAccuracy,
    required_holdout: requiredHoldout,
    required_avg_return_pct: requiredAvgReturn,
    required_profit_factor: requiredProfitFactor,
    shadow_required_holdout: shadowRequiredHoldout,
    validation_status: liveEnabled
      ? 'live_validated_next_session_edge'
      : enoughLiveSamples
        ? 'shadow_next_session_not_validated'
        : 'shadow_insufficient_next_session_samples',
    validation_reason: liveEnabled
      ? 'next-session holdout accuracy, positive-return, and profit-factor requirements met'
      : !enoughLiveSamples
        ? `has_${samples.length}_labeled_outcomes_needs_${minSamples}_for_live_use`
      : best
        ? `best_threshold_accuracy_${best.accuracy}_avg_return_${best.avg_labeled_return}_profit_factor_${best.profit_factor}_with_${best.actionable_samples}_samples_not_enough_for_live_use`
        : 'no_actionable_holdout_predictions',
    metrics: {
      selected: best,
      threshold_candidates: evaluated,
      baseline_majority_accuracy: baselineAccuracy == null ? null : Number(baselineAccuracy.toFixed(3)),
      up_rate_holdout: baselineUpRate == null ? null : Number(baselineUpRate.toFixed(3)),
      labeled_return_mean: Number((samples.reduce((sum, row) => sum + row.target, 0) / samples.length).toFixed(3)),
    },
    updated_at: now,
    note: 'Learns from saved dashboard predictions and labeled next-session outcomes only. Default target is payoff_capture, not close-only, so the model can reward tradable spikes that the giveback/partial-exit logic captures. Use live_enabled=false as a hard warning, not a suggestion.',
  }
  await db.collection('next_session_prediction_models').updateOne({ _id: MODEL_ID }, { $set: doc }, { upsert: true })
  await db.collection('next_session_prediction_models').createIndex({ updated_at: -1 })
  console.log(JSON.stringify({ ok: true, model: doc }, null, 2))
  await mongoose.disconnect()
}

main().catch(async err => {
  console.error(JSON.stringify({ ok: false, error: String(err.message || err) }, null, 2))
  try { await mongoose.disconnect() } catch (_) {}
  process.exit(1)
})
