import express from 'express'
import mongoose from 'mongoose'
import Article from '../models/Article.js'

const router = express.Router()
const MARKET_WINDOW_TIME_ZONE = process.env.MARKET_WINDOW_TIMEZONE || 'America/New_York'
const MARKET_WINDOW_CLOSE_HOUR = Number(process.env.MARKET_WINDOW_CLOSE_HOUR_ET || 17)

function normalizeUnixSeconds(value, fallback) {
  const n = Number(value || 0)
  const fb = Number(fallback || Math.floor(Date.now() / 1000))

  if (!n) return fb

  // milliseconds timestamp
  if (n > 1000000000000) return Math.floor(n / 1000)

  // normal unix seconds
  if (n > 1000000000) return n

  // broken/too-small timestamp, use fallback
  return fb
}

function easternParts(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: MARKET_WINDOW_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)

  return Object.fromEntries(
    parts
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, Number(part.value)])
  )
}

function easternLocalToUtc(year, month, day, hour, minute = 0, second = 0) {
  const target = Date.UTC(year, month - 1, day, hour, minute, second)
  let guess = target

  for (let i = 0; i < 4; i += 1) {
    const parts = easternParts(new Date(guess))
    const actual = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
    const diff = target - actual
    if (diff === 0) break
    guess += diff
  }

  return new Date(guess)
}

function shiftLocalDate(year, month, day, deltaDays) {
  const shifted = new Date(Date.UTC(year, month - 1, day + deltaDays))
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  }
}

function localWeekday(year, month, day) {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay()
}

function latestMarketCloseCutoff(now = new Date()) {
  let { year, month, day, hour } = easternParts(now)
  let weekday = localWeekday(year, month, day)

  if (weekday === 0) {
    ;({ year, month, day } = shiftLocalDate(year, month, day, -2))
  } else if (weekday === 6) {
    ;({ year, month, day } = shiftLocalDate(year, month, day, -1))
  } else if (hour < MARKET_WINDOW_CLOSE_HOUR) {
    ;({ year, month, day } = shiftLocalDate(year, month, day, -1))
    while ([0, 6].includes(localWeekday(year, month, day))) {
      ;({ year, month, day } = shiftLocalDate(year, month, day, -1))
    }
  }

  return easternLocalToUtc(year, month, day, MARKET_WINDOW_CLOSE_HOUR)
}

function articleWindowFilter(cutoffMs) {
  const cutoffSec = Math.floor(cutoffMs / 1000)
  const cutoffDate = new Date(cutoffMs)
  const missingPublishDate = {
    $or: [
      { publish_date: { $exists: false } },
      { publish_date: null },
      { publish_date: '' },
    ],
  }

  return {
    $or: [
      { publish_date: { $type: 'date', $gte: cutoffDate } },
      { publish_date: { $type: 'int', $gte: cutoffSec } },
      { publish_date: { $type: 'long', $gte: cutoffSec } },
      { publish_date: { $type: 'double', $gte: cutoffSec } },
      {
        $and: [
          missingPublishDate,
          {
            $or: [
              { fetched_date: { $type: 'date', $gte: cutoffDate } },
              { fetched_date: { $type: 'int', $gte: cutoffSec } },
              { fetched_date: { $type: 'long', $gte: cutoffSec } },
              { fetched_date: { $type: 'double', $gte: cutoffSec } },
              { detected_at: { $type: 'date', $gte: cutoffDate } },
              { detected_at: { $type: 'int', $gte: cutoffSec } },
              { detected_at: { $type: 'long', $gte: cutoffSec } },
              { detected_at: { $type: 'double', $gte: cutoffSec } },
              { createdAt: { $gte: cutoffDate } },
            ],
          },
        ],
      },
    ],
  }
}

function recentArticleFilter(days) {
  const n = Number(days || 0)
  const cutoffMs = Number.isFinite(n) && n > 0
    ? Date.now() - n * 86_400_000
    : latestMarketCloseCutoff().getTime()

  return articleWindowFilter(cutoffMs)
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function tickerCsvRegex(tickers) {
  const values = Array.from(new Set((tickers || [])
    .map(t => String(t || '').trim().toUpperCase())
    .filter(Boolean)))

  if (!values.length) return null
  return new RegExp(`(^|,\\s*)(${values.map(escapeRegExp).join('|')})(\\s*,|$)`, 'i')
}

async function loadPositiveMoverTickers(source = 'all') {
  const db = mongoose.connection.db
  if (!db) return []

  const filter = {
    $or: [
      { change_pct: { $gte: 0.01 } },
      { change_percent: { $gte: 0.01 } },
    ],
  }
  const sourceName = String(source || 'all').toLowerCase()
  if (sourceName === 'finviz') filter.quote_source = 'finviz_elite_screener'
  if (sourceName === 'tradingview') filter.quote_source = 'tradingview_numeric_screener'

  const rows = await db.collection('screeners')
    .find(filter, { projection: { ticker: 1 } })
    .limit(300)
    .toArray()

  return rows
    .map(row => String(row.ticker || '').trim().toUpperCase())
    .filter(Boolean)
}

function matchedTickers(articleTicker, moverTickers) {
  const wanted = new Set(moverTickers)
  return String(articleTicker || '')
    .split(',')
    .map(t => t.trim().toUpperCase())
    .filter(t => t && wanted.has(t))
}

// GET /api/articles
// Query params: sentiment, source, ticker, ticker_only, from, to, recent_days, limit, skip, offset
router.get('/', async (req, res) => {
  try {
    const {
      sentiment,
      source,
      ticker,
      ticker_only,
      mover_only,
      mover_source,
      from,
      to,
      recent_days,
      days,
      limit = 50,
      skip = 0,
      offset = 0,
    } = req.query

    const pageSkip = Number(offset || skip || 0)
    const pageLimit = Number(limit || 50)

    const filter = {}
    const tickerFilters = []
    let moverTickers = []

    if (sentiment) filter.sentiment = sentiment
    if (source) filter.source = source
    if (ticker) tickerFilters.push({ ticker: { $regex: tickerCsvRegex([ticker]) } })
    if (ticker_only === '1' || ticker_only === 'true') {
      tickerFilters.push({ ticker: { $exists: true, $nin: ['', null] } })
    }
    if (mover_only === '1' || mover_only === 'true') {
      moverTickers = await loadPositiveMoverTickers(mover_source)
      const moverRegex = tickerCsvRegex(moverTickers)
      tickerFilters.push(moverRegex ? { ticker: { $regex: moverRegex } } : { ticker: '__NO_CURRENT_MOVER_TICKERS__' })
    }

    if (from || to) {
      filter.publish_date = {}
      if (from) filter.publish_date.$gte = Number(from)
      if (to) filter.publish_date.$lte = Number(to)
    } else {
      Object.assign(filter, recentArticleFilter(recent_days || days))
    }

    if (tickerFilters.length === 1) Object.assign(filter, tickerFilters[0])
    if (tickerFilters.length > 1) filter.$and = [...(filter.$and || []), ...tickerFilters]

    const [articles, total] = await Promise.all([
      Article.collection.find(filter)
        .sort({ publish_date: -1, fetched_date: -1 })
        .skip(pageSkip)
        .limit(pageLimit)
        .toArray(),
      Article.collection.countDocuments(filter),
    ])

    const mapped = articles.map((a) => {
      const fetchedSeconds = normalizeUnixSeconds(
        a.fetched_date || a.detected_at,
        Math.floor(Date.now() / 1000)
      )

      const publishSeconds = normalizeUnixSeconds(a.publish_date, fetchedSeconds)

      return {
        ...a,
        id: a.article_id,
        publish_date: publishSeconds,
        fetched_date: fetchedSeconds,
        detected_at: normalizeUnixSeconds(a.detected_at, fetchedSeconds),
        positive_mover_match: moverTickers.length ? matchedTickers(a.ticker, moverTickers).length > 0 : false,
        matched_mover_tickers: moverTickers.length ? matchedTickers(a.ticker, moverTickers) : [],
      }
    })

    res.json({
      articles: mapped,
      total,
      skip: pageSkip,
      offset: pageSkip,
      limit: pageLimit,
      market_window_start: latestMarketCloseCutoff().toISOString(),
      market_window_timezone: MARKET_WINDOW_TIME_ZONE,
      mover_only: mover_only === '1' || mover_only === 'true',
      mover_source: mover_source || 'all',
      mover_ticker_count: moverTickers.length,
    })
  } catch (err) {
    console.error('GET /api/articles failed:', err)
    res.status(500).json({ error: 'Failed to load articles' })
  }
})

export default router
