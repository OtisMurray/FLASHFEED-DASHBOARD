import { Router } from 'express'
import mongoose from 'mongoose'
import { approvedNewsSourceMongoFilter } from '../sourceFilter.js'
import { normalizeScreenerRow } from './screener.js'
import { scoreLongTerm } from '../lib/longTermScore.js'
import {
  AI_CATALYST_MODEL,
  getCatalystAnalysis,
  getCacheStats,
  isAiCatalystConfigured,
} from '../lib/aiCatalystAgent.js'

const router = Router()

const DISCLAIMER = 'AI-generated commentary from an LLM. Not verified financial advice, not a backtested signal, and not an input to any ranking on this page. Confidence is the model\'s own self-reported number, not a measured probability.'

const ARTICLE_WINDOW_HOURS = 72
const ARTICLE_LIMIT = 40
const SOCIAL_WINDOW_HOURS = 24
const SOCIAL_LIMIT = 200

function normalizeTicker(value) {
  const ticker = String(value || '').trim().toUpperCase().replace(/^\$/, '')
  return /^[A-Z][A-Z0-9.-]{0,5}$/.test(ticker) ? ticker : ''
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function headlineTickerFilter(ticker) {
  const tickerText = new RegExp(`(?:^|[^A-Z0-9])\\$?${escapeRegex(ticker)}(?:[^A-Z0-9]|$)`, 'i')
  return {
    $or: [
      { ticker },
      { tickers: ticker },
      { title: tickerText },
      { headline: tickerText },
    ],
  }
}

router.get('/status', (req, res) => {
  res.json({
    ok: true,
    configured: isAiCatalystConfigured(),
    model: AI_CATALYST_MODEL,
    cache: getCacheStats(),
    disclaimer: DISCLAIMER,
  })
})

router.get('/ticker/:ticker', async (req, res) => {
  const ticker = normalizeTicker(req.params.ticker)
  if (!ticker) return res.status(400).json({ ok: false, error: 'valid ticker required' })

  try {
    const db = mongoose.connection.db
    if (!db) return res.status(503).json({ ok: false, error: 'MongoDB is not connected' })

    const raw = await db.collection('screeners').findOne({ ticker })
    if (!raw) return res.status(404).json({ ok: false, error: 'ticker not in screener universe' })

    const normalized = normalizeScreenerRow(raw)
    const scoreResult = scoreLongTerm(normalized, raw)
    const row = {
      ...normalized,
      week_52_high: raw.week_52_high ?? null,
      week_52_low: raw.week_52_low ?? null,
      profit_margin: raw.profit_margin ?? null,
      long_term_score: scoreResult.score,
      components_available: scoreResult.components_available,
      components_total: scoreResult.components_total,
    }

    let headlines = []
    try {
      const since = new Date(Date.now() - ARTICLE_WINDOW_HOURS * 60 * 60 * 1000)
      const docs = await db.collection('articles').find({
        $and: [
          approvedNewsSourceMongoFilter('source'),
          { $or: [{ publish_date: { $gte: since } }, { first_seen_at: { $gte: since } }] },
          headlineTickerFilter(ticker),
        ],
      }, {
        projection: { title: 1, headline: 1, source: 1, publish_date: 1, first_seen_at: 1 },
      }).sort({ publish_date: -1, first_seen_at: -1 }).limit(ARTICLE_LIMIT).toArray()

      headlines = docs.map(doc => ({
        title: doc.title || doc.headline,
        source: doc.source,
        published_at: doc.publish_date ?? doc.first_seen_at,
      }))
    } catch (error) {
      console.error(`GET /api/ai-catalyst/ticker/${ticker} headline lookup failed:`, error?.message || error)
      headlines = []
    }

    let social = null
    try {
      const since = new Date(Date.now() - SOCIAL_WINDOW_HOURS * 60 * 60 * 1000)
      const docs = await db.collection('socials').find({
        ticker,
        created_at: { $gte: since },
      }, {
        projection: { platform: 1 },
      }).limit(SOCIAL_LIMIT).toArray()

      if (docs.length) {
        social = {
          post_count: docs.length,
          platforms: [...new Set(docs.map(doc => doc.platform).filter(Boolean))],
        }
      }
    } catch (error) {
      console.error(`GET /api/ai-catalyst/ticker/${ticker} social lookup failed:`, error?.message || error)
      social = null
    }

    const result = await getCatalystAnalysis(row, { headlines, social })
    return res.status(200).json({ ...result, disclaimer: DISCLAIMER })
  } catch (error) {
    console.error(`GET /api/ai-catalyst/ticker/${ticker} failed:`, error?.message || error)
    return res.status(500).json({ ok: false, error: 'analysis_failed', disclaimer: DISCLAIMER })
  }
})

export default router
