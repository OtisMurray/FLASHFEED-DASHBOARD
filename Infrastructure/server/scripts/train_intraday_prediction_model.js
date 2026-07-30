import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import mongoose from 'mongoose'

import {
  INTRADAY_EVALUATION_PROTOCOL,
  INTRADAY_LABEL_VERSION,
  INTRADAY_MODEL_ID,
  chronologicalDateSplit,
  dedupePurgedSignals,
  evaluateDirectionModel,
  marketDateKey,
  promotionDecision,
  serializableMetrics,
  trainAdaBoostDirectionModel,
  trainLogisticDirectionModel,
  transformIntradayFeatures,
} from '../lib/intradayPredictionModel.js'

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] != null ? process.argv[index + 1] : fallback
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`)
}

function timestampSeconds(value) {
  if (value instanceof Date) return Math.floor(value.getTime() / 1000)
  const number = Number(value)
  if (Number.isFinite(number)) return number > 1e12 ? Math.floor(number / 1000) : Math.floor(number)
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0
}

function firstBarAtOrAfter(bars, targetSec, maxDelaySeconds) {
  for (const bar of bars || []) {
    if (bar.sec < targetSec) continue
    return bar.sec - targetSec <= maxDelaySeconds ? bar : null
  }
  return null
}

async function loadStrictSamples(db, {
  limit = 250000,
  maxDelaySeconds = 90,
  horizonMinutes = 5,
  minAbsoluteReturnPct = 0.05,
  excludeDate = marketDateKey(Math.floor(Date.now() / 1000)),
} = {}) {
  const signalDocs = await db.collection('prediction_signals').find({
    signal_sec: { $type: 'number' },
    ticker: { $exists: true, $nin: ['', null] },
    features: { $exists: true },
  }, {
    projection: {
      _id: 1,
      ticker: 1,
      signal_sec: 1,
      entry_price: 1,
      features: 1,
      'entry_signal.entry_ready': 1,
      'threshold_rule_signal.entry_ready': 1,
    },
  }).sort({ signal_sec: -1 }).limit(limit).toArray()

  const uniqueSignals = dedupePurgedSignals(signalDocs.map(doc => ({
    ...doc,
    ticker: String(doc.ticker || '').toUpperCase(),
    market_date: marketDateKey(doc.signal_sec),
  })).filter(doc => doc.market_date && doc.market_date !== excludeDate))

  const byTicker = new Map()
  for (const doc of uniqueSignals) {
    const current = byTicker.get(doc.ticker) || { min: doc.signal_sec, max: doc.signal_sec, docs: [] }
    current.min = Math.min(current.min, doc.signal_sec)
    current.max = Math.max(current.max, doc.signal_sec)
    current.docs.push(doc)
    byTicker.set(doc.ticker, current)
  }

  const rows = []
  const quality = {
    raw_signals: signalDocs.length,
    deduplicated_signals: uniqueSignals.length,
    excluded_current_date: signalDocs.filter(doc => marketDateKey(doc.signal_sec) === excludeDate).length,
    missing_entry_bar: 0,
    missing_target_bar: 0,
    cross_date_target: 0,
    stale_quote_divergence_over_10pct: 0,
    below_minimum_move: 0,
  }
  for (const [ticker, group] of byTicker.entries()) {
    const barDocs = await db.collection('ohlcv_bars').find({
      ticker,
      $or: [
        { minute: { $gte: group.min - 120, $lte: group.max + horizonMinutes * 60 + 180 } },
        { timestamp: { $gte: group.min - 120, $lte: group.max + horizonMinutes * 60 + 180 } },
      ],
    }, {
      projection: { _id: 0, minute: 1, timestamp: 1, close: 1, source: 1, providerInterval: 1, interval: 1 },
    }).sort({ minute: 1, timestamp: 1 }).toArray()
    const bars = barDocs.map(bar => ({
      sec: timestampSeconds(bar.minute ?? bar.timestamp),
      close: Number(bar.close),
      source: bar.source || null,
      interval: bar.providerInterval || bar.interval || null,
    })).filter(bar => bar.sec > 0 && bar.close > 0).sort((left, right) => left.sec - right.sec)

    for (const doc of group.docs) {
      const entryBar = firstBarAtOrAfter(bars, Number(doc.signal_sec), maxDelaySeconds)
      if (!entryBar) {
        quality.missing_entry_bar += 1
        continue
      }
      const targetSec = Number(doc.signal_sec) + horizonMinutes * 60
      const targetBar = firstBarAtOrAfter(bars, targetSec, maxDelaySeconds)
      if (!targetBar) {
        quality.missing_target_bar += 1
        continue
      }
      const entryDate = marketDateKey(entryBar.sec)
      const targetDate = marketDateKey(targetBar.sec)
      if (entryDate !== targetDate) {
        quality.cross_date_target += 1
        continue
      }
      const staleQuote = Number(doc.entry_price)
      const staleQuoteDivergencePct = staleQuote > 0 ? Math.abs((staleQuote - entryBar.close) / entryBar.close) * 100 : null
      if (staleQuoteDivergencePct != null && staleQuoteDivergencePct > 10) quality.stale_quote_divergence_over_10pct += 1
      const returnPct = ((targetBar.close - entryBar.close) / entryBar.close) * 100
      if (Math.abs(returnPct) < minAbsoluteReturnPct) {
        quality.below_minimum_move += 1
        continue
      }
      const rawFeatures = {
        ...(doc.features || {}),
        threshold_entry_ready: Boolean(doc.entry_signal?.entry_ready || doc.threshold_rule_signal?.entry_ready),
      }
      rows.push({
        signal_id: String(doc._id),
        ticker,
        signal_sec: Number(doc.signal_sec),
        market_date: entryDate,
        entry_bar_sec: entryBar.sec,
        target_bar_sec: targetBar.sec,
        entry_price: entryBar.close,
        target_price: targetBar.close,
        return_pct: returnPct,
        label: returnPct > 0 ? 1 : 0,
        features: transformIntradayFeatures(rawFeatures, Number(doc.signal_sec)),
        label_source: 'mongo_ohlcv_bars',
        outcome_label_version: INTRADAY_LABEL_VERSION,
      })
    }
  }
  quality.strict_samples = rows.length
  return { rows, quality }
}

function selectCandidate(trainRows, validationRows) {
  const candidates = []
  for (const classBalanced of [false, true]) {
    for (const l2 of [0.01, 0.05, 0.1, 0.25, 0.5]) {
      const classifier = trainLogisticDirectionModel(trainRows, { l2, classBalanced })
      for (const threshold of [0.52, 0.54, 0.56, 0.58, 0.60, 0.62, 0.65]) {
        const metrics = evaluateDirectionModel(validationRows, classifier, threshold)
        const accuracy = Number(metrics.directional_accuracy_5m || 0)
        const balanced = Number(metrics.balanced_accuracy_5m || 0)
        const coverage = Number(metrics.coverage || 0)
        const returnScore = Math.max(-1, Math.min(1, Number(metrics.mean_signed_return_pct || 0) / 2))
        const lowSamplePenalty = metrics.actionable_samples < 100 ? 0.2 : 0
        const score = balanced * 0.40 + accuracy * 0.30 + Math.min(0.5, coverage) * 0.20 + returnScore * 0.10 - lowSamplePenalty
        candidates.push({ l2, classBalanced, threshold, score, classifier, metrics })
      }
    }
  }
  for (const classBalanced of [false, true]) {
    const fullClassifier = trainAdaBoostDirectionModel(trainRows, { estimators: 30, classBalanced })
    for (const estimators of [10, 20, 30]) {
      const classifier = { ...fullClassifier, stumps: fullClassifier.stumps.slice(0, estimators), estimators }
      for (const threshold of [0.52, 0.54, 0.56, 0.58, 0.60, 0.62, 0.65]) {
        const metrics = evaluateDirectionModel(validationRows, classifier, threshold)
        const accuracy = Number(metrics.directional_accuracy_5m || 0)
        const balanced = Number(metrics.balanced_accuracy_5m || 0)
        const coverage = Number(metrics.coverage || 0)
        const returnScore = Math.max(-1, Math.min(1, Number(metrics.mean_signed_return_pct || 0) / 2))
        const lowSamplePenalty = metrics.actionable_samples < 100 ? 0.2 : 0
        const score = balanced * 0.40 + accuracy * 0.30 + Math.min(0.5, coverage) * 0.20 + returnScore * 0.10 - lowSamplePenalty
        candidates.push({ algorithm: 'adaboost_stumps_direction_v2', estimators, classBalanced, threshold, score, classifier, metrics })
      }
    }
  }
  return candidates.sort((left, right) => right.score - left.score || right.metrics.actionable_samples - left.metrics.actionable_samples)[0]
}

async function main() {
  const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/feedflash'
  const dbName = arg('db', process.env.MONGODB_DB || 'feedflash')
  const persist = hasFlag('persist')
  const outputPath = path.resolve(arg('output', `/tmp/intraday_prediction_evidence_${Date.now()}.json`))
  await mongoose.connect(mongoUri, { dbName })
  const db = mongoose.connection.db
  const { rows, quality } = await loadStrictSamples(db, {
    limit: Number(arg('limit', 250000)),
    maxDelaySeconds: Number(arg('max-delay-seconds', 90)),
    minAbsoluteReturnPct: Number(arg('min-absolute-return-pct', 0.05)),
  })
  const split = chronologicalDateSplit(rows, {
    validationDates: Number(arg('validation-dates', 1)),
    testDates: Number(arg('test-dates', 1)),
    minRowsPerDate: Number(arg('min-rows-per-date', 50)),
  })
  const candidate = selectCandidate(split.train, split.validation)
  candidate.classifier.probability_threshold = candidate.threshold
  const validationMetrics = evaluateDirectionModel(split.validation, candidate.classifier, candidate.threshold)
  const testMetrics = evaluateDirectionModel(split.test, candidate.classifier, candidate.threshold)
  const model = {
    _id: INTRADAY_MODEL_ID,
    model_id: INTRADAY_MODEL_ID,
    status: 'trained',
    version: Date.now(),
    samples: split.train.length,
    direction_classifier: candidate.classifier,
    metrics: {
      ...serializableMetrics(testMetrics),
      baseline_directional_accuracy_5m: Number(testMetrics.majority_baseline_accuracy_5m?.toFixed(6)),
      evaluation_protocol: INTRADAY_EVALUATION_PROTOCOL,
      outcome_label_version: INTRADAY_LABEL_VERSION,
      evaluated_split: 'untouched_final_test_dates',
    },
    validation_metrics: serializableMetrics(validationMetrics),
    split_dates: split.dates,
    counts_by_date: split.counts_by_date,
    data_quality: quality,
    selected_on_validation: {
      algorithm: candidate.algorithm || candidate.classifier?.type,
      l2: candidate.l2 ?? null,
      estimators: candidate.estimators ?? null,
      class_balanced: candidate.classBalanced,
      probability_threshold: candidate.threshold,
    },
    trained_at: new Date(),
    updated_at: new Date(),
  }
  const promotion = promotionDecision(model)
  model.promotion = promotion
  model.live_eligible = promotion.allow_live_classifier
  const shouldPersist = persist && promotion.allow_live_classifier
  const evidence = {
    generated_at: new Date().toISOString(),
    dry_run: !shouldPersist,
    model,
    validation: serializableMetrics(validationMetrics),
    test: serializableMetrics(testMetrics),
    note: 'Hyperparameters and abstention threshold were selected on validation dates only. Test dates were evaluated once after selection.',
  }
  fs.writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`)
  if (shouldPersist) {
    await db.collection('prediction_models').updateOne({ _id: INTRADAY_MODEL_ID }, { $set: model }, { upsert: true })
  }
  console.log(JSON.stringify({
    model_id: INTRADAY_MODEL_ID,
    persisted: shouldPersist,
    persistence_requested: persist,
    evidence: outputPath,
    quality,
    split_dates: split.dates,
    split_samples: { train: split.train.length, validation: split.validation.length, test: split.test.length },
    selected: model.selected_on_validation,
    validation: serializableMetrics(validationMetrics),
    test: serializableMetrics(testMetrics),
    promotion,
  }, null, 2))
  await mongoose.disconnect()
}

main().catch(async error => {
  console.error(error.stack || error.message || error)
  await mongoose.disconnect().catch(() => {})
  process.exitCode = 1
})
