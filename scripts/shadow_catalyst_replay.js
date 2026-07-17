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

function toNumber(value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function eventSec(doc = {}) {
  const value = doc.published_at || doc.publishedAt || doc.publish_time || doc.pubDate || doc.date || doc.created_at || doc.detected_at || doc.ingested_at
  if (value instanceof Date) return Math.floor(value.getTime() / 1000)
  if (typeof value === 'number') return value > 1e12 ? Math.floor(value / 1000) : Math.floor(value)
  const parsed = Date.parse(String(value || ''))
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0
}

function ingestSec(doc = {}) {
  const value = doc.detected_at || doc.ingested_at || doc.created_at || doc.updated_at || doc.first_seen_at
  if (value instanceof Date) return Math.floor(value.getTime() / 1000)
  if (typeof value === 'number') return value > 1e12 ? Math.floor(value / 1000) : Math.floor(value)
  const parsed = Date.parse(String(value || ''))
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0
}

function iso(sec) {
  return sec ? new Date(sec * 1000).toISOString() : null
}

function pct(from, to) {
  const a = Number(from)
  const b = Number(to)
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0) return null
  return Number((((b - a) / a) * 100).toFixed(3))
}

function normalizeCandle(doc = {}) {
  const time = toNumber(doc.minute ?? doc.time ?? doc.timestamp ?? doc.date, 0)
  const close = Number(doc.close ?? doc.price)
  const open = Number(doc.open)
  const high = Number(doc.high)
  const low = Number(doc.low)
  if (!time || !Number.isFinite(close) || close <= 0) return null
  const candle = {
    time: Math.floor(time / 60) * 60,
    open: Number.isFinite(open) && open > 0 ? open : close,
    high: Number.isFinite(high) && high > 0 ? high : close,
    low: Number.isFinite(low) && low > 0 ? low : close,
    close,
    volume: Number.isFinite(Number(doc.volume)) ? Number(doc.volume) : 0,
    providerInterval: doc.providerInterval || doc.interval || null,
    providerIntervalSec: toNumber(doc.providerIntervalSec, null),
    source: doc.source || 'mongo_ohlcv_bars',
  }
  if (candle.high < Math.max(candle.open, candle.close, candle.low)) return null
  if (candle.low > Math.min(candle.open, candle.close, candle.high)) return null
  return candle
}

async function loadOhlcCandles(db, ticker, startSec, endSec) {
  if (!ticker || !startSec || !endSec || endSec <= startSec) return []
  const docs = await db.collection('ohlcv_bars').find({
    ticker: String(ticker).toUpperCase(),
    minute: { $gte: Math.max(0, startSec), $lte: endSec },
  }, {
    projection: {
      _id: 0,
      ticker: 1,
      minute: 1,
      time: 1,
      timestamp: 1,
      date: 1,
      open: 1,
      high: 1,
      low: 1,
      close: 1,
      price: 1,
      volume: 1,
      source: 1,
      providerInterval: 1,
      providerIntervalSec: 1,
    },
  }).sort({ minute: 1 }).limit(20000).toArray()
  const byMinute = new Map()
  for (const candle of docs.map(normalizeCandle).filter(Boolean)) {
    const existing = byMinute.get(candle.time)
    if (!existing || Number(existing.providerIntervalSec || Infinity) > Number(candle.providerIntervalSec || Infinity)) {
      byMinute.set(candle.time, candle)
    }
  }
  return [...byMinute.values()].sort((a, b) => a.time - b.time)
}

function providerIntervalSec(interval = '1m') {
  const text = String(interval || '').toLowerCase()
  const match = text.match(/^(\d+)(m|h|d)$/)
  if (!match) return 60
  const value = Number(match[1])
  if (match[2] === 'h') return value * 3600
  if (match[2] === 'd') return value * 86400
  return value * 60
}

async function fetchYahooCandles(ticker, range = '5d', interval = '1m') {
  const symbol = String(ticker || '').toUpperCase()
  if (!symbol) return []
  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`)
  url.searchParams.set('range', range)
  url.searchParams.set('interval', interval)
  url.searchParams.set('includePrePost', 'true')
  url.searchParams.set('events', 'history')
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'FeedFlashStockDashboard/0.1',
      Accept: 'application/json',
    },
  })
  if (!response.ok) throw new Error(`chart provider HTTP ${response.status}`)
  const payload = await response.json()
  const result = payload?.chart?.result?.[0]
  const timestamps = result?.timestamp || []
  const quote = result?.indicators?.quote?.[0] || {}
  const bars = []
  const intervalSec = providerIntervalSec(interval)
  for (let i = 0; i < timestamps.length; i += 1) {
    const minute = Math.floor(Number(timestamps[i]) / 60) * 60
    const close = Number(quote.close?.[i])
    if (!minute || !Number.isFinite(close) || close <= 0) continue
    const open = Number(quote.open?.[i])
    const high = Number(quote.high?.[i])
    const low = Number(quote.low?.[i])
    const volume = Number(quote.volume?.[i])
    const candle = normalizeCandle({
      ticker: symbol,
      minute,
      open: Number.isFinite(open) && open > 0 ? open : close,
      high: Number.isFinite(high) && high > 0 ? high : close,
      low: Number.isFinite(low) && low > 0 ? low : close,
      close,
      price: close,
      volume: Number.isFinite(volume) && volume >= 0 ? volume : 0,
      source: 'yahoo_chart_ohlcv',
      providerRange: range,
      providerInterval: interval,
      providerIntervalSec: intervalSec,
    })
    if (candle) {
      bars.push({
        ...candle,
        ticker: symbol,
        minute: candle.time,
        price: candle.close,
        providerRange: range,
        providerInterval: interval,
        providerIntervalSec: intervalSec,
        source: 'yahoo_chart_ohlcv',
      })
    }
  }
  return bars
}

async function persistOhlcCandles(db, candles = []) {
  const valid = candles.filter(candle => candle?.ticker && candle?.minute && candle?.close > 0)
  if (!valid.length) return { attempted: 0, upserted: 0, modified: 0 }
  const collection = db.collection('ohlcv_bars')
  await collection.createIndex({ source: 1, ticker: 1, minute: 1 }, { unique: true })
  await collection.createIndex({ ticker: 1, minute: 1 })
  const ops = valid.map(candle => ({
    updateOne: {
      filter: { source: candle.source || 'yahoo_chart_ohlcv', ticker: candle.ticker, minute: candle.minute },
      update: {
        $set: {
          ticker: candle.ticker,
          minute: candle.minute,
          time: new Date(candle.minute * 1000),
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
          price: candle.close,
          volume: candle.volume,
          source: candle.source || 'yahoo_chart_ohlcv',
          providerRange: candle.providerRange,
          providerInterval: candle.providerInterval,
          providerIntervalSec: candle.providerIntervalSec,
          updatedAt: new Date(),
        },
        $setOnInsert: { createdAt: new Date() },
      },
      upsert: true,
    },
  }))
  const result = await collection.bulkWrite(ops, { ordered: false })
  return {
    attempted: valid.length,
    upserted: Number(result.upsertedCount || 0),
    modified: Number(result.modifiedCount || 0),
  }
}

function outcomeFromCandles(best, candles = [], options = {}) {
  if (!best) return { status: 'missing_catalyst', reason: 'no_best_catalyst' }
  const publish = Math.floor(Date.parse(best.published_at || '') / 1000)
  const ingest = Math.floor(Date.parse(best.ingested_at || '') / 1000)
  const signalSec = Math.max(Number.isFinite(publish) ? publish : 0, Number.isFinite(ingest) ? ingest : 0)
  if (!signalSec) return { status: 'missing_signal_time', reason: 'missing_publish_and_ingest_time' }
  if (!candles.length) return { status: 'missing_ohlc', reason: 'no_mongo_ohlcv_bars', signal_sec: signalSec, signal_at: iso(signalSec) }
  const asOfSec = Number(options.asOfSec || 0)
  const horizonMinutes = Math.max(1, Number(options.horizonMinutes || 390))
  const horizonEndSec = Math.min(asOfSec || signalSec + horizonMinutes * 60, signalSec + horizonMinutes * 60)
  const prior = candles.filter(c => c.time <= signalSec).at(-1) || null
  const entryIndex = candles.findIndex(c => c.time > signalSec)
  if (entryIndex < 0) {
    return {
      status: 'missing_entry_bar',
      reason: 'no_bar_after_signal',
      signal_sec: signalSec,
      signal_at: iso(signalSec),
      ohlc_first_at: iso(candles[0]?.time),
      ohlc_last_at: iso(candles.at(-1)?.time),
      prior_close: prior?.close ?? null,
    }
  }
  const entry = candles[entryIndex]
  const horizonCandles = candles.slice(entryIndex).filter(c => c.time <= horizonEndSec)
  if (!horizonCandles.length) {
    return {
      status: 'missing_horizon_bars',
      reason: 'no_bars_inside_replay_horizon',
      signal_sec: signalSec,
      signal_at: iso(signalSec),
      entry_sec: entry.time,
      entry_at: iso(entry.time),
      ohlc_first_at: iso(candles[0]?.time),
      ohlc_last_at: iso(candles.at(-1)?.time),
    }
  }
  const entryPrice = entry.open || entry.close
  const highCandle = horizonCandles.reduce((bestCandle, candle) => Number(candle.high) > Number(bestCandle.high) ? candle : bestCandle, horizonCandles[0])
  const lowCandle = horizonCandles.reduce((bestCandle, candle) => Number(candle.low) < Number(bestCandle.low) ? candle : bestCandle, horizonCandles[0])
  const last = horizonCandles.at(-1)
  const priorReactionPct = prior?.close ? pct(prior.close, entryPrice) : null
  const mfePct = pct(entryPrice, highCandle.high)
  const maePct = pct(entryPrice, lowCandle.low)
  const finalReturnPct = pct(entryPrice, last.close)
  return {
    status: 'labeled',
    source: 'mongo_ohlcv_bars',
    signal_sec: signalSec,
    signal_at: iso(signalSec),
    publish_at: best.published_at || null,
    ingest_at: best.ingested_at || null,
    entry_sec: entry.time,
    entry_at: iso(entry.time),
    entry_price: Number(entryPrice.toFixed(4)),
    entry_latency_min: Number(((entry.time - signalSec) / 60).toFixed(1)),
    horizon_minutes_requested: horizonMinutes,
    horizon_end_sec: horizonEndSec,
    horizon_end_at: iso(horizonEndSec),
    label_end_sec: last.time,
    label_end_at: iso(last.time),
    bars_used: horizonCandles.length,
    ohlc_first_at: iso(candles[0]?.time),
    ohlc_last_at: iso(candles.at(-1)?.time),
    prior_close: prior?.close != null ? Number(prior.close.toFixed(4)) : null,
    prior_to_entry_return_pct: priorReactionPct,
    max_favorable_excursion_pct: mfePct,
    max_adverse_excursion_pct: maePct,
    final_return_pct: finalReturnPct,
    high_price: Number(highCandle.high.toFixed(4)),
    high_at: iso(highCandle.time),
    low_price: Number(lowCandle.low.toFixed(4)),
    low_at: iso(lowCandle.time),
    ended_before_requested_horizon: last.time < horizonEndSec,
    win_mfe_gt_2pct: mfePct != null ? mfePct >= 2 : null,
    win_final_positive: finalReturnPct != null ? finalReturnPct > 0 : null,
    already_priced_before_entry: priorReactionPct != null ? priorReactionPct >= 5 : null,
  }
}

function summarizeOutcomes(rows = []) {
  const outcomes = rows.map(row => row.outcome).filter(Boolean)
  const labeled = outcomes.filter(o => o.status === 'labeled')
  const nums = (field) => labeled.map(o => Number(o[field])).filter(Number.isFinite)
  const avg = (field) => {
    const values = nums(field)
    return values.length ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(3)) : null
  }
  const median = (field) => {
    const values = nums(field).sort((a, b) => a - b)
    if (!values.length) return null
    const mid = Math.floor(values.length / 2)
    return values.length % 2 ? values[mid] : Number(((values[mid - 1] + values[mid]) / 2).toFixed(3))
  }
  const countBy = outcomes.reduce((acc, outcome) => {
    const key = outcome.status || 'unknown'
    acc[key] = (acc[key] || 0) + 1
    return acc
  }, {})
  return {
    total: outcomes.length,
    labeled: labeled.length,
    status_counts: countBy,
    precision_mfe_gt_2pct: labeled.length ? Number((labeled.filter(o => o.win_mfe_gt_2pct).length / labeled.length).toFixed(3)) : null,
    final_positive_rate: labeled.length ? Number((labeled.filter(o => o.win_final_positive).length / labeled.length).toFixed(3)) : null,
    already_priced_before_entry_rate: labeled.length ? Number((labeled.filter(o => o.already_priced_before_entry).length / labeled.length).toFixed(3)) : null,
    avg_mfe_pct: avg('max_favorable_excursion_pct'),
    median_mfe_pct: median('max_favorable_excursion_pct'),
    avg_mae_pct: avg('max_adverse_excursion_pct'),
    median_mae_pct: median('max_adverse_excursion_pct'),
    avg_final_return_pct: avg('final_return_pct'),
    median_final_return_pct: median('final_return_pct'),
    avg_entry_latency_min: avg('entry_latency_min'),
  }
}

function articleTickers(doc = {}) {
  const raw = doc.tickers || doc.symbols || doc.related_tickers || doc.matched_tickers || doc.ticker || doc.symbol || ''
  const list = Array.isArray(raw) ? raw : String(raw).split(/[,\s]+/)
  return [...new Set(list.map(v => String(v || '').trim().toUpperCase()).filter(Boolean))]
}

function textOf(doc = {}) {
  return [doc.title, doc.headline, doc.summary, doc.event_type, doc.category, doc.catalyst_category].filter(Boolean).join(' ')
}

function parseMoneyAmount(text = '') {
  const clean = String(text || '').replace(/,/g, '')
  const patterns = [
    /(?:us\$|usd|\$)\s*([0-9]+(?:\.[0-9]+)?)\s*(billion|million|bn|m|k)?/ig,
    /([0-9]+(?:\.[0-9]+)?)\s*(billion|million|bn|m)\s+(?:usd|us dollars|dollars)/ig,
  ]
  let best = null
  for (const pattern of patterns) {
    for (const match of clean.matchAll(pattern)) {
      const raw = Number(match[1])
      if (!Number.isFinite(raw) || raw <= 0) continue
      const unit = String(match[2] || '').toLowerCase()
      const multiplier = /billion|bn/.test(unit) ? 1_000_000_000 : /million|m/.test(unit) ? 1_000_000 : /k/.test(unit) ? 1_000 : 1
      const amount = raw * multiplier
      if (best == null || amount > best) best = amount
    }
  }
  return best
}

function classifyCatalyst(doc = {}, screener = {}) {
  const text = textOf(doc).toLowerCase()
  const title = String(doc.title || doc.headline || '').trim()
  const marketCap = toNumber(screener.market_cap ?? screener.marketCap, null)
  const amount = parseMoneyAmount(title)
  const amountToCapPct = amount != null && marketCap ? Number((amount / marketCap * 100).toFixed(2)) : null
  let category = 'ordinary_news'
  let direction = 'neutral'
  let base = 12
  let rejection = null
  if (!title) rejection = 'no_direct_catalyst'
  else if (/top\s+.*gainers|stocks? moving|why shares|market movers|market update|crude oil surges|roundup/.test(text)) {
    category = 'roundup_or_recap'; rejection = 'stale_recap'; base = 3
  } else if (/rest of the sector|sector is being repriced|sector read.?through|peer read.?through/.test(text)) {
    category = 'indirect_sector_readthrough'; rejection = 'indirect_ticker_match'; base = 5
  } else if (/reverse[_ -]?split|share[_ -]?consolidation/.test(text)) {
    category = 'capital_structure_risk'; direction = 'negative'; rejection = 'reverse_split_noise'; base = 2
  } else if (/offering|dilution|atm\b|warrant|convertible|registered direct|public offering/.test(text)) {
    category = 'dilution_or_financing_risk'; direction = /fund.{0,40}pipeline|runway|secures?.{0,40}financing|private placement/.test(text) ? 'mixed' : 'negative'; rejection = 'dilution_risk'; base = direction === 'mixed' ? 22 : 2
  } else if (/lawsuit|class action|investigation|delisting|bankruptcy|default|downgrade|price target cut|guidance cut/.test(text)) {
    category = 'negative_event'; direction = 'negative'; rejection = 'bearish_catalyst'; base = 2
  } else if (/announces? date|announces? schedule|conference call|to report|monthly update|weekly share repurchase|director\/pdmr|shareholding|shareholder approval|annual general|special meeting|maintained at|reiterates? guidance/.test(text)) {
    category = 'routine_news'; rejection = 'routine_news'; base = 6
  } else if (/merger|acquisition|completed acquisition|definitive agreement|business combination|buyout|takeover|tender offer/.test(text)) {
    category = 'merger_acquisition'; direction = 'positive'; base = 42
  } else if (/fda|pdufa|clearance|approval|breakthrough|orphan drug|fast track|phase\s*(1|2|3)|clinical|trial|endpoint|topline|data readout/.test(text)) {
    category = 'biotech_regulatory_or_trial'; direction = 'positive'; base = 40
  } else if (/contract|award|purchase order|supply agreement|government award|defence|defense|navy|army|air force/.test(text)) {
    category = 'contract_award'; direction = 'positive'; base = 32
  } else if (/partnership|collaboration|license agreement|commercial agreement|distribution agreement|strategic alliance/.test(text)) {
    category = 'partnership_commercial'; direction = 'positive'; base = 30
  } else if (/private placement|secures?.{0,40}(financing|capital)|financing.{0,40}(pipeline|runway)|fund.{0,40}pipeline|non.?dilutive|grant|credit facility/.test(text)) {
    category = 'financing_runway'; direction = /offering|warrant|convertible|registered direct/.test(text) ? 'mixed' : 'positive'; base = direction === 'mixed' ? 26 : 34
  } else if (/earnings|revenue|eps|guidance|raises? outlook|raises? forecast|beats?|record sales|profitability|ebitda|annualized/.test(text)) {
    category = 'earnings_guidance'; direction = /miss|cut|below|loss widens/.test(text) ? 'negative' : 'positive'; base = direction === 'positive' ? 30 : 4
    if (direction !== 'positive') rejection = 'bearish_catalyst'
  } else if (/analyst|upgrade|price target|initiates?|buy rating/.test(text)) {
    category = 'analyst_action'; direction = /downgrade|cut|lower/.test(text) ? 'negative' : 'positive'; base = direction === 'positive' ? 18 : 3
  }

  let materiality = 10
  if (amountToCapPct != null && ['merger_acquisition', 'biotech_regulatory_or_trial', 'contract_award', 'partnership_commercial', 'financing_runway', 'earnings_guidance'].includes(category)) {
    materiality = amountToCapPct >= 50 ? 30 : amountToCapPct >= 20 ? 25 : amountToCapPct >= 5 ? 18 : amountToCapPct >= 2 ? 10 : 3
    if (['contract_award', 'financing_runway', 'earnings_guidance'].includes(category) && amountToCapPct < 2 && marketCap >= 1_000_000_000) {
      rejection = rejection || 'immaterial_for_company_size'
    }
  } else if (amountToCapPct != null && category === 'ordinary_news') {
    materiality = 4
    rejection = rejection || 'indirect_ticker_match'
  } else if (marketCap && marketCap >= 10_000_000_000 && ['contract_award', 'analyst_action', 'routine_news', 'ordinary_news'].includes(category)) {
    materiality = 4
    if (category === 'contract_award') rejection = rejection || 'immaterial_for_company_size'
  } else if (marketCap && marketCap <= 500_000_000 && ['merger_acquisition', 'biotech_regulatory_or_trial', 'financing_runway', 'contract_award', 'partnership_commercial'].includes(category)) {
    materiality = 18
  }

  const score = Math.max(0, Math.min(100, base + materiality + 18 + 10 - (rejection ? 18 : 0)))
  return { category, direction, materiality, amount_usd: amount, amount_to_market_cap_pct: amountToCapPct, score, rejection }
}

async function articlesForTicker(db, ticker, sinceSec, asOfSec) {
  const re = new RegExp(`(^|[,\\s])${ticker}([,\\s]|$)`, 'i')
  const rows = await db.collection('articles').find({
    $and: [
      {
        $or: [
          { ticker },
          { symbol: ticker },
          { tickers: ticker },
          { symbols: ticker },
          { related_tickers: ticker },
          { ticker: re },
        ],
      },
    ],
  }).sort({ published_at: 1, detected_at: 1 }).limit(200).toArray()
  return rows.filter(doc => {
    const pub = eventSec(doc)
    const ing = ingestSec(doc) || pub
    return (pub || ing) >= sinceSec && (pub || ing) <= asOfSec && ing <= asOfSec
  })
}

async function latestSignal(db, ticker, sinceSec, asOfSec) {
  return db.collection('prediction_signals').find({
    ticker,
    $or: [
      { signal_sec: { $gte: sinceSec, $lte: asOfSec } },
      { created_at: { $gte: new Date(sinceSec * 1000), $lte: new Date(asOfSec * 1000) } },
    ],
  }).sort({ signal_sec: -1, created_at: -1 }).limit(1).next()
}

function summarizeArticle(doc, screener) {
  const pub = eventSec(doc)
  const ing = ingestSec(doc)
  const taxonomy = classifyCatalyst(doc, screener)
  return {
    title: doc.title || doc.headline || null,
    source: doc.source || doc.publisher || doc.feed || null,
    url: doc.url || doc.link || null,
    published_at: iso(pub),
    ingested_at: iso(ing),
    ingestion_latency_min: pub && ing ? Number(((ing - pub) / 60).toFixed(1)) : null,
    tickers: articleTickers(doc),
    event_type: doc.event_type || doc.catalyst_category || doc.category || null,
    sentiment: doc.sentiment || doc.sentiment_label || null,
    sentiment_score: doc.sentiment_score ?? doc.score ?? null,
    taxonomy,
  }
}

function capTier(screener = {}) {
  const cap = toNumber(screener.market_cap ?? screener.marketCap, 0)
  if (cap >= 200_000_000_000) return 'Mega'
  if (cap >= 10_000_000_000) return 'Large'
  if (cap >= 2_000_000_000) return 'Mid'
  if (cap >= 300_000_000) return 'Small'
  if (cap > 0) return 'Nano'
  return 'Unknown'
}

function shadowDecision(best, screener = {}) {
  if (!best) return 'source_coverage_failure_no_article'
  const taxonomy = best.taxonomy || {}
  if (taxonomy.rejection) return `would_reject_or_watch: ${taxonomy.rejection}`
  const tier = capTier(screener)
  const relVol = toNumber(screener.rel_volume ?? screener.relative_volume, 0)
  const change = toNumber(screener.change_pct ?? screener.change, 0)
  const social = toNumber(screener.social_message_count ?? screener.message_count ?? screener.stocktwits_message_count, 0)
  const socialOk = social >= 12
  const earlyMarketOk = change >= 1 || relVol >= 1.5
  const strongMateriality = toNumber(taxonomy.amount_to_market_cap_pct, 0) >= 5 || toNumber(taxonomy.score, 0) >= 78
  const largeNeeds = ['Mega', 'Large', 'Mid'].includes(tier)
  const largeOk = !largeNeeds || socialOk || relVol >= 3 || change >= 3 || toNumber(taxonomy.amount_to_market_cap_pct, 0) >= 5
  if (taxonomy.score >= 65 && (socialOk || earlyMarketOk || strongMateriality) && largeOk) return 'would_keep_or_promote_for_confirmation'
  if (!largeOk) return 'would_reject_or_watch: large_cap_needs_stronger_retail_or_volume_confirmation'
  return 'would_reject_or_watch: insufficient_early_confirmation_for_catalyst'
}

async function main() {
  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI || argValue('mongo', 'mongodb://localhost:27017/feedflash')
  const asOfSec = Math.floor(Date.parse(argValue('asOf', new Date().toISOString())) / 1000)
  const sinceSec = Math.floor(Date.parse(argValue('since', new Date((asOfSec * 1000) - 36 * 3600 * 1000).toISOString())) / 1000)
  const tickers = argValue('tickers', 'ADUR,TAK,IPGP,CACI,WSE').split(',').map(v => v.trim().toUpperCase()).filter(Boolean)
  const minPrice = toNumber(argValue('minPrice', '0.5'), 0.5)
  const minVolume = toNumber(argValue('minVolume', '100000'), 100000)
  const minDollarVolume = toNumber(argValue('minDollarVolume', '250000'), 250000)
  const minMove = toNumber(argValue('minMove', '10'), 10)
  const limit = toNumber(argValue('limit', '25'), 25)
  const horizonMinutes = Math.max(1, toNumber(argValue('horizonMinutes', '1440'), 1440))
  const hydrateOhlc = ['1', 'true', 'yes'].includes(String(argValue('hydrateOhlc', '0')).toLowerCase())
  const hydrateLimit = Math.max(0, toNumber(argValue('hydrateLimit', '25'), 25))
  const hydrateRange = argValue('hydrateRange', '5d')
  const hydrateInterval = argValue('hydrateInterval', '1m')
  const staleOhlcMinutes = Math.max(1, toNumber(argValue('staleOhlcMinutes', '30'), 30))

  await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 10000 })
  const db = mongoose.connection.db

  const screenerRows = await db.collection('screeners').find({}).toArray()
  const screenerByTicker = new Map(screenerRows.map(row => [String(row.ticker || row.symbol || '').toUpperCase(), row]))
  const ohlcCache = new Map()
  const hydrateDiagnostics = {
    enabled: hydrateOhlc,
    range: hydrateRange,
    interval: hydrateInterval,
    stale_minutes: staleOhlcMinutes,
    limit: hydrateLimit,
    attempted_tickers: 0,
    fetched_tickers: 0,
    failed_tickers: 0,
    fetched_bars: 0,
    persisted_attempted: 0,
    persisted_upserted: 0,
    persisted_modified: 0,
    skipped_limit: 0,
    errors: [],
  }
  async function candlesFor(ticker) {
    const key = String(ticker || '').toUpperCase()
    if (!key) return []
    if (!ohlcCache.has(key)) {
      let candles = await loadOhlcCandles(db, key, sinceSec - 6 * 3600, asOfSec)
      const latest = candles.at(-1)?.time || 0
      const stale = !latest || latest < asOfSec - staleOhlcMinutes * 60
      if (hydrateOhlc && stale) {
        if (hydrateDiagnostics.attempted_tickers >= hydrateLimit) {
          hydrateDiagnostics.skipped_limit += 1
        } else {
          hydrateDiagnostics.attempted_tickers += 1
          try {
            const fetched = await fetchYahooCandles(key, hydrateRange, hydrateInterval)
            hydrateDiagnostics.fetched_bars += fetched.length
            if (fetched.length) {
              hydrateDiagnostics.fetched_tickers += 1
              const persisted = await persistOhlcCandles(db, fetched)
              hydrateDiagnostics.persisted_attempted += persisted.attempted
              hydrateDiagnostics.persisted_upserted += persisted.upserted
              hydrateDiagnostics.persisted_modified += persisted.modified
              candles = await loadOhlcCandles(db, key, sinceSec - 6 * 3600, asOfSec)
            } else {
              hydrateDiagnostics.failed_tickers += 1
            }
          } catch (err) {
            hydrateDiagnostics.failed_tickers += 1
            if (hydrateDiagnostics.errors.length < 12) hydrateDiagnostics.errors.push({ ticker: key, error: String(err.message || err) })
          }
        }
      }
      ohlcCache.set(key, candles)
    }
    return ohlcCache.get(key)
  }

  const traces = []
  for (const ticker of tickers) {
    const screener = screenerByTicker.get(ticker) || {}
    const articles = await articlesForTicker(db, ticker, sinceSec, asOfSec)
    const signal = await latestSignal(db, ticker, sinceSec, asOfSec)
    const summarized = articles.map(doc => summarizeArticle(doc, screener))
    const best = summarized.slice().sort((a, b) => (b.taxonomy.score || 0) - (a.taxonomy.score || 0))[0] || null
    const candles = await candlesFor(ticker)
    const outcome = outcomeFromCandles(best, candles, { asOfSec, horizonMinutes })
    traces.push({
      ticker,
      screener: {
        company: screener.company || screener.name || null,
        exchange: screener.exchange || null,
        price: screener.price ?? screener.close ?? null,
        change_pct: screener.change_pct ?? screener.change ?? null,
        premarket_change_pct: screener.premarket_change_pct ?? null,
        postmarket_change_pct: screener.postmarket_change_pct ?? null,
        rel_volume: screener.rel_volume ?? screener.relative_volume ?? null,
        volume: screener.volume ?? null,
        market_cap: screener.market_cap ?? screener.marketCap ?? null,
        quote_updated_at: screener.quote_updated_at ? iso(toNumber(screener.quote_updated_at)) : screener.quote_updated_iso || null,
      },
      articles_used_or_available: summarized,
      best_shadow_catalyst: best,
      outcome,
      latest_prediction_signal: signal ? {
        signal_sec: signal.signal_sec || null,
        signal_at: iso(signal.signal_sec),
        rank: signal.rank ?? signal.final_rank ?? null,
        score: signal.score ?? signal.final_prediction_score ?? null,
        mode: signal.mode || signal.source || null,
        reason: signal.reason || signal.explanation || null,
      } : null,
      shadow_decision: shadowDecision(best, screener),
    })
  }

  const movers = screenerRows
    .map(row => {
      const ticker = String(row.ticker || row.symbol || '').toUpperCase()
      const price = toNumber(row.price ?? row.close, 0)
      const change = toNumber(row.change_pct ?? row.change, 0)
      const volume = toNumber(row.volume, 0)
      return {
        ticker,
        company: row.company || row.name || null,
        price,
        change_pct: change,
        premarket_change_pct: row.premarket_change_pct ?? null,
        postmarket_change_pct: row.postmarket_change_pct ?? null,
        rel_volume: row.rel_volume ?? row.relative_volume ?? null,
        volume,
        dollar_volume: price * volume,
        market_cap: row.market_cap ?? row.marketCap ?? null,
        exchange: row.exchange || null,
      }
    })
    .filter(row => row.ticker && row.price >= minPrice && row.volume >= minVolume && row.dollar_volume >= minDollarVolume && row.change_pct >= minMove)
    .sort((a, b) => b.change_pct - a.change_pct)
    .slice(0, limit)

  const missed = []
  for (const mover of movers) {
    const screener = screenerByTicker.get(mover.ticker) || {}
    const articles = await articlesForTicker(db, mover.ticker, sinceSec, asOfSec)
    const summarized = articles.map(doc => summarizeArticle(doc, screener))
    const best = summarized.slice().sort((a, b) => (b.taxonomy.score || 0) - (a.taxonomy.score || 0))[0] || null
    const candles = await candlesFor(mover.ticker)
    const outcome = outcomeFromCandles(best, candles, { asOfSec, horizonMinutes })
    let group = 'unpredictable_or_invalid_mover'
    let failure_stage = 'source_coverage_no_timely_direct_article'
    const decision = shadowDecision(best, screener)
    if (decision === 'would_keep_or_promote_for_confirmation') {
      group = 'predictable_catalyst_opportunity'
      failure_stage = 'ranking_or_classifier_missed_material_direct_catalyst'
    } else if (best) {
      group = ['stale_recap', 'routine_news'].includes(best.taxonomy.rejection) ? 'late_or_partially_catchable_opportunity' : 'unpredictable_or_invalid_mover'
      failure_stage = best.taxonomy.rejection || decision.replace(/^would_reject_or_watch:\s*/, '') || 'low_materiality_or_confirmation'
    }
    missed.push({
      ...mover,
      best_catalyst: best,
      outcome,
      group,
      failure_stage,
      articles_found: summarized.length,
    })
  }

  const grouped = missed.reduce((acc, row) => {
    acc[row.group] = acc[row.group] || []
    acc[row.group].push(row)
    return acc
  }, {})

  const report = {
    as_of: iso(asOfSec),
    since: iso(sinceSec),
    horizon_minutes: horizonMinutes,
    mode: 'shadow_read_only_no_db_writes',
    five_ticker_trace: traces,
    top_mover_missed_opportunities: missed,
    grouped_counts: Object.fromEntries(Object.entries(grouped).map(([key, rows]) => [key, rows.length])),
    validation: {
      all_top_movers: summarizeOutcomes(missed),
      predictable_catalyst_opportunities: summarizeOutcomes(grouped.predictable_catalyst_opportunity || []),
      late_or_partially_catchable_opportunities: summarizeOutcomes(grouped.late_or_partially_catchable_opportunity || []),
      five_ticker_trace: summarizeOutcomes(traces),
    },
    ohlc_coverage: {
      tickers_requested: ohlcCache.size,
      tickers_with_bars: [...ohlcCache.entries()].filter(([, candles]) => candles.length > 0).length,
      tickers_missing_bars: [...ohlcCache.entries()].filter(([, candles]) => !candles.length).map(([ticker]) => ticker).sort(),
    },
    hydrate_ohlc: hydrateDiagnostics,
    validation_limits: [
      'Uses stored Mongo articles, current screener rows, and prediction_signals only.',
      'Does not use future articles beyond --asOf.',
      'OHLC outcomes use only mongo ohlcv_bars available inside the replay window; missing symbols are reported as missing_ohlc, not fabricated.',
      'Signal time is max(publication time, ingestion time); entry is the next real stored OHLC bar after the signal.',
      'When --hydrateOhlc=1 is passed, the script fetches real Yahoo chart OHLC and persists it into Mongo before labeling; hydration is off by default.',
    ],
  }
  console.log(JSON.stringify(report, null, 2))
  await mongoose.disconnect()
}

main().catch(async err => {
  console.error(err)
  try { await mongoose.disconnect() } catch (_) {}
  process.exit(1)
})
