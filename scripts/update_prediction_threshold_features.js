#!/usr/bin/env node

import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
let mongoose
try {
  mongoose = require(path.join(__dirname, '..', 'Infrastructure', 'server', 'node_modules', 'mongoose'))
} catch (_) {
  mongoose = require('mongoose')
}
const THRESHOLD_FEATURE_POLICY_VERSION = 'density_corr_balanced_w90_candidate_v3'
const ENTRY_CORRELATION_THRESHOLD = 0.3
const MAX_PRE_SIGNAL_RETURN_60M_PCT = 5
const MIN_TRAILING_60M_MESSAGES = 3
const SETUP_NEAR_THRESHOLD_BAND = 0.05

function argValue(name, fallback = '') {
  const prefix = `--${name}=`
  const inline = process.argv.find(arg => arg.startsWith(prefix))
  if (inline) return inline.slice(prefix.length)
  const index = process.argv.indexOf(`--${name}`)
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1]
  return fallback
}

function toSec(value) {
  if (value == null || value === '') return null
  if (value instanceof Date) return Math.floor(value.getTime() / 1000)
  const n = Number(value)
  if (Number.isFinite(n) && n > 0) return n > 1_000_000_000_000 ? Math.floor(n / 1000) : Math.floor(n)
  const ms = Date.parse(String(value))
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null
}

function floorMinute(value) {
  const sec = toSec(value)
  return sec == null ? null : Math.floor(sec / 60) * 60
}

function eventSec(doc = {}) {
  return toSec(doc.fetched_at ?? doc.detected_at ?? doc.timestamp ?? doc.created_at ?? doc.publish_date)
}

function candidateTickers(doc = {}) {
  const values = []
  const push = value => {
    if (Array.isArray(value)) value.forEach(push)
    else if (typeof value === 'string') value.split(',').forEach(v => values.push(v))
    else if (value != null) values.push(String(value))
  }
  push(doc.ticker)
  push(doc.symbol)
  push(doc.cashtag)
  push(doc.tickers_mentioned)
  if (!values.some(v => String(v).trim())) {
    const text = `${doc.text || ''} ${doc.content || ''} ${doc.title || ''} ${doc.summary || ''}`
    for (const match of text.matchAll(/\$[A-Za-z][A-Za-z0-9.-]{0,5}\b/g)) values.push(match[0])
  }
  const seen = new Set()
  return values
    .map(v => String(v || '').toUpperCase().replace(/\$/g, '').trim().replace(/[ ,;#]/g, ''))
    .filter(v => /^[A-Z][A-Z0-9.-]{0,5}$/.test(v))
    .filter(v => {
      if (seen.has(v)) return false
      seen.add(v)
      return true
    })
}

function dedupeKey(doc = {}) {
  const platform = String(doc.platform || doc.collector || doc.source || '').toLowerCase()
  const stable = doc.id || doc.url || doc.link || doc.source_url || `${doc.title || ''}|${doc.text || doc.content || doc.summary || ''}`
  return crypto.createHash('sha1').update(`${platform}|${stable}`).digest('hex')
}

function causalRollingMean(values, window) {
  const k = Math.max(1, Math.floor(window))
  const out = []
  const queue = []
  let sum = 0
  for (const raw of values) {
    const value = Number.isFinite(Number(raw)) ? Number(raw) : 0
    queue.push(value)
    sum += value
    while (queue.length > k) sum -= queue.shift()
    out.push(sum / queue.length)
  }
  return out
}

function clampCorrelation(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  return Math.max(-1, Math.min(1, n))
}

function rollingCorrelation(bars, densityByMinute, windowMinutes, minObservations) {
  const out = new Map()
  const queue = []
  const windowSec = windowMinutes * 60
  let sumX = 0
  let sumY = 0
  let sumXX = 0
  let sumYY = 0
  let sumXY = 0
  for (const bar of bars) {
    const x = Number(bar.close)
    const y = Number(densityByMinute.get(bar.minute) ?? 0)
    if (Number.isFinite(x) && Number.isFinite(y)) {
      queue.push({ minute: bar.minute, x, y })
      sumX += x
      sumY += y
      sumXX += x * x
      sumYY += y * y
      sumXY += x * y
    }
    const start = bar.minute - windowSec + 60
    while (queue.length && queue[0].minute < start) {
      const old = queue.shift()
      sumX -= old.x
      sumY -= old.y
      sumXX -= old.x * old.x
      sumYY -= old.y * old.y
      sumXY -= old.x * old.y
    }
    const n = queue.length
    if (n < minObservations) {
      out.set(bar.minute, null)
      continue
    }
    const cov = sumXY - (sumX * sumY) / n
    const vx = sumXX - (sumX * sumX) / n
    const vy = sumYY - (sumY * sumY) / n
    const corr = vx > 0 && vy > 0 ? clampCorrelation(cov / Math.sqrt(vx * vy)) : null
    out.set(bar.minute, corr == null ? null : Number(corr.toFixed(6)))
  }
  return out
}

function findBarAtOrBefore(bars, sec) {
  let found = null
  for (const bar of bars) {
    if (bar.minute <= sec) found = bar
    else break
  }
  return found
}

function pctReturn(from, to) {
  const a = Number(from)
  const b = Number(to)
  return Number.isFinite(a) && Number.isFinite(b) && a > 0 ? ((b - a) / a) * 100 : null
}

function minuteRange(start, end) {
  const out = []
  for (let t = start; t <= end; t += 60) out.push(t)
  return out
}

async function fetchYahooCandles(ticker, range = '5d', interval = '1m') {
  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}`)
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
  for (let i = 0; i < timestamps.length; i += 1) {
    const close = Number(quote.close?.[i])
    if (!Number.isFinite(close) || close <= 0) continue
    const minute = floorMinute(Number(timestamps[i]))
    if (!minute) continue
    bars.push({ ticker, minute, close: Number(close.toFixed(4)), source: 'market_chart_provider' })
  }
  return bars
}

async function activeScreenerTickers(db, freshMinutes) {
  const nowSec = Math.floor(Date.now() / 1000)
  const rows = await db.collection('screeners')
    .find({
      ticker: { $type: 'string', $ne: '' },
      price: { $gt: 0 },
      quote_updated_at: { $gte: nowSec - freshMinutes * 60 },
    }, {
      projection: { ticker: 1, change_pct: 1, rel_volume: 1, volume: 1, quote_updated_at: 1 },
    })
    .sort({ quote_updated_at: -1, volume: -1 })
    .toArray()
  const seen = new Set()
  return rows
    .map(row => String(row.ticker || '').toUpperCase().trim())
    .filter(ticker => /^[A-Z][A-Z0-9.-]{0,5}$/.test(ticker))
    .filter(ticker => {
      if (seen.has(ticker)) return false
      seen.add(ticker)
      return true
    })
}

async function mergeLiveChartBars(db, barsByTicker, { freshMinutes, concurrency }) {
  const tickers = await activeScreenerTickers(db, freshMinutes)
  let fetched = 0
  let failed = 0
  let mergedBars = 0
  let cursor = 0

  async function worker() {
    while (cursor < tickers.length) {
      const ticker = tickers[cursor++]
      try {
        const bars = await fetchYahooCandles(ticker)
        if (!bars.length) {
          failed += 1
          continue
        }
        fetched += 1
        const existing = barsByTicker.get(ticker)
        const minuteMap = existing instanceof Map
          ? existing
          : new Map((Array.isArray(existing) ? existing : []).map(bar => [bar.minute, bar]))
        for (const bar of bars) {
          minuteMap.set(bar.minute, bar)
          mergedBars += 1
        }
        barsByTicker.set(ticker, minuteMap)
      } catch (_) {
        failed += 1
      }
    }
  }

  const workers = Array.from({ length: Math.max(1, concurrency) }, () => worker())
  await Promise.all(workers)
  return { activeTickers: tickers.length, fetched, failed, mergedBars }
}

async function loadPriceBars(db, { maxTickers }) {
  const snapshots = await db.collection('finviz_momentum_snapshots')
    .find({}, { projection: { _id: 0, snapshot_sec: 1, snapshot_at: 1, rows: 1 } })
    .sort({ snapshot_sec: 1 })
    .toArray()

  const byTicker = new Map()
  let expandedRows = 0
  for (const snapshot of snapshots) {
    const minute = floorMinute(snapshot.snapshot_sec ?? snapshot.snapshot_at)
    if (!minute || !Array.isArray(snapshot.rows)) continue
    for (const row of snapshot.rows) {
      const ticker = String(row.ticker || '').toUpperCase().trim()
      const close = Number(row.price)
      if (!ticker || !Number.isFinite(close) || close <= 0) continue
      expandedRows += 1
      if (!byTicker.has(ticker)) byTicker.set(ticker, new Map())
      byTicker.get(ticker).set(minute, { ticker, minute, close })
    }
  }

  const final = new Map()
  for (const [ticker, minuteMap] of byTicker.entries()) {
    const bars = [...minuteMap.values()].sort((a, b) => a.minute - b.minute)
    const uniquePrices = new Set(bars.map(bar => bar.close)).size
    if (bars.length >= 30 && uniquePrices >= 2) final.set(ticker, bars)
  }
  const limited = [...final.entries()].slice(0, maxTickers)
  return {
    barsByTicker: new Map(limited),
    diagnostics: {
      snapshots: snapshots.length,
      expandedRows,
      eligibleTickers: final.size,
      limitedTickers: limited.length,
    },
  }
}

async function loadSocialCounts(db, tickerSet, startSec, endSec) {
  const startLookback = startSec - 6 * 3600
  const docs = await db.collection('socials')
    .find({}, {
      projection: {
        _id: 1, id: 1, platform: 1, collector: 1, source: 1, ticker: 1, symbol: 1,
        cashtag: 1, tickers_mentioned: 1, text: 1, content: 1, title: 1, summary: 1,
        url: 1, link: 1, source_url: 1, fetched_at: 1, detected_at: 1, timestamp: 1,
        created_at: 1, publish_date: 1,
      },
    })
    .toArray()
  const rawByTickerMinute = new Map()
  const dedupByTickerMinute = new Map()
  let matchedDocs = 0
  for (const doc of docs) {
    const sec = eventSec(doc)
    if (!sec || sec < startLookback || sec > endSec + 3600) continue
    const minute = floorMinute(sec)
    const tickers = candidateTickers(doc).filter(ticker => tickerSet.has(ticker))
    if (!tickers.length) continue
    matchedDocs += 1
    const keyBase = dedupeKey(doc)
    for (const ticker of tickers) {
      const key = `${ticker}|${minute}`
      rawByTickerMinute.set(key, (rawByTickerMinute.get(key) || 0) + 1)
      const dedupSet = dedupByTickerMinute.get(key) || new Set()
      dedupSet.add(keyBase)
      dedupByTickerMinute.set(key, dedupSet)
    }
  }
  return { rawByTickerMinute, dedupByTickerMinute, diagnostics: { totalDocs: docs.length, matchedDocs } }
}

function computeFeatures(ticker, bars, social, { windowMinutes, minObservations }) {
  const first = bars[0]?.minute
  const last = bars[bars.length - 1]?.minute
  if (!first || !last) return null
  const minutes = minuteRange(first - 6 * 3600, last)
  const counts = minutes.map(minute => social.rawByTickerMinute.get(`${ticker}|${minute}`) || 0)
  const smoothed = causalRollingMean(counts, windowMinutes)
  const densityByMinute = new Map(minutes.map((minute, index) => [minute, smoothed[index] || 0]))
  const corrByMinute = rollingCorrelation(bars, densityByMinute, windowMinutes, minObservations)
  const latest = bars[bars.length - 1]
  const previous = bars[bars.length - 2]
  const currentCorrelation = clampCorrelation(corrByMinute.get(latest.minute))
  const previousCorrelation = previous ? clampCorrelation(corrByMinute.get(previous.minute)) : null
  const prior60 = findBarAtOrBefore(bars, latest.minute - 60 * 60)
  const preReturn60 = prior60 ? pctReturn(prior60.close, latest.close) : null
  const minuteIndex = new Map(minutes.map((minute, index) => [minute, index]))
  const latestIndex = minuteIndex.get(latest.minute)
  let trailing60Messages = 0
  if (latestIndex != null) {
    const start = Math.max(0, latestIndex - 59)
    for (let i = start; i <= latestIndex; i += 1) trailing60Messages += counts[i] || 0
  }
  const hasCorr = Number.isFinite(Number(currentCorrelation)) && Number.isFinite(Number(previousCorrelation))
  const hasPre60 = Number.isFinite(Number(preReturn60))
  const messagesOk = trailing60Messages >= MIN_TRAILING_60M_MESSAGES
  const crossed = hasCorr && previousCorrelation <= ENTRY_CORRELATION_THRESHOLD && currentCorrelation > ENTRY_CORRELATION_THRESHOLD
  const preMoveOk = hasPre60 && preReturn60 <= MAX_PRE_SIGNAL_RETURN_60M_PCT
  const aboveThreshold = hasCorr && currentCorrelation > ENTRY_CORRELATION_THRESHOLD
  const nearThreshold = hasCorr && currentCorrelation >= ENTRY_CORRELATION_THRESHOLD - SETUP_NEAR_THRESHOLD_BAND && currentCorrelation <= ENTRY_CORRELATION_THRESHOLD
  const setupStatus = hasCorr && hasPre60
    ? crossed && preMoveOk && messagesOk
      ? 'entry_passed'
      : aboveThreshold && preMoveOk && messagesOk
        ? 'active_setup_already_above_threshold'
        : nearThreshold && preMoveOk && messagesOk
          ? 'near_threshold_setup'
          : crossed && !preMoveOk
            ? 'late_setup_rejected'
            : crossed && !messagesOk
              ? 'low_message_density_rejected'
            : 'inactive'
    : 'insufficient_history'
  const distanceToThreshold = hasCorr ? Number((currentCorrelation - ENTRY_CORRELATION_THRESHOLD).toFixed(6)) : null
  const setupScore = setupStatus === 'entry_passed'
    ? 100
    : setupStatus === 'active_setup_already_above_threshold'
      ? 75
      : setupStatus === 'near_threshold_setup'
        ? 55
        : setupStatus === 'late_setup_rejected'
          ? 25
          : 0
  return {
    ticker,
    latestMinute: latest.minute,
    price_density_correlation: hasCorr ? Number(Number(currentCorrelation).toFixed(6)) : null,
    previous_price_density_correlation: hasCorr ? Number(Number(previousCorrelation).toFixed(6)) : null,
    threshold_pre_return_60m_pct: hasPre60 ? Number(Number(preReturn60).toFixed(4)) : null,
    threshold_trailing_60m_messages: trailing60Messages,
    threshold_feature_window_minutes: windowMinutes,
    threshold_feature_min_observations: minObservations,
    threshold_setup_status: setupStatus,
    threshold_setup_score: setupScore,
    threshold_setup_distance_to_entry: distanceToThreshold,
    threshold_feature_status: hasCorr && hasPre60 ? (crossed && preMoveOk && messagesOk ? 'entry_passed' : crossed && !preMoveOk ? 'late_entry_rejected' : crossed && !messagesOk ? 'low_message_density_rejected' : 'entry_not_crossed') : 'insufficient_history',
  }
}

async function main() {
  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI || argValue('mongo', 'mongodb://localhost:27017/feedflash')
  const maxTickers = Math.max(1, Math.min(5000, Number(argValue('maxTickers', '1200')) || 1200))
  const windowMinutes = Math.max(30, Math.min(720, Number(argValue('windowMinutes', '90')) || 90))
  const minObservations = Math.max(5, Math.min(240, Number(argValue('minObservations', '30')) || 30))
  const liveCharts = !['0', 'false', 'no'].includes(String(argValue('liveCharts', '1')).toLowerCase())
  const freshMinutes = Math.max(15, Math.min(1440, Number(argValue('freshMinutes', '240')) || 240))
  const chartConcurrency = Math.max(1, Math.min(12, Number(argValue('chartConcurrency', '6')) || 6))

  await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 10000 })
  const db = mongoose.connection.db
  try {
    const price = await loadPriceBars(db, { maxTickers })
    let liveChartDiagnostics = null
    if (liveCharts) {
      liveChartDiagnostics = await mergeLiveChartBars(db, price.barsByTicker, { freshMinutes, concurrency: chartConcurrency })
    }
    const normalizedBarsByTicker = new Map()
    for (const [ticker, minuteMap] of price.barsByTicker.entries()) {
      const bars = (minuteMap instanceof Map ? [...minuteMap.values()] : (Array.isArray(minuteMap) ? minuteMap : []))
        .sort((a, b) => a.minute - b.minute)
      const uniquePrices = new Set(bars.map(bar => bar.close)).size
      if (bars.length >= minObservations && uniquePrices >= 2) normalizedBarsByTicker.set(ticker, bars)
    }
    const tickers = [...normalizedBarsByTicker.keys()]
    const allBars = [...normalizedBarsByTicker.values()].flat()
    let startSec = Infinity
    let endSec = -Infinity
    for (const bar of allBars) {
      startSec = Math.min(startSec, bar.minute)
      endSec = Math.max(endSec, bar.minute)
    }
    const social = await loadSocialCounts(db, new Set(tickers), startSec, endSec)
    const updates = []
    const statuses = {}
    for (const [ticker, bars] of normalizedBarsByTicker.entries()) {
      const features = computeFeatures(ticker, bars, social, { windowMinutes, minObservations })
      if (!features) continue
      statuses[features.threshold_feature_status] = (statuses[features.threshold_feature_status] || 0) + 1
      updates.push({
        updateOne: {
          filter: { ticker },
          update: {
            $set: {
              price_density_correlation: features.price_density_correlation,
              previous_price_density_correlation: features.previous_price_density_correlation,
              threshold_pre_return_60m_pct: features.threshold_pre_return_60m_pct,
              threshold_trailing_60m_messages: features.threshold_trailing_60m_messages,
              threshold_feature_window_minutes: features.threshold_feature_window_minutes,
              threshold_feature_min_observations: features.threshold_feature_min_observations,
              threshold_setup_status: features.threshold_setup_status,
              threshold_setup_score: features.threshold_setup_score,
              threshold_setup_distance_to_entry: features.threshold_setup_distance_to_entry,
              threshold_feature_status: features.threshold_feature_status,
              threshold_feature_policy_version: THRESHOLD_FEATURE_POLICY_VERSION,
              threshold_feature_source: 'finviz_momentum_snapshots+socials',
              threshold_feature_snapshot_sec: features.latestMinute,
              threshold_feature_updated_at: new Date(),
              updated_at: new Date(),
            },
          },
        },
      })
    }
    if (updates.length) await db.collection('screeners').bulkWrite(updates, { ordered: false })
    await db.collection('screeners').createIndex({ threshold_feature_policy_version: 1, threshold_feature_status: 1 }).catch(() => {})
    console.log(JSON.stringify({
      ok: true,
      updated: updates.length,
      statuses,
      price: price.diagnostics,
      social: social.diagnostics,
      liveCharts: liveChartDiagnostics,
      windowMinutes,
      minObservations,
      thresholdC: ENTRY_CORRELATION_THRESHOLD,
      maxPreSignalReturn60mPct: MAX_PRE_SIGNAL_RETURN_60M_PCT,
      minTrailing60Messages: MIN_TRAILING_60M_MESSAGES,
    }, null, 2))
  } finally {
    await mongoose.disconnect()
  }
}

main().catch(async err => {
  console.error(JSON.stringify({ ok: false, error: String(err.message || err) }, null, 2))
  try { await mongoose.disconnect() } catch (_) {}
  process.exit(1)
})
