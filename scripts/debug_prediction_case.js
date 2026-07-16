#!/usr/bin/env node
const path = require('path')
const mongoose = require(path.join(__dirname, '..', 'Infrastructure', 'server', 'node_modules', 'mongoose'))

function argValue(name, fallback = '') {
  const direct = process.argv.find(arg => arg.startsWith(`--${name}=`))
  if (direct) return direct.slice(name.length + 3)
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] || fallback : fallback
}

function seconds(value) {
  if (!value) return 0
  if (value instanceof Date) return Math.floor(value.getTime() / 1000)
  const n = Number(value)
  if (Number.isFinite(n) && n > 0) return n > 1_000_000_000_000 ? Math.floor(n / 1000) : Math.floor(n)
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0
}

function iso(sec) {
  return sec ? new Date(sec * 1000).toISOString() : null
}

function mountain(sec) {
  if (!sec) return null
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Denver',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'short',
  }).format(new Date(sec * 1000))
}

function tickerRegex(ticker) {
  return new RegExp(`(^|,)\\s*${ticker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*(,|$)`, 'i')
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function candidateTickersFromArticle(row = {}) {
  const candidates = new Set()
  for (const part of String(row.ticker || '').split(',')) {
    const t = part.trim().toUpperCase()
    if (t) candidates.add(t)
  }
  for (const field of ['tickers', 'matched_mover_tickers', 'tickers_mentioned']) {
    const values = Array.isArray(row[field]) ? row[field] : []
    for (const value of values) {
      const t = String(value || '').trim().toUpperCase()
      if (t) candidates.add(t)
    }
  }
  return candidates
}

function normalizedWords(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function companyAliases(company = '') {
  const normalized = normalizedWords(company)
  if (!normalized) return []
  const stripped = normalized
    .replace(/\b(incorporated|inc|corp|corporation|co|company|plc|ltd|limited|adr|class a|common stock)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const aliases = new Set([normalized, stripped].filter(value => value && value.length >= 3))
  const words = stripped.split(' ').filter(Boolean)
  if (words.length >= 2) aliases.add(words.slice(0, 2).join(' '))
  if (words[0] && words[0].length >= 5) aliases.add(words[0])
  return Array.from(aliases).filter(value => value.length >= 3)
}

function articleLooksRelevantForTicker(row = {}, ticker = '', company = '') {
  const wanted = String(ticker || '').toUpperCase()
  if (!wanted) return false
  const candidates = candidateTickersFromArticle(row)
  if (!candidates.has(wanted)) return false
  if (wanted.length > 1) return true
  const title = String(row.title || '')
  const text = normalizedWords([
    row.title,
    row.summary,
    row.description,
    row.contentText,
    row.content_text,
    row.content,
    row.url,
  ].join(' '))
  if (companyAliases(company).some(alias => text.includes(alias))) return true
  if (new RegExp(`^\\s*\\$?${escapeRegExp(wanted)}\\s*:`, 'i').test(title)) return true
  if (new RegExp(`\\b${escapeRegExp(wanted)}\\s+(stock|shares|equity)\\b`, 'i').test(title)) return true
  return false
}

function isSecFiling(row = {}) {
  return Boolean(
    row.is_sec_filing ||
    row.isFiling ||
    row.source_type === 'filing' ||
    /sec|edgar/i.test(String(row.source || '')) ||
    /filings?/i.test(String(row.category || '')) ||
    String(row.event_type || '').toLowerCase() === 'sec_filing'
  )
}

function contentLength(row = {}) {
  return Math.max(
    String(row.contentText || '').length,
    String(row.content_text || '').length,
    String(row.content || '').length,
    String(row.summary || '').length
  )
}

function canonicalPrediction(row = {}, horizon = '1d') {
  if (!row) return null
  const active = row.model_signal || row.baseline_signal || null
  if (!active) return null
  const predictedReturn = Number(
    active.predicted_return_1d ??
    active.predicted_return_next_day ??
    active.predicted_return_60m ??
    active.predicted_return_5m
  )
  const signalSec = seconds(row.signal_sec || row.signal_at)
  const supported = Boolean(active.predicted_return_1d ?? active.predicted_return_next_day)
  return {
    signalId: row.signal_id || row._id || null,
    source: row.source || null,
    requestedHorizon: horizon,
    storedHorizonsMinutes: row.horizons_minutes || [],
    horizonSupported: horizon !== '1d' || supported,
    warning: horizon === '1d' && !supported ? 'No true 1d/next-day prediction field exists on this signal; this is not proof of a next-day prediction.' : null,
    signalSec,
    signalAtUtc: iso(signalSec),
    signalAtMountain: mountain(signalSec),
    direction: active.direction || null,
    predictedReturn: Number.isFinite(predictedReturn) ? Number(predictedReturn.toFixed(3)) : null,
    confidence: active.confidence ?? null,
    probabilityUp: active.probability_up ?? null,
    model: active.model || null,
    modelVersion: active.model_version || null,
    decision: row.decision || row.trade_watch?.decision || null,
    features: row.features || null,
    tradeWatch: row.trade_watch || null,
    labelStatus: row.label_status || null,
  }
}

function computeFinalScore(prediction, momentumScore, aiScore, correlationScore, catalysts, filings) {
  if (!prediction) return { finalPredictionScore: 0, signalQuality: 'insufficient_evidence', scoreBreakdown: {} }
  const modelScore = prediction.confidence != null ? prediction.confidence * 100 : 0
  const confidenceScore = prediction.confidence != null ? Math.round(prediction.confidence * 100) : 0
  const momentumVal = momentumScore?.momentum_score ?? 0
  const aiVal = aiScore?.ai_numeric_rank ?? 0
  const correlationVal = correlationScore?.avg_abs_correlation ?? 0
  const newsSentVal = catalysts.filter(c => !c.isSecFiling).reduce((sum, c) => sum + Math.abs(c.sentimentScore || 0), 0) / Math.max(1, catalysts.filter(c => !c.isSecFiling).length)
  const filingSentVal = filings.some(f => f.usedInSentiment && f.contentCharLength >= 200) ? 0.5 : 0
  const catalystScore = Math.min(1, catalysts.length / 5)
  const proxyPenalty = prediction.warning ? 0.3 : 0
  const score = Math.round(Math.min(100, Math.max(0,
    modelScore * 0.30 +
    confidenceScore * 0.15 +
    momentumVal * 10 * 0.12 +
    aiVal * 10 * 0.10 +
    correlationVal * 10 * 0.08 +
    newsSentVal * 30 * 0.10 +
    filingSentVal * 30 * 0.08 +
    catalystScore * 10 * 0.07 -
    proxyPenalty * 100
  )))
  let signalQuality = 'insufficient_evidence'
  if (!prediction.warning && prediction.direction === 'up' && prediction.confidence >= 0.60 && score >= 70 && catalysts.length >= 1) {
    signalQuality = 'high_quality'
  } else if (prediction.confidence >= 0.35 && score >= 50 && catalysts.length >= 1) {
    signalQuality = 'medium_quality'
  } else if (prediction.confidence >= 0.10 && score >= 30) {
    signalQuality = 'low_quality'
  } else if (prediction.warning) {
    signalQuality = 'proxy_only'
  }
  return {
    finalPredictionScore: score,
    signalQuality,
    scoreBreakdown: {
      modelScore: Math.round(modelScore),
      confidenceScore,
      momentumScore: Math.round(momentumVal * 100) / 100,
      aiScore: Math.round(aiVal * 100) / 100,
      correlationScore: Math.round(correlationVal * 100) / 100,
      newsSentimentScore: Math.round(newsSentVal * 100) / 100,
      filingSentimentScore: Math.round(filingSentVal * 100) / 100,
      catalystScore: Math.round(catalystScore * 100) / 100,
      proxyPenalty: Math.round(proxyPenalty * 100) / 100,
    },
  }
}

function conclusionFor(ticker, prediction, filings, momentumScore, aiScore, correlationScore, catalysts) {
  const warnings = []
  if (!prediction) {
    warnings.push(`No stored prediction_signals row exists for ${ticker}.`)
  } else if (prediction.warning) {
    warnings.push(prediction.warning)
  }
  const realFilings = filings.filter(f => f.contentCharLength >= 200)
  if (!filings.length) warnings.push(`No SEC filing rows found for ${ticker} in the database query.`)
  if (filings.length && !realFilings.length) warnings.push('SEC filing rows exist only as weak/no-content records, so they should not strongly affect sentiment.')
  const used = filings.some(f => f.usedInSentiment)
  if (filings.length && !used) warnings.push('No SEC filing appears to have been used as real filing sentiment.')

  const finalScore = computeFinalScore(prediction, momentumScore, aiScore, correlationScore, catalysts, filings)
  const isTrueModel = prediction && !prediction.warning
  const hasFilingContent = realFilings.length > 0 && used
  const hasCatalysts = catalysts.length > 0
  const hasMomentum = momentumScore && Math.abs(momentumScore.momentum_score || 0) >= 0.3
  const hasSentiment = catalysts.some(c => Math.abs(c.sentimentScore || 0) >= 0.3)

  let verdict = 'INSUFFICIENT_DATA'
  let summary = ''
  if (!prediction) {
    verdict = 'INSUFFICIENT_DATA'
    summary = `No prediction signal found for ${ticker}. Cannot verify claim.`
  } else if (prediction.direction === 'up' && isTrueModel && prediction.confidence >= 0.60 && hasFilingContent && hasCatalysts) {
    verdict = 'CONFIRMED'
    summary = `Stored data shows true 1d model predicting UP for ${ticker} with confidence ${Math.round(prediction.confidence * 100)}% and usable SEC filing content.`
  } else if (prediction.direction === 'up' && isTrueModel && prediction.confidence >= 0.35) {
    verdict = 'PARTIALLY_SUPPORTED'
    summary = `True 1d model predicts UP for ${ticker} (confidence ${Math.round(prediction.confidence * 100)}%), but supporting evidence from SEC filings/catalysts is limited.`
  } else if (prediction.direction === 'up' && prediction.warning) {
    verdict = 'NO_TRUE_1D_MODEL'
    summary = `Signal exists but is a ${prediction.requestedHorizon || 'shorter-horizon'} proxy, not a true next-day prediction.`
  } else if (prediction.direction !== 'up') {
    verdict = 'NOT_SUPPORTED'
    summary = `Prediction direction is "${prediction.direction}", not UP.`
  } else {
    verdict = 'INSUFFICIENT_DATA'
    summary = `Cannot determine if ${ticker} is predicted up tomorrow from available data.`
  }

  return {
    verdict,
    summary,
    finalPredictionScore: finalScore.finalPredictionScore,
    signalQuality: finalScore.signalQuality,
    scoreBreakdown: finalScore.scoreBreakdown,
    supportsClaim: verdict === 'CONFIRMED',
    warnings,
  }
}

async function main() {
  const tickers = argValue('tickers', 'S,VRDN,GME')
    .split(',')
    .map(t => t.trim().toUpperCase())
    .filter(Boolean)
  const horizon = argValue('horizon', '1d').toLowerCase()
  const mongoUri = process.env.MONGO_URI || 'mongodb://localhost:27017/feedflash'

  await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 8000 })
  const db = mongoose.connection.db
  const output = {
    generatedAtUtc: new Date().toISOString(),
    horizon,
    database: db.databaseName,
    tickers: [],
  }

  for (const ticker of tickers) {
    const [screener, predictionRows, catalystRows, secRows, correlationRows] = await Promise.all([
      db.collection('screeners').findOne({ ticker }),
      db.collection('prediction_signals').find({ ticker }).sort({ signal_sec: -1, rank: 1 }).limit(5).toArray(),
      db.collection('articles').find({
        $and: [
          { $or: [{ ticker: { $regex: tickerRegex(ticker) } }, { tickers: ticker }, { matched_mover_tickers: ticker }, { tickers_mentioned: ticker }] },
          { $or: [{ event_type: { $ne: 'sec_filing' } }, { source: { $not: /SEC|EDGAR/i } }] },
        ],
      }, { projection: { title: 1, source: 1, url: 1, ticker: 1, tickers: 1, matched_mover_tickers: 1, tickers_mentioned: 1, summary: 1, content: 1, contentText: 1, content_text: 1, sentiment: 1, sentiment_score: 1, ml_confidence: 1, event_type: 1, publish_date: 1, fetched_date: 1, detected_at: 1 } }).sort({ publish_date: -1, fetched_date: -1, detected_at: -1 }).limit(50).toArray(),
      db.collection('articles').find({
        $and: [
          { $or: [{ ticker: { $regex: tickerRegex(ticker) } }, { tickers: ticker }, { matched_mover_tickers: ticker }, { tickers_mentioned: ticker }] },
          { $or: [{ source: { $regex: 'SEC|EDGAR', $options: 'i' } }, { is_sec_filing: true }, { isFiling: true }, { event_type: 'sec_filing' }, { category: 'filings' }, { source_type: 'filing' }] },
        ],
      }).sort({ publish_date: -1, fetched_date: -1, detected_at: -1 }).limit(50).toArray(),
      db.collection('correlations').findOne({ ticker }),
    ])

    const latestPrediction = canonicalPrediction(predictionRows[0], horizon)
    const company = screener?.company || ''
    const relevantCatalystRows = catalystRows.filter(row => articleLooksRelevantForTicker(row, ticker, company)).slice(0, 8)
    const relevantSecRows = secRows.filter(row => articleLooksRelevantForTicker(row, ticker, company)).slice(0, 20)
    const filings = relevantSecRows.map(row => {
      const acceptedSec = seconds(row.acceptedAt || row.accepted_at || row.publish_date || row.fetched_date || row.detected_at)
      const len = contentLength(row)
      const explicitUsedInSentiment = row.filingUsedInSentiment ?? row.filing_used_in_sentiment
      return {
        articleId: row.article_id || row._id || null,
        accessionNumber: row.accessionNumber || row.accession_number || null,
        formType: row.formType || row.form_type || null,
        filingType: row.filingCategory || row.event_type || row.category || null,
        source: row.source || null,
        title: row.title || null,
        acceptedAtUtc: iso(acceptedSec),
        acceptedAtMountain: mountain(acceptedSec),
        publishedAtUtc: iso(seconds(row.publish_date)),
        fetchedAtUtc: iso(seconds(row.fetched_date)),
        filingUrl: row.secUrl || row.url || null,
        primaryDocumentUrl: row.primaryDocumentUrl || row.primary_document_url || null,
        contentCharLength: len,
        contentStatus: row.filingContentStatus || row.content_status || (len >= 200 ? 'content_extracted' : 'missing_or_weak'),
        contentUsedInSentiment: explicitUsedInSentiment == null
          ? Boolean(row.filing_sentiment_input_type === 'content' || len >= 200)
          : Boolean(explicitUsedInSentiment),
        usedInSentiment: explicitUsedInSentiment == null
          ? Boolean(len >= 200 && row.sentiment && row.sentiment !== 'neutral')
          : Boolean(explicitUsedInSentiment),
        filingSentimentScore: row.filingSentiment ?? row.filing_sentiment ?? row.sentiment_score ?? (row.sentiment === 'bullish' ? row.ml_confidence : row.sentiment === 'bearish' ? -row.ml_confidence : 0),
        filingSentimentConfidence: row.filingSentimentConfidence ?? row.filing_sentiment_confidence ?? row.ml_confidence ?? null,
        filingImpactWeight: row.filingImpactWeight ?? row.filing_impact_weight ?? null,
      }
    })

    const catalysts = relevantCatalystRows.map(row => ({
      title: row.title || null,
      source: row.source || null,
      type: row.event_type || null,
      url: row.url || null,
      publishedAtUtc: iso(seconds(row.publish_date || row.fetched_date || row.detected_at)),
      sentiment: row.sentiment || null,
      sentimentScore: row.sentiment_score ?? (row.sentiment === 'bullish' ? row.ml_confidence : row.sentiment === 'bearish' ? -row.ml_confidence : 0),
    }))

    // Momentum is derived from screener row's change_pct + volume data
    const momentumScore = screener ? {
      momentum_score: Math.abs(Number(screener.change_pct || 0)) / 10,
      change_pct: screener.change_pct ?? null,
      rel_volume: screener.rel_volume ?? null,
      volume: screener.volume ?? null,
    } : null
    // AI score is computed on-the-fly from article data (no dedicated collection)
    const aiScore = null
    const correlationScore = correlationRows?.[0] || null

    output.tickers.push({
      ticker,
      screener: screener ? {
        company: screener.company || null,
        exchange: screener.exchange || null,
        price: screener.price ?? null,
        changePercent: screener.change_pct ?? screener.change_percent ?? null,
        quoteUpdatedAtUtc: iso(seconds(screener.quote_updated_at || screener.quote_time)),
      } : null,
      latestPrediction,
      predictionCount: predictionRows.length,
      catalysts,
      rawCatalystMatchesBeforeRelevanceFilter: catalystRows.length,
      rawSecMatchesBeforeRelevanceFilter: secRows.length,
      secFilingsFound: filings.length,
      secFilings: filings,
      momentum: momentumScore ? {
        momentum_score: momentumScore.momentum_score ?? null,
        change_pct: momentumScore.change_pct ?? null,
        rel_volume: momentumScore.rel_volume ?? null,
        article_count: momentumScore.article_count ?? null,
        message_count: momentumScore.message_count ?? null,
      } : null,
      aiScore: aiScore ? {
        ai_numeric_rank: aiScore.ai_numeric_rank ?? null,
        ai_label: aiScore.ai_label ?? null,
      } : null,
      correlation: correlationScore ? {
        avg_abs_correlation: correlationScore.avg_abs_correlation ?? null,
        pearson_correlation: correlationScore.pearson_correlation ?? null,
        signal_score: correlationScore.signal_score ?? null,
        direction: correlationScore.direction ?? null,
      } : null,
      conclusion: conclusionFor(ticker, latestPrediction, filings, momentumScore, aiScore, correlationScore, catalysts),
    })
  }

  console.log(JSON.stringify(output, null, 2))
  await mongoose.disconnect()
}

main().catch(async err => {
  console.error(JSON.stringify({ ok: false, error: String(err.message || err) }, null, 2))
  try { await mongoose.disconnect() } catch (_) {}
  process.exit(1)
})
