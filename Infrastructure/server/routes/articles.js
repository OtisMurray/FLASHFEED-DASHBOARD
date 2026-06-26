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

function calendarWindowStart(days = 1, now = new Date()) {
  const n = Math.max(1, Math.floor(Number(days) || 1))
  const { year, month, day } = easternParts(now)
  const shifted = shiftLocalDate(year, month, day, -(n - 1))
  return easternLocalToUtc(shifted.year, shifted.month, shifted.day, 0).getTime()
}

function articleWindowFilter(cutoffMs) {
  const cutoffSec = Math.floor(cutoffMs / 1000)
  const cutoffDate = new Date(cutoffMs)
  const ceilingMs = Date.now() + 5 * 60 * 1000
  const ceilingSec = Math.floor(ceilingMs / 1000)
  const ceilingDate = new Date(ceilingMs)
  const rangeFor = (field) => ({
    $or: [
      { [field]: { $type: 'date', $gte: cutoffDate, $lte: ceilingDate } },
      { [field]: { $type: 'int', $gte: cutoffSec, $lte: ceilingSec } },
      { [field]: { $type: 'long', $gte: cutoffSec, $lte: ceilingSec } },
      { [field]: { $type: 'double', $gte: cutoffSec, $lte: ceilingSec } },
    ],
  })
  const missingPublishDate = {
    $or: [
      { publish_date: { $exists: false } },
      { publish_date: null },
      { publish_date: '' },
    ],
  }
  return {
    $or: [
      {
        $and: [
          {
            $or: [
              { publish_time_trusted: true },
              {
                $and: [
                  { publish_time_trusted: { $exists: false } },
                  { article_kind: { $nin: ['public', 'unstructured'] } },
                  { category: { $nin: ['unstructured_public_title', 'public_news', 'public_market_news'] } },
                  { collector: { $ne: 'unstructured_news_title_only_v1' } },
                ],
              },
            ],
          },
          rangeFor('publish_date'),
        ],
      },
      {
        $and: [
          { $or: [{ publish_time_trusted: false }, missingPublishDate] },
          { $or: [rangeFor('first_seen_at'), rangeFor('createdAt')] },
        ],
      },
    ],
  }
}

function recentArticleFilter(days) {
  const n = Number(days || 0)
  const cutoffMs = Number.isFinite(n) && n > 0
    ? calendarWindowStart(n)
    : latestMarketCloseCutoff().getTime()

  return articleWindowFilter(cutoffMs)
}

function todayArticleFilter(now = new Date()) {
  const { year, month, day } = easternParts(now)
  const todayStartMs = easternLocalToUtc(year, month, day, 0).getTime()
  const todayStartSec = Math.floor(todayStartMs / 1000)
  const ceilingMs = Date.now() + 5 * 60 * 1000
  const ceilingSec = Math.floor(ceilingMs / 1000)
  const ceilingDate = new Date(ceilingMs)

  // Strict today filter: only articles whose publish_date falls within today.
  // No fallback to first_seen_at/createdAt — those can pull in old articles
  // that were merely re-fetched today.
  return {
    $or: [
      { publish_date: { $type: 'date', $gte: new Date(todayStartMs), $lte: ceilingDate } },
      { publish_date: { $type: 'int', $gte: todayStartSec, $lte: ceilingSec } },
      { publish_date: { $type: 'long', $gte: todayStartSec, $lte: ceilingSec } },
      { publish_date: { $type: 'double', $gte: todayStartSec, $lte: ceilingSec } },
    ],
  }
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
  const values = Array.isArray(articleTicker) ? articleTicker : String(articleTicker || '').split(',')
  return values
    .map(t => t.trim().toUpperCase())
    .filter(t => t && wanted.has(t))
}

const PUBLIC_ARTICLE_CATEGORIES = ['unstructured_public_title', 'public_news', 'public_market_news']

function articleKindFilter(kind) {
  const requested = String(kind || '').toLowerCase()
  const publicFilter = {
    $or: [
      { article_kind: { $in: ['public', 'unstructured'] } },
      { category: { $in: PUBLIC_ARTICLE_CATEGORIES } },
      { collector: 'unstructured_news_title_only_v1' },
      { source: /unstructured/i },
    ],
  }
  if (requested === 'public' || requested === 'unstructured') return publicFilter
  if (requested !== 'structured') return null
  return {
    $or: [
      { article_kind: 'structured' },
      {
        $and: [
          { article_kind: { $nin: ['structured', 'public', 'unstructured'] } },
          { category: { $nin: PUBLIC_ARTICLE_CATEGORIES } },
          { collector: { $ne: 'unstructured_news_title_only_v1' } },
          { source: { $not: /unstructured/i } },
        ],
      },
    ],
  }
}

// GET /api/articles
// Query params: sentiment, source, ticker, ticker_only, from, to, recent_days, limit, skip, offset
router.get('/', async (req, res) => {
  try {
    const {
      sentiment,
      source,
      category,
      search,
      article_kind,
      ticker,
      ticker_only,
      mover_only,
      mover_source,
      from,
      to,
      recent_days,
      days,
      today,
      feed,
      limit = 50,
      skip = 0,
      offset = 0,
    } = req.query

    const pageSkip = Number(offset || skip || 0)
    const pageLimit = Number(limit || 50)
    const includeFilings = req.query.include_filings === '1' || req.query.include_filings === 'true'

    const filter = includeFilings ? {} : { suppress_from_main_news: { $ne: true } }
    const tickerFilters = []
    let moverTickers = []

    if (sentiment) filter.sentiment = sentiment
    if (source) filter.source = source
    if (category) filter.category = category
    if (search) {
      const query = String(search).trim().slice(0, 100)
      if (query) filter.$and = [...(filter.$and || []), { $or: [
        { title: { $regex: escapeRegExp(query), $options: 'i' } },
        { company: { $regex: escapeRegExp(query), $options: 'i' } },
      ] }]
    }
    if (req.query.keywords_only === '1' || req.query.keywords_only === 'true') {
      filter.keyword_match = { $exists: true, $ne: [] }
    }
    const kindFilter = articleKindFilter(article_kind)
    if (kindFilter) filter.$and = [...(filter.$and || []), kindFilter]
    if (ticker) tickerFilters.push({
      $or: [
        { ticker: { $regex: tickerCsvRegex([ticker]) } },
        { tickers: String(ticker).toUpperCase() },
      ],
    })
    if (ticker_only === '1' || ticker_only === 'true') {
      tickerFilters.push({
        $or: [
          { ticker: { $exists: true, $nin: ['', null] } },
          { tickers: { $exists: true, $ne: [] } },
        ],
      })
    }
    if (mover_only === '1' || mover_only === 'true') {
      moverTickers = await loadPositiveMoverTickers(mover_source)
      const moverRegex = tickerCsvRegex(moverTickers)
      tickerFilters.push(moverRegex ? {
        $or: [
          { ticker: { $regex: moverRegex } },
          { tickers: { $in: moverTickers } },
        ],
      } : { ticker: '__NO_CURRENT_MOVER_TICKERS__' })
    }

    if (from || to) {
      filter.publish_date = {}
      if (from) filter.publish_date.$gte = Number(from)
      if (to) filter.publish_date.$lte = Number(to)
    } else {
      const todayOnly = feed === 'today' || today === '1' || today === 'true' || (!recent_days && !days)
      Object.assign(filter, todayOnly ? todayArticleFilter() : recentArticleFilter(recent_days || days))
    }

    if (tickerFilters.length) filter.$and = [...(filter.$and || []), ...tickerFilters]

    const sourceFacetFilter = { ...filter }
    const categoryFacetFilter = { ...filter }
    delete sourceFacetFilter.source
    delete categoryFacetFilter.category

    const [articles, total, sourceRows, categoryRows] = await Promise.all([
      Article.collection.find(filter)
        .sort({
          main_feed_priority: -1,
          feed_sort_time: -1,
          publish_date: -1,
          fetched_date: -1,
          detected_at: -1
        })
        .skip(pageSkip)
        .limit(pageLimit)
        .toArray(),
      Article.collection.countDocuments(filter),
      Article.collection.aggregate([
        { $match: sourceFacetFilter },
        { $match: { source: { $exists: true, $nin: ['', null] } } },
        { $group: { _id: '$source', count: { $sum: 1 } } },
        { $project: { _id: 0, source: '$_id', count: 1 } },
        { $sort: { count: -1 } },
      ]).toArray(),
      Article.collection.aggregate([
        { $match: categoryFacetFilter },
        { $match: { category: { $exists: true, $nin: ['', null] } } },
        { $group: { _id: '$category', count: { $sum: 1 } } },
        { $project: { _id: 0, category: '$_id', count: 1 } },
        { $sort: { count: -1 } },
      ]).toArray(),
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
        article_kind: a.article_kind || (PUBLIC_ARTICLE_CATEGORIES.includes(a.category) || a.collector === 'unstructured_news_title_only_v1' ? 'public' : 'structured'),
        positive_mover_match: moverTickers.length ? matchedTickers(a.tickers?.length ? a.tickers : a.ticker, moverTickers).length > 0 : false,
        matched_mover_tickers: moverTickers.length ? matchedTickers(a.tickers?.length ? a.tickers : a.ticker, moverTickers) : [],
      }
    })

    const responseTodayOnly = feed === 'today' || today === '1' || today === 'true' || (!recent_days && !days)
    const responseParts = easternParts(new Date())
    const responseWindowDays = Math.max(1, Math.floor(Number(recent_days || days || 3) || 3))
    const responseWindowStart = responseTodayOnly
      ? easternLocalToUtc(responseParts.year, responseParts.month, responseParts.day, 0)
      : new Date(calendarWindowStart(responseWindowDays))

    res.json({
      articles: mapped,
      total,
      skip: pageSkip,
      offset: pageSkip,
      limit: pageLimit,
      sources: sourceRows,
      categories: categoryRows,
      market_window_start: responseWindowStart.toISOString(),
      market_window_timezone: MARKET_WINDOW_TIME_ZONE,
      window_mode: responseTodayOnly ? 'today' : 'calendar_days_et',
      window_days: responseTodayOnly ? 1 : responseWindowDays,
      window_date: responseTodayOnly
        ? `${String(responseParts.year).padStart(4, '0')}-${String(responseParts.month).padStart(2, '0')}-${String(responseParts.day).padStart(2, '0')}`
        : null,
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
