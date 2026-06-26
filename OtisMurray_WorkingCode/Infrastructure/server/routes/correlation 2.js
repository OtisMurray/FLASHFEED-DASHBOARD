import { Router } from 'express'
import mongoose from 'mongoose'
import Correlation from '../models/Correlation.js'

const router = Router()

const NON_STOCK_TICKERS = new Set([
  'BTC', 'ETH', 'LTC', 'DOGE', 'SOL', 'ADA', 'XRP', 'BNB', 'DOT', 'AVAX',
  'MATIC', 'SHIB', 'TRX', 'BCH', 'LINK', 'ATOM', 'UNI', 'ETC', 'FIL',
  'USD', 'USDT', 'USDC', 'SPOT',
])
const US_EXCHANGES = new Set(['NASDAQ', 'NYSE', 'AMEX'])
const MAX_SIGNAL_CHANGE_PCT = Math.max(10, Number(process.env.MAX_SIGNAL_CHANGE_PCT || 300))

function clamp(value, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return min
  return Math.max(min, Math.min(max, n))
}

function normalizeExchange(value) {
  const raw = String(value || '').trim().toUpperCase()
  if (raw === 'NYSEAMERICAN' || raw === 'NYSE AMERICAN') return 'AMEX'
  if (raw === 'NAS') return 'NASDAQ'
  return raw
}

function normalizeTicker(value) {
  const ticker = String(value || '').toUpperCase().replace(/^\$/, '').trim()
  if (!/^[A-Z][A-Z0-9]{0,5}$/.test(ticker)) return ''
  if (NON_STOCK_TICKERS.has(ticker)) return ''
  return ticker
}

function recentMatch(days = 2) {
  const n = Math.max(1, Number(days || 2))
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
      { fetched_at: { $gte: cutoffSec } },
      { timestamp: { $gte: cutoffSec } },
      { created_at: { $gte: cutoffSec } },
      { createdAt: { $gte: cutoffDate } },
    ],
  }
}

function sentimentDirectionExpr(field = '$sentiment') {
  return {
    $switch: {
      branches: [
        { case: { $regexMatch: { input: { $toLower: { $toString: { $ifNull: [field, ''] } } }, regex: 'bull|positive' } }, then: 1 },
        { case: { $regexMatch: { input: { $toLower: { $toString: { $ifNull: [field, ''] } } }, regex: 'bear|negative' } }, then: -1 },
      ],
      default: 0,
    },
  }
}

function sentimentScoreExpr({ sentimentField = '$sentiment', scoreField = '$sentiment_score', confidenceField = '$ml_confidence' } = {}) {
  return {
    $switch: {
      branches: [
        { case: { $in: [{ $type: scoreField }, ['int', 'long', 'double', 'decimal']] }, then: { $toDouble: scoreField } },
        {
          case: { $in: [{ $type: confidenceField }, ['int', 'long', 'double', 'decimal']] },
          then: { $multiply: [sentimentDirectionExpr(sentimentField), { $toDouble: confidenceField }] },
        },
      ],
      default: sentimentDirectionExpr(sentimentField),
    },
  }
}

function tickerCandidateStages() {
  return [
    {
      $addFields: {
        _ticker_primary_values_raw: {
          $setUnion: [
            [{ $ifNull: ['$ticker', ''] }],
            [{ $ifNull: ['$symbol', ''] }],
            [{ $ifNull: ['$cashtag', ''] }],
            { $cond: [{ $isArray: '$tickers_mentioned' }, '$tickers_mentioned', []] },
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
            {
              $setUnion: [
                { $cond: [{ $isArray: '$matched_mover_tickers' }, '$matched_mover_tickers', []] },
                { $ifNull: ['$_ticker_text_cashtags', []] },
              ],
            },
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
            cond: { $regexMatch: { input: '$$candidate', regex: '^[A-Z][A-Z0-9]{0,5}$' } },
          },
        },
      },
    },
  ]
}

function articlePipeline(days, limit) {
  return [
    { $match: { ...recentMatch(days), ticker: { $exists: true, $nin: ['', null] } } },
    {
      $addFields: {
        _ticker_values_raw: {
          $map: {
            input: { $split: [{ $toUpper: { $toString: '$ticker' } }, ','] },
            as: 'ticker_part',
            in: { $trim: { input: '$$ticker_part' } },
          },
        },
      },
    },
    { $addFields: { _ticker_primary_values_raw: '$_ticker_values_raw' } },
    ...tickerCandidateStages().slice(1),
    { $unwind: '$_ticker_candidates' },
    { $match: { _ticker_candidates: { $nin: Array.from(NON_STOCK_TICKERS) } } },
    {
      $group: {
        _id: '$_ticker_candidates',
        count: { $sum: 1 },
        bullish: { $sum: { $cond: [{ $gt: [sentimentScoreExpr(), 0.08] }, 1, 0] } },
        bearish: { $sum: { $cond: [{ $lt: [sentimentScoreExpr(), -0.08] }, 1, 0] } },
        neutral: { $sum: { $cond: [{ $lte: [{ $abs: sentimentScoreExpr() }, 0.08] }, 1, 0] } },
        score_sum: { $sum: sentimentScoreExpr() },
        sources: { $addToSet: '$source' },
        latest_publish: { $max: '$publish_date' },
      },
    },
    { $sort: { count: -1, latest_publish: -1 } },
    { $limit: Math.max(1, Math.min(500, Number(limit || 300))) },
  ]
}

function socialPipeline(days, limit) {
  return [
    { $match: recentMatch(days) },
    ...tickerCandidateStages(),
    { $unwind: '$_ticker_candidates' },
    { $match: { _ticker_candidates: { $nin: Array.from(NON_STOCK_TICKERS) } } },
    {
      $group: {
        _id: '$_ticker_candidates',
        count: { $sum: 1 },
        bullish: { $sum: { $cond: [{ $gt: [sentimentScoreExpr({ confidenceField: '$sentiment_score' }), 0.08] }, 1, 0] } },
        bearish: { $sum: { $cond: [{ $lt: [sentimentScoreExpr({ confidenceField: '$sentiment_score' }), -0.08] }, 1, 0] } },
        neutral: { $sum: { $cond: [{ $lte: [{ $abs: sentimentScoreExpr({ confidenceField: '$sentiment_score' }) }, 0.08] }, 1, 0] } },
        score_sum: { $sum: sentimentScoreExpr({ confidenceField: '$sentiment_score' }) },
        platforms: { $addToSet: { $ifNull: ['$platform', '$source'] } },
        latest_post: { $max: { $ifNull: ['$fetched_at', { $ifNull: ['$timestamp', '$created_at'] }] } },
      },
    },
    { $sort: { count: -1, latest_post: -1 } },
    { $limit: Math.max(1, Math.min(1000, Number(limit || 500))) },
  ]
}

function evidenceScore(row, prior = 8) {
  const count = Number(row?.count || 0)
  if (!count) return 0
  const rawMean = Number(row?.score_sum || 0) / Math.max(1, count)
  return clamp(rawMean * (count / (count + prior)), -1, 1)
}

function evidenceConfidence(count, target = 40) {
  return clamp(Math.log1p(Number(count || 0)) / Math.log1p(target), 0, 1)
}

function weightedPearson(rows, xKey, yKey, weightKey) {
  const pairs = rows
    .map(row => [Number(row[xKey]), Number(row[yKey]), Math.max(0, Number(row[weightKey] || 0))])
    .filter(([x, y, w]) => Number.isFinite(x) && Number.isFinite(y) && w > 0)
  const totalW = pairs.reduce((sum, [, , w]) => sum + w, 0)
  if (pairs.length < 5 || totalW <= 0) return null

  const meanX = pairs.reduce((sum, [x, , w]) => sum + x * w, 0) / totalW
  const meanY = pairs.reduce((sum, [, y, w]) => sum + y * w, 0) / totalW
  let cov = 0
  let varX = 0
  let varY = 0
  for (const [x, y, w] of pairs) {
    const dx = x - meanX
    const dy = y - meanY
    cov += w * dx * dy
    varX += w * dx * dx
    varY += w * dy * dy
  }
  const denom = Math.sqrt(varX * varY)
  if (!denom) return null
  return Number(clamp(cov / denom, -1, 1).toFixed(3))
}

function weightedPearsonStats(rows, xKey, yKey, weightKey) {
  const pairs = rows
    .map(row => [Number(row[xKey]), Number(row[yKey]), Math.max(0, Number(row[weightKey] || 0))])
    .filter(([x, y, w]) => Number.isFinite(x) && Number.isFinite(y) && w > 0)
  const totalW = pairs.reduce((sum, [, , w]) => sum + w, 0)
  if (pairs.length < 5 || totalW <= 0) {
    return { r: null, n: pairs.length, total_weight: Number(totalW.toFixed(3)), effective_n: pairs.length }
  }

  const r = weightedPearson(rows, xKey, yKey, weightKey)
  const sumW2 = pairs.reduce((sum, [, , w]) => sum + w * w, 0)
  const effectiveN = sumW2 ? (totalW * totalW) / sumW2 : pairs.length
  return {
    r,
    n: pairs.length,
    total_weight: Number(totalW.toFixed(3)),
    effective_n: Number(effectiveN.toFixed(1)),
  }
}

function averageValue(rows, key) {
  const values = rows.map(row => Number(row[key])).filter(Number.isFinite)
  if (!values.length) return null
  return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(3))
}

function interpretPearson(value) {
  if (!Number.isFinite(Number(value))) return 'Not enough reliable rows for a true Pearson reading yet.'
  const abs = Math.abs(Number(value))
  if (abs < 0.1) return 'Weak linear relationship right now. That can be accurate when sentiment and price are moving independently across tickers.'
  if (abs < 0.3) return 'Mild linear relationship across reliable ticker rows.'
  if (abs < 0.6) return 'Moderate linear relationship across reliable ticker rows.'
  return 'Strong linear relationship across reliable ticker rows.'
}

function buildEntry(ticker, articleRow, socialRow, quote, days) {
  const exchange = normalizeExchange(quote?.exchange)
  const changePct = Number(quote?.change_pct ?? quote?.change_percent)
  const price = Number(quote?.price)
  if (!US_EXCHANGES.has(exchange)) return null
  if (!Number.isFinite(price) || price <= 0) return null
  if (!Number.isFinite(changePct)) return null
  if (Math.abs(changePct) > MAX_SIGNAL_CHANGE_PCT) return null

  const articleCount = Number(articleRow?.count || 0)
  const socialCount = Number(socialRow?.count || 0)
  const newsSentiment = evidenceScore(articleRow, 8)
  const socialSentiment = evidenceScore(socialRow, 20)
  const articleConfidence = evidenceConfidence(articleCount, 25)
  const socialConfidence = evidenceConfidence(socialCount, 80)
  const evidenceCount = articleCount + socialCount
  if (evidenceCount < 1) return null
  const previousClose = Number(quote?.previous_close)
  const priceMoveValid = Math.abs(changePct) >= 0.05
  const flatPreviousClose = Number.isFinite(previousClose)
    && Math.abs(previousClose - price) <= Math.max(0.0001, price * 0.000001)
    && Math.abs(changePct) < 0.05

  const newsWeight = articleCount ? 2.0 * articleConfidence : 0
  const socialWeight = socialCount ? 0.9 * socialConfidence : 0
  const weightTotal = newsWeight + socialWeight
  const combinedSentiment = weightTotal
    ? (newsSentiment * newsWeight + socialSentiment * socialWeight) / weightTotal
    : 0
  const priceMomentum = clamp(changePct / 20, -1, 1)
  const robustPriceMomentum = clamp(changePct / 20, -1, 1)
  const evidenceReliability = clamp((newsWeight + socialWeight) / 2.9, 0.05, 1)
  const sentimentPressure = combinedSentiment * evidenceReliability
  const newsPressure = newsSentiment * (articleCount ? articleConfidence : 0)
  const socialPressure = socialSentiment * (socialCount ? socialConfidence : 0)
  const directionalAlignment = Math.sign(combinedSentiment || 0) === Math.sign(changePct || 0) ? 1 : -1
  const alignedEnough = Math.abs(combinedSentiment) >= 0.03 && Math.abs(changePct) >= 0.1
  const signal = alignedEnough
    ? directionalAlignment * evidenceReliability * (Math.abs(combinedSentiment) * 0.55 + Math.abs(priceMomentum) * 0.45)
    : 0

  return {
    ticker,
    correlation: Number(clamp(signal, -0.95, 0.95).toFixed(3)),
    signal_score: Number(clamp(signal, -0.95, 0.95).toFixed(3)),
    p_value: null,
    sample_size: evidenceCount,
    evidence_count: evidenceCount,
    article_count: articleCount,
    social_count: socialCount,
    window_days: days,
    news_sentiment: Number(newsSentiment.toFixed(3)),
    social_sentiment: Number(socialSentiment.toFixed(3)),
    combined_sentiment: Number(combinedSentiment.toFixed(3)),
    sentiment_pressure: Number(sentimentPressure.toFixed(3)),
    news_pressure: Number(newsPressure.toFixed(3)),
    social_pressure: Number(socialPressure.toFixed(3)),
    reliability_weight: Number(evidenceReliability.toFixed(3)),
    price_momentum: Number(priceMomentum.toFixed(3)),
    robust_price_momentum: Number(robustPriceMomentum.toFixed(3)),
    price_move_valid: priceMoveValid,
    flat_previous_close: flatPreviousClose,
    change_pct: Number(changePct.toFixed(3)),
    price: Number(price.toFixed(4)),
    previous_close: Number.isFinite(previousClose) ? Number(previousClose.toFixed(4)) : null,
    exchange,
    quote_source: quote?.quote_source || null,
    quote_time: quote?.quote_time || null,
    quote_updated_at: quote?.quote_updated_at || null,
    quote_status: quote?.quote_status || 'priced',
    bullish_count: Number(articleRow?.bullish || 0) + Number(socialRow?.bullish || 0),
    bearish_count: Number(articleRow?.bearish || 0) + Number(socialRow?.bearish || 0),
    neutral_count: Number(articleRow?.neutral || 0),
    confidence: Number(evidenceReliability.toFixed(3)),
    evidence_quality: evidenceCount >= 10 && evidenceReliability >= 0.35
      ? 'high'
      : evidenceCount >= 3 && evidenceReliability >= 0.15
        ? 'medium'
        : 'thin',
    direction: signal > 0 ? 'aligned' : signal < 0 ? 'divergent' : 'neutral',
    sources: [...(articleRow?.sources || []), ...(socialRow?.platforms || [])].filter(Boolean).slice(0, 8),
    generated: true,
    signal_type: 'evidence_weighted_sentiment_price_alignment',
    methodology: 'Evidence-weighted sentiment uses Bayesian shrinkage so one bullish article cannot produce a perfect score. Row values are alignment signals; summary Pearson r compares sentiment pressure against robust price movement across reliable rows.',
    updated_at: new Date(),
  }
}

async function generatedCorrelations({ days = 2, limit = 150 } = {}) {
  const db = mongoose.connection.db
  if (!db) return []

  const requestedLimit = Math.max(1, Math.min(500, Number(limit || 150)))
  const [articleRows, socialRows] = await Promise.all([
    db.collection('articles').aggregate(articlePipeline(days, requestedLimit * 2)).toArray(),
    db.collection('socials').aggregate(socialPipeline(days, requestedLimit * 4)).toArray(),
  ])

  const articleMap = new Map(articleRows.map(row => [normalizeTicker(row._id), row]).filter(([ticker]) => ticker))
  const socialMap = new Map(socialRows.map(row => [normalizeTicker(row._id), row]).filter(([ticker]) => ticker))
  const tickers = Array.from(new Set([...articleMap.keys(), ...socialMap.keys()])).filter(Boolean)
  if (!tickers.length) return []

  const quoteDocs = await db.collection('screeners').find({ ticker: { $in: tickers } }).toArray()
  const quoteMap = new Map(quoteDocs.map(doc => [normalizeTicker(doc.ticker), doc]).filter(([ticker]) => ticker))

  return tickers
    .map(ticker => buildEntry(ticker, articleMap.get(ticker), socialMap.get(ticker), quoteMap.get(ticker), days))
    .filter(Boolean)
    .sort((a, b) => {
      const absDiff = Math.abs(b.correlation || 0) - Math.abs(a.correlation || 0)
      if (absDiff !== 0) return absDiff
      return Number(b.sample_size || 0) - Number(a.sample_size || 0)
    })
    .slice(0, requestedLimit)
}

router.get('/', async (req, res) => {
  try {
    const days = Number(req.query.days || 2)
    const limit = Number(req.query.limit || 150)
    const entries = await generatedCorrelations({ days, limit })
    const aligned = entries.filter(row => (row.correlation || 0) > 0).length
    const divergent = entries.filter(row => (row.correlation || 0) < 0).length
    const neutral = entries.length - aligned - divergent
    const reliableEntries = entries.filter(row => Number(row.evidence_count || 0) >= 3 && Number(row.reliability_weight || 0) >= 0.15)
    const priceReliableEntries = reliableEntries.filter(row => row.price_move_valid !== false)
    const pearsonStats = weightedPearsonStats(reliableEntries, 'sentiment_pressure', 'robust_price_momentum', 'reliability_weight')
    const rawPearsonStats = weightedPearsonStats(priceReliableEntries, 'combined_sentiment', 'robust_price_momentum', 'reliability_weight')
    const pricePearsonStats = weightedPearsonStats(priceReliableEntries, 'sentiment_pressure', 'robust_price_momentum', 'reliability_weight')
    const weightedR = pricePearsonStats.r
    const avgAbsSignal = entries.length
      ? entries.reduce((sum, row) => sum + Math.abs(Number(row.correlation || 0)), 0) / entries.length
      : 0
    const directionalRows = priceReliableEntries.filter(row => Math.abs(Number(row.sentiment_pressure || 0)) >= 0.02 && Math.abs(Number(row.robust_price_momentum || 0)) >= 0.005)
    const alignedDirectional = directionalRows.filter(row => Math.sign(Number(row.sentiment_pressure || 0)) === Math.sign(Number(row.robust_price_momentum || 0))).length
    const directionalAlignmentRate = directionalRows.length ? alignedDirectional / directionalRows.length : null

    res.json({
      entries,
      results: entries,
      count: entries.length,
      signal_type: 'evidence_weighted_sentiment_price_alignment',
      correlation_method: weightedR == null ? 'insufficient_reliable_price_samples' : 'weighted_cross_sectional_pearson_price_reliable_rows_sentiment_pressure_vs_robust_price_momentum',
      methodology: 'Row values are evidence-weighted alignment signals. Sentiment is shrunk toward neutral when evidence is thin. Pearson r compares sentiment pressure, not plain average sentiment, against robust price movement so high-volume flat mega-cap chatter does not dominate.',
      summary: {
        aligned,
        divergent,
        neutral,
        reliable_rows: reliableEntries.length,
        price_valid_rows: priceReliableEntries.length,
        flat_price_rows: reliableEntries.length - priceReliableEntries.length,
        thin_rows: entries.length - reliableEntries.length,
        pearson_correlation: weightedR,
        pearson_stats: pricePearsonStats,
        pearson_stats_before_price_filter: pearsonStats,
        raw_sentiment_pearson_stats: rawPearsonStats,
        raw_sentiment_pearson: rawPearsonStats.r,
        avg_abs_correlation: weightedR == null ? null : Math.abs(weightedR),
        avg_abs_alignment: Number(avgAbsSignal.toFixed(3)),
        directional_alignment_rate: directionalAlignmentRate == null ? null : Number(directionalAlignmentRate.toFixed(3)),
        directional_rows: directionalRows.length,
        interpretation: interpretPearson(weightedR),
        avg_news_sentiment: averageValue(entries, 'news_sentiment'),
        avg_social_sentiment: averageValue(entries, 'social_sentiment'),
        avg_combined_sentiment: averageValue(entries, 'combined_sentiment'),
        avg_change_pct: averageValue(entries, 'change_pct'),
        strongest: entries[0] || null,
      },
      true_correlation_available: weightedR != null,
      excluded: {
        exchanges: 'non NASDAQ/NYSE/AMEX',
        max_abs_change_pct: MAX_SIGNAL_CHANGE_PCT,
        thin_evidence: 'shrunk toward neutral instead of scored as perfect',
      },
      accuracy: {
        accuracy_1h: null,
        accuracy_24h: null,
      },
      days,
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.post('/run', async (req, res) => {
  try {
    const rows = await generatedCorrelations({ days: Number(req.query.days || req.body?.days || 2), limit: 300 })
    if (rows.length) {
      await Correlation.deleteMany({ ticker: { $nin: rows.map(row => row.ticker) } })
      await Correlation.bulkWrite(rows.map(row => ({
        updateOne: {
          filter: { ticker: row.ticker },
          update: { $set: { ...row, updated_at: new Date() } },
          upsert: true,
        },
      })))
    }

    res.json({
      success: true,
      saved: rows.length,
      signal_type: 'evidence_weighted_sentiment_price_alignment',
      message: `Generated ${rows.length} evidence-weighted correlation signals.`,
    })
  } catch (err) {
    res.status(500).json({ success: false, error: err.message })
  }
})

export default router
