import { Router } from 'express'
import mongoose from 'mongoose'
import { allowedSource, approvedNewsSourceMongoFilter } from '../sourceFilter.js'
import {
  CLASSIFICATION_METHOD,
  CLASSIFICATION_VERSION,
  buildCompanyAliases,
  buildTickerCatalystIntelligence,
  catalystRankingConfig,
  deterministicBrief,
  isCatalystIntelligenceEnabled,
} from '../lib/catalystIntelligence.js'

const router = Router()
const MAX_HOURS = 7 * 24
const MAX_ARTICLES = 500

function normalizeTicker(value) {
  const ticker = String(value || '').trim().toUpperCase().replace(/^\$/, '')
  return /^[A-Z][A-Z0-9.-]{0,5}$/.test(ticker) ? ticker : ''
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function causalWindowFilter(sinceDate, nowDate) {
  const sinceSec = Math.floor(sinceDate.getTime() / 1000)
  const nowSec = Math.floor(nowDate.getTime() / 1000) + 300
  return {
    $or: [
      { publish_date: { $type: 'date', $gte: sinceDate, $lte: nowDate } },
      { publish_date: { $type: 'int', $gte: sinceSec, $lte: nowSec } },
      { publish_date: { $type: 'long', $gte: sinceSec, $lte: nowSec } },
      { publish_date: { $type: 'double', $gte: sinceSec, $lte: nowSec } },
      { first_seen_at: { $type: 'date', $gte: sinceDate, $lte: nowDate } },
      { first_seen_at: { $type: 'int', $gte: sinceSec, $lte: nowSec } },
      { first_seen_at: { $type: 'long', $gte: sinceSec, $lte: nowSec } },
      { first_seen_at: { $type: 'double', $gte: sinceSec, $lte: nowSec } },
    ],
  }
}

function articleTickerFilter(ticker, company) {
  const tickerText = new RegExp(`(?:^|[^A-Z0-9])\\$?${escapeRegex(ticker)}(?:[^A-Z0-9]|$)`, 'i')
  const clauses = [
    { ticker },
    { tickers: ticker },
    { tickers_mentioned: ticker },
    { matched_mover_tickers: ticker },
    { symbol: ticker },
    { symbols: ticker },
    { title: tickerText },
    { headline: tickerText },
  ]
  const companyName = String(company || '').trim()
  if (companyName.length >= 5) {
    const compact = companyName
      .replace(/\b(inc|corp|corporation|company|holdings|group|limited|ltd|plc|adr|common stock|class [a-z])\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (compact.length >= 5) {
      const companyText = new RegExp(`\\b${escapeRegex(compact)}\\b`, 'i')
      clauses.push({ title: companyText }, { headline: companyText })
    }
  }
  return { $or: clauses }
}

router.get('/status', (req, res) => {
  const ranking = catalystRankingConfig()
  const enabled = isCatalystIntelligenceEnabled()
  res.json({
    ok: true,
    enabled,
    mode: enabled ? 'active_ranking_validation' : 'disabled_base_ranking_fallback',
    method: CLASSIFICATION_METHOD,
    version: CLASSIFICATION_VERSION,
    affects_rankings: enabled,
    affects_positions: enabled ? 'candidate_priority_only' : false,
    ranking_weight: ranking.weight,
    max_ranking_adjustment: ranking.maxAdjustment,
    changes_thresholds: false,
    places_trades: false,
  })
})

router.get('/ticker/:ticker', async (req, res) => {
  const ticker = normalizeTicker(req.params.ticker)
  if (!ticker) return res.status(400).json({ ok: false, error: 'valid ticker required' })
  if (!isCatalystIntelligenceEnabled()) {
    return res.json({
      ok: true,
      enabled: false,
      ticker,
      mode: 'disabled_base_ranking_fallback',
      events: [],
      note: 'Catalyst Intelligence is disabled by configuration; existing rankings remain active.',
    })
  }

  const db = mongoose.connection.db
  if (!db) return res.status(503).json({ ok: false, enabled: true, ticker, error: 'MongoDB is not connected' })

  try {
    const hours = Math.max(1, Math.min(MAX_HOURS, Number(req.query.hours) || 72))
    const limit = Math.max(1, Math.min(MAX_ARTICLES, Number(req.query.limit) || 250))
    const now = new Date()
    const since = new Date(now.getTime() - hours * 60 * 60 * 1000)
    const screener = await db.collection('screeners').findOne(
      { ticker },
      { projection: { ticker: 1, company: 1, sector: 1, industry: 1 } },
    )
    const companyAliases = buildCompanyAliases(screener ? [screener] : [])
    const rows = await db.collection('articles').find({
      $and: [
        approvedNewsSourceMongoFilter('source'),
        causalWindowFilter(since, now),
        articleTickerFilter(ticker, screener?.company),
      ],
    }, {
      projection: {
        _id: 1,
        article_id: 1,
        title: 1,
        headline: 1,
        summary: 1,
        content: 1,
        source: 1,
        url: 1,
        link: 1,
        category: 1,
        article_kind: 1,
        collector: 1,
        publish_date: 1,
        publish_time_trusted: 1,
        first_seen_at: 1,
        fetched_date: 1,
        ticker: 1,
        tickers: 1,
        tickers_mentioned: 1,
        matched_mover_tickers: 1,
        symbol: 1,
        symbols: 1,
        sentiment: 1,
        event_type: 1,
      },
    }).sort({ publish_date: -1, first_seen_at: -1 }).limit(limit).toArray()

    const result = buildTickerCatalystIntelligence(rows, {
      ticker,
      universe: new Set([ticker]),
      sourceAllowed: allowedSource,
      companyAliases,
    })
    const latest = result.events[0] || null
    const brief = latest ? deterministicBrief(latest) : null
    res.set('Cache-Control', 'private, max-age=30')
    return res.json({
      ok: true,
      enabled: true,
      mode: 'active_ranking_validation',
      ticker,
      company: screener?.company || null,
      sector: screener?.sector || null,
      hours,
      generated_at: now.toISOString(),
      summary: result.summary,
      brief,
      events: result.events,
      duplicate_groups: result.duplicate_groups,
      diagnostics: {
        queried_articles: rows.length,
        processed_articles: result.processed_articles,
        rejected: result.rejection_counts,
        source_count: new Set(result.events.flatMap(event => event.source_names)).size,
      },
      safeguards: {
        affects_rankings: true,
        affects_positions: 'candidate_priority_only',
        changes_thresholds: false,
        places_trades: false,
      },
    })
  } catch (error) {
    console.error(`GET /api/catalyst-intelligence/ticker/${ticker} failed:`, error)
    return res.status(500).json({ ok: false, enabled: true, ticker, error: String(error?.message || error) })
  }
})

export default router
