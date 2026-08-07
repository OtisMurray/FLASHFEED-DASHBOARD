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

// The articles collection stores publish_date / first_seen_at as BSON int
// (epoch seconds) far more often than as a real Date — confirmed against both
// local and production data. Mongo range operators compare same-BSON-type
// only, so a single `{ $gte: someJsDate }` clause silently matches nothing
// against an int field: it neither errors nor throws, it just returns zero
// rows every time, which is exactly why this bug shipped invisibly. Mirrors
// the proven causalWindowFilter pattern in routes/catalystIntelligence.js.
function articleWindowFilter(since, now) {
  const sinceSec = Math.floor(since.getTime() / 1000)
  const nowSec = Math.floor(now.getTime() / 1000) + 300
  return {
    $or: [
      { publish_date: { $type: 'date', $gte: since, $lte: now } },
      { publish_date: { $type: 'int', $gte: sinceSec, $lte: nowSec } },
      { publish_date: { $type: 'long', $gte: sinceSec, $lte: nowSec } },
      { publish_date: { $type: 'double', $gte: sinceSec, $lte: nowSec } },
      { first_seen_at: { $type: 'date', $gte: since, $lte: now } },
      { first_seen_at: { $type: 'int', $gte: sinceSec, $lte: nowSec } },
      { first_seen_at: { $type: 'long', $gte: sinceSec, $lte: nowSec } },
      { first_seen_at: { $type: 'double', $gte: sinceSec, $lte: nowSec } },
    ],
  }
}

// Same defect, same fix, for the socials collection: created_at is stored as
// BSON int (epoch seconds) there too — confirmed locally (25,882 of 25,882
// docs are int, none are Date) — so a Date-only bound would be equally dead.
function socialWindowFilter(since, now) {
  const sinceSec = Math.floor(since.getTime() / 1000)
  const nowSec = Math.floor(now.getTime() / 1000) + 300
  return {
    $or: [
      { created_at: { $type: 'date', $gte: since, $lte: now } },
      { created_at: { $type: 'int', $gte: sinceSec, $lte: nowSec } },
      { created_at: { $type: 'long', $gte: sinceSec, $lte: nowSec } },
      { created_at: { $type: 'double', $gte: sinceSec, $lte: nowSec } },
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
      const now = new Date()
      const since = new Date(now.getTime() - ARTICLE_WINDOW_HOURS * 60 * 60 * 1000)
      const docs = await db.collection('articles').find({
        $and: [
          approvedNewsSourceMongoFilter('source'),
          articleWindowFilter(since, now),
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
      const now = new Date()
      const since = new Date(now.getTime() - SOCIAL_WINDOW_HOURS * 60 * 60 * 1000)
      const docs = await db.collection('socials').find({
        $and: [
          { ticker },
          socialWindowFilter(since, now),
        ],
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
export { articleWindowFilter, socialWindowFilter, headlineTickerFilter, normalizeTicker }
