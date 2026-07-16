#!/usr/bin/env node

const path = require('path')
let mongoose
try {
  mongoose = require(path.join(__dirname, '..', 'Infrastructure', 'server', 'node_modules', 'mongoose'))
} catch (_) {
  mongoose = require(path.join('/app', 'node_modules', 'mongoose'))
}

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

async function fetchJson(url) {
  const response = await fetch(url, { headers: { Accept: 'application/json' } })
  const text = await response.text()
  let body = null
  try { body = text ? JSON.parse(text) : null } catch (_) {}
  if (!response.ok) throw new Error(`${url} HTTP ${response.status}: ${text.slice(0, 500)}`)
  return body
}

function verdict(ok, warn = false) {
  return ok ? 'pass' : warn ? 'warn' : 'fail'
}

function compactCandidate(row = {}) {
  const prediction = row.prediction || {}
  const assessment = row.dashboard_assessment || {}
  const components = assessment.components || {}
  const features = prediction.features || {}
  const riskFlags = Array.isArray(row.risk_flags) ? row.risk_flags : []
  const catalyst = (row.catalysts || [])[0] || null
  const missing = []
  if (!toNumber(row.news_article_count, 0)) missing.push('news')
  if (!toNumber(row.message_count, 0)) missing.push('social')
  if (!toNumber(row.ai_score, 0)) missing.push('ai')
  if (!Number.isFinite(Number(row.correlation_score))) missing.push('correlation')
  if (!row.momentum_context) missing.push('momentum')
  return {
    ticker: row.ticker,
    company: row.company || row.companyName || '',
    score: row.final_prediction_score ?? null,
    signal_quality: row.signal_quality || null,
    predicted_return: row.predicted_return ?? prediction.predictedReturn ?? null,
    confidence: prediction.confidence ?? null,
    probability_up: prediction.probabilityUp ?? null,
    risk_flags: riskFlags,
    sendable: riskFlags.length === 0 && prediction.predictedDirection === 'up',
    evidence: {
      news_articles: toNumber(row.news_article_count, 0),
      social_posts: toNumber(row.message_count, 0),
      social_sentiment: toNumber(row.social_sentiment, 0),
      ai_score: row.ai_score ?? null,
      ai_confidence: row.ai_context?.ai_confidence ?? components.aiConfidence ?? null,
      ai_articles: row.ai_context?.ai_article_count ?? features.ai_article_count ?? null,
      momentum_score: row.momentum_score ?? null,
      correlation_score: row.correlation_score ?? null,
      catalyst_alignment: components.catalystAlignment ?? null,
      filing_sentiment: row.filing_sentiment ?? 0,
      positive_catalyst_gate: Boolean(components.positiveCatalystGate),
    },
    catalyst: catalyst ? {
      type: catalyst.type || null,
      source: catalyst.source || null,
      title: catalyst.title || null,
      sentiment_score: catalyst.sentimentScore ?? null,
      published_at: catalyst.publishedAt ?? null,
    } : null,
    missing_evidence: missing,
  }
}

async function main() {
  const baseUrl = String(argValue('baseUrl', process.env.FLASHFEED_API_BASE_URL || 'http://localhost:3001')).replace(/\/$/, '')
  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI || argValue('mongo', 'mongodb://localhost:27017/feedflash')
  const maxPicks = Math.max(1, Math.min(10, toNumber(argValue('maxPicks', '5'), 5)))
  const recentDays = Math.max(1, Math.min(10, toNumber(argValue('days', '3'), 3)))
  const sinceSec = Math.floor(Date.now() / 1000) - recentDays * 86400

  const urls = {
    health: `${baseUrl}/api/health`,
    sessionModel: `${baseUrl}/api/prediction/session-model`,
    ai: `${baseUrl}/api/ai/rankings?limit=25&days=${recentDays}&window_minutes=4320`,
    high: `${baseUrl}/api/screener?view=high_conviction_next_day&horizon=1d&limit=${maxPicks}&maxPicks=${maxPicks}&require_catalyst_alignment=true`,
    predicted: `${baseUrl}/api/screener?view=predicted_increases&horizon=1d&limit=25&require_catalyst_alignment=true`,
    social: `${baseUrl}/api/social/rolling?window_minutes=4320&limit=25`,
    correlation: `${baseUrl}/api/correlation?limit=25`,
    momentum: `${baseUrl}/api/momentum?limit=25`,
  }

  const api = {}
  for (const [key, url] of Object.entries(urls)) {
    try { api[key] = await fetchJson(url) }
    catch (err) { api[key] = { ok: false, error: String(err.message || err) } }
  }

  await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 10000 })
  const db = mongoose.connection.db
  const [
    articleSources,
    socialSources,
    collectionCounts,
    latestMomentum,
    latestSignal,
  ] = await Promise.all([
    db.collection('articles').aggregate([
      { $match: { $or: [{ publish_date: { $gte: sinceSec } }, { fetched_date: { $gte: sinceSec } }, { detected_at: { $gte: sinceSec } }] } },
      { $group: { _id: '$source', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]).toArray(),
    db.collection('socials').aggregate([
      { $match: { $or: [{ timestamp: { $gte: sinceSec } }, { created_at: { $gte: sinceSec } }, { fetched_at: { $gte: sinceSec } }] } },
      { $group: { _id: { $ifNull: ['$platform', '$source'] }, count: { $sum: 1 }, tickered: { $sum: { $cond: [{ $ne: ['$ticker', null] }, 1, 0] } } } },
      { $sort: { count: -1 } },
    ]).toArray(),
    Promise.all(['articles', 'socials', 'screeners', 'prediction_signals', 'correlations', 'finviz_momentum_snapshots', 'daily_prediction_snapshots', 'prediction_outcomes']
      .map(async name => [name, await db.collection(name).countDocuments()])),
    db.collection('finviz_momentum_snapshots').findOne({}, { sort: { snapshot_sec: -1 } }),
    db.collection('prediction_signals').findOne({}, { sort: { signal_sec: -1 } }),
  ])
  await mongoose.disconnect()

  const highRows = api.high?.rows || api.high?.tickers || []
  const predictedRows = api.predicted?.rows || api.predicted?.tickers || []
  const finalList = highRows.map(compactCandidate)
  const componentHealth = {
    news: {
      status: verdict(articleSources.reduce((sum, row) => sum + row.count, 0) > 100),
      recent_sources: articleSources,
    },
    social: {
      status: verdict(socialSources.reduce((sum, row) => sum + row.count, 0) > 100, socialSources.length > 0),
      recent_platforms: socialSources,
    },
    ai: {
      status: verdict(Boolean(api.ai?.ok && api.ai?.summary?.scored_articles > 0)),
      scored_articles: api.ai?.summary?.scored_articles ?? 0,
      model_status: api.ai?.model?.status || null,
      live_classifier_enabled: Boolean(api.ai?.model?.live_classifier_enabled),
      live_classifier_reason: api.ai?.model?.live_classifier_reason || null,
    },
    momentum: {
      status: verdict(Boolean(api.momentum?.ok && (api.momentum?.rows || []).length || Number(api.momentum?.count || 0) > 0)),
      rows: api.momentum?.count ?? (api.momentum?.rows || []).length ?? 0,
      latest_snapshot_sec: latestMomentum?.snapshot_sec ?? null,
      fallback_counts: api.momentum?.rows ? api.momentum.rows.filter(r => r.momentum_score == null).length : null,
    },
    correlation: {
      status: verdict(Boolean(api.correlation?.summary && api.correlation?.summary?.aligned != null)),
      summary: api.correlation?.summary || null,
      missing_rows: api.correlation?.entries ? api.correlation.entries.filter(row => row.correlation == null).length : null,
    },
    next_session_model: {
      status: api.sessionModel?.model?.status || 'missing',
      live_enabled: Boolean(api.sessionModel?.model?.live_enabled),
      samples: api.sessionModel?.model?.samples ?? 0,
      min_samples: api.sessionModel?.model?.min_samples ?? 0,
      selected: api.sessionModel?.model?.metrics?.selected || null,
      outcome_counts: api.sessionModel?.outcome_counts || null,
    },
    prediction_signals: {
      status: verdict(Boolean(latestSignal?.signal_sec)),
      latest_signal_sec: latestSignal?.signal_sec ?? null,
      latest_signal_at: latestSignal?.signal_at ?? null,
    },
  }

  const warnings = []
  if (!componentHealth.next_session_model.live_enabled) {
    warnings.push('Next-session model is shadow-only; final list is evidence-ranked, not statistically live-validated yet.')
  }
  if (finalList.some(row => row.evidence.social_posts === 0)) {
    warnings.push('Some final picks have no direct social support in the selected window; social pipeline is working globally but not contributing to every pick.')
  }
  if (finalList.some(row => Number(row.evidence.correlation_score || 0) < 0)) {
    warnings.push('At least one final pick has negative correlation context; strict high-conviction gates should exclude meaningful negative correlation.')
  }

  const output = {
    ok: true,
    generated_at: new Date().toISOString(),
    collection_counts: Object.fromEntries(collectionCounts),
    component_health: componentHealth,
    final_list: finalList,
    predicted_watchlist_count: predictedRows.length,
    warnings,
    recommendation: finalList.length
      ? `Send only the ${finalList.length} high-conviction names shown here, with the model-readiness caveat if asked.`
      : 'No high-conviction names pass the current gates; do not force a list.',
  }
  console.log(JSON.stringify(output, null, 2))
}

main().catch(async err => {
  console.error(JSON.stringify({ ok: false, error: String(err.message || err) }, null, 2))
  try { await mongoose.disconnect() } catch (_) {}
  process.exit(1)
})
