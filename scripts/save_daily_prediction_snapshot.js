#!/usr/bin/env node

const path = require('path')
let mongoose
try {
  mongoose = require('mongoose')
} catch (_) {
  mongoose = require(path.join(__dirname, '..', 'Infrastructure', 'server', 'node_modules', 'mongoose'))
}

function argValue(name, fallback = '') {
  const prefix = `--${name}=`
  const inline = process.argv.find(arg => arg.startsWith(prefix))
  if (inline) return inline.slice(prefix.length)
  const index = process.argv.indexOf(`--${name}`)
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1]
  return fallback
}

function toNumber(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function easternParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: process.env.MARKET_WINDOW_TIMEZONE || 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  return Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]))
}

function localDateKey(date = new Date()) {
  const p = easternParts(date)
  return `${String(p.year).padStart(4, '0')}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`
}

function nextTradingDateKey(dateKey) {
  const [year, month, day] = String(dateKey).split('-').map(Number)
  let d = new Date(Date.UTC(year, month - 1, day + 1))
  while ([0, 6].includes(d.getUTCDay())) {
    d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1))
  }
  return d.toISOString().slice(0, 10)
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: 'application/json',
      ...(options.headers || {}),
    },
  })
  const text = await response.text()
  let body = null
  try { body = text ? JSON.parse(text) : null } catch (_) {}
  if (!response.ok) {
    throw new Error(`${url} failed: HTTP ${response.status} ${text.slice(0, 300)}`)
  }
  return body
}

function compactRow(row = {}, rank) {
  const predictedReturn = row.predicted_return ?? row.prediction?.predictedReturn ?? null
  const confidence = row.prediction_confidence ?? row.prediction?.confidence ?? row.fallback_confidence ?? null
  const catalyst = row.main_catalyst || (Array.isArray(row.catalysts) ? row.catalysts[0] : null) || null
  const debug = row.prediction_debug || row.dashboard_assessment?.predictionDebug || {}
  const predictedDirection = String(row.prediction_direction || row.prediction?.predictedDirection || row.fallback_prediction_direction || '').toLowerCase()
    || (Number(predictedReturn) > 0 ? 'up' : Number(predictedReturn) < 0 ? 'down' : 'watch')
  return {
    rank,
    ticker: row.ticker,
    company: row.company || row.companyName || '',
    price: row.price ?? null,
    reference_price: row.price ?? row.prediction?.entry_price ?? row.entry_price ?? null,
    reference_price_source: row.quote_source || row.screener_source || row.source || row.cache_status || null,
    change_pct: row.change_pct ?? null,
    predicted_direction: predictedDirection,
    predicted_percent: predictedReturn,
    predicted_return: predictedReturn,
    prediction_confidence: confidence,
    confidence,
    probability_up: row.prediction?.probabilityUp ?? null,
    final_prediction_score: row.final_prediction_score ?? null,
    model_mode: row.model_mode || row.prediction?.model || row.prediction_debug?.model_mode || null,
    signal_quality: row.signal_quality || null,
    high_conviction: Boolean(row.high_conviction),
    high_conviction_rank: row.high_conviction_rank ?? null,
    high_conviction_tier: row.high_conviction_tier ?? null,
    purchase_confidence_score: row.purchase_confidence_score ?? null,
    evidence_quality_score: row.evidence_quality_score ?? null,
    false_positive_risk_score: row.false_positive_risk_score ?? null,
    why_high_conviction: row.why_high_conviction || [],
    why_not_high_conviction: row.why_not_high_conviction || [],
    missing_evidence_flags: row.missing_evidence_flags || [],
    postmortem_adjustment_reason: row.postmortem_adjustment_reason || null,
    high_conviction_guard: row.high_conviction_guard || null,
    risk_flags: Array.isArray(row.risk_flags) ? row.risk_flags : [],
    prediction_tier: row.prediction_tier || row.prediction_readiness_level || row.prediction_readiness?.level || null,
    prediction_trade_ready: Boolean(row.prediction_trade_ready),
    prediction_readiness_level: row.prediction_readiness_level || row.prediction_readiness?.level || null,
    prediction_readiness_label: row.prediction_readiness_label || row.prediction_readiness?.label || null,
    prediction_waiting_for: row.prediction_waiting_for || row.prediction_readiness?.waiting_for || [],
    prediction_blocked_reasons: row.prediction_blocked_reasons || row.prediction_readiness?.blocked_reasons || [],
    prediction_decision_reason: row.prediction_decision_reason || row.reason_included_detail || null,
    catalyst_quality_score: row.catalyst_quality_score ?? row.catalyst_quality?.score ?? null,
    catalyst_quality_tier: row.catalyst_quality_tier || row.catalyst_quality?.tier || null,
    catalyst_quality: row.catalyst_quality || row.prediction_debug?.catalyst_quality || null,
    pending_open_confirmed: row.pending_open_confirmed ?? row.pending_open_confirmation?.passes ?? null,
    pending_open_payoff_override: row.pending_open_payoff_override ?? row.prediction_debug?.pending_open_payoff_override ?? null,
    pending_open_confirmation: row.pending_open_confirmation || row.prediction_debug?.pending_open_confirmation || null,
    catalyst_reaction_summary: row.catalyst_reaction_summary || row.prediction_debug?.catalyst_reaction_summary || null,
    first_reaction_state: row.catalyst_reaction_summary?.first_reaction_state || row.prediction_debug?.catalyst_reaction_summary?.first_reaction_state || null,
    score_breakdown: row.score_breakdown || row.dashboard_assessment?.scoreBreakdown || null,
    dashboard_assessment: row.dashboard_assessment || null,
    prediction_debug: row.prediction_debug || row.dashboard_assessment?.predictionDebug || null,
    prediction_threshold_policy: row.prediction_threshold_policy || row.threshold_policy || null,
    threshold_policy: row.threshold_policy || row.prediction_threshold_policy || null,
    entry_signal: row.entry_signal || null,
    prediction: row.prediction || null,
    prediction_session: row.prediction?.predictionSession || row.prediction?.prediction_session || row.catalyst_session_context?.session || null,
    prediction_target: row.prediction?.predictionTarget || row.prediction?.prediction_target || row.catalyst_session_context?.next_session_date || null,
    evidence_window_start_sec: row.prediction?.evidenceWindowStartSec || row.prediction?.evidence_window_start_sec || row.catalyst_session_context?.catalyst_window_start_sec || null,
    evidence_window_end_sec: row.prediction?.evidenceWindowEndSec || row.prediction?.evidence_window_end_sec || row.catalyst_session_context?.catalyst_window_end_sec || null,
    evidence_window_hours: row.prediction?.evidenceWindowHours ?? row.prediction?.evidence_window_hours ?? null,
    main_catalyst: row.main_catalyst || null,
    main_catalyst_headline: catalyst?.title || catalyst?.headline || debug.best_structured_catalyst_headline || row.catalyst_summary || null,
    main_catalyst_source: catalyst?.source || debug.best_structured_catalyst_source || null,
    main_catalyst_age_minutes: catalyst?.age_minutes ?? debug.best_structured_catalyst_age_minutes ?? null,
    catalyst_power_score: row.catalyst_power_score ?? row.catalystScore ?? row.catalyst_score ?? null,
    catalyst_window_article_count: row.catalyst_window_article_count ?? null,
    catalyst_session_context: row.catalyst_session_context || null,
    structured_catalyst_type: row.structured_catalyst_type ?? debug.structured_catalyst_type ?? null,
    catalysts: Array.isArray(row.catalysts) ? row.catalysts.slice(0, 5) : [],
    sentiment_breakdown: row.sentiment_breakdown || null,
    ai_score: row.ai_score ?? null,
    ai_context: row.ai_context || null,
    momentum_score: row.momentum_score ?? null,
    momentum_context: row.momentum_context || null,
    correlation_score: row.correlation_score ?? null,
    correlation_context: row.correlation_context || null,
    sec_filing_contributed: Boolean(row.sec_filing_contributed),
    filing_sentiment: row.filing_sentiment ?? null,
    filing_used_count: row.filing_used_count ?? null,
    quote_updated_at: row.quote_updated_at ?? null,
    structured_news_score: row.structured_news_score ?? row.prediction_debug?.structured_news_score ?? null,
    structured_news_available: row.structured_news_available ?? row.prediction_debug?.structured_news_available ?? null,
    structured_catalyst_type: row.structured_catalyst_type ?? row.prediction_debug?.structured_catalyst_type ?? null,
    structured_catalyst_confidence: row.structured_catalyst_confidence ?? row.prediction_debug?.structured_catalyst_confidence ?? null,
    best_structured_catalyst_headline: row.best_structured_catalyst_headline ?? row.prediction_debug?.best_structured_catalyst_headline ?? null,
    short_squeeze_score: row.short_squeeze_score ?? row.prediction_debug?.short_squeeze_score ?? null,
    short_squeeze_available: row.short_squeeze_available ?? row.prediction_debug?.short_squeeze_available ?? null,
    short_squeeze_reason: row.short_squeeze_reason ?? row.prediction_debug?.short_squeeze_reason ?? null,
    squeeze_proxy_used: row.squeeze_proxy_used ?? row.prediction_debug?.squeeze_proxy_used ?? null,
    message_density_trend: row.message_density_trend ?? row.prediction_debug?.message_density_trend ?? null,
    message_density_rising: row.message_density_rising ?? row.prediction_debug?.message_density_rising ?? null,
    message_density_score: row.message_density_score ?? row.prediction_debug?.message_density_score ?? null,
    threshold_policy_version: row.threshold_policy?.policyVersion || row.prediction_threshold_policy?.policyVersion || row.entry_signal?.policy_version || null,
    threshold_status: row.entry_signal?.status || row.threshold_policy?.status || row.prediction_threshold_policy?.status || null,
    threshold_setup_status: row.entry_signal?.setup_status || row.threshold_setup_status || row.threshold_policy?.setupStatus || row.prediction_threshold_policy?.setupStatus || null,
    threshold_setup_score: row.entry_signal?.setup_score ?? row.threshold_setup_score ?? row.threshold_policy?.setupScore ?? row.prediction_threshold_policy?.setupScore ?? null,
    threshold_setup_reason: row.entry_signal?.setup_reason || row.threshold_policy?.setupReason || row.prediction_threshold_policy?.setupReason || null,
    price_density_correlation: row.price_density_correlation ?? row.threshold_policy?.correlation ?? row.prediction_threshold_policy?.correlation ?? null,
    previous_price_density_correlation: row.previous_price_density_correlation ?? row.threshold_policy?.previousCorrelation ?? row.prediction_threshold_policy?.previousCorrelation ?? null,
    threshold_pre_return_60m_pct: row.threshold_pre_return_60m_pct ?? row.threshold_policy?.preSignalReturn60mPct ?? row.prediction_threshold_policy?.preSignalReturn60mPct ?? null,
    threshold_trailing_60m_messages: row.threshold_trailing_60m_messages ?? null,
    threshold_entry_ready: Boolean(row.entry_signal?.entry_ready || row.threshold_policy?.passed || row.prediction_threshold_policy?.passed),
    realized_return_pct: null,
    realized_price: null,
    realized_at: null,
    outcome_status: 'pending',
  }
}

function isRealPredictionRow(row = {}) {
  const predictedReturn = row.predicted_return ?? row.prediction?.predictedReturn ?? null
  const direction = String(row.prediction_direction || row.prediction?.predictedDirection || '').toLowerCase()
  const sourceCode = String(row.prediction_source_code || row.prediction?.model || row.model_mode || '').toLowerCase()
  const isPredictionSource = sourceCode.includes('stored') ||
    sourceCode.includes('live') ||
    sourceCode.includes('threshold') ||
    sourceCode.includes('evidence_next_session')
  return !Boolean(row.isFallback || row.is_fallback) &&
    isPredictionSource &&
    predictedReturn != null &&
    Number.isFinite(Number(predictedReturn)) &&
    (direction === 'up' || direction === 'down')
}

function isStrictHighConvictionRow(row = {}) {
  return isRealPredictionRow(row) &&
    Boolean(row.high_conviction) &&
    !Boolean(row.high_conviction_fallback)
}

function uniqueByTicker(rows = []) {
  const seen = new Set()
  const out = []
  for (const row of rows) {
    const ticker = String(row?.ticker || '').toUpperCase()
    if (!ticker || seen.has(ticker)) continue
    seen.add(ticker)
    out.push(row)
  }
  return out.map((row, index) => ({ ...row, rank: index + 1 }))
}

async function main() {
  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI || argValue('mongo', 'mongodb://localhost:27017/feedflash')
  const baseUrl = String(argValue('baseUrl', process.env.FLASHFEED_API_BASE_URL || 'http://localhost:3001')).replace(/\/$/, '')
  const horizon = argValue('horizon', '1d')
  const maxRaw = Math.max(1, Math.min(250, toNumber(argValue('maxRaw', '50'), 50)))
  const maxHighConviction = Math.max(1, Math.min(10, toNumber(argValue('maxHighConviction', '5'), 5)))
  const days = Math.max(1, Math.min(14, toNumber(argValue('days', '4'), 4)))
  const retentionDays = Math.max(1, Math.min(365, toNumber(argValue('retentionDays', process.env.PREDICTION_ARCHIVE_RETENTION_DAYS || '90'), 90)))
  const pruneOldSnapshots = ['1', 'true', 'yes'].includes(String(argValue('pruneOldSnapshots', process.env.PREDICTION_ARCHIVE_PRUNE || 'false')).toLowerCase())
  const tag = argValue('tag', 'daily')
  const generatedAt = new Date()
  const dateKey = argValue('dateKey', localDateKey(generatedAt))
  const predictedForDate = argValue('predictedForDate', nextTradingDateKey(dateKey))
  const snapshotId = `${dateKey}:${horizon}:${tag}`

  const snapshotEndpoint = new URL(`${baseUrl}/api/prediction/snapshot`)
  snapshotEndpoint.searchParams.set('limit', String(Math.max(maxRaw, 250)))
  snapshotEndpoint.searchParams.set('window_minutes', argValue('window_minutes', '60'))

  const rawEndpoint = new URL(`${baseUrl}/api/screener`)
  rawEndpoint.searchParams.set('view', 'predicted_increases')
  rawEndpoint.searchParams.set('horizon', horizon)
  rawEndpoint.searchParams.set('limit', String(Math.max(maxRaw, 250)))
  rawEndpoint.searchParams.set('maxPicks', String(maxRaw))
  rawEndpoint.searchParams.set('days', String(days))
  rawEndpoint.searchParams.set('require_catalyst_alignment', 'true')

  const highEndpoint = new URL(`${baseUrl}/api/screener`)
  highEndpoint.searchParams.set('view', 'high_conviction_next_day')
  highEndpoint.searchParams.set('horizon', horizon)
  highEndpoint.searchParams.set('limit', String(maxHighConviction))
  highEndpoint.searchParams.set('days', String(days))
  highEndpoint.searchParams.set('maxPicks', String(maxHighConviction))
  highEndpoint.searchParams.set('requireTrue1d', 'true')
  highEndpoint.searchParams.set('requireCatalyst', 'true')
  highEndpoint.searchParams.set('require_catalyst_alignment', 'true')
  highEndpoint.searchParams.set('minFinalScore', argValue('minFinalScore', '52'))
  highEndpoint.searchParams.set('minConfidence', argValue('minConfidence', '0.45'))
  highEndpoint.searchParams.set('minPredictedReturn', argValue('minPredictedReturn', '0.15'))

  const [modelSnapshot, raw, highConviction] = await Promise.all([
    fetchJson(snapshotEndpoint, { method: 'POST' }),
    fetchJson(rawEndpoint),
    fetchJson(highEndpoint),
  ])

  const rawSourceRows = (raw.rows || raw.tickers || [])
  const rawWatchSourceRows = rawSourceRows.length ? rawSourceRows : (raw.fallbackRows || [])
  const rawRows = uniqueByTicker(rawWatchSourceRows.slice(0, maxRaw).map((row, index) => compactRow(row, index + 1)))
  const setupSourceRows = (raw.fallbackRows || rawSourceRows || [])
    .filter(row => ['entry_passed', 'active_setup_already_above_threshold', 'near_threshold_setup'].includes(row?.entry_signal?.setup_status || row?.threshold_setup_status || ''))
  const thresholdSetupRows = setupSourceRows
    .slice(0, 50)
    .map((row, index) => compactRow(row, index + 1))
  const highRowsRaw = (highConviction.rows || highConviction.tickers || [])
    .map((row, index) => compactRow(row, index + 1))
    .filter(isStrictHighConvictionRow)
  const highRows = uniqueByTicker(highRowsRaw).slice(0, maxHighConviction)

  await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 10000 })
  const db = mongoose.connection.db
  const doc = {
    _id: snapshotId,
    snapshot_id: snapshotId,
    date_key: dateKey,
    prediction_date_key: dateKey,
    predicted_for_date: predictedForDate,
    trading_date_predicted_for: predictedForDate,
    tag,
    horizon,
    generated_at: generatedAt,
    generated_at_sec: Math.floor(generatedAt.getTime() / 1000),
    api_base_url: baseUrl,
    raw_endpoint: rawEndpoint.toString(),
    high_conviction_endpoint: highEndpoint.toString(),
    model_snapshot_endpoint: snapshotEndpoint.toString(),
    raw_rows: rawRows,
    threshold_setup_rows: thresholdSetupRows,
    high_conviction_rows: highRows,
    raw_count: rawRows.length,
    threshold_setup_count: thresholdSetupRows.length,
    high_conviction_count: highRows.length,
    threshold_setup_summary: {
      active_setup_already_above_threshold: thresholdSetupRows.filter(row => row.threshold_setup_status === 'active_setup_already_above_threshold').length,
      near_threshold_setup: thresholdSetupRows.filter(row => row.threshold_setup_status === 'near_threshold_setup').length,
      entry_passed: thresholdSetupRows.filter(row => row.threshold_setup_status === 'entry_passed').length,
      note: 'Threshold setup rows are archived for review only; they are not stored next-day predictions unless threshold_entry_ready is true and a real predicted return/direction exists.',
    },
    raw_summary: raw.summary || null,
    raw_source_mode: rawSourceRows.length ? 'real_prediction_rows' : 'fallback_watch_candidates',
    high_conviction_summary: {
      ...(highConviction.summary || {}),
      strict_entry_ready_count: highRows.length,
      excluded_watch_rows: Math.max(0, (highConviction.rows || highConviction.tickers || []).length - highRows.length),
    },
    prediction_session_context: raw.prediction_session_context || highConviction.prediction_session_context || null,
    prediction_gate_defaults: {
      raw: raw.prediction_gate_defaults || null,
      high_conviction: highConviction.prediction_gate_defaults || null,
    },
    model_snapshot: {
      labels: modelSnapshot.labels || null,
      snapshot_saved: modelSnapshot.snapshot?.saved ?? null,
      model: modelSnapshot.model || null,
    },
    note: highRows.length
      ? 'High conviction rows passed strict gates at snapshot time.'
      : 'No high-conviction picks passed strict improved threshold gates at snapshot time; raw_rows are watchlist candidates only.',
    archive_schema_version: 3,
    updated_at: generatedAt,
  }

  await db.collection('daily_prediction_snapshots').updateOne(
    { _id: snapshotId },
    { $set: doc, $setOnInsert: { created_at: generatedAt } },
    { upsert: true }
  )

  await db.collection('daily_prediction_snapshots').createIndex({ date_key: -1, horizon: 1, tag: 1 })
  await db.collection('daily_prediction_snapshots').createIndex({ predicted_for_date: -1, horizon: 1, tag: 1 })
  await db.collection('daily_prediction_snapshots').createIndex({ generated_at: -1 })
  await db.collection('daily_prediction_snapshots').createIndex({ tag: 1, horizon: 1, date_key: -1 })

  let deletedOldSnapshots = 0
  if (pruneOldSnapshots) {
    const archiveDocs = await db.collection('daily_prediction_snapshots')
      .find({ tag, horizon }, { projection: { _id: 1, date_key: 1, generated_at: 1 } })
      .sort({ date_key: -1, generated_at: -1 })
      .toArray()
    const retainedDates = new Set()
    const keepIds = []
    for (const item of archiveDocs) {
      const key = item.date_key || (item.generated_at ? new Date(item.generated_at).toISOString().slice(0, 10) : String(item._id).split(':')[0])
      if (!retainedDates.has(key) && retainedDates.size >= retentionDays) continue
      retainedDates.add(key)
      keepIds.push(item._id)
    }
    if (keepIds.length) {
      const retentionResult = await db.collection('daily_prediction_snapshots').deleteMany({
        tag,
        horizon,
        _id: { $nin: keepIds },
      })
      deletedOldSnapshots = retentionResult.deletedCount || 0
    }
  }

  console.log(JSON.stringify({
    ok: true,
    snapshot_id: snapshotId,
    raw_count: rawRows.length,
    high_conviction_count: highRows.length,
    threshold_setup_count: thresholdSetupRows.length,
    top_raw: rawRows.slice(0, 8).map(row => ({
      rank: row.rank,
      ticker: row.ticker,
      predicted_return: row.predicted_return,
      score: row.final_prediction_score,
      quality: row.signal_quality,
      risk_flags: row.risk_flags,
    })),
    top_high_conviction: highRows.map(row => ({
      rank: row.rank,
      ticker: row.ticker,
      predicted_return: row.predicted_return,
      score: row.final_prediction_score,
      quality: row.signal_quality,
      risk_flags: row.risk_flags,
    })),
    top_threshold_setups: thresholdSetupRows.slice(0, 8).map(row => ({
      rank: row.rank,
      ticker: row.ticker,
      setup_status: row.threshold_setup_status,
      setup_score: row.threshold_setup_score,
      corr: row.price_density_correlation,
      previous_corr: row.previous_price_density_correlation,
      pre60: row.threshold_pre_return_60m_pct,
      entry_ready: row.threshold_entry_ready,
    })),
    note: doc.note,
    retention_days: retentionDays,
    pruning_enabled: pruneOldSnapshots,
    deleted_old_snapshots: deletedOldSnapshots,
  }, null, 2))

  await mongoose.disconnect()
}

main().catch(async err => {
  console.error(JSON.stringify({ ok: false, error: String(err.message || err) }, null, 2))
  try { await mongoose.disconnect() } catch (_) {}
  process.exit(1)
})
