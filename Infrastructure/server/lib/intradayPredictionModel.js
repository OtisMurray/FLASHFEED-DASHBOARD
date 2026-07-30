const DEFAULT_FEATURE_KEYS = [
  'change_signed_log',
  'change_abs_log',
  'price_log',
  'volume_log',
  'rel_volume_log',
  'market_cap_log',
  'article_count_log',
  'article_sentiment',
  'structured_sentiment',
  'social_count_log',
  'social_density_log',
  'social_sentiment',
  'weighted_sentiment',
  'evidence_score',
  'trade_watch_score',
  'agreement',
  'price_density_correlation',
  'correlation_missing',
  'threshold_pre_return_signed_log',
  'threshold_messages_log',
  'threshold_setup_score',
  'threshold_setup_distance',
  'rsi_centered',
  'gap_signed_log',
  'is_news_catalyst',
  'threshold_entry_ready',
  'regular_session',
  'opening_30m',
  'opening_60m',
  'minute_sin',
  'minute_cos',
]

export const INTRADAY_MODEL_ID = 'trade_watch_direction_v2'
export const INTRADAY_LABEL_VERSION = 'bar_to_bar_5m_v2'
export const INTRADAY_EVALUATION_PROTOCOL = 'purged_chronological_holdout_v2'
export const INTRADAY_FEATURE_KEYS = Object.freeze([...DEFAULT_FEATURE_KEYS])

function finite(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, finite(value)))
}

function signedLog(value, scale = 1) {
  const normalized = finite(value) / Math.max(1e-9, finite(scale, 1))
  return Math.sign(normalized) * Math.log1p(Math.abs(normalized))
}

function logPositive(value) {
  return Math.log1p(Math.max(0, finite(value)))
}

export function marketDateKey(signalSec, timeZone = 'America/New_York') {
  if (!Number.isFinite(Number(signalSec)) || Number(signalSec) <= 0) return ''
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(Number(signalSec) * 1000))
}

function marketClock(signalSec, timeZone = 'America/New_York') {
  if (!Number.isFinite(Number(signalSec)) || Number(signalSec) <= 0) return { hour: 12, minute: 0 }
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(Number(signalSec) * 1000))
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]))
  return { hour: finite(values.hour, 12) % 24, minute: finite(values.minute, 0) }
}

export function transformIntradayFeatures(raw = {}, signalSec = 0, timeZone = 'America/New_York') {
  const correlationValue = raw.price_density_correlation
  const correlation = Number(correlationValue)
  const hasCorrelation = correlationValue != null && correlationValue !== '' && Number.isFinite(correlation)
  const setupScore = finite(raw.threshold_setup_score)
  const setupDistance = finite(raw.threshold_setup_distance_to_entry)
  const rsi = Number(raw.rsi)
  const { hour, minute } = marketClock(signalSec, timeZone)
  const minuteOfDay = hour * 60 + minute
  const sessionMinute = minuteOfDay - (9 * 60 + 30)
  const phase = (minuteOfDay / (24 * 60)) * Math.PI * 2

  return {
    change_signed_log: signedLog(clamp(raw.change_pct, -100, 300), 5),
    change_abs_log: Math.log1p(Math.abs(clamp(raw.change_pct, -100, 300)) / 5),
    price_log: logPositive(clamp(raw.price, 0, 100000)),
    volume_log: logPositive(clamp(raw.volume, 0, 10_000_000_000)),
    rel_volume_log: logPositive(clamp(raw.rel_volume, 0, 1000)),
    market_cap_log: logPositive(clamp(raw.market_cap, 0, 10_000_000_000_000)),
    article_count_log: logPositive(clamp(raw.article_count, 0, 10000)),
    article_sentiment: clamp(raw.article_sentiment, -1, 1),
    structured_sentiment: clamp(raw.structured_sentiment, -1, 1),
    social_count_log: logPositive(clamp(raw.social_count, 0, 1_000_000)),
    social_density_log: logPositive(clamp(raw.social_density_per_minute, 0, 10000)),
    social_sentiment: clamp(raw.social_sentiment, -1, 1),
    weighted_sentiment: clamp(raw.weighted_sentiment, -1, 1),
    evidence_score: clamp(raw.evidence_score, -2, 2),
    trade_watch_score: clamp(raw.trade_watch_score, 0, 1),
    agreement: clamp(raw.agreement, 0, 1),
    price_density_correlation: hasCorrelation ? clamp(correlation, -1, 1) : 0,
    correlation_missing: hasCorrelation ? 0 : 1,
    threshold_pre_return_signed_log: signedLog(clamp(raw.threshold_pre_return_60m_pct, -100, 300), 5),
    threshold_messages_log: logPositive(clamp(raw.threshold_trailing_60m_messages, 0, 1_000_000)),
    threshold_setup_score: clamp(setupScore / 100, -1, 1),
    threshold_setup_distance: clamp(setupDistance / 100, -2, 2),
    rsi_centered: Number.isFinite(rsi) ? clamp((rsi - 50) / 50, -1, 1) : 0,
    gap_signed_log: signedLog(clamp(raw.gap, -100, 300), 5),
    is_news_catalyst: raw.is_news_catalyst ? 1 : 0,
    threshold_entry_ready: raw.threshold_entry_ready || raw.entry_ready ? 1 : 0,
    regular_session: sessionMinute >= 0 && sessionMinute <= 390 ? 1 : 0,
    opening_30m: sessionMinute >= 0 && sessionMinute < 30 ? 1 : 0,
    opening_60m: sessionMinute >= 0 && sessionMinute < 60 ? 1 : 0,
    minute_sin: Math.sin(phase),
    minute_cos: Math.cos(phase),
  }
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
}

function featureStats(rows, keys) {
  return Object.fromEntries(keys.map(key => {
    const values = rows.map(row => finite(row.features?.[key]))
    const avg = mean(values)
    const variance = values.length > 1
      ? values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1)
      : 0
    return [key, { mean: avg, std: Math.sqrt(variance) || 1 }]
  }))
}

function standardize(features, keys, stats) {
  return keys.map(key => {
    const stat = stats[key] || { mean: 0, std: 1 }
    return (finite(features?.[key]) - finite(stat.mean)) / Math.max(1e-9, finite(stat.std, 1))
  })
}

export function sigmoid(value) {
  const bounded = clamp(value, -35, 35)
  return 1 / (1 + Math.exp(-bounded))
}

export function trainLogisticDirectionModel(rows = [], {
  featureKeys = INTRADAY_FEATURE_KEYS,
  l2 = 0.1,
  learningRate = 0.08,
  iterations = 500,
  classBalanced = true,
} = {}) {
  if (!Array.isArray(rows) || rows.length < 2) throw new Error('At least two training rows are required')
  const keys = [...featureKeys]
  const stats = featureStats(rows, keys)
  const matrix = rows.map(row => standardize(row.features, keys, stats))
  const labels = rows.map(row => finite(row.label) > 0 ? 1 : 0)
  const positives = labels.reduce((sum, value) => sum + value, 0)
  const negatives = labels.length - positives
  if (!positives || !negatives) throw new Error('Training rows must contain both directions')
  const positiveWeight = classBalanced ? labels.length / (2 * positives) : 1
  const negativeWeight = classBalanced ? labels.length / (2 * negatives) : 1
  const weights = Array(keys.length).fill(0)
  let intercept = Math.log((positives + 0.5) / (negatives + 0.5))

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const gradient = Array(keys.length).fill(0)
    let interceptGradient = 0
    for (let index = 0; index < matrix.length; index += 1) {
      const vector = matrix[index]
      const label = labels[index]
      const sampleWeight = label ? positiveWeight : negativeWeight
      let score = intercept
      for (let featureIndex = 0; featureIndex < weights.length; featureIndex += 1) {
        score += weights[featureIndex] * vector[featureIndex]
      }
      const error = (sigmoid(score) - label) * sampleWeight
      interceptGradient += error
      for (let featureIndex = 0; featureIndex < weights.length; featureIndex += 1) {
        gradient[featureIndex] += error * vector[featureIndex]
      }
    }
    const rate = learningRate / Math.sqrt(1 + iteration / 50)
    intercept -= rate * interceptGradient / matrix.length
    for (let featureIndex = 0; featureIndex < weights.length; featureIndex += 1) {
      const regularized = gradient[featureIndex] / matrix.length + l2 * weights[featureIndex]
      weights[featureIndex] -= rate * regularized
    }
  }

  return {
    type: 'regularized_logistic_direction_v2',
    feature_keys: keys,
    feature_stats: Object.fromEntries(Object.entries(stats).map(([key, stat]) => [key, {
      mean: Number(stat.mean.toFixed(8)),
      std: Number(stat.std.toFixed(8)),
    }])),
    weights: Object.fromEntries(keys.map((key, index) => [key, Number(weights[index].toFixed(8))])),
    intercept: Number(intercept.toFixed(8)),
    l2: finite(l2),
    iterations,
    learning_rate: finite(learningRate),
    class_counts: { up: positives, down: negatives },
    class_balanced: Boolean(classBalanced),
  }
}

export function predictIntradayDirection(features = {}, classifier = null, probabilityThreshold = null) {
  if (classifier?.type === 'adaboost_stumps_direction_v2') {
    let score = 0
    for (const stump of classifier.stumps || []) {
      const value = finite(features?.[stump.feature])
      const leftPrediction = finite(stump.left_prediction, -1)
      const prediction = value <= finite(stump.threshold) ? leftPrediction : -leftPrediction
      score += finite(stump.alpha) * prediction
    }
    const probabilityUp = sigmoid(2 * score)
    const threshold = clamp(probabilityThreshold ?? classifier.probability_threshold ?? 0.55, 0.5, 0.95)
    const direction = probabilityUp >= threshold ? 'up' : probabilityUp <= 1 - threshold ? 'down' : 'watch'
    return {
      direction,
      probability_up: Number(probabilityUp.toFixed(6)),
      confidence: Number(Math.abs(probabilityUp - 0.5).toFixed(6)),
      score: Number(score.toFixed(6)),
    }
  }
  if (!classifier?.weights || !classifier?.feature_stats) return null
  const keys = classifier.feature_keys || INTRADAY_FEATURE_KEYS
  let score = finite(classifier.intercept)
  for (const key of keys) {
    const stat = classifier.feature_stats[key] || { mean: 0, std: 1 }
    const normalized = (finite(features?.[key]) - finite(stat.mean)) / Math.max(1e-9, finite(stat.std, 1))
    score += finite(classifier.weights[key]) * normalized
  }
  const probabilityUp = sigmoid(score)
  const threshold = clamp(probabilityThreshold ?? classifier.probability_threshold ?? 0.55, 0.5, 0.95)
  const direction = probabilityUp >= threshold ? 'up' : probabilityUp <= 1 - threshold ? 'down' : 'watch'
  return {
    direction,
    probability_up: Number(probabilityUp.toFixed(6)),
    confidence: Number(Math.abs(probabilityUp - 0.5).toFixed(6)),
    score: Number(score.toFixed(6)),
  }
}

function quantileThresholds(values = [], count = 9) {
  const sorted = [...new Set(values.filter(Number.isFinite))].sort((left, right) => left - right)
  if (sorted.length < 2) return []
  const thresholds = []
  for (let index = 1; index <= count; index += 1) {
    const position = Math.floor((index / (count + 1)) * (sorted.length - 1))
    const next = Math.min(sorted.length - 1, position + 1)
    const threshold = (sorted[position] + sorted[next]) / 2
    if (Number.isFinite(threshold) && !thresholds.includes(threshold)) thresholds.push(threshold)
  }
  return thresholds
}

export function trainAdaBoostDirectionModel(rows = [], {
  featureKeys = INTRADAY_FEATURE_KEYS,
  estimators = 30,
  thresholdCount = 9,
  classBalanced = true,
} = {}) {
  if (!Array.isArray(rows) || rows.length < 2) throw new Error('At least two training rows are required')
  const labels = rows.map(row => finite(row.label) > 0 ? 1 : -1)
  const positives = labels.filter(label => label === 1).length
  const negatives = labels.length - positives
  if (!positives || !negatives) throw new Error('Training rows must contain both directions')
  let sampleWeights = labels.map(label => classBalanced
    ? label === 1 ? 1 / (2 * positives) : 1 / (2 * negatives)
    : 1 / labels.length)
  const candidates = []
  for (const feature of featureKeys) {
    const values = rows.map(row => finite(row.features?.[feature]))
    for (const threshold of quantileThresholds(values, thresholdCount)) {
      candidates.push({ feature, threshold, values })
    }
  }
  const stumps = []
  for (let estimator = 0; estimator < estimators; estimator += 1) {
    let best = null
    for (const candidate of candidates) {
      for (const leftPrediction of [-1, 1]) {
        let error = 0
        for (let index = 0; index < labels.length; index += 1) {
          const prediction = candidate.values[index] <= candidate.threshold ? leftPrediction : -leftPrediction
          if (prediction !== labels[index]) error += sampleWeights[index]
        }
        if (!best || error < best.error) best = { ...candidate, leftPrediction, error }
      }
    }
    if (!best || best.error >= 0.499999) break
    const boundedError = clamp(best.error, 1e-9, 1 - 1e-9)
    const alpha = 0.5 * Math.log((1 - boundedError) / boundedError)
    let totalWeight = 0
    for (let index = 0; index < labels.length; index += 1) {
      const prediction = best.values[index] <= best.threshold ? best.leftPrediction : -best.leftPrediction
      sampleWeights[index] *= Math.exp(-alpha * labels[index] * prediction)
      totalWeight += sampleWeights[index]
    }
    sampleWeights = sampleWeights.map(weight => weight / Math.max(1e-12, totalWeight))
    stumps.push({
      feature: best.feature,
      threshold: Number(best.threshold.toFixed(8)),
      left_prediction: best.leftPrediction,
      alpha: Number(alpha.toFixed(8)),
      weighted_error: Number(best.error.toFixed(8)),
    })
  }
  return {
    type: 'adaboost_stumps_direction_v2',
    feature_keys: [...featureKeys],
    stumps,
    estimators: stumps.length,
    class_balanced: Boolean(classBalanced),
    class_counts: { up: positives, down: negatives },
  }
}

export function evaluateDirectionModel(rows = [], classifier = null, probabilityThreshold = null) {
  const evaluated = rows.map(row => {
    const prediction = predictIntradayDirection(row.features, classifier, probabilityThreshold)
    const actual = finite(row.label) > 0 ? 'up' : 'down'
    const actionable = prediction && prediction.direction !== 'watch'
    const correct = actionable ? prediction.direction === actual : null
    const signedReturn = actionable
      ? finite(row.return_pct) * (prediction.direction === 'up' ? 1 : -1)
      : null
    return { ...row, prediction, actual, actionable, correct, signed_return_pct: signedReturn }
  })
  const actionableRows = evaluated.filter(row => row.actionable)
  const positives = evaluated.filter(row => row.actual === 'up')
  const negatives = evaluated.filter(row => row.actual === 'down')
  const upActionable = actionableRows.filter(row => row.actual === 'up')
  const downActionable = actionableRows.filter(row => row.actual === 'down')
  const accuracy = actionableRows.length ? mean(actionableRows.map(row => row.correct ? 1 : 0)) : null
  const upRecall = upActionable.length ? upActionable.filter(row => row.correct).length / upActionable.length : null
  const downRecall = downActionable.length ? downActionable.filter(row => row.correct).length / downActionable.length : null
  const recalls = [upRecall, downRecall].filter(Number.isFinite)
  const majorityBaseline = evaluated.length ? Math.max(positives.length, negatives.length) / evaluated.length : null
  const signedReturns = actionableRows.map(row => finite(row.signed_return_pct))
  const grossProfit = signedReturns.filter(value => value > 0).reduce((sum, value) => sum + value, 0)
  const grossLoss = Math.abs(signedReturns.filter(value => value < 0).reduce((sum, value) => sum + value, 0))
  const brier = evaluated.length
    ? mean(evaluated.map(row => (finite(row.prediction?.probability_up, 0.5) - (row.actual === 'up' ? 1 : 0)) ** 2))
    : null
  return {
    rows: evaluated.length,
    actionable_samples: actionableRows.length,
    coverage: evaluated.length ? actionableRows.length / evaluated.length : 0,
    directional_accuracy_5m: accuracy,
    balanced_accuracy_5m: recalls.length ? mean(recalls) : null,
    up_recall: upRecall,
    down_recall: downRecall,
    up_coverage: positives.length ? upActionable.length / positives.length : 0,
    down_coverage: negatives.length ? downActionable.length / negatives.length : 0,
    up_rows: positives.length,
    down_rows: negatives.length,
    majority_baseline_accuracy_5m: majorityBaseline,
    mean_signed_return_pct: signedReturns.length ? mean(signedReturns) : null,
    median_signed_return_pct: signedReturns.length ? [...signedReturns].sort((a, b) => a - b)[Math.floor(signedReturns.length / 2)] : null,
    profit_factor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? null : 0,
    brier_score: brier,
    evaluated,
  }
}

export function dedupePurgedSignals(rows = [], bucketSeconds = 5 * 60) {
  const sorted = [...rows].sort((a, b) => finite(a.signal_sec) - finite(b.signal_sec) || String(a.ticker).localeCompare(String(b.ticker)))
  const seen = new Set()
  const output = []
  for (const row of sorted) {
    const ticker = String(row.ticker || '').toUpperCase()
    const bucket = Math.floor(finite(row.signal_sec) / bucketSeconds)
    const key = `${ticker}:${bucket}`
    if (!ticker || seen.has(key)) continue
    seen.add(key)
    output.push(row)
  }
  return output
}

export function chronologicalDateSplit(rows = [], {
  validationDates = 1,
  testDates = 1,
  minRowsPerDate = 50,
} = {}) {
  const counts = new Map()
  for (const row of rows) counts.set(row.market_date, (counts.get(row.market_date) || 0) + 1)
  const eligibleDates = [...counts.entries()]
    .filter(([date, count]) => date && count >= minRowsPerDate)
    .map(([date]) => date)
    .sort()
  const heldOutCount = validationDates + testDates
  if (eligibleDates.length <= heldOutCount) {
    throw new Error(`Need more than ${heldOutCount} eligible market dates; found ${eligibleDates.length}`)
  }
  const test = eligibleDates.slice(-testDates)
  const validation = eligibleDates.slice(-(heldOutCount), -testDates)
  const train = eligibleDates.slice(0, -heldOutCount)
  const trainSet = new Set(train)
  const validationSet = new Set(validation)
  const testSet = new Set(test)
  return {
    dates: { train, validation, test },
    train: rows.filter(row => trainSet.has(row.market_date)),
    validation: rows.filter(row => validationSet.has(row.market_date)),
    test: rows.filter(row => testSet.has(row.market_date)),
    excluded: rows.filter(row => !trainSet.has(row.market_date) && !validationSet.has(row.market_date) && !testSet.has(row.market_date)),
    counts_by_date: Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right))),
  }
}

export function promotionDecision(model = null, {
  minActionable = 100,
  minAccuracy = 0.60,
  minBalancedAccuracy = 0.55,
  minBaselineEdge = 0.02,
  minCoverage = 0.10,
  minProfitFactor = 1.05,
} = {}) {
  if (model?.status !== 'trained') return { allow_live_classifier: false, status: model?.status || 'missing', reason: 'model_not_trained' }
  const metrics = model.metrics || {}
  if (metrics.evaluation_protocol !== INTRADAY_EVALUATION_PROTOCOL) {
    return { allow_live_classifier: false, status: 'shadow_invalid_protocol', reason: 'requires_purged_chronological_holdout_v2' }
  }
  if (metrics.outcome_label_version !== INTRADAY_LABEL_VERSION) {
    return { allow_live_classifier: false, status: 'shadow_invalid_labels', reason: 'requires_bar_to_bar_5m_v2_labels' }
  }
  const accuracy = Number(metrics.directional_accuracy_5m)
  const balancedAccuracy = Number(metrics.balanced_accuracy_5m)
  const baseline = Number(metrics.baseline_directional_accuracy_5m)
  const actionable = Number(metrics.actionable_samples || 0)
  const coverage = Number(metrics.coverage || 0)
  const profitFactor = Number(metrics.profit_factor)
  if (actionable < minActionable) return { allow_live_classifier: false, status: 'shadow_insufficient_validation', reason: `needs_at_least_${minActionable}_actionable_test_samples` }
  if (!Number.isFinite(accuracy) || accuracy < minAccuracy) return { allow_live_classifier: false, status: 'shadow_below_required_accuracy', reason: 'test_accuracy_below_required_minimum' }
  if (!Number.isFinite(balancedAccuracy) || balancedAccuracy < minBalancedAccuracy) return { allow_live_classifier: false, status: 'shadow_below_balanced_accuracy', reason: 'test_balanced_accuracy_below_required_minimum' }
  if (!Number.isFinite(baseline) || accuracy < baseline + minBaselineEdge) return { allow_live_classifier: false, status: 'shadow_under_baseline', reason: 'test_accuracy_does_not_beat_majority_baseline' }
  if (coverage < minCoverage) return { allow_live_classifier: false, status: 'shadow_low_coverage', reason: 'test_coverage_below_required_minimum' }
  if (!Number.isFinite(profitFactor) || profitFactor < minProfitFactor) return { allow_live_classifier: false, status: 'shadow_nonpositive_utility', reason: 'test_profit_factor_below_required_minimum' }
  return {
    allow_live_classifier: true,
    status: 'live_validated_edge',
    reason: 'passed_strict_chronological_test_gate',
    edge: Number((accuracy - baseline).toFixed(6)),
  }
}

export function serializableMetrics(metrics = {}) {
  const { evaluated, ...summary } = metrics
  return Object.fromEntries(Object.entries(summary).map(([key, value]) => [
    key,
    Number.isFinite(value) ? Number(value.toFixed(6)) : value,
  ]))
}
