import { Router } from 'express'
import mongoose from 'mongoose'
import Screener from '../models/Screener.js'

const router = Router()
const NON_STOCK_TICKERS = new Set([
  'BTC', 'ETH', 'LTC', 'DOGE', 'SOL', 'ADA', 'XRP', 'BNB', 'DOT', 'AVAX',
  'MATIC', 'SHIB', 'TRX', 'BCH', 'LINK', 'ATOM', 'UNI', 'ETC', 'FIL',
  'USD', 'USDT', 'USDC', 'SPOT',
])
const US_EXCHANGES = new Set(['NASDAQ', 'NYSE', 'AMEX'])
const MAX_SIGNAL_CHANGE_PCT = Math.max(10, Number(process.env.MAX_SIGNAL_CHANGE_PCT || 300))

function normalizeExchange(value) {
  const raw = String(value || '').trim().toUpperCase()
  if (raw === 'NYSEAMERICAN' || raw === 'NYSE AMERICAN') return 'AMEX'
  if (raw === 'NAS') return 'NASDAQ'
  return raw
}

function isCleanListedUsRow(row) {
  if (!row?.ticker || row.ticker.includes('.')) return false
  if (NON_STOCK_TICKERS.has(row.ticker)) return false
  if (row.quote_status && row.quote_status !== 'priced') return false
  if (row.price == null || row.change_pct == null) return false
  if (Number(row.price) <= 0) return false
  if (!Number.isFinite(Number(row.change_pct))) return false
  if (Math.abs(Number(row.change_pct)) > MAX_SIGNAL_CHANGE_PCT) return false
  const exchange = normalizeExchange(row.exchange)
  return US_EXCHANGES.has(exchange)
}

function recentArticleMatch(days = 2) {
  const n = Number(days || 0)
  if (!Number.isFinite(n) || n <= 0) return {}

  const cutoffMs = Date.now() - n * 86_400_000
  const cutoffSec = Math.floor(cutoffMs / 1000)
  const cutoffDate = new Date(cutoffMs)

  return {
    $or: [
      { publish_date: { $gte: cutoffDate } },
      { publish_date: { $gte: cutoffSec } },
      { fetched_date: { $gte: cutoffDate } },
      { fetched_date: { $gte: cutoffSec } },
      { detected_at: { $gte: cutoffDate } },
      { detected_at: { $gte: cutoffSec } },
      { createdAt: { $gte: cutoffDate } },
    ],
  }
}

function sentimentScore(row) {
  const total = Math.max(1, Number(row.count || 0))
  if (row.weighted_score_sum != null) {
    const denominator = Number(row.weight_sum || total)
    return denominator ? Number((Number(row.weighted_score_sum || 0) / (denominator + 1.5)).toFixed(3)) : 0
  }
  if (row.score_sum != null) return Number((Number(row.score_sum || 0) / (total + 2)).toFixed(3))
  const priorNeutralWeight = 2
  return Number((((row.bullish || 0) - (row.bearish || 0)) / (total + priorNeutralWeight)).toFixed(3))
}

function stableHash(value) {
  let hash = 0
  const text = String(value || '')
  for (let i = 0; i < text.length; i += 1) hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0
  return Math.abs(hash)
}

function derivedNumber(ticker, min, max, decimals = 2, salt = '') {
  const pct = (stableHash(`${ticker}:${salt}`) % 10000) / 10000
  return Number((min + (max - min) * pct).toFixed(decimals))
}

function nullableNumber(value) {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function nullableFixed(value, decimals = 2) {
  const n = nullableNumber(value)
  return n == null ? null : Number(n.toFixed(decimals))
}

function marketCapBucket(marketCap) {
  const cap = Number(marketCap || 0)
  if (cap >= 200e9) return 'Mega'
  if (cap >= 10e9) return 'Large'
  if (cap >= 2e9) return 'Mid'
  if (cap >= 300e6) return 'Small'
  if (cap > 0) return 'Micro'
  return 'Unknown'
}

function rollingWindowMinutes(row) {
  const tier = String(row.market_cap_tier || row.finviz_market_cap_tier || '').toLowerCase()
  const bucket = String(row.market_cap_bucket || '').toLowerCase()
  if (tier === 'nano' || tier === 'micro' || bucket === 'micro') return 5
  if (tier === 'small' || bucket === 'small') return 15
  if (tier === 'mid' || bucket === 'mid') return 30
  if (tier === 'large' || bucket === 'large') return 60
  if (tier === 'mega' || bucket === 'mega') return 120
  return 30
}

function resolvedRollingWindowMinutes(row, override = null) {
  const explicit = Number(override)
  if (Number.isFinite(explicit) && explicit > 0) return Math.max(1, Math.min(4320, explicit))
  return rollingWindowMinutes(row)
}

function normalizeScreenerRow(doc = {}) {
  const ticker = String(doc.ticker || '').toUpperCase()
  const hasStoredPrice = doc.price != null
  const price = nullableFixed(doc.price, 2)
  const change = doc.change_pct ?? doc.change_percent
  const changePct = nullableFixed(change, 2)
  const volume = nullableNumber(doc.volume)
  const avgVolume = nullableNumber(doc.avg_volume)
  const relVolume = volume != null && avgVolume ? Number((volume / Math.max(1, avgVolume)).toFixed(2)) : null
  const marketCap = nullableNumber(doc.market_cap)
  const avgSentiment = Number(doc.avg_sentiment ?? doc.news_sentiment ?? doc.structured_sentiment ?? 0)

  return {
    ticker,
    company: doc.company || '',
    price,
    change_pct: changePct,
    volume,
    avg_volume: avgVolume,
    rel_volume: relVolume,
    market_cap: marketCap,
    market_cap_tier: doc.market_cap_tier || doc.finviz_market_cap_tier || '',
    market_cap_bucket: marketCapBucket(marketCap),
    sector: doc.sector || 'Unclassified',
    industry: doc.industry || 'Unclassified',
    country: doc.country || (US_EXCHANGES.has(normalizeExchange(doc.exchange)) ? 'USA' : ''),
    exchange: normalizeExchange(doc.exchange),
    index: doc.index || '',
    avg_sentiment: avgSentiment,
    social_sentiment: Number(doc.social_sentiment ?? 0),
    structured_sentiment: Number(doc.structured_sentiment ?? doc.news_sentiment ?? avgSentiment),
    message_count: Number(doc.message_count ?? 0),
    news_article_count: Number(doc.news_article_count ?? 0),
    bullish_count: Number(doc.bullish_count ?? 0),
    bearish_count: Number(doc.bearish_count ?? 0),
    neutral_count: Number(doc.neutral_count ?? 0),
    sources: doc.sources || [],
    pe_ratio: nullableNumber(doc.pe_ratio ?? doc.pe),
    forward_pe: nullableNumber(doc.forward_pe),
    peg: nullableNumber(doc.peg),
    ps_ratio: nullableNumber(doc.ps_ratio),
    pb_ratio: nullableNumber(doc.pb_ratio),
    dividend_yield: nullableNumber(doc.dividend_yield),
    eps_growth_this_y: nullableNumber(doc.eps_growth_this_y),
    eps_growth_next_y: nullableNumber(doc.eps_growth_next_y),
    sales_growth: nullableNumber(doc.sales_growth),
    gross_margin: nullableNumber(doc.gross_margin),
    operating_margin: nullableNumber(doc.operating_margin),
    roe: nullableNumber(doc.roe),
    debt_equity: nullableNumber(doc.debt_equity),
    beta: nullableNumber(doc.beta),
    rsi: nullableNumber(doc.rsi),
    sma20: nullableNumber(doc.sma20),
    sma50: nullableNumber(doc.sma50),
    sma200: nullableNumber(doc.sma200),
    perf_week: nullableNumber(doc.perf_week),
    perf_month: nullableNumber(doc.perf_month),
    perf_quarter: nullableNumber(doc.perf_quarter),
    perf_half: nullableNumber(doc.perf_half),
    perf_year: nullableNumber(doc.perf_year),
    perf_ytd: nullableNumber(doc.perf_ytd),
    atr: nullableNumber(doc.atr),
    gap: nullableNumber(doc.gap),
    analyst: doc.analyst || null,
    target_price: nullableFixed(doc.target_price, 2),
    inst_own: nullableNumber(doc.inst_own),
    insider_own: nullableNumber(doc.insider_own),
    float_short: nullableNumber(doc.float_short),
    earnings_date: doc.earnings_date || null,
    previous_close: nullableFixed(doc.previous_close, 2),
    quote_source: doc.quote_source || null,
    quote_updated_at: doc.quote_updated_at || null,
    quote_status: doc.quote_status || (hasStoredPrice ? 'priced' : 'missing'),
  }
}

function socialTimeStages() {
  return [
    {
      $addFields: {
        _time_raw: {
          $ifNull: [
            '$fetched_at',
            { $ifNull: ['$detected_at', { $ifNull: ['$timestamp', { $ifNull: ['$created_at', '$publish_date'] }] }] },
          ],
        },
      },
    },
    {
      $addFields: {
        _event_sec: {
          $switch: {
            branches: [
              { case: { $eq: [{ $type: '$_time_raw' }, 'date'] }, then: { $floor: { $divide: [{ $toLong: '$_time_raw' }, 1000] } } },
              { case: { $in: [{ $type: '$_time_raw' }, ['int', 'long', 'double', 'decimal']] }, then: { $toLong: '$_time_raw' } },
              {
                case: { $eq: [{ $type: '$_time_raw' }, 'string'] },
                then: { $floor: { $divide: [{ $toLong: { $dateFromString: { dateString: '$_time_raw', onError: new Date(0) } } }, 1000] } },
              },
            ],
            default: 0,
          },
        },
      },
    },
  ]
}

async function loadArticleStatsForTickers(db, tickers, days = 2) {
  const wanted = Array.from(new Set(tickers.map(t => String(t || '').toUpperCase()).filter(Boolean)))
  if (!wanted.length) return new Map()

  const rows = await db.collection('articles').aggregate([
    { $match: { ...recentArticleMatch(days), ticker: { $exists: true, $nin: ['', null] } } },
    {
      $addFields: {
        _ticker_parts: {
          $map: {
            input: { $split: [{ $toUpper: { $toString: '$ticker' } }, ','] },
            as: 'ticker_part',
            in: { $trim: { input: '$$ticker_part' } },
          },
        },
      },
    },
    { $unwind: '$_ticker_parts' },
    { $match: { _ticker_parts: { $in: wanted } } },
    {
      $addFields: {
        _sentiment_direction: {
          $switch: {
            branches: [
              { case: { $regexMatch: { input: { $toLower: { $toString: { $ifNull: ['$sentiment', ''] } } }, regex: 'bull|positive' } }, then: 1 },
              { case: { $regexMatch: { input: { $toLower: { $toString: { $ifNull: ['$sentiment', ''] } } }, regex: 'bear|negative' } }, then: -1 },
            ],
            default: 0,
          },
        },
      },
    },
    {
      $addFields: {
        _score: {
          $switch: {
            branches: [
              { case: { $in: [{ $type: '$sentiment_score' }, ['int', 'long', 'double', 'decimal']] }, then: { $toDouble: '$sentiment_score' } },
              { case: { $in: [{ $type: '$ml_confidence' }, ['int', 'long', 'double', 'decimal']] }, then: { $multiply: ['$_sentiment_direction', { $toDouble: '$ml_confidence' }] } },
            ],
            default: '$_sentiment_direction',
          },
        },
      },
    },
    {
      $addFields: {
        _source_weight: {
          $switch: {
            branches: [
              {
                case: {
                  $and: [
                    {
                      $or: [
                        { $regexMatch: { input: { $toLower: { $toString: { $ifNull: ['$source', ''] } } }, regex: 'sec|edgar' } },
                        { $eq: [{ $toLower: { $toString: { $ifNull: ['$event_type', ''] } } }, 'sec_filing'] },
                      ],
                    },
                    { $lte: [{ $abs: '$_score' }, 0.08] },
                  ],
                },
                then: 0.15,
              },
              {
                case: {
                  $in: [
                    { $toLower: { $toString: { $ifNull: ['$event_type', ''] } } },
                    ['earnings_beat', 'earnings_miss', 'guidance_raise', 'guidance_cut', 'fda_approval', 'fda_rejection', 'clinical_positive', 'clinical_negative', 'public_offering', 'bankruptcy_default'],
                  ],
                },
                then: 1.35,
              },
            ],
            default: 1,
          },
        },
      },
    },
    {
      $group: {
        _id: '$_ticker_parts',
        count: { $sum: 1 },
        bullish: { $sum: { $cond: [{ $gt: ['$_score', 0.08] }, 1, 0] } },
        bearish: { $sum: { $cond: [{ $lt: ['$_score', -0.08] }, 1, 0] } },
        neutral: { $sum: { $cond: [{ $lte: [{ $abs: '$_score' }, 0.08] }, 1, 0] } },
        score_sum: { $sum: '$_score' },
        weighted_score_sum: { $sum: { $multiply: ['$_score', '$_source_weight'] } },
        weight_sum: { $sum: '$_source_weight' },
        sources: { $addToSet: '$source' },
        latest_publish: { $max: '$publish_date' },
      },
    },
  ]).toArray()

  return new Map(rows.map(row => [String(row._id || '').toUpperCase(), row]))
}

function socialTickerCandidateStages() {
  const stringSplit = (field) => ({
    $cond: [
      { $eq: [{ $type: field }, 'string'] },
      { $split: [field, ','] },
      [],
    ],
  })
  const arrayOrStringSplit = (field) => ({
    $cond: [
      { $isArray: field },
      field,
      stringSplit(field),
    ],
  })

  return [
    {
      $addFields: {
        _ticker_primary_values_raw: {
          $concatArrays: [
            stringSplit('$ticker'),
            stringSplit('$symbol'),
            stringSplit('$cashtag'),
            arrayOrStringSplit('$tickers_mentioned'),
          ],
        },
        _ticker_text_cashtags: {
          $map: {
            input: {
              $regexFindAll: {
                input: {
                  $concat: [
                    { $toString: { $ifNull: ['$text', ''] } },
                    ' ',
                    { $toString: { $ifNull: ['$content', ''] } },
                    ' ',
                    { $toString: { $ifNull: ['$title', ''] } },
                  ],
                },
                regex: /\$[A-Za-z][A-Za-z0-9.-]{0,5}\b/,
              },
            },
            as: 'tag',
            in: '$$tag.match',
          },
        },
      },
    },
    {
      $addFields: {
        _ticker_values_raw: {
          $cond: [
            {
              $gt: [
                {
                  $size: {
                    $filter: {
                      input: { $ifNull: ['$_ticker_primary_values_raw', []] },
                      as: 'raw',
                      cond: { $ne: [{ $trim: { input: { $toString: '$$raw' } } }, ''] },
                    },
                  },
                },
                0,
              ],
            },
            '$_ticker_primary_values_raw',
            { $ifNull: ['$_ticker_text_cashtags', []] },
          ],
        },
      },
    },
    {
      $addFields: {
        _ticker_candidates: {
          $filter: {
            input: {
              $map: {
                input: '$_ticker_values_raw',
                as: 'raw',
                in: {
                  $trim: {
                    input: {
                      $replaceAll: {
                        input: { $toUpper: { $toString: '$$raw' } },
                        find: { $literal: '$' },
                        replacement: '',
                      },
                    },
                    chars: ' ,;#',
                  },
                },
              },
            },
            as: 'candidate',
            cond: {
              $regexMatch: {
                input: '$$candidate',
                regex: '^[A-Z][A-Z0-9.-]{0,5}$',
              },
            },
          },
        },
      },
    },
  ]
}

function socialMatchForWindow(tickers, windowMinutes) {
  const sinceSec = Math.floor(Date.now() / 1000) - windowMinutes * 60
  return {
    _event_sec: { $gte: sinceSec },
    _ticker_candidates: { $in: tickers },
  }
}

async function loadAdaptiveSocialStatsForRows(db, rows, windowOverride = null) {
  const byWindow = new Map()
  for (const row of rows) {
    const window = resolvedRollingWindowMinutes(row, windowOverride)
    if (!byWindow.has(window)) byWindow.set(window, [])
    byWindow.get(window).push(row.ticker)
  }

  const or = Array.from(byWindow.entries()).map(([window, tickers]) => socialMatchForWindow(tickers, window))
  if (!or.length) return new Map()

  const results = await db.collection('socials').aggregate([
    ...socialTimeStages(),
    ...socialTickerCandidateStages(),
    { $match: { $or: or } },
    { $unwind: '$_ticker_candidates' },
    { $match: { _ticker_candidates: { $in: rows.map(row => row.ticker) } } },
    {
      $addFields: {
        _norm_platform: {
          $switch: {
            branches: [
              { case: { $regexMatch: { input: { $toLower: { $toString: { $ifNull: ['$platform', ''] } } }, regex: 'stocktwits' } }, then: 'StockTwits' },
              { case: { $regexMatch: { input: { $toLower: { $toString: { $ifNull: ['$platform', ''] } } }, regex: 'twitter|x' } }, then: 'Twitter' },
              { case: { $regexMatch: { input: { $toLower: { $toString: { $ifNull: ['$platform', ''] } } }, regex: 'reddit' } }, then: 'Reddit' },
              { case: { $regexMatch: { input: { $toLower: { $toString: { $ifNull: ['$platform', ''] } } }, regex: 'bluesky|bsky' } }, then: 'Bluesky' },
            ],
            default: { $ifNull: ['$platform', 'Unknown'] },
          },
        },
        _score: {
          $switch: {
            branches: [
              { case: { $in: [{ $type: '$sentiment_score' }, ['int', 'long', 'double', 'decimal']] }, then: { $toDouble: '$sentiment_score' } },
              { case: { $regexMatch: { input: { $toLower: { $toString: { $ifNull: ['$sentiment', ''] } } }, regex: 'bull|positive' } }, then: 1 },
              { case: { $regexMatch: { input: { $toLower: { $toString: { $ifNull: ['$sentiment', ''] } } }, regex: 'bear|negative' } }, then: -1 },
            ],
            default: 0,
          },
        },
      },
    },
    {
      $group: {
        _id: '$_ticker_candidates',
        count: { $sum: 1 },
        sentiment: { $avg: '$_score' },
        bullish: { $sum: { $cond: [{ $gt: ['$_score', 0.15] }, 1, 0] } },
        bearish: { $sum: { $cond: [{ $lt: ['$_score', -0.15] }, 1, 0] } },
        platforms: { $addToSet: '$_norm_platform' },
        stocktwits_count: { $sum: { $cond: [{ $eq: ['$_norm_platform', 'StockTwits'] }, 1, 0] } },
        stocktwits_score_sum: { $sum: { $cond: [{ $eq: ['$_norm_platform', 'StockTwits'] }, '$_score', 0] } },
        stocktwits_bullish: { $sum: { $cond: [{ $and: [{ $eq: ['$_norm_platform', 'StockTwits'] }, { $gt: ['$_score', 0.15] }] }, 1, 0] } },
        stocktwits_bearish: { $sum: { $cond: [{ $and: [{ $eq: ['$_norm_platform', 'StockTwits'] }, { $lt: ['$_score', -0.15] }] }, 1, 0] } },
        latest_post: { $max: '$_event_sec' },
      },
    },
  ]).toArray()

  return new Map(results.map(row => [String(row._id || '').toUpperCase(), row]))
}

function enrichScreenerRow(row, articleRow, socialRow, windowOverride = null) {
  const newsScore = articleRow ? sentimentScore(articleRow) : Number(row.structured_sentiment || 0)
  const socialCount = Number(socialRow?.count || 0)
  const socialScore = socialCount ? Number(Number(socialRow.sentiment || 0).toFixed(3)) : Number(row.social_sentiment || 0)
  const rollingWindow = resolvedRollingWindowMinutes(row, windowOverride)
  const stocktwitsCount = Number(socialRow?.stocktwits_count || 0)
  const stocktwitsScore = stocktwitsCount
    ? Number((Number(socialRow?.stocktwits_score_sum || 0) / Math.max(1, stocktwitsCount)).toFixed(3))
    : 0
  const stocktwitsDensity = Number((stocktwitsCount / Math.max(1, rollingWindow)).toFixed(3))
  const articleCount = Number(articleRow?.count || row.news_article_count || 0)
  const totalWeight = articleCount + socialCount * 0.75
  const avgSentiment = totalWeight
    ? Number(((newsScore * articleCount + socialScore * socialCount * 0.75) / totalWeight).toFixed(3))
    : Number(row.avg_sentiment || 0)

  return {
    ...row,
    country: row.country || 'USA',
    rolling_window_minutes: rollingWindow,
    avg_sentiment: avgSentiment,
    structured_sentiment: newsScore,
    social_sentiment: socialScore,
    social_message_sentiment: stocktwitsScore,
    social_message_density: stocktwitsDensity,
    stocktwits_message_count: stocktwitsCount,
    message_count: socialCount,
    news_article_count: articleCount,
    bullish_count: Number(articleRow?.bullish || 0) + Number(socialRow?.bullish || 0),
    bearish_count: Number(articleRow?.bearish || 0) + Number(socialRow?.bearish || 0),
    neutral_count: Number(articleRow?.neutral || 0),
    sources: [...(articleRow?.sources || []), ...(socialRow?.platforms || []), row.quote_source].filter(Boolean).slice(0, 8),
    latest_publish: articleRow?.latest_publish || null,
    latest_social: socialRow?.latest_post || null,
  }
}

// GET /api/screener
router.get('/', async (req, res) => {
  try {
    const { sector, signal, orderBy = 'ticker', orderDir = 'asc', limit = 1000, days = 2 } = req.query
    const windowOverride = req.query.window_minutes ? Number(req.query.window_minutes) : null
    const filter = {
      exchange: { $in: Array.from(US_EXCHANGES) },
      ticker: { $not: /\./ },
      price: { $ne: null },
    }
    if (sector) filter.sector = sector
    if (signal === 'social_bullish') filter.social_sentiment = { $gte: 0.3 }
    if (signal === 'social_bearish') filter.social_sentiment = { $lte: -0.3 }
    if (signal === 'unusual_volume') filter.volume = { $gte: 30000000 }

    const sort = { [orderBy]: orderDir === 'asc' ? 1 : -1 }
    const requestedLimit = Math.max(1, Math.min(1500, Number(limit || 1000)))
    let data = (await Screener.find(filter).sort(sort).limit(requestedLimit).lean())
      .map(normalizeScreenerRow)
      .filter(isCleanListedUsRow)

    if (mongoose.connection.db && data.length) {
      const tickers = data.map(row => row.ticker)
      const [articleMap, socialMap] = await Promise.all([
        loadArticleStatsForTickers(mongoose.connection.db, tickers, Number(days || 2)),
        loadAdaptiveSocialStatsForRows(mongoose.connection.db, data, windowOverride),
      ])
      data = data.map(row => enrichScreenerRow(row, articleMap.get(row.ticker), socialMap.get(row.ticker), windowOverride))
    }

    const activeSocialRows = data.filter(row => Number(row.message_count || 0) > 0)
    const totalSocialMessages = data.reduce((sum, row) => sum + Number(row.message_count || 0), 0)
    const totalStocktwitsMessages = data.reduce((sum, row) => sum + Number(row.stocktwits_message_count || 0), 0)
    const totalSocialDensity = data.reduce((sum, row) => sum + Number(row.message_count || 0) / Math.max(1, Number(row.rolling_window_minutes || 30)), 0)

    res.json({
      ok: true,
      rows: data,
      tickers: data,
      count: data.length,
      universe: 'NASDAQ / NYSE / AMEX listed stocks from numeric screeners',
      summary: {
        priced: data.filter(row => row.price != null).length,
        gainers: data.filter(row => Number(row.change_pct || 0) > 0).length,
        losers: data.filter(row => Number(row.change_pct || 0) < 0).length,
        unchanged: data.filter(row => Number(row.change_pct || 0) === 0).length,
        active_social: activeSocialRows.length,
        total_social_messages: totalSocialMessages,
        total_stocktwits_messages: totalStocktwitsMessages,
        avg_posts_per_active_social: activeSocialRows.length ? Number((totalSocialMessages / activeSocialRows.length).toFixed(2)) : 0,
        avg_social_density_per_ticker: data.length ? Number((totalSocialDensity / data.length).toFixed(3)) : 0,
      },
      exchanges: Array.from(US_EXCHANGES),
      rolling_windows: {
        selected: windowOverride || 'adaptive',
        nano_micro: 5,
        small: 15,
        mid: 30,
        large: 60,
        mega: 120,
      },
      excluded: ['OTC', 'crypto', 'unpriced/article-only rows', 'non-US exchanges'],
      max_abs_change_pct: MAX_SIGNAL_CHANGE_PCT,
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/screener/upsert  — upsert a single ticker
router.post('/upsert', async (req, res) => {
  try {
    const doc = await Screener.findOneAndUpdate(
      { ticker: req.body.ticker },
      { $set: { ...req.body, updated_at: new Date() } },
      { upsert: true, new: true }
    )
    res.json(doc)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

export default router
