#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import {
  candidateTickers,
  dedupeKey,
  etParts,
  eventSec,
  findBarAtOrAfter,
  findBarAtOrBefore,
  floorMinute,
  isRegularSession,
  marketCapTier,
  nextRealBarAfter,
  pearson,
  pctReturn,
  rollingTimeCorrelation,
  sameEtDate,
  summarizeTrades,
  thresholdCrossed,
} from './features.mjs'

const require = createRequire(new URL('../../Infrastructure/server/package.json', import.meta.url))
const { MongoClient } = require('mongodb')

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const CONFIG_PATH = process.env.MESSAGE_DENSITY_BACKTEST_CONFIG
  ? path.resolve(ROOT, process.env.MESSAGE_DENSITY_BACKTEST_CONFIG)
  : path.join(ROOT, 'backtests/message_density_thresholds/config.json')

function deepMergeConfig(base, override) {
  const out = { ...base }
  for (const [key, value] of Object.entries(override || {})) {
    if (key === 'extends') continue
    const prior = out[key]
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      prior &&
      typeof prior === 'object' &&
      !Array.isArray(prior)
    ) {
      out[key] = deepMergeConfig(prior, value)
    } else {
      out[key] = value
    }
  }
  return out
}

function readConfig(configPath, seen = new Set()) {
  const absolute = path.resolve(configPath)
  if (seen.has(absolute)) throw new Error(`Circular config extends: ${absolute}`)
  seen.add(absolute)
  const raw = JSON.parse(fs.readFileSync(absolute, 'utf8'))
  if (!raw.extends) return raw
  const parentPath = path.resolve(path.dirname(absolute), raw.extends)
  return deepMergeConfig(readConfig(parentPath, seen), raw)
}

const config = readConfig(CONFIG_PATH)
const outputDir = path.join(ROOT, config.outputDir)
fs.mkdirSync(outputDir, { recursive: true })
const chartCacheDir = path.join(ROOT, config.chartCacheDir || 'backtests/message_density_thresholds/.chart_cache')
fs.mkdirSync(chartCacheDir, { recursive: true })
const startedAt = Date.now()
const progress = label => console.error(`[backtest +${((Date.now() - startedAt) / 1000).toFixed(1)}s] ${label}`)

const minuteRange = (start, end) => {
  const out = []
  for (let t = start; t <= end; t += 60) out.push(t)
  return out
}

function csvEscape(value) {
  if (value == null) return ''
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value)
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function writeCsv(file, rows) {
  const allKeys = []
  const seen = new Set()
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key)
        allKeys.push(key)
      }
    }
  }
  const body = [
    allKeys.join(','),
    ...rows.map(row => allKeys.map(key => csvEscape(row[key])).join(',')),
  ].join('\n')
  fs.writeFileSync(path.join(outputDir, file), body + '\n')
}

function pct(value, decimals = 4) {
  return value == null || !Number.isFinite(Number(value)) ? null : Number(Number(value).toFixed(decimals))
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function safeTicker(ticker) {
  return String(ticker || '').toUpperCase().replace(/[^A-Z0-9._-]/g, '')
}

function yahooChartCachePath(ticker, range, interval) {
  return path.join(chartCacheDir, `${safeTicker(ticker)}_${String(range).replace(/[^a-zA-Z0-9]/g, '')}_${String(interval).replace(/[^a-zA-Z0-9]/g, '')}.json`)
}

function intervalSeconds(interval) {
  const text = String(interval || '').trim().toLowerCase()
  const match = text.match(/^(\d+)(m|h|d|wk|mo)$/)
  if (!match) return null
  const value = Number(match[1])
  if (!Number.isFinite(value) || value <= 0) return null
  const unit = match[2]
  if (unit === 'm') return value * 60
  if (unit === 'h') return value * 3600
  if (unit === 'd') return value * 86400
  if (unit === 'wk') return value * 7 * 86400
  if (unit === 'mo') return value * 30 * 86400
  return null
}

function chartQuerySpecs() {
  const configured = Array.isArray(config.chartQueries) ? config.chartQueries : []
  const queries = configured.length
    ? configured
    : [{ range: config.chartRange || '1mo', interval: config.chartInterval || '5m' }]
  const seen = new Set()
  const specs = []
  for (const query of queries) {
    const range = String(query?.range || '').trim()
    const interval = String(query?.interval || '').trim()
    if (!range || !interval) continue
    const key = `${range}|${interval}`.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    specs.push({
      range,
      interval,
      intervalSec: intervalSeconds(interval) || 0,
      label: query?.label ? String(query.label) : `${range}/${interval}`,
    })
  }
  if (!specs.length) specs.push({ range: '1mo', interval: '5m', intervalSec: 300, label: '1mo/5m' })
  return specs
}

async function fetchYahooCandles(ticker, range = '1mo', interval = '5m') {
  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}`)
  url.searchParams.set('range', range)
  url.searchParams.set('interval', interval)
  url.searchParams.set('includePrePost', 'true')
  url.searchParams.set('events', 'history')
  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'FeedFlashThresholdBacktest/0.1',
      Accept: 'application/json',
    },
  })
  if (!resp.ok) throw new Error(`chart provider HTTP ${resp.status}`)
  const payload = await resp.json()
  const result = payload?.chart?.result?.[0]
  const timestamps = result?.timestamp || []
  const quote = result?.indicators?.quote?.[0] || {}
  const candles = []
  for (let i = 0; i < timestamps.length; i += 1) {
    const open = Number(quote.open?.[i])
    const high = Number(quote.high?.[i])
    const low = Number(quote.low?.[i])
    const close = Number(quote.close?.[i])
    if (![open, high, low, close].every(Number.isFinite)) continue
    if (open <= 0 || high <= 0 || low <= 0 || close <= 0) continue
    if (high < Math.max(open, close, low) || low > Math.min(open, close, high)) continue
    candles.push({
      time: Number(timestamps[i]),
      open: Number(open.toFixed(4)),
      high: Number(high.toFixed(4)),
      low: Number(low.toFixed(4)),
      close: Number(close.toFixed(4)),
      volume: Number.isFinite(Number(quote.volume?.[i])) ? Number(quote.volume[i]) : 0,
    })
  }
  return candles.sort((a, b) => Number(a.time || 0) - Number(b.time || 0))
}

async function loadCachedYahooCandles(ticker, range, interval) {
  const cachePath = yahooChartCachePath(ticker, range, interval)
  const maxAgeHours = Number(config.chartCacheMaxAgeHours ?? 18)
  if (fs.existsSync(cachePath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'))
      const ageMs = Date.now() - Number(cached.fetchedAtMs || 0)
      if (Array.isArray(cached.candles) && ageMs <= maxAgeHours * 3600_000) return { candles: cached.candles, cacheHit: true }
    } catch (_) {}
  }
  const candles = await fetchYahooCandles(ticker, range, interval)
  fs.writeFileSync(cachePath, JSON.stringify({ ticker, range, interval, fetchedAtMs: Date.now(), candles }))
  return { candles, cacheHit: false }
}

function buildStatsRows(group, tradesByName) {
  return Object.entries(tradesByName).map(([name, trades]) => ({
    group,
    name,
    ...summarizeTrades(trades),
  }))
}

async function loadPriceBars(db) {
  const source = String(config.priceSource || '').toLowerCase()
  if (source === 'yahoo_chart') {
    return loadYahooChartBars(db)
  }
  if (source === 'mongo_ohlcv') {
    return loadMongoOhlcvBars(db)
  }

  const snapshots = await loadPriceSnapshots(db)
  const byTicker = new Map()
  let expandedRows = 0
  for (const snapshot of snapshots) {
    const minute = floorMinute(snapshot.snapshot_sec ?? snapshot.snapshot_at)
    if (!minute || !Array.isArray(snapshot.rows)) continue
    for (const row of snapshot.rows) {
      const ticker = String(row.ticker || '').toUpperCase().trim()
      const price = Number(row.price)
      if (!ticker || !Number.isFinite(price) || price <= 0) continue
      expandedRows += 1
      const source = row.quote_source || snapshot.source || 'finviz_momentum_snapshots'
      const tier = marketCapTier(row.market_cap, source)
      const bar = {
        ticker,
        minute,
        close: price,
        price,
        changePct: Number(row.change_pct),
        relVolume: Number(row.rel_volume),
        volume: Number(row.volume),
        rank: Number(row.rank),
        marketCap: Number(row.market_cap),
        tier,
        source,
        quoteUpdatedAt: row.quote_updated_at || null,
      }
      if (!byTicker.has(ticker)) byTicker.set(ticker, new Map())
      byTicker.get(ticker).set(minute, bar)
    }
  }

  const final = finalizeBarsByTicker(byTicker)
  const range = priceRange(final)
  return {
    barsByTicker: final,
    diagnostics: {
      snapshots: snapshots.length,
      expandedRows,
      eligibleTickers: final.size,
      priceStartSec: range.priceStartSec,
      priceEndSec: range.priceEndSec,
      droppedStaticOrSparseTickers: byTicker.size - final.size,
    },
  }
}

async function loadPriceSnapshots(db) {
  return db.collection(config.priceCollection)
    .find({}, { projection: { _id: 0, snapshot_sec: 1, snapshot_at: 1, source: 1, rows: 1 } })
    .sort({ snapshot_sec: 1 })
    .toArray()
}

async function loadLatestTickerMeta(db) {
  const snapshots = await loadPriceSnapshots(db)
  const latestMeta = new Map()
  for (const snapshot of snapshots) {
    const sec = floorMinute(snapshot.snapshot_sec ?? snapshot.snapshot_at)
    if (!sec || !Array.isArray(snapshot.rows)) continue
    for (const row of snapshot.rows) {
      const ticker = safeTicker(row.ticker)
      const price = Number(row.price)
      if (!ticker || !Number.isFinite(price) || price <= 0) continue
      const source = row.quote_source || snapshot.source || 'finviz_momentum_snapshots'
      const existing = latestMeta.get(ticker)
      if (!existing || sec >= existing.snapshotSec) {
        latestMeta.set(ticker, {
          snapshotSec: sec,
          source,
          rank: Number(row.rank),
          marketCap: Number(row.market_cap),
          tier: marketCapTier(row.market_cap, source),
          relVolume: Number(row.rel_volume),
        })
      }
    }
  }
  return { snapshots, latestMeta }
}

function finalizeBarsByTicker(byTicker) {
  const final = new Map()
  for (const [ticker, minuteMap] of byTicker.entries()) {
    const bars = [...minuteMap.values()].sort((a, b) => a.minute - b.minute)
    const uniquePrices = new Set(bars.map(bar => bar.close)).size
    if (bars.length >= config.minPriceBarsPerTicker && uniquePrices >= 2) final.set(ticker, bars)
  }
  return final
}

function priceRange(barsByTicker) {
  let priceStartSec = Infinity
  let priceEndSec = -Infinity
  for (const bars of barsByTicker.values()) {
    if (bars[0]) priceStartSec = Math.min(priceStartSec, bars[0].minute)
    if (bars[bars.length - 1]) priceEndSec = Math.max(priceEndSec, bars[bars.length - 1].minute)
  }
  return {
    priceStartSec: Number.isFinite(priceStartSec) ? priceStartSec : null,
    priceEndSec: Number.isFinite(priceEndSec) ? priceEndSec : null,
  }
}

async function persistOhlcBarsToMongo(db, barsByTicker) {
  const collectionName = config.ohlcCollection || 'ohlcv_bars'
  const collection = db.collection(collectionName)
  await collection.createIndex({ source: 1, ticker: 1, minute: 1 }, { unique: true })
  await collection.createIndex({ ticker: 1, minute: 1 })
  const batchSize = Math.max(50, Number(config.ohlcPersistBatchSize || 250))
  let batch = []
  let attempted = 0
  let upserted = 0
  let modified = 0
  const writeBatch = async (operations, attempt = 1) => {
    try {
      return await collection.bulkWrite(operations, { ordered: false })
    } catch (err) {
      if (attempt >= 3) throw err
      await sleep(500 * attempt)
      return writeBatch(operations, attempt + 1)
    }
  }
  const flush = async () => {
    if (!batch.length) return
    const result = await writeBatch(batch)
    upserted += Number(result.upsertedCount || 0)
    modified += Number(result.modifiedCount || 0)
    batch = []
  }
  for (const bars of barsByTicker.values()) {
    for (const bar of bars) {
      attempted += 1
      batch.push({
        updateOne: {
          filter: { source: bar.source || 'yahoo_chart_ohlcv', ticker: bar.ticker, minute: bar.minute },
          update: {
            $set: {
              ticker: bar.ticker,
              minute: bar.minute,
              time: new Date(bar.minute * 1000),
              open: bar.open,
              high: bar.high,
              low: bar.low,
              close: bar.close,
              price: bar.price,
              volume: bar.volume,
              changePct: bar.changePct,
              relVolume: bar.relVolume,
              rank: bar.rank,
              marketCap: bar.marketCap,
              tier: bar.tier,
              source: bar.source || 'yahoo_chart_ohlcv',
              providerRange: bar.providerRange,
              providerInterval: bar.providerInterval,
              providerIntervalSec: bar.providerIntervalSec,
              updatedAt: new Date(),
            },
            $setOnInsert: { createdAt: new Date() },
          },
          upsert: true,
        },
      })
      if (batch.length >= batchSize) await flush()
    }
  }
  await flush()
  return { collection: collectionName, attempted, upserted, modified }
}

async function loadMongoOhlcvBars(db) {
  const collectionName = config.ohlcCollection || 'ohlcv_bars'
  const { snapshots, latestMeta } = await loadLatestTickerMeta(db)
  const tickers = [...latestMeta.keys()].slice(0, Math.max(1, Number(config.maxChartTickers || config.maxTickers || 300)))
  const source = config.ohlcSource || 'yahoo_chart_ohlcv'
  const byTicker = new Map()
  const intervalCounts = new Map()
  let rawRows = 0
  let acceptedRows = 0
  const readTickerDocs = async (ticker, attempt = 1) => {
    try {
      return await db.collection(collectionName)
        .find({ ticker, source }, {
          projection: {
            _id: 0, ticker: 1, minute: 1, open: 1, high: 1, low: 1, close: 1,
            price: 1, volume: 1, providerRange: 1, providerInterval: 1, providerIntervalSec: 1,
          },
        })
        .sort({ minute: 1, providerIntervalSec: 1 })
        .toArray()
    } catch (err) {
      if (attempt >= 3) throw err
      await sleep(500 * attempt)
      return readTickerDocs(ticker, attempt + 1)
    }
  }
  for (let idx = 0; idx < tickers.length; idx += 1) {
    const ticker = tickers[idx]
    const docs = await readTickerDocs(ticker)
    rawRows += docs.length
    const minuteMap = new Map()
    for (const doc of docs) {
      const minute = floorMinute(doc.minute)
      const open = Number(doc.open)
      const high = Number(doc.high)
      const low = Number(doc.low)
      const close = Number(doc.close)
      if (!minute || ![open, high, low, close].every(Number.isFinite)) continue
      if (open <= 0 || high <= 0 || low <= 0 || close <= 0) continue
      if (high < Math.max(open, close, low) || low > Math.min(open, close, high)) continue
      const meta = latestMeta.get(ticker) || {}
      const bar = {
        ticker,
        minute,
        open,
        high,
        low,
        close,
        price: Number(doc.price ?? close),
        volume: Number(doc.volume || 0),
        changePct: null,
        relVolume: null,
        rank: meta.rank,
        marketCap: meta.marketCap,
        tier: meta.tier || 'Unknown',
        source,
        providerRange: doc.providerRange || null,
        providerInterval: doc.providerInterval || null,
        providerIntervalSec: Number(doc.providerIntervalSec || 0) || null,
      }
      const existing = minuteMap.get(minute)
      if (!existing || Number(existing.providerIntervalSec || Infinity) > Number(bar.providerIntervalSec || Infinity)) minuteMap.set(minute, bar)
      intervalCounts.set(bar.providerInterval || 'unknown', (intervalCounts.get(bar.providerInterval || 'unknown') || 0) + 1)
      acceptedRows += 1
    }
    if (minuteMap.size) byTicker.set(ticker, minuteMap)
    if ((idx + 1) % 100 === 0) progress(`loaded Mongo OHLC for ${idx + 1}/${tickers.length} tickers`)
  }
  for (const [ticker, minuteMap] of byTicker.entries()) {
    const meta = latestMeta.get(ticker) || {}
    const sortedBars = [...minuteMap.values()].sort((a, b) => a.minute - b.minute)
    applyDailyChartBarFeatures(sortedBars, meta)
    byTicker.set(ticker, minuteMap)
  }
  const final = finalizeBarsByTicker(byTicker)
  const range = priceRange(final)
  return {
    barsByTicker: final,
    diagnostics: {
      priceSource: 'mongo_ohlcv',
      collection: collectionName,
      ohlcSource: source,
      snapshotMetaRows: snapshots.length,
      requestedTickers: tickers.length,
      rawRows,
      acceptedRows,
      intervalCounts: Object.fromEntries([...intervalCounts.entries()].sort()),
      expandedRows: [...final.values()].reduce((sum, bars) => sum + bars.length, 0),
      eligibleTickers: final.size,
      priceStartSec: range.priceStartSec,
      priceEndSec: range.priceEndSec,
      droppedStaticOrSparseTickers: latestMeta.size - final.size,
    },
  }
}

async function loadYahooChartBars(db) {
  const querySpecs = chartQuerySpecs()
  const { snapshots, latestMeta } = await loadLatestTickerMeta(db)

  const tickers = [...latestMeta.keys()].slice(0, Math.max(1, Number(config.maxChartTickers || config.maxTickers || 300)))
  const final = new Map()
  const errors = []
  let fetchedTickers = 0
  let cacheHits = 0
  let expandedRows = 0
  let rawCandles = 0
  const queryDiagnostics = new Map(querySpecs.map(spec => [spec.label, {
    label: spec.label,
    range: spec.range,
    interval: spec.interval,
    requestedTickers: tickers.length,
    fetchedTickers: 0,
    cacheHits: 0,
    rawCandles: 0,
    acceptedCandles: 0,
    fetchErrors: 0,
  }]))
  const concurrency = Math.max(1, Math.min(12, Number(config.chartFetchConcurrency || 4)))
  let cursor = 0

  async function worker() {
    while (cursor < tickers.length) {
      const ticker = tickers[cursor++]
      try {
        const meta = latestMeta.get(ticker) || {}
        const minuteMap = new Map()
        for (const spec of querySpecs) {
          const diag = queryDiagnostics.get(spec.label)
          try {
            const { candles, cacheHit } = await loadCachedYahooCandles(ticker, spec.range, spec.interval)
            fetchedTickers += 1
            diag.fetchedTickers += 1
            if (cacheHit) {
              cacheHits += 1
              diag.cacheHits += 1
            }
            rawCandles += candles.length
            diag.rawCandles += candles.length
            if (!cacheHit && Number(config.chartFetchDelayMs || 0) > 0) await sleep(Number(config.chartFetchDelayMs))
            for (const candle of candles) {
              const minute = floorMinute(candle.time)
              if (!minute) continue
              const existing = minuteMap.get(minute)
              if (existing && Number(existing.providerIntervalSec || Infinity) <= Number(spec.intervalSec || Infinity)) continue
              const bar = {
                ticker,
                minute,
                open: Number(candle.open),
                high: Number(candle.high),
                low: Number(candle.low),
                close: Number(candle.close),
                price: Number(candle.close),
                volume: Number(candle.volume || 0),
                changePct: null,
                relVolume: null,
                rank: meta.rank,
                marketCap: meta.marketCap,
                tier: meta.tier || 'Unknown',
                source: 'yahoo_chart_ohlcv',
                providerRange: spec.range,
                providerInterval: spec.interval,
                providerIntervalSec: spec.intervalSec || null,
              }
              minuteMap.set(minute, bar)
              diag.acceptedCandles += 1
            }
          } catch (err) {
            diag.fetchErrors += 1
            errors.push({ ticker, range: spec.range, interval: spec.interval, error: String(err.message || err).slice(0, 160) })
          }
        }
        const bars = [...minuteMap.values()].sort((a, b) => a.minute - b.minute)
        const uniquePrices = new Set(bars.map(bar => bar.close)).size
        if (bars.length >= config.minPriceBarsPerTicker && uniquePrices >= 2) {
          applyDailyChartBarFeatures(bars, meta)
          final.set(ticker, bars)
          expandedRows += bars.length
        }
      } catch (err) {
        errors.push({ ticker, error: String(err.message || err).slice(0, 160) })
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()))

  const range = priceRange(final)
  const persistedOhlc = config.persistOhlcToMongo ? await persistOhlcBarsToMongo(db, final) : null
  return {
    barsByTicker: final,
    diagnostics: {
      priceSource: 'yahoo_chart_ohlcv',
      providerRange: querySpecs.length === 1 ? querySpecs[0].range : null,
      providerInterval: querySpecs.length === 1 ? querySpecs[0].interval : null,
      providerQueries: querySpecs.map(spec => ({ range: spec.range, interval: spec.interval, label: spec.label })),
      providerQueryDiagnostics: [...queryDiagnostics.values()],
      snapshotMetaRows: snapshots.length,
      requestedTickers: tickers.length,
      fetchedTickers,
      cacheHits,
      fetchErrors: errors.slice(0, 25),
      fetchErrorCount: errors.length,
      rawCandles,
      expandedRows,
      persistedOhlc,
      eligibleTickers: final.size,
      priceStartSec: range.priceStartSec,
      priceEndSec: range.priceEndSec,
      droppedStaticOrSparseTickers: latestMeta.size - final.size,
    },
  }
}

function applyDailyChartBarFeatures(bars, meta = {}) {
  const byDate = new Map()
  for (const bar of bars) {
    const date = etParts(bar.minute).date
    if (!byDate.has(date)) byDate.set(date, [])
    byDate.get(date).push(bar)
  }
  const regularVolumes = bars.filter(bar => isRegularSession(bar.minute)).map(bar => Number(bar.volume || 0)).filter(v => v > 0)
  const avgRegularVolume = regularVolumes.length ? regularVolumes.reduce((a, b) => a + b, 0) / regularVolumes.length : null
  for (const dayBars of byDate.values()) {
    const regular = dayBars.filter(bar => isRegularSession(bar.minute))
    const sessionOpen = (regular[0] || dayBars[0])?.open
    for (const bar of dayBars) {
      bar.changePct = pctReturn(sessionOpen, bar.close)
      bar.relVolume = avgRegularVolume ? Number((Number(bar.volume || 0) / avgRegularVolume).toFixed(4)) : (Number.isFinite(meta.relVolume) ? meta.relVolume : null)
    }
  }
}

async function loadSocialEvents(db, priceTickers, startSec, endSec) {
  const tickerSet = new Set(priceTickers)
  const startLookback = startSec - 6 * 3600
  const docs = await db.collection(config.socialCollection)
    .find({}, {
      projection: {
        _id: 1, id: 1, platform: 1, collector: 1, source: 1, ticker: 1, symbol: 1,
        cashtag: 1, tickers_mentioned: 1, text: 1, content: 1, title: 1, summary: 1,
        url: 1, link: 1, source_url: 1, fetched_at: 1, detected_at: 1, timestamp: 1,
        created_at: 1, publish_date: 1, sentiment: 1, sentiment_score: 1,
      },
    })
    .toArray()

  const rawByTickerMinute = new Map()
  const dedupByTickerMinute = new Map()
  const rawByTicker = new Map()
  const dedupSetsByTicker = new Map()
  const sentimentByTicker = new Map()
  const tickerTotals = new Map()
  const duplicateGroups = new Map()
  const platformCounts = new Map()
  let inRangeDocs = 0
  let missingTickerCandidates = 0
  let multiTickerDocs = 0
  let futureDatedDocs = 0
  let publishAfterFetchDocs = 0
  const nowSec = Math.floor(Date.now() / 1000)

  const inc = (map, key, amount = 1) => map.set(key, (map.get(key) || 0) + amount)
  const nestedMap = (outer, key) => {
    let inner = outer.get(key)
    if (!inner) {
      inner = new Map()
      outer.set(key, inner)
    }
    return inner
  }
  const sentimentValue = doc => {
    const direct = Number(doc.sentiment_score)
    if (Number.isFinite(direct)) return Math.max(-1, Math.min(1, direct))
    const text = String(doc.sentiment || '').toLowerCase()
    if (/bull|positive|buy|up/.test(text)) return 1
    if (/bear|negative|sell|down/.test(text)) return -1
    return 0
  }
  for (const doc of docs) {
    const sec = eventSec(doc)
    if (!sec) continue
    if (sec > nowSec + 300) futureDatedDocs += 1
    const published = eventSec({ fetched_at: doc.publish_date })
    const fetched = eventSec({ fetched_at: doc.fetched_at })
    if (published && fetched && published > fetched + 300) publishAfterFetchDocs += 1
    if (sec < startLookback || sec > endSec + 3600) continue
    const minute = floorMinute(sec)
    const candidates = candidateTickers(doc).filter(t => tickerSet.has(t))
    if (!candidates.length) {
      missingTickerCandidates += 1
      continue
    }
    if (candidates.length > 1) multiTickerDocs += 1
    inRangeDocs += 1
    inc(platformCounts, doc.platform || doc.collector || 'Unknown')
    const dk = dedupeKey(doc)
    inc(duplicateGroups, dk)
    const s = sentimentValue(doc)
    for (const ticker of candidates) {
      const key = `${ticker}|${minute}`
      inc(rawByTickerMinute, key)
      inc(nestedMap(rawByTicker, ticker), minute)
      const tickerSentiment = nestedMap(sentimentByTicker, ticker)
      const minuteSentiment = tickerSentiment.get(minute) || { total: 0, bull: 0, bear: 0, tagged: 0 }
      minuteSentiment.total += 1
      if (s > 0.12) {
        minuteSentiment.bull += 1
        minuteSentiment.tagged += 1
      } else if (s < -0.12) {
        minuteSentiment.bear += 1
        minuteSentiment.tagged += 1
      }
      tickerSentiment.set(minute, minuteSentiment)
      const dedupSet = dedupByTickerMinute.get(key) || new Set()
      dedupSet.add(dk)
      dedupByTickerMinute.set(key, dedupSet)
      const tickerDedup = nestedMap(dedupSetsByTicker, ticker)
      const tickerMinuteDedup = tickerDedup.get(minute) || new Set()
      tickerMinuteDedup.add(dk)
      tickerDedup.set(minute, tickerMinuteDedup)
      inc(tickerTotals, ticker)
    }
  }

  const dedupByTicker = new Map()
  for (const [ticker, minuteMap] of dedupSetsByTicker.entries()) {
    dedupByTicker.set(ticker, new Map([...minuteMap.entries()].map(([minute, set]) => [minute, set.size])))
  }

  return {
    rawByTickerMinute,
    dedupByTickerMinute,
    rawByTicker,
    dedupByTicker,
    sentimentByTicker,
    tickerTotals,
    diagnostics: {
      totalSocialDocs: docs.length,
      inBacktestRangeMatchedDocs: inRangeDocs,
      missingTickerCandidateDocsInRange: missingTickerCandidates,
      multiTickerMatchedDocsInRange: multiTickerDocs,
      futureDatedDocs,
      publishAfterFetchDocs,
      duplicateMessageGroupsInRange: [...duplicateGroups.values()].filter(n => n > 1).length,
      platformCounts: Object.fromEntries([...platformCounts.entries()].sort((a, b) => b[1] - a[1])),
    },
  }
}

async function loadCatalystEvents(db, priceTickers, startSec, endSec) {
  const collectionName = config.articleCollection || config.newsCollection || 'articles'
  const tickerSet = new Set(priceTickers)
  const startLookback = startSec - 12 * 3600
  let docs = []
  try {
    docs = await db.collection(collectionName)
      .find({}, {
        projection: {
          _id: 1, id: 1, ticker: 1, symbol: 1, tickers_mentioned: 1, symbols: 1,
          title: 1, summary: 1, url: 1, link: 1, source_url: 1, source: 1,
          category: 1, event_type: 1, article_kind: 1, sentiment: 1, sentiment_score: 1,
          ml_confidence: 1, detected_at: 1, fetched_at: 1, timestamp: 1,
          created_at: 1, publish_date: 1, published_at: 1,
        },
      })
      .toArray()
  } catch (err) {
    return {
      byTicker: new Map(),
      diagnostics: {
        collection: collectionName,
        totalCatalystDocs: 0,
        inBacktestRangeMatchedDocs: 0,
        missingTickerCandidateDocsInRange: 0,
        loadError: err?.message || String(err),
      },
    }
  }

  const byTicker = new Map()
  const tickerTotals = new Map()
  const categoryCounts = new Map()
  let inRangeDocs = 0
  let missingTickerCandidates = 0
  let multiTickerDocs = 0
  const nowSec = Math.floor(Date.now() / 1000)
  let futureDatedDocs = 0

  const inc = (map, key, amount = 1) => map.set(key, (map.get(key) || 0) + amount)
  const nestedMap = (outer, key) => {
    let inner = outer.get(key)
    if (!inner) {
      inner = new Map()
      outer.set(key, inner)
    }
    return inner
  }
  const articleSec = doc => {
    const preferred = eventSec({ fetched_at: doc.detected_at || doc.fetched_at || doc.publish_date || doc.published_at || doc.timestamp || doc.created_at })
    return preferred || eventSec(doc)
  }
  const sentimentValue = doc => {
    const direct = Number(doc.sentiment_score)
    if (Number.isFinite(direct)) return Math.max(-1, Math.min(1, direct))
    const text = String(doc.sentiment || '').toLowerCase()
    if (/bull|positive|buy|up/.test(text)) return 1
    if (/bear|negative|sell|down/.test(text)) return -1
    return 0
  }

  for (const doc of docs) {
    const sec = articleSec(doc)
    if (!sec) continue
    if (sec > nowSec + 300) futureDatedDocs += 1
    if (sec < startLookback || sec > endSec + 3600) continue
    const candidates = candidateTickers(doc).filter(t => tickerSet.has(t))
    if (!candidates.length) {
      missingTickerCandidates += 1
      continue
    }
    if (candidates.length > 1) multiTickerDocs += 1
    inRangeDocs += 1
    inc(categoryCounts, doc.event_type || doc.category || doc.article_kind || doc.source || 'Unknown')
    const minute = floorMinute(sec)
    const s = sentimentValue(doc)
    for (const ticker of candidates) {
      const tickerMap = nestedMap(byTicker, ticker)
      const row = tickerMap.get(minute) || { total: 0, positive: 0, negative: 0, score: 0, confidence: 0 }
      row.total += 1
      if (s > 0.12) row.positive += 1
      if (s < -0.12) row.negative += 1
      row.score += s
      const confidence = Number(doc.ml_confidence)
      if (Number.isFinite(confidence)) row.confidence += confidence
      tickerMap.set(minute, row)
      inc(tickerTotals, ticker)
    }
  }

  return {
    byTicker,
    tickerTotals,
    diagnostics: {
      collection: collectionName,
      totalCatalystDocs: docs.length,
      inBacktestRangeMatchedDocs: inRangeDocs,
      missingTickerCandidateDocsInRange: missingTickerCandidates,
      multiTickerMatchedDocsInRange: multiTickerDocs,
      futureDatedDocs,
      categoryCounts: Object.fromEntries([...categoryCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)),
    },
  }
}

function buildTickerContext(ticker, bars, social, catalysts = null) {
  const first = bars[0].minute
  const last = bars[bars.length - 1].minute
  const rawByMinute = social.rawByTicker.get(ticker) || new Map()
  const dedupByMinute = social.dedupByTicker.get(ticker) || new Map()
  const sentimentByMinute = social.sentimentByTicker.get(ticker) || new Map()
  const catalystByMinute = catalysts?.byTicker?.get(ticker) || new Map()
  const socialEntries = [...rawByMinute.entries()]
    .filter(([minute]) => minute >= first - 6 * 3600 && minute <= last)
    .sort((a, b) => a[0] - b[0])
  const socialMinutes = socialEntries.map(([minute]) => minute)
  const socialPrefix = []
  const bullPrefix = []
  const bearPrefix = []
  const taggedPrefix = []
  let runningSocial = 0
  let runningBull = 0
  let runningBear = 0
  let runningTagged = 0
  for (const [minute, count] of socialEntries) {
    const sentiment = sentimentByMinute.get(minute) || {}
    runningSocial += Number(count || 0)
    runningBull += Number(sentiment.bull || 0)
    runningBear += Number(sentiment.bear || 0)
    runningTagged += Number(sentiment.tagged || 0)
    socialPrefix.push(runningSocial)
    bullPrefix.push(runningBull)
    bearPrefix.push(runningBear)
    taggedPrefix.push(runningTagged)
  }
  const catalystEntries = [...catalystByMinute.entries()]
    .filter(([minute]) => minute >= first - 12 * 3600 && minute <= last)
    .sort((a, b) => a[0] - b[0])
  const catalystMinutes = catalystEntries.map(([minute]) => minute)
  const catalystPrefix = []
  const catalystPositivePrefix = []
  const catalystNegativePrefix = []
  const catalystScorePrefix = []
  let runningCatalysts = 0
  let runningPositiveCatalysts = 0
  let runningNegativeCatalysts = 0
  let runningCatalystScore = 0
  for (const [, row] of catalystEntries) {
    runningCatalysts += Number(row.total || 0)
    runningPositiveCatalysts += Number(row.positive || 0)
    runningNegativeCatalysts += Number(row.negative || 0)
    runningCatalystScore += Number(row.score || 0)
    catalystPrefix.push(runningCatalysts)
    catalystPositivePrefix.push(runningPositiveCatalysts)
    catalystNegativePrefix.push(runningNegativeCatalysts)
    catalystScorePrefix.push(runningCatalystScore)
  }
  const regularBars = bars.filter(bar => isRegularSession(bar.minute))
  const regularBarsByDate = new Map()
  const barsByDate = new Map()
  for (const bar of bars) {
    const date = etParts(bar.minute).date
    if (!barsByDate.has(date)) barsByDate.set(date, [])
    barsByDate.get(date).push(bar)
    if (isRegularSession(bar.minute)) {
      if (!regularBarsByDate.has(date)) regularBarsByDate.set(date, [])
      regularBarsByDate.get(date).push(bar)
    }
  }
  return {
    ticker,
    bars,
    regularBars,
    barsByDate,
    regularBarsByDate,
    first,
    last,
    rawByMinute,
    dedupByMinute,
    sentimentByMinute,
    catalystByMinute,
    socialMinutes,
    socialPrefix,
    bullPrefix,
    bearPrefix,
    taggedPrefix,
    catalystMinutes,
    catalystPrefix,
    catalystPositivePrefix,
    catalystNegativePrefix,
    catalystScorePrefix,
    correlationCache: new Map(),
    densityCache: new Map(),
    peerWindowCache: new Map(),
    peerConfirmationCache: new Map(),
  }
}

function upperBound(values, target) {
  let lo = 0
  let hi = values.length
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    if (values[mid] <= target) lo = mid + 1
    else hi = mid
  }
  return lo
}

function trailingSocialSum(context, minute, lookbackMinutes) {
  const minutes = context.socialMinutes || []
  if (!minutes.length) return 0
  const endIdx = upperBound(minutes, minute) - 1
  if (endIdx < 0) return 0
  const startMinute = minute - Math.max(1, Number(lookbackMinutes || 1)) * 60 + 60
  const beforeStartIdx = upperBound(minutes, startMinute - 1) - 1
  const endTotal = context.socialPrefix[endIdx] || 0
  const beforeTotal = beforeStartIdx >= 0 ? (context.socialPrefix[beforeStartIdx] || 0) : 0
  return endTotal - beforeTotal
}

function trailingSocialTotals(context, minute, lookbackMinutes) {
  const minutes = context.socialMinutes || []
  if (!minutes.length) return { total: 0, bull: 0, bear: 0, tagged: 0 }
  const endIdx = upperBound(minutes, minute) - 1
  if (endIdx < 0) return { total: 0, bull: 0, bear: 0, tagged: 0 }
  const startMinute = minute - Math.max(1, Number(lookbackMinutes || 1)) * 60 + 60
  const beforeStartIdx = upperBound(minutes, startMinute - 1) - 1
  const subtract = (prefix) => {
    const endTotal = prefix[endIdx] || 0
    const beforeTotal = beforeStartIdx >= 0 ? (prefix[beforeStartIdx] || 0) : 0
    return endTotal - beforeTotal
  }
  return {
    total: subtract(context.socialPrefix || []),
    bull: subtract(context.bullPrefix || []),
    bear: subtract(context.bearPrefix || []),
    tagged: subtract(context.taggedPrefix || []),
  }
}

function trailingCatalystTotals(context, minute, lookbackMinutes) {
  const minutes = context.catalystMinutes || []
  if (!minutes.length) return { total: 0, positive: 0, negative: 0, score: 0 }
  const endIdx = upperBound(minutes, minute) - 1
  if (endIdx < 0) return { total: 0, positive: 0, negative: 0, score: 0 }
  const startMinute = minute - Math.max(1, Number(lookbackMinutes || 1)) * 60 + 60
  const beforeStartIdx = upperBound(minutes, startMinute - 1) - 1
  const subtract = (prefix) => {
    const endTotal = prefix[endIdx] || 0
    const beforeTotal = beforeStartIdx >= 0 ? (prefix[beforeStartIdx] || 0) : 0
    return endTotal - beforeTotal
  }
  return {
    total: subtract(context.catalystPrefix || []),
    positive: subtract(context.catalystPositivePrefix || []),
    negative: subtract(context.catalystNegativePrefix || []),
    score: subtract(context.catalystScorePrefix || []),
  }
}

function firstBarAfter(sortedBars, sec) {
  let lo = 0
  let hi = sortedBars.length
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    if (sortedBars[mid].minute <= sec) lo = mid + 1
    else hi = mid
  }
  return sortedBars[lo] || null
}

function barsFrom(sortedBars, sec) {
  let lo = 0
  let hi = sortedBars.length
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    if (sortedBars[mid].minute < sec) lo = mid + 1
    else hi = mid
  }
  return sortedBars.slice(lo)
}

function densityAt(context, smoothed, minute) {
  if (smoothed?.byMinute?.has(minute)) return smoothed.byMinute.get(minute) || 0
  if (smoothed?.windowMinutes) return trailingSocialSum(context, minute, smoothed.windowMinutes) / Math.max(1, smoothed.windowMinutes)
  return 0
}

function smoothedForWindow(context, windowMinutes) {
  if (!context.densityCache.has(windowMinutes)) {
    const byMinute = new Map()
    for (const bar of context.bars) {
      byMinute.set(bar.minute, trailingSocialSum(context, bar.minute, windowMinutes) / Math.max(1, windowMinutes))
    }
    context.densityCache.set(windowMinutes, { windowMinutes, byMinute })
  }
  return context.densityCache.get(windowMinutes)
}

function correlationForWindow(context, windowMinutes) {
  if (!context.correlationCache.has(windowMinutes)) {
    const smoothed = smoothedForWindow(context, windowMinutes)
    const densityByMinute = smoothed.byMinute
    const corrByMinute = rollingTimeCorrelation(context.bars, densityByMinute, windowMinutes, config.minCorrelationObservations)
    context.correlationCache.set(windowMinutes, corrByMinute)
  }
  return context.correlationCache.get(windowMinutes)
}

function countTrailing(context, minute, lookbackMinutes) {
  return trailingSocialSum(context, minute, lookbackMinutes)
}

function minuteDuplicateInfo(context, minute) {
  const raw = context.rawByMinute.get(minute) || 0
  const dedup = context.dedupByMinute.get(minute) || 0
  return {
    raw,
    dedup,
    duplicateDriven: raw >= 3 && dedup > 0 && dedup <= 2,
  }
}

function historicalReturnPct(bars, bar, minutes) {
  return pctReturn(findBarAtOrBefore(bars, bar.minute - minutes * 60)?.close, bar.close)
}

function passesQualityGate(context, bar, smoothed, gate = null) {
  if (!gate) return true
  const requireMaxPreMove = (minutes, maxPct) => {
    if (maxPct == null) return true
    const value = historicalReturnPct(context.bars, bar, minutes)
    return Number.isFinite(value) && value <= maxPct
  }
  if (!requireMaxPreMove(15, gate.maxPre15Pct)) return false
  if (!requireMaxPreMove(30, gate.maxPre30Pct)) return false
  if (!requireMaxPreMove(60, gate.maxPre60Pct)) return false
  if (gate.minTrailing60Messages != null && countTrailing(context, bar.minute, 60) < gate.minTrailing60Messages) return false
  const sentimentLookback = Number(gate.sentimentLookbackMinutes || gate.peerSentimentLookbackMinutes || 60)
  const sentimentTotals = trailingSocialTotals(context, bar.minute, sentimentLookback)
  if (gate.minSocialTaggedMessages != null && sentimentTotals.tagged < Number(gate.minSocialTaggedMessages)) return false
  if (gate.minSocialBullBearDelta != null && (sentimentTotals.bull - sentimentTotals.bear) < Number(gate.minSocialBullBearDelta)) return false
  if (gate.minSocialBullShare != null) {
    const share = sentimentTotals.tagged ? sentimentTotals.bull / sentimentTotals.tagged : 0
    if (share < Number(gate.minSocialBullShare)) return false
  }
  const catalystLookback = Number(gate.catalystLookbackMinutes || 240)
  const catalysts = trailingCatalystTotals(context, bar.minute, catalystLookback)
  if (gate.minTrailingCatalysts != null && catalysts.total < Number(gate.minTrailingCatalysts)) return false
  if (gate.minPositiveCatalysts != null && catalysts.positive < Number(gate.minPositiveCatalysts)) return false
  if (gate.minCatalystScore != null && catalysts.score < Number(gate.minCatalystScore)) return false
  if (gate.requirePeerConfirmation || gate.minPeerPriceDensityCorr != null || gate.minPeerPriceSentimentCorr != null || gate.requirePeerPriceRising) {
    const peer = peerConfirmationAt(context, bar.minute, {
      windowMinutes: Number(gate.peerWindowMinutes || gate.windowMinutes || 60),
      lookbackWindows: Number(gate.peerCorrelationLookbackWindows || 10),
    })
    if (!peer) return false
    if (gate.requirePeerPriceRising && !(Number(peer.priceClose) > Number(peer.priceOpen))) return false
    if (gate.minPeerPriceDensityCorr != null && !(Number(peer.corrPriceDensity) >= Number(gate.minPeerPriceDensityCorr))) return false
    if (gate.minPeerPriceSentimentCorr != null && !(Number(peer.corrPriceSentiment) >= Number(gate.minPeerPriceSentimentCorr))) return false
  }

  const current = densityAt(context, smoothed, bar.minute)
  if (gate.minSmoothedDensity != null && current < gate.minSmoothedDensity) return false
  if (gate.minDensityRise30Multiple != null) {
    const prior = densityAt(context, smoothed, bar.minute - 30 * 60)
    if (!(prior > 0) || current / prior < gate.minDensityRise30Multiple) return false
  }
  return true
}

function qualityGateFromRule(rule = {}) {
  const gate = {}
  if (rule.maxPreSignalReturn60mPct != null) gate.maxPre60Pct = Number(rule.maxPreSignalReturn60mPct)
  if (rule.maxPre60Pct != null) gate.maxPre60Pct = Number(rule.maxPre60Pct)
  if (rule.minTrailing60Messages != null) gate.minTrailing60Messages = Number(rule.minTrailing60Messages)
  if (rule.minSmoothedDensity != null) gate.minSmoothedDensity = Number(rule.minSmoothedDensity)
  if (rule.minDensityRise30Multiple != null) gate.minDensityRise30Multiple = Number(rule.minDensityRise30Multiple)
  return Object.keys(gate).length ? gate : null
}

function signalDiagnostics(context, bars, signalBar, entryBar, exitBars) {
  const before = minutes => pctReturn(findBarAtOrBefore(bars, signalBar.minute - minutes * 60)?.close, signalBar.close)
  const forward = minutes => pctReturn(signalBar.close, findBarAtOrAfter(bars, signalBar.minute + minutes * 60)?.close)
  const highs = exitBars.map(bar => Number.isFinite(Number(bar.high)) ? Number(bar.high) : Number(bar.close))
  const lows = exitBars.map(bar => Number.isFinite(Number(bar.low)) ? Number(bar.low) : Number(bar.close))
  const mfe = highs.length ? pctReturn(entryBar.close, Math.max(...highs)) : null
  const mae = lows.length ? pctReturn(entryBar.close, Math.min(...lows)) : null
  let timeToMfeMinutes = null
  if (highs.length) {
    const peak = Math.max(...highs)
    const peakBar = exitBars.find(bar => (Number.isFinite(Number(bar.high)) ? Number(bar.high) : Number(bar.close)) === peak)
    if (peakBar) timeToMfeMinutes = Math.round((peakBar.minute - entryBar.minute) / 60)
  }
  const pre60 = before(60)
  const halfMoveBeforeEntry = Number.isFinite(pre60) && Number.isFinite(mfe) && pre60 > 0 && mfe > 0 && pre60 > mfe
  const dup = minuteDuplicateInfo(context, signalBar.minute)
  return {
    preReturn15mPct: pct(before(15)),
    preReturn30mPct: pct(before(30)),
    preReturn60mPct: pct(pre60),
    forwardReturn15mPct: pct(forward(15)),
    forwardReturn30mPct: pct(forward(30)),
    forwardReturn60mPct: pct(forward(60)),
    forwardReturn2hPct: pct(forward(120)),
    forwardReturn4hPct: pct(forward(240)),
    forwardReturnEodPct: pctReturn(signalBar.close, exitBars[exitBars.length - 1]?.close),
    mfePct: pct(mfe),
    maePct: pct(mae),
    timeToMfeMinutes,
    alreadyUpMoreThan3PctBeforeEntry: Number.isFinite(pre60) && pre60 > 3,
    halfMoveBeforeEntry,
    signalMinuteRawMessages: dup.raw,
    signalMinuteDedupMessages: dup.dedup,
    duplicateDriven: dup.duplicateDriven,
  }
}

function averageRangePctBefore(bars, minute, lookbackBars = 12) {
  const prior = bars.filter(bar => bar.minute < minute).slice(-Math.max(1, Number(lookbackBars || 12)))
  if (!prior.length) return null
  const values = prior.map(bar => {
    const high = Number.isFinite(Number(bar.high)) ? Number(bar.high) : Number(bar.close)
    const low = Number.isFinite(Number(bar.low)) ? Number(bar.low) : Number(bar.close)
    const close = Number(bar.close)
    return close > 0 ? ((high - low) / close) * 100 : null
  }).filter(Number.isFinite)
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null
}

function simulateSignal({ context, signalBar, ruleName, group, thresholdC, correlation, previousCorrelation, trailingStopPct, protectiveStopPct = config.protectiveStopPct, tier, extra = {}, exitOverlay = null }) {
  const bars = context.bars
  const regularOnly = config.sessionMode === 'regular'
  const entryBar = firstBarAfter(regularOnly ? context.regularBars : bars, signalBar.minute)
  if (!entryBar || !sameEtDate(signalBar.minute, entryBar.minute)) return null

  const date = etParts(entryBar.minute).date
  const daySource = regularOnly ? (context.regularBarsByDate.get(date) || []) : (context.barsByDate.get(date) || [])
  const dayBars = barsFrom(daySource, entryBar.minute)
  if (!dayBars.length) return null

  const entry = entryBar.close
  let peak = entry
  let exitBar = dayBars[dayBars.length - 1]
  let exitPrice = exitBar.close
  let exitReason = 'eod_flatten'
  let partialExitPrice = null
  let partialExitSec = null
  let partialExitReason = null
  const protective = entry * (1 - protectiveStopPct / 100)
  const profitTargetPct = exitOverlay?.profitTargetPct == null ? null : Number(exitOverlay.profitTargetPct)
  const profitTarget = Number.isFinite(profitTargetPct) && profitTargetPct > 0 ? entry * (1 + profitTargetPct / 100) : null
  const timeStopMinutes = exitOverlay?.timeStopMinutes == null ? null : Number(exitOverlay.timeStopMinutes)
  const profitGivebackPct = exitOverlay?.profitGivebackPct == null ? null : Number(exitOverlay.profitGivebackPct)
  const profitGivebackActivationPct = exitOverlay?.profitGivebackActivationPct == null ? 1 : Number(exitOverlay.profitGivebackActivationPct)
  const partialExitFraction = exitOverlay?.partialExitFraction == null ? null : Math.max(0, Math.min(1, Number(exitOverlay.partialExitFraction)))
  const partialProfitTargetPct = exitOverlay?.partialProfitTargetPct == null ? null : Number(exitOverlay.partialProfitTargetPct)
  const partialTarget = Number.isFinite(partialExitFraction) &&
    partialExitFraction > 0 &&
    partialExitFraction < 1 &&
    Number.isFinite(partialProfitTargetPct) &&
    partialProfitTargetPct > 0
      ? entry * (1 + partialProfitTargetPct / 100)
      : null
  const breakevenActivationPct = exitOverlay?.breakevenActivationPct == null ? null : Number(exitOverlay.breakevenActivationPct)
  const breakevenOffsetPct = exitOverlay?.breakevenOffsetPct == null ? 0 : Number(exitOverlay.breakevenOffsetPct)
  const avgRangePct = averageRangePctBefore(regularOnly ? context.regularBars : bars, entryBar.minute, exitOverlay?.rangeLookbackBars || 12)
  const rangeGivebackMultiple = exitOverlay?.rangeGivebackMultiple == null ? null : Number(exitOverlay.rangeGivebackMultiple)
  const rangeGivebackActivationPct = exitOverlay?.rangeGivebackActivationPct == null ? 2 : Number(exitOverlay.rangeGivebackActivationPct)
  for (const bar of dayBars.slice(1)) {
    const high = Number.isFinite(Number(bar.high)) ? Number(bar.high) : Number(bar.close)
    const low = Number.isFinite(Number(bar.low)) ? Number(bar.low) : Number(bar.close)
    const trailingBeforeHigh = peak * (1 - trailingStopPct / 100)
    const hitProtective = low <= protective
    const hitTrailingBeforeHigh = low <= trailingBeforeHigh
    const nextPeak = Math.max(peak, high)
    const trailingAfterHigh = nextPeak * (1 - trailingStopPct / 100)
    const hitTrailingAfterHigh = nextPeak > peak && low <= trailingAfterHigh
    const peakProfitPct = pctReturn(entry, nextPeak)
    const breakevenStop = Number.isFinite(breakevenActivationPct) &&
      Number.isFinite(peakProfitPct) &&
      peakProfitPct >= breakevenActivationPct
        ? entry * (1 + breakevenOffsetPct / 100)
        : null
    const givebackStop = Number.isFinite(profitGivebackPct) &&
      profitGivebackPct > 0 &&
      profitGivebackPct < 100 &&
      Number.isFinite(peakProfitPct) &&
      peakProfitPct >= profitGivebackActivationPct
        ? entry + (nextPeak - entry) * (1 - profitGivebackPct / 100)
        : null
    const rangeGivebackStop = Number.isFinite(rangeGivebackMultiple) &&
      rangeGivebackMultiple > 0 &&
      Number.isFinite(avgRangePct) &&
      Number.isFinite(peakProfitPct) &&
      peakProfitPct >= rangeGivebackActivationPct
        ? nextPeak * (1 - (avgRangePct * rangeGivebackMultiple) / 100)
        : null
    const dynamicStop = Math.max(
      protective,
      breakevenStop == null ? -Infinity : breakevenStop,
      givebackStop == null ? -Infinity : givebackStop,
      rangeGivebackStop == null ? -Infinity : rangeGivebackStop,
    )
    const hitGiveback = givebackStop != null && low <= givebackStop
    const hitBreakeven = breakevenStop != null && low <= breakevenStop
    const hitRangeGiveback = rangeGivebackStop != null && low <= rangeGivebackStop
    const hitDynamicStop = low <= dynamicStop && dynamicStop > protective
    if (hitProtective || hitTrailingBeforeHigh || hitTrailingAfterHigh) {
      exitBar = bar
      if (hitProtective) {
        exitPrice = protective
        exitReason = (hitTrailingBeforeHigh || hitTrailingAfterHigh)
          ? 'protective_and_trailing_same_bar_intrabar_conservative'
          : 'protective_stop_intrabar_low'
      } else if (hitTrailingBeforeHigh) {
        exitPrice = trailingBeforeHigh
        exitReason = 'trailing_stop_intrabar_low'
      } else {
        exitPrice = trailingAfterHigh
        exitReason = 'trailing_stop_intrabar_high_then_low'
      }
      break
    }
    if (hitDynamicStop) {
      exitBar = bar
      exitPrice = dynamicStop
      if (hitRangeGiveback && dynamicStop === rangeGivebackStop) exitReason = 'range_giveback_intrabar_low'
      else if (hitGiveback && dynamicStop === givebackStop) exitReason = 'profit_giveback_intrabar_low'
      else if (hitBreakeven && dynamicStop === breakevenStop) exitReason = breakevenOffsetPct > 0 ? 'lock_profit_stop_intrabar_low' : 'breakeven_stop_intrabar_low'
      else exitReason = 'dynamic_stop_intrabar_low'
      break
    }
    if (partialTarget != null && partialExitPrice == null && high >= partialTarget) {
      partialExitPrice = partialTarget
      partialExitSec = bar.minute
      partialExitReason = 'partial_profit_target_intrabar_high'
    }
    if (profitTarget != null && high >= profitTarget) {
      exitBar = bar
      exitPrice = profitTarget
      exitReason = 'profit_target_intrabar_high'
      break
    }
    if (Number.isFinite(timeStopMinutes) && timeStopMinutes > 0 && bar.minute - entryBar.minute >= timeStopMinutes * 60) {
      exitBar = bar
      exitPrice = bar.close
      exitReason = 'time_stop_close'
      break
    }
    peak = nextPeak
  }

  const exitBars = dayBars.filter(bar => bar.minute >= entryBar.minute && bar.minute <= exitBar.minute)
  if (exitReason === 'eod_flatten') exitPrice = exitBar.close
  const finalGrossReturnPct = pctReturn(entry, exitPrice)
  const partialGrossReturnPct = partialExitPrice == null ? null : pctReturn(entry, partialExitPrice)
  const grossReturnPct = partialGrossReturnPct == null
    ? finalGrossReturnPct
    : partialExitFraction * partialGrossReturnPct + (1 - partialExitFraction) * finalGrossReturnPct
  const slippagePct = Number(config.slippagePctByTier[tier] ?? config.slippagePctByTier.Unknown ?? 0)
  const slippageRoundTrips = partialGrossReturnPct == null ? 1 : 1
  const netReturnPct = grossReturnPct == null ? null : grossReturnPct - slippagePct * 2 * slippageRoundTrips
  const diag = signalDiagnostics(context, bars, signalBar, entryBar, exitBars)
  const entryLagMinutes = Math.round((entryBar.minute - signalBar.minute) / 60)
  return {
    group,
    ruleName,
    ticker: context.ticker,
    tier,
    signalEtDate: etParts(signalBar.minute).date,
    signalSec: signalBar.minute,
    signalTimeEt: `${String(etParts(signalBar.minute).hour).padStart(2, '0')}:${String(etParts(signalBar.minute).minute).padStart(2, '0')}`,
    entrySec: entryBar.minute,
    exitSec: exitBar.minute,
    entryLagMinutes,
    entryPrice: pct(entry),
    exitPrice: pct(grossReturnPct == null ? exitPrice : entry * (1 + grossReturnPct / 100)),
    finalExitPrice: pct(exitPrice),
    partialExitPrice: pct(partialExitPrice),
    partialExitSec,
    partialExitFraction,
    partialProfitTargetPct,
    partialExitReason,
    exitClose: pct(exitBar.close),
    exitReason: partialExitPrice == null ? exitReason : `partial_profit_then_${exitReason}`,
    grossReturnPct: pct(grossReturnPct),
    finalGrossReturnPct: pct(finalGrossReturnPct),
    partialGrossReturnPct: pct(partialGrossReturnPct),
    netReturnPct: pct(netReturnPct),
    slippagePctOneWay: slippagePct,
    trailingStopPct,
    protectiveStopPct,
    profitTargetPct,
    timeStopMinutes,
    profitGivebackPct,
    profitGivebackActivationPct: profitGivebackPct == null ? null : profitGivebackActivationPct,
    breakevenActivationPct,
    breakevenOffsetPct: breakevenActivationPct == null ? null : breakevenOffsetPct,
    rangeGivebackMultiple,
    rangeGivebackActivationPct: rangeGivebackMultiple == null ? null : rangeGivebackActivationPct,
    avgRangePctAtEntry: pct(avgRangePct),
    thresholdC: thresholdC ?? null,
    correlation: pct(correlation, 6),
    previousCorrelation: pct(previousCorrelation, 6),
    changePctAtSignal: pct(signalBar.changePct),
    relVolumeAtSignal: pct(signalBar.relVolume),
    rankAtSignal: signalBar.rank,
    holdingMinutes: Math.round((exitBar.minute - entryBar.minute) / 60),
    ...diag,
    ...extra,
  }
}

function runCorrelationRule(context, rule, { group, ruleName, tierFilter = null, qualityGate = null } = {}) {
  const bars = context.bars
  const smoothed = smoothedForWindow(context, rule.windowMinutes)
  const corrByMinute = correlationForWindow(context, rule.windowMinutes)
  const trades = []
  let openUntil = 0
  for (let i = 1; i < bars.length; i += 1) {
    const bar = bars[i]
    if (bar.minute <= openUntil) continue
    const tier = bar.tier || 'Unknown'
    if (tierFilter && tier !== tierFilter) continue
    if (config.sessionMode === 'regular' && !isRegularSession(bar.minute)) continue
    const current = corrByMinute.get(bar.minute)
    const previous = corrByMinute.get(bars[i - 1].minute)
    if (!thresholdCrossed(previous, current, rule.thresholdC)) continue
    if (!passesQualityGate(context, bar, smoothed, qualityGate)) continue
    const trade = simulateSignal({
      context,
      signalBar: bar,
      ruleName,
      group,
      thresholdC: rule.thresholdC,
      correlation: current,
      previousCorrelation: previous,
      trailingStopPct: rule.trailingStopPct,
      protectiveStopPct: rule.protectiveStopPct ?? config.protectiveStopPct,
      tier,
      extra: {
        windowMinutes: rule.windowMinutes,
        densitySmoothedAtSignal: pct(densityAt(context, smoothed, bar.minute), 6),
      },
    })
    if (!trade) continue
    trades.push(trade)
    openUntil = trade.exitSec + config.cooldownMinutes * 60
  }
  return trades
}

function runNanoRule(context, rule, { group, ruleName, qualityGate = null } = {}) {
  const bars = context.bars
  const smoothed = smoothedForWindow(context, rule.windowMinutes)
  const trades = []
  let openUntil = 0
  for (const bar of bars) {
    if (bar.minute <= openUntil) continue
    if (bar.tier !== 'Nano') continue
    if (config.sessionMode === 'regular' && !isRegularSession(bar.minute)) continue
    const current = densityAt(context, smoothed, bar.minute)
    const prior = densityAt(context, smoothed, bar.minute - 60 * 60)
    const trailing60 = countTrailing(context, bar.minute, 60)
    if (!(prior > 0) || trailing60 < rule.minTrailing60Messages) continue
    const rise = current / prior
    if (rise < rule.densityRiseMultiple) continue
    if (!passesQualityGate(context, bar, smoothed, qualityGate)) continue
    const trade = simulateSignal({
      context,
      signalBar: bar,
      ruleName,
      group,
      trailingStopPct: rule.trailingStopPct,
      protectiveStopPct: rule.protectiveStopPct ?? config.protectiveStopPct,
      tier: 'Nano',
      extra: {
        windowMinutes: rule.windowMinutes,
        densitySmoothedAtSignal: pct(current, 6),
        densitySmoothed60mAgo: pct(prior, 6),
        densityRiseMultiple: pct(rise),
        trailing60Messages: trailing60,
      },
    })
    if (!trade) continue
    trades.push(trade)
    openUntil = trade.exitSec + config.cooldownMinutes * 60
  }
  return trades
}

function runTierRules(contexts) {
  const byName = {}
  for (const [name, rule] of Object.entries(config.tierRules)) byName[name] = []
  for (const context of contexts) {
    for (const [name, rule] of Object.entries(config.tierRules)) {
      if (rule.entrySignal === 'density_rise_3x_60m') {
        byName[name].push(...runNanoRule(context, { ...rule, name }, { group: 'tier_exact', ruleName: name, qualityGate: qualityGateFromRule(rule) }))
      } else {
        byName[name].push(...runCorrelationRule(context, rule, { group: 'tier_exact', ruleName: name, tierFilter: rule.tier || name, qualityGate: qualityGateFromRule(rule) }))
      }
    }
  }
  return byName
}

function runPooledRules(contexts) {
  const byName = Object.fromEntries(config.pooledRules.map(rule => [rule.name, []]))
  for (const context of contexts) {
    for (const rule of config.pooledRules) {
      byName[rule.name].push(...runCorrelationRule(context, rule, { group: 'pooled_exact', ruleName: rule.name }))
    }
  }
  return byName
}

function runSensitivity(contexts) {
  const rows = []
  for (const windowMinutes of config.sensitivity.windowsMinutes) {
    for (const thresholdC of config.sensitivity.thresholds) {
      const rule = { windowMinutes, thresholdC, trailingStopPct: 2 }
      let trades = []
      for (const context of contexts) trades.push(...runCorrelationRule(context, rule, { group: 'sensitivity_corr', ruleName: `corr_w${windowMinutes}_c${thresholdC}_trail2` }))
      rows.push({ family: 'corr_threshold_window_oat', windowMinutes, thresholdC, trailingStopPct: 2, ...summarizeTrades(trades) })
    }
  }
  for (const trailingStopPct of config.sensitivity.trailingStopsPct) {
    const rule = { windowMinutes: 240, thresholdC: 0.7, trailingStopPct }
    let trades = []
    for (const context of contexts) trades.push(...runCorrelationRule(context, rule, { group: 'sensitivity_trail', ruleName: `corr_w240_c0.7_trail${trailingStopPct}` }))
    rows.push({ family: 'trailing_stop_oat_w240_c0.7', windowMinutes: 240, thresholdC: 0.7, trailingStopPct, ...summarizeTrades(trades) })
  }
  for (const densityRiseMultiple of config.sensitivity.nanoRiseMultiples) {
    for (const minTrailing60Messages of config.sensitivity.nanoMinTrailing60Messages) {
      const rule = { windowMinutes: 360, densityRiseMultiple, minTrailing60Messages, trailingStopPct: 15 }
      let trades = []
      for (const context of contexts) trades.push(...runNanoRule(context, rule, { group: 'sensitivity_nano', ruleName: `nano_r${densityRiseMultiple}_m${minTrailing60Messages}_trail15` }))
      rows.push({ family: 'nano_density_oat', windowMinutes: 360, densityRiseMultiple, minTrailing60Messages, trailingStopPct: 15, ...summarizeTrades(trades) })
    }
  }
  return rows
}

function runSubmittedTierAggregate(contexts, name, qualityGate) {
  const trades = []
  for (const context of contexts) {
    for (const [ruleName, rule] of Object.entries(config.tierRules)) {
      if (rule.entrySignal === 'density_rise_3x_60m') {
        trades.push(...runNanoRule(context, { ...rule, name: ruleName }, { group: 'improvement', ruleName: `${name}:${ruleName}`, qualityGate }))
      } else {
        trades.push(...runCorrelationRule(context, rule, { group: 'improvement', ruleName: `${name}:${ruleName}`, tierFilter: ruleName, qualityGate }))
      }
    }
  }
  return trades
}

function runSubmittedPooledAggregate(contexts, name, qualityGate) {
  const trades = []
  for (const context of contexts) {
    for (const rule of config.pooledRules) {
      trades.push(...runCorrelationRule(context, rule, { group: 'improvement', ruleName: `${name}:${rule.name}`, qualityGate }))
    }
  }
  return trades
}

function runImprovementTests(contexts) {
  const out = {
    submitted_tier_pre60le3: runSubmittedTierAggregate(contexts, 'submitted_tier_pre60le3', { maxPre60Pct: 3 }),
    submitted_tier_pre60le5_msg3: runSubmittedTierAggregate(contexts, 'submitted_tier_pre60le5_msg3', { maxPre60Pct: 5, minTrailing60Messages: 3 }),
    submitted_pooled_pre60le3: runSubmittedPooledAggregate(contexts, 'submitted_pooled_pre60le3', { maxPre60Pct: 3 }),
    submitted_pooled_pre60le5_msg3: runSubmittedPooledAggregate(contexts, 'submitted_pooled_pre60le5_msg3', { maxPre60Pct: 5, minTrailing60Messages: 3 }),
  }

  const localVariants = [
    { name: 'local_w120_c0.8_t2_pre60le3', rule: { windowMinutes: 120, thresholdC: 0.8, trailingStopPct: 2 }, gate: { maxPre60Pct: 3 } },
    { name: 'local_w120_c0.8_t2_pre60le5', rule: { windowMinutes: 120, thresholdC: 0.8, trailingStopPct: 2 }, gate: { maxPre60Pct: 5 } },
    { name: 'local_w120_c0.8_t2_pre60le5_msg3', rule: { windowMinutes: 120, thresholdC: 0.8, trailingStopPct: 2 }, gate: { maxPre60Pct: 5, minTrailing60Messages: 3 } },
    { name: 'local_w120_c0.8_t3_pre60le5_msg3', rule: { windowMinutes: 120, thresholdC: 0.8, trailingStopPct: 3 }, gate: { maxPre60Pct: 5, minTrailing60Messages: 3 } },
    { name: 'local_w120_c0.85_t2_pre60le5', rule: { windowMinutes: 120, thresholdC: 0.85, trailingStopPct: 2 }, gate: { maxPre60Pct: 5 } },
    { name: 'local_w180_c0.2_t2_pre60le3', rule: { windowMinutes: 180, thresholdC: 0.2, trailingStopPct: 2 }, gate: { maxPre60Pct: 3 } },
    { name: 'local_w180_c-0.2_t2_pre60le3', rule: { windowMinutes: 180, thresholdC: -0.2, trailingStopPct: 2 }, gate: { maxPre60Pct: 3 } },
    { name: 'local_w240_c-0.2_t2_pre60le3', rule: { windowMinutes: 240, thresholdC: -0.2, trailingStopPct: 2 }, gate: { maxPre60Pct: 3 } },
  ]
  for (const variant of localVariants) {
    const trades = []
    for (const context of contexts) trades.push(...runCorrelationRule(context, variant.rule, { group: 'improvement', ruleName: variant.name, qualityGate: variant.gate }))
    out[variant.name] = trades
  }

  const nanoVariants = [
    { name: 'nano20_pre60le3', rule: { windowMinutes: 360, densityRiseMultiple: 3, minTrailing60Messages: 5, trailingStopPct: 20 }, gate: { maxPre60Pct: 3 } },
    { name: 'nano20_pre60le5_msg3', rule: { windowMinutes: 360, densityRiseMultiple: 3, minTrailing60Messages: 5, trailingStopPct: 20 }, gate: { maxPre60Pct: 5, minTrailing60Messages: 3 } },
    { name: 'nano20_r2.5_pre60le5_msg5', rule: { windowMinutes: 360, densityRiseMultiple: 2.5, minTrailing60Messages: 5, trailingStopPct: 20 }, gate: { maxPre60Pct: 5 } },
  ]
  for (const variant of nanoVariants) {
    const trades = []
    for (const context of contexts) trades.push(...runNanoRule(context, variant.rule, { group: 'improvement', ruleName: variant.name, qualityGate: variant.gate }))
    out[variant.name] = trades
  }
  return out
}

function optimizationParamGrid() {
  const grid = config.optimizationGrid || {}
  const windows = grid.windowsMinutes || [60, 90, 120, 180, 240, 300, 360]
  const thresholds = grid.thresholds || [-0.2, 0, 0.1, 0.2, 0.3, 0.4, 0.6, 0.8]
  const trailingStops = grid.trailingStopsPct || [1.5, 2, 3, 5]
  const maxPre60Values = grid.maxPre60Pct || [1, 2, 3, 5]
  const minTrailing60Messages = grid.minTrailing60Messages || [0, 3]
  const minRelVolumeValues = grid.minRelVolumeAtSignal || [0]
  const maxAbsChangePctValues = grid.maxAbsChangePctAtSignal || [null]
  const out = []
  for (const windowMinutes of windows) {
    for (const thresholdC of thresholds) {
      for (const trailingStopPct of trailingStops) {
        for (const maxPre60Pct of maxPre60Values) {
          for (const minMsgs of minTrailing60Messages) {
            for (const minRelVolumeAtSignal of minRelVolumeValues) {
              for (const maxAbsChangePctAtSignal of maxAbsChangePctValues) {
                out.push({
                  name: [
                    `opt_w${windowMinutes}`,
                    `c${String(thresholdC).replace('-', 'm')}`,
                    `t${trailingStopPct}`,
                    `pre60le${maxPre60Pct}`,
                    minMsgs ? `msg${minMsgs}` : 'msg0',
                    minRelVolumeAtSignal ? `rv${minRelVolumeAtSignal}` : null,
                    maxAbsChangePctAtSignal ? `abschg${maxAbsChangePctAtSignal}` : null,
                  ].filter(Boolean).join('_'),
                  rule: { windowMinutes, thresholdC, trailingStopPct },
                  gate: {
                    maxPre60Pct,
                    minTrailing60Messages: minMsgs || null,
                    minRelVolumeAtSignal: minRelVolumeAtSignal || null,
                    maxAbsChangePctAtSignal: maxAbsChangePctAtSignal || null,
                  },
                })
              }
            }
          }
        }
      }
    }
  }
  return out
}

function passesOptimizationGate(bar, gate = {}) {
  if (gate.minRelVolumeAtSignal != null && Number(bar.relVolume) < Number(gate.minRelVolumeAtSignal)) return false
  if (gate.maxRelVolumeAtSignal != null && Number(bar.relVolume) > Number(gate.maxRelVolumeAtSignal)) return false
  if (gate.maxRankAtSignal != null && Number(bar.rank) > Number(gate.maxRankAtSignal)) return false
  if (gate.minRankAtSignal != null && Number(bar.rank) < Number(gate.minRankAtSignal)) return false
  if (gate.minChangePctAtSignal != null && Number(bar.changePct) < Number(gate.minChangePctAtSignal)) return false
  if (gate.maxChangePctAtSignal != null && Number(bar.changePct) > Number(gate.maxChangePctAtSignal)) return false
  if (gate.maxAbsChangePctAtSignal != null && Math.abs(Number(bar.changePct || 0)) > Number(gate.maxAbsChangePctAtSignal)) return false
  return true
}

function dashboardScore(context, bar, smoothed, correlation, gate = {}) {
  const scoreGate = gate.dashboardScore || {}
  const catalysts = trailingCatalystTotals(context, bar.minute, Number(scoreGate.catalystLookbackMinutes || 240))
  const sentiment = trailingSocialTotals(context, bar.minute, Number(scoreGate.sentimentLookbackMinutes || 60))
  const pre15 = historicalReturnPct(context.bars, bar, 15)
  const pre30 = historicalReturnPct(context.bars, bar, 30)
  const pre60 = historicalReturnPct(context.bars, bar, 60)
  const density = densityAt(context, smoothed, bar.minute)
  const trailing60 = countTrailing(context, bar.minute, 60)
  const peer = scoreGate.peerWindowMinutes
    ? peerConfirmationAt(context, bar.minute, {
        windowMinutes: Number(scoreGate.peerWindowMinutes || 60),
        lookbackWindows: Number(scoreGate.peerCorrelationLookbackWindows || 10),
      })
    : null
  const checks = {
    relVolume: Number(bar.relVolume) >= Number(scoreGate.relVolumeAtLeast ?? 2),
    topRank: Number(bar.rank) > 0 && Number(bar.rank) <= Number(scoreGate.rankAtMost ?? 50),
    healthyMomentum: Number(bar.changePct) >= Number(scoreGate.changePctAtLeast ?? 1) && Number(bar.changePct) <= Number(scoreGate.changePctAtMost ?? 12),
    notOverextended: Number.isFinite(pre60) && pre60 <= Number(scoreGate.pre60AtMost ?? 4),
    shortTermTrend: Number.isFinite(pre15) && pre15 >= Number(scoreGate.pre15AtLeast ?? 0),
    density: density >= Number(scoreGate.densityAtLeast ?? 0.025),
    messageFlow: trailing60 >= Number(scoreGate.trailing60AtLeast ?? gate.minTrailing60Messages ?? 3),
    catalyst: catalysts.total >= Number(scoreGate.catalystsAtLeast ?? 1) || catalysts.positive >= Number(scoreGate.positiveCatalystsAtLeast ?? 1),
    sentiment: sentiment.tagged >= Number(scoreGate.sentimentTaggedAtLeast ?? 1) && (sentiment.bull - sentiment.bear) >= Number(scoreGate.sentimentDeltaAtLeast ?? 1),
    peer: peer ? Number(peer.priceClose) > Number(peer.priceOpen) &&
      Number(peer.corrPriceDensity) >= Number(scoreGate.peerDensityCorrAtLeast ?? 0.1) &&
      Number(peer.corrPriceSentiment) >= Number(scoreGate.peerSentimentCorrAtLeast ?? 0.1) : false,
    correlation: Number(correlation) >= Number(scoreGate.correlationAtLeast ?? gate.thresholdC ?? -1),
  }
  const enabled = scoreGate.enabledChecks || [
    'relVolume',
    'topRank',
    'healthyMomentum',
    'notOverextended',
    'shortTermTrend',
    'density',
    'messageFlow',
    'catalyst',
    'sentiment',
    'peer',
    'correlation',
  ]
  const passed = enabled.filter(key => checks[key]).length
  return {
    passed,
    possible: enabled.length,
    pct: enabled.length ? passed / enabled.length : null,
    checks,
    pre15,
    pre30,
    pre60,
    density,
    trailing60,
    catalysts,
    sentiment,
    peer,
  }
}

function signalGateDiagnostics(context, bar, gate = {}) {
  const catalystLookback = Number(gate?.catalystLookbackMinutes || 240)
  const sentimentLookback = Number(gate?.sentimentLookbackMinutes || gate?.peerSentimentLookbackMinutes || 60)
  const catalysts = trailingCatalystTotals(context, bar.minute, catalystLookback)
  const sentiment = trailingSocialTotals(context, bar.minute, sentimentLookback)
  const peer = (gate?.requirePeerConfirmation || gate?.minPeerPriceDensityCorr != null || gate?.minPeerPriceSentimentCorr != null || gate?.requirePeerPriceRising)
    ? peerConfirmationAt(context, bar.minute, {
        windowMinutes: Number(gate.peerWindowMinutes || gate.windowMinutes || 60),
        lookbackWindows: Number(gate.peerCorrelationLookbackWindows || 10),
      })
    : null
  return {
    catalystLookbackMinutes: catalystLookback,
    trailingCatalysts: catalysts.total,
    trailingPositiveCatalysts: catalysts.positive,
    trailingNegativeCatalysts: catalysts.negative,
    trailingCatalystScore: pct(catalysts.score, 6),
    sentimentLookbackMinutes: sentimentLookback,
    trailingSentimentTagged: sentiment.tagged,
    trailingSentimentBull: sentiment.bull,
    trailingSentimentBear: sentiment.bear,
    trailingSentimentBullBearDelta: sentiment.bull - sentiment.bear,
    peerWindowMinutes: peer ? Number(gate.peerWindowMinutes || gate.windowMinutes || 60) : null,
    peerCorrPriceDensityAtSignal: peer ? pct(peer.corrPriceDensity, 6) : null,
    peerCorrPriceSentimentAtSignal: peer ? pct(peer.corrPriceSentiment, 6) : null,
    peerPriceRisingAtSignal: peer ? Number(peer.priceClose) > Number(peer.priceOpen) : null,
  }
}

function runCorrelationRuleWithSignalGate(context, rule, { group, ruleName, qualityGate = null, exitOverlay = null, tierFilter = null } = {}) {
  const bars = context.bars
  const smoothed = smoothedForWindow(context, rule.windowMinutes)
  const corrByMinute = correlationForWindow(context, rule.windowMinutes)
  const trades = []
  let openUntil = 0
  for (let i = 1; i < bars.length; i += 1) {
    const bar = bars[i]
    if (bar.minute <= openUntil) continue
    if (tierFilter && (bar.tier || 'Unknown') !== tierFilter) continue
    if (config.sessionMode === 'regular' && !isRegularSession(bar.minute)) continue
    if (!passesOptimizationGate(bar, qualityGate)) continue
    const current = corrByMinute.get(bar.minute)
    const previous = corrByMinute.get(bars[i - 1].minute)
    if (!thresholdCrossed(previous, current, rule.thresholdC)) continue
    if (!passesQualityGate(context, bar, smoothed, qualityGate)) continue
    const score = dashboardScore(context, bar, smoothed, current, { ...(qualityGate || {}), thresholdC: rule.thresholdC })
    if (qualityGate?.minDashboardScore != null && score.passed < Number(qualityGate.minDashboardScore)) continue
    if (qualityGate?.minDashboardScorePct != null && !(score.pct >= Number(qualityGate.minDashboardScorePct))) continue
    const trade = simulateSignal({
      context,
      signalBar: bar,
      ruleName,
      group,
      thresholdC: rule.thresholdC,
      correlation: current,
      previousCorrelation: previous,
      trailingStopPct: rule.trailingStopPct,
      tier: bar.tier || 'Unknown',
      protectiveStopPct: rule.protectiveStopPct ?? config.protectiveStopPct,
      exitOverlay,
      extra: {
        windowMinutes: rule.windowMinutes,
        densitySmoothedAtSignal: pct(densityAt(context, smoothed, bar.minute), 6),
        minTrailing60Messages: qualityGate?.minTrailing60Messages ?? null,
        maxPre60Pct: qualityGate?.maxPre60Pct ?? null,
        minRelVolumeAtSignal: qualityGate?.minRelVolumeAtSignal ?? null,
        maxRankAtSignal: qualityGate?.maxRankAtSignal ?? null,
        minChangePctAtSignal: qualityGate?.minChangePctAtSignal ?? null,
        maxChangePctAtSignal: qualityGate?.maxChangePctAtSignal ?? null,
        minDashboardScore: qualityGate?.minDashboardScore ?? null,
        dashboardScorePassed: score.passed,
        dashboardScorePossible: score.possible,
        dashboardScorePct: pct(score.pct == null ? null : score.pct * 100),
        dashboardScoreChecks: score.checks,
        maxAbsChangePctAtSignal: qualityGate?.maxAbsChangePctAtSignal ?? null,
        ...signalGateDiagnostics(context, bar, qualityGate || {}),
      },
    })
    if (!trade) continue
    trades.push(trade)
    openUntil = trade.exitSec + config.cooldownMinutes * 60
  }
  return trades
}

function runOptimizationGrid(contexts) {
  const variants = optimizationParamGrid()
  const byName = {}
  for (const variant of variants) {
    const trades = []
    for (const context of contexts) {
      trades.push(...runCorrelationRuleWithSignalGate(context, variant.rule, {
        group: 'optimization',
        ruleName: variant.name,
        qualityGate: variant.gate,
      }))
    }
    byName[variant.name] = trades
  }
  return byName
}

function v6FullImprovementConfig() {
  const cfg = config.v6FullImprovementGrid || {}
  return {
    enabled: Boolean(cfg.enabled),
    windowsMinutes: cfg.windowsMinutes || [90, 120],
    thresholds: cfg.thresholds || [0.32, 0.36, 0.38, 0.4],
    trailingStopsPct: cfg.trailingStopsPct || [5, 7, 10],
    maxPre60Pct: cfg.maxPre60Pct || [1, 4],
    minTrailing60Messages: cfg.minTrailing60Messages || [3, 8, 10],
    gatePresets: cfg.gatePresets || [
      { name: 'base', gate: {} },
      { name: 'cat240ge1', gate: { catalystLookbackMinutes: 240, minTrailingCatalysts: 1 } },
      { name: 'poscat240ge1', gate: { catalystLookbackMinutes: 240, minPositiveCatalysts: 1 } },
      { name: 'sent60delta1', gate: { sentimentLookbackMinutes: 60, minSocialTaggedMessages: 1, minSocialBullBearDelta: 1 } },
      { name: 'peer60c02', gate: { requirePeerPriceRising: true, peerWindowMinutes: 60, peerCorrelationLookbackWindows: 10, minPeerPriceDensityCorr: 0.2, minPeerPriceSentimentCorr: 0.2 } },
    ],
    exitOverlays: cfg.exitOverlays || [
      { name: 'eodtrail', overlay: {} },
      { name: 'pt3', overlay: { profitTargetPct: 3 } },
      { name: 'pt5', overlay: { profitTargetPct: 5 } },
      { name: 'ts120', overlay: { timeStopMinutes: 120 } },
      { name: 'pt3_ts120', overlay: { profitTargetPct: 3, timeStopMinutes: 120 } },
    ],
    maxVariants: Number(cfg.maxVariants || 500),
  }
}

function v6FullImprovementVariants() {
  const cfg = v6FullImprovementConfig()
  if (!cfg.enabled) return []
  const out = []
  for (const windowMinutes of cfg.windowsMinutes) {
    for (const thresholdC of cfg.thresholds) {
      for (const trailingStopPct of cfg.trailingStopsPct) {
        for (const maxPre60Pct of cfg.maxPre60Pct) {
          for (const minMsgs of cfg.minTrailing60Messages) {
            for (const gatePreset of cfg.gatePresets) {
              for (const exitPreset of cfg.exitOverlays) {
                const gate = {
                  maxPre60Pct,
                  minTrailing60Messages: minMsgs || null,
                  ...(gatePreset.gate || {}),
                }
                const overlay = exitPreset.overlay || {}
                out.push({
                  name: [
                    `v6full_w${windowMinutes}`,
                    `c${String(thresholdC).replace('-', 'm')}`,
                    `t${trailingStopPct}`,
                    `pre60le${maxPre60Pct}`,
                    minMsgs ? `msg${minMsgs}` : 'msg0',
                    gatePreset.name || 'gate',
                    exitPreset.name || 'exit',
                  ].filter(Boolean).join('_'),
                  rule: { windowMinutes, thresholdC, trailingStopPct },
                  gate,
                  exitOverlay: Object.keys(overlay).length ? overlay : null,
                })
                if (out.length >= cfg.maxVariants) return out
              }
            }
          }
        }
      }
    }
  }
  return out
}

function runV6FullImprovementGrid(contexts) {
  const variants = v6FullImprovementVariants()
  const byName = {}
  for (const variant of variants) {
    const trades = []
    for (const context of contexts) {
      trades.push(...runCorrelationRuleWithSignalGate(context, variant.rule, {
        group: 'v6_full_improvement',
        ruleName: variant.name,
        qualityGate: variant.gate,
        exitOverlay: variant.exitOverlay,
      }))
    }
    byName[variant.name] = trades
  }
  return byName
}

function v6WinRateQualityConfig() {
  const cfg = config.v6WinRateQualityGrid || {}
  return {
    enabled: Boolean(cfg.enabled),
    baseRules: cfg.baseRules || [
      { name: 'v6_anchor', windowMinutes: 120, thresholdC: 0.4, trailingStopPct: 10, maxPre60Pct: 1, minTrailing60Messages: 3 },
      { name: 'v6_large', windowMinutes: 120, thresholdC: 0.38, trailingStopPct: 5, maxPre60Pct: 1, minTrailing60Messages: 3 },
      { name: 'v6_mid_small', windowMinutes: 90, thresholdC: 0.32, trailingStopPct: 5, maxPre60Pct: 4, minTrailing60Messages: 8 },
    ],
    dashboardScores: cfg.dashboardScores || [3, 4, 5, 6],
    rankMax: cfg.rankMax || [null, 100, 50, 25],
    relVolumeMin: cfg.relVolumeMin || [null, 1.5, 2.5, 5],
    changeBands: cfg.changeBands || [
      { name: 'mom0to12', min: 0, max: 12 },
      { name: 'mom1to10', min: 1, max: 10 },
      { name: 'mom2to8', min: 2, max: 8 },
      { name: 'anymom', min: null, max: null },
    ],
    exitOverlays: cfg.exitOverlays || [
      { name: 'eodtrail', overlay: {} },
      { name: 'pt2', overlay: { profitTargetPct: 2 } },
      { name: 'pt3', overlay: { profitTargetPct: 3 } },
      { name: 'pt2_ts90', overlay: { profitTargetPct: 2, timeStopMinutes: 90 } },
    ],
    dashboardScore: cfg.dashboardScore || {
      peerWindowMinutes: 60,
      peerCorrelationLookbackWindows: 10,
      enabledChecks: ['relVolume', 'topRank', 'healthyMomentum', 'notOverextended', 'shortTermTrend', 'density', 'messageFlow', 'catalyst', 'sentiment', 'peer', 'correlation'],
    },
    maxVariants: Number(cfg.maxVariants || 400),
    minWinRateTrades: Math.max(10, Number(cfg.minWinRateTrades || 20)),
    targetWinRate: Number(cfg.targetWinRate || 0.5),
  }
}

function v6WinRateQualityVariants() {
  const cfg = v6WinRateQualityConfig()
  if (!cfg.enabled) return []
  const out = []
  for (const base of cfg.baseRules) {
    for (const minDashboardScore of cfg.dashboardScores) {
      for (const maxRankAtSignal of cfg.rankMax) {
        for (const minRelVolumeAtSignal of cfg.relVolumeMin) {
          for (const band of cfg.changeBands) {
            for (const exitPreset of cfg.exitOverlays) {
              const gate = {
                maxPre60Pct: base.maxPre60Pct,
                minTrailing60Messages: base.minTrailing60Messages,
                minDashboardScore,
                maxRankAtSignal,
                minRelVolumeAtSignal,
                minChangePctAtSignal: band.min,
                maxChangePctAtSignal: band.max,
                dashboardScore: cfg.dashboardScore,
              }
              const overlay = exitPreset.overlay || {}
              out.push({
                name: [
                  base.name,
                  `score${minDashboardScore}`,
                  maxRankAtSignal ? `rank${maxRankAtSignal}` : 'rankany',
                  minRelVolumeAtSignal ? `rv${minRelVolumeAtSignal}` : 'rvany',
                  band.name || 'mom',
                  exitPreset.name || 'exit',
                ].join('_'),
                  rule: {
                    windowMinutes: base.windowMinutes,
                    thresholdC: base.thresholdC,
                    trailingStopPct: base.trailingStopPct,
                    protectiveStopPct: base.protectiveStopPct,
                  },
                  tierFilter: base.tier || base.tierFilter || null,
                  gate,
                  exitOverlay: Object.keys(overlay).length ? overlay : null,
              })
              if (out.length >= cfg.maxVariants) return out
            }
          }
        }
      }
    }
  }
  return out
}

function runV6WinRateQualityGrid(contexts) {
  const variants = v6WinRateQualityVariants()
  const byName = {}
  for (const variant of variants) {
    const trades = []
    for (const context of contexts) {
      trades.push(...runCorrelationRuleWithSignalGate(context, variant.rule, {
        group: 'v6_winrate_quality',
        ruleName: variant.name,
        qualityGate: variant.gate,
        exitOverlay: variant.exitOverlay,
        tierFilter: variant.tierFilter,
      }))
    }
    byName[variant.name] = trades
  }
  return byName
}

function winRateRows(tradesByName) {
  const cfg = v6WinRateQualityConfig()
  return Object.entries(tradesByName)
    .map(([name, trades]) => {
      const stats = summarizeTrades(trades)
      const rejectReasons = []
      if (Number(stats.trades || 0) < cfg.minWinRateTrades) rejectReasons.push(`trades_lt_${cfg.minWinRateTrades}`)
      if (!(Number(stats.winRate || 0) >= cfg.targetWinRate)) rejectReasons.push(`win_rate_lt_${cfg.targetWinRate}`)
      if (!(Number(stats.meanNetReturnPct ?? -999) > 0)) rejectReasons.push('mean_net_not_positive')
      if (!(Number(stats.profitFactor ?? 0) >= 1.15)) rejectReasons.push('profit_factor_lt_1.15')
      return {
        name,
        winRateStatus: rejectReasons.length ? 'watch_or_reject' : 'win_rate_candidate',
        winRateRejectReasons: rejectReasons,
        trades: stats.trades,
        winRate: stats.winRate,
        meanNetReturnPct: stats.meanNetReturnPct,
        medianNetReturnPct: stats.medianNetReturnPct,
        profitFactor: stats.profitFactor,
        maxDrawdownPctPoints: stats.maxDrawdownPctPoints,
        exitCounts: stats.exitCounts,
      }
    })
    .sort((a, b) => {
      const ap = a.winRateStatus === 'win_rate_candidate' ? 1 : 0
      const bp = b.winRateStatus === 'win_rate_candidate' ? 1 : 0
      return bp - ap ||
        Number(b.winRate || 0) - Number(a.winRate || 0) ||
        Number(b.profitFactor || 0) - Number(a.profitFactor || 0) ||
        Number(b.meanNetReturnPct ?? -999) - Number(a.meanNetReturnPct ?? -999)
    })
}

function peerResearchConfig() {
  const cfg = config.peerResearch || {}
  return {
    enabled: Boolean(cfg.enabled),
    windowsMinutes: cfg.windowsMinutes || [10, 20, 30, 60, 90, 120, 180, 240, 360, 480],
    entryThresholds: cfg.entryThresholds || [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0],
    corrTrailingStopsPct: cfg.corrTrailingStopsPct || [5, 10, 15, 20, 25, 30],
    exitThresholds: cfg.exitThresholds || [0, 0.1, 0.15, 0.2, 0.25, 0.3],
    correlationLookbackWindows: Math.max(3, Number(cfg.correlationLookbackWindows || 10)),
  }
}

function peerPctChangeThresholdForTier(tier) {
  const values = config.peerResearch?.pctChangeThresholdsByTier || {}
  const fallback = { Mega: 0.5, Large: 0.5, Mid: 5, Small: 5, Nano: 10, Unknown: 5 }
  return Number(values[tier] ?? fallback[tier] ?? 5)
}

function peerSentimentScore({ bull = 0, bear = 0, tagged = 0, total = 0 } = {}) {
  if (!tagged) return null
  return ((Number(bull || 0) - Number(bear || 0)) / Number(tagged)) * Math.log1p(Number(total || 0))
}

function safePearson(xs, ys) {
  const r = pearson(xs, ys)
  return Number.isFinite(Number(r)) ? Number(r) : null
}

function peerWindowSeries(context, windowMinutes, lookbackWindows) {
  const cacheKey = `${windowMinutes}|${lookbackWindows}`
  if (context.peerWindowCache.has(cacheKey)) return context.peerWindowCache.get(cacheKey)
  const sourceBars = config.sessionMode === 'regular' ? context.regularBars : context.bars
  const rows = []
  for (const bar of sourceBars) {
    const windowStart = bar.minute - windowMinutes * 60 + 60
    const startBar = findBarAtOrAfter(context.bars, windowStart)
    if (!startBar || !sameEtDate(startBar.minute, bar.minute)) continue
    const totals = trailingSocialTotals(context, bar.minute, windowMinutes)
    rows.push({
      minute: bar.minute,
      priceOpen: Number(startBar.open ?? startBar.close),
      priceClose: Number(bar.close),
      high: Number(bar.high ?? bar.close),
      low: Number(bar.low ?? bar.close),
      totalMsgs: totals.total,
      bull: totals.bull,
      bear: totals.bear,
      tagged: totals.tagged,
      msgPerMin: Number(totals.total || 0) / Math.max(1, windowMinutes),
      sentiment: peerSentimentScore(totals),
      bar,
    })
  }

  const prices = rows.map(row => row.priceClose)
  const densities = rows.map(row => row.msgPerMin)
  const sentiments = rows.map(row => row.sentiment)
  for (let i = 0; i < rows.length; i += 1) {
    const lo = Math.max(0, i - lookbackWindows + 1)
    rows[i].corrPriceDensity = safePearson(prices.slice(lo, i + 1), densities.slice(lo, i + 1))
    rows[i].corrPriceSentiment = safePearson(prices.slice(lo, i + 1), sentiments.slice(lo, i + 1))
  }
  context.peerWindowCache.set(cacheKey, rows)
  return rows
}

function peerConfirmationAt(context, minute, { windowMinutes = 60, lookbackWindows = 10 } = {}) {
  const cacheKey = `${windowMinutes}|${lookbackWindows}`
  let byMinute = context.peerConfirmationCache.get(cacheKey)
  if (!byMinute) {
    byMinute = new Map()
    for (const row of peerWindowSeries(context, windowMinutes, lookbackWindows)) byMinute.set(row.minute, row)
    context.peerConfirmationCache.set(cacheKey, byMinute)
  }
  return byMinute.get(minute) || null
}

function peerTradeFromWindows({ context, entryWindow, exitWindow, ruleName, exitReason, entryThreshold, exitThreshold = null, corrTrailingStopPct = null, peakDensityCorr = null, peakSentimentCorr = null, windowMinutes }) {
  if (!entryWindow || !exitWindow || exitWindow.minute <= entryWindow.minute) return null
  const tier = exitWindow.bar.tier || entryWindow.bar.tier || 'Unknown'
  const entry = Number(entryWindow.priceClose)
  const exit = Number(exitWindow.priceClose)
  if (!Number.isFinite(entry) || !Number.isFinite(exit) || entry <= 0 || exit <= 0) return null
  const grossReturnPct = pctReturn(entry, exit)
  const slippagePct = Number(config.slippagePctByTier[tier] ?? config.slippagePctByTier.Unknown ?? 0)
  const netReturnPct = grossReturnPct == null ? null : grossReturnPct - slippagePct * 2
  const peerPctThreshold = peerPctChangeThresholdForTier(tier)
  return {
    group: 'peer_research',
    ruleName,
    ticker: context.ticker,
    tier,
    signalEtDate: etParts(entryWindow.minute).date,
    signalSec: entryWindow.minute,
    signalTimeEt: `${String(etParts(entryWindow.minute).hour).padStart(2, '0')}:${String(etParts(entryWindow.minute).minute).padStart(2, '0')}`,
    entrySec: entryWindow.minute,
    exitSec: exitWindow.minute,
    entryLagMinutes: 0,
    entryPrice: pct(entry),
    exitPrice: pct(exit),
    exitClose: pct(exit),
    exitReason,
    grossReturnPct: pct(grossReturnPct),
    netReturnPct: pct(netReturnPct),
    slippagePctOneWay: slippagePct,
    windowMinutes,
    thresholdC: entryThreshold,
    peerEntryCorrelationThreshold: entryThreshold,
    peerExitCorrelationThreshold: exitThreshold,
    peerCorrelationTrailingStopPct: corrTrailingStopPct,
    peerPctChangeThreshold: peerPctThreshold,
    peerPctChangePass: Number.isFinite(Number(grossReturnPct)) && Number(grossReturnPct) > peerPctThreshold,
    entryCorrPriceDensity: pct(entryWindow.corrPriceDensity, 6),
    entryCorrPriceSentiment: pct(entryWindow.corrPriceSentiment, 6),
    exitCorrPriceDensity: pct(exitWindow.corrPriceDensity, 6),
    exitCorrPriceSentiment: pct(exitWindow.corrPriceSentiment, 6),
    peakCorrPriceDensity: pct(peakDensityCorr, 6),
    peakCorrPriceSentiment: pct(peakSentimentCorr, 6),
    avgMsgPerMinAtEntry: pct(entryWindow.msgPerMin, 6),
    sentimentAtEntry: pct(entryWindow.sentiment, 6),
    holdingMinutes: Math.round((exitWindow.minute - entryWindow.minute) / 60),
  }
}

function runPeerResearchRule(context, rule) {
  const rows = peerWindowSeries(context, rule.windowMinutes, rule.correlationLookbackWindows)
  const trades = []
  let inTrade = false
  let entryWindow = null
  let peakPd = null
  let peakPs = null
  let openUntil = 0

  for (const row of rows) {
    if (!inTrade && row.minute <= openUntil) continue
    const priceRising = Number.isFinite(row.priceOpen) && Number.isFinite(row.priceClose) && row.priceClose > row.priceOpen
    const rPd = Number(row.corrPriceDensity)
    const rPs = Number(row.corrPriceSentiment)
    const corrReady = Number.isFinite(rPd) && Number.isFinite(rPs)
    const entryCorrOk = corrReady && rPd >= rule.entryThreshold && rPs >= rule.entryThreshold

    if (!inTrade) {
      if (priceRising && entryCorrOk) {
        inTrade = true
        entryWindow = row
        peakPd = rPd
        peakPs = rPs
      }
      continue
    }

    if (Number.isFinite(rPd)) peakPd = peakPd == null ? rPd : Math.max(peakPd, rPd)
    if (Number.isFinite(rPs)) peakPs = peakPs == null ? rPs : Math.max(peakPs, rPs)

    let exitReason = null
    if (!priceRising) {
      exitReason = 'peer_price_decreasing'
    } else if (rule.exitMode === 'fixed_exit') {
      if (corrReady && (rPd < rule.exitThreshold || rPs < rule.exitThreshold)) exitReason = `peer_corr_below_exit_${rule.exitThreshold}`
    } else if (rule.exitMode === 'corr_trailing') {
      const stopFraction = Number(rule.corrTrailingStopPct || 0) / 100
      const pdStopped = peakPd != null && Number.isFinite(rPd) && rPd < peakPd * (1 - stopFraction)
      const psStopped = peakPs != null && Number.isFinite(rPs) && rPs < peakPs * (1 - stopFraction)
      if (pdStopped || psStopped) exitReason = `peer_corr_trailing_stop_${rule.corrTrailingStopPct}pct`
    }

    if (exitReason || row === rows[rows.length - 1]) {
      const trade = peerTradeFromWindows({
        context,
        entryWindow,
        exitWindow: row,
        ruleName: rule.name,
        exitReason: exitReason || 'peer_end_of_window',
        entryThreshold: rule.entryThreshold,
        exitThreshold: rule.exitThreshold,
        corrTrailingStopPct: rule.corrTrailingStopPct,
        peakDensityCorr: peakPd,
        peakSentimentCorr: peakPs,
        windowMinutes: rule.windowMinutes,
      })
      if (trade) {
        trades.push(trade)
        openUntil = trade.exitSec + config.cooldownMinutes * 60
      }
      inTrade = false
      entryWindow = null
      peakPd = null
      peakPs = null
    }
  }
  return trades
}

function peerResearchRules() {
  const cfg = peerResearchConfig()
  const rules = []
  for (const windowMinutes of cfg.windowsMinutes) {
    for (const entryThreshold of cfg.entryThresholds) {
      for (const corrTrailingStopPct of cfg.corrTrailingStopsPct) {
        rules.push({
          name: `peer_trail_w${windowMinutes}_entry${entryThreshold}_stop${corrTrailingStopPct}`,
          exitMode: 'corr_trailing',
          windowMinutes,
          entryThreshold,
          corrTrailingStopPct,
          correlationLookbackWindows: cfg.correlationLookbackWindows,
        })
      }
      for (const exitThreshold of cfg.exitThresholds) {
        if (exitThreshold >= entryThreshold) continue
        rules.push({
          name: `peer_fixed_w${windowMinutes}_entry${entryThreshold}_exit${exitThreshold}`,
          exitMode: 'fixed_exit',
          windowMinutes,
          entryThreshold,
          exitThreshold,
          correlationLookbackWindows: cfg.correlationLookbackWindows,
        })
      }
    }
  }
  return rules
}

function runPeerResearchGrid(contexts) {
  if (!peerResearchConfig().enabled) return {}
  const byName = {}
  for (const rule of peerResearchRules()) {
    const trades = []
    for (const context of contexts) trades.push(...runPeerResearchRule(context, rule))
    byName[rule.name] = trades
  }
  return byName
}

function runBaselineRule(contexts, name, predicate, trailingStopPct = 5) {
  const trades = []
  for (const context of contexts) {
    let openUntil = 0
    for (let i = 1; i < context.bars.length; i += 1) {
      const bar = context.bars[i]
      if (bar.minute <= openUntil) continue
      if (config.sessionMode === 'regular' && !isRegularSession(bar.minute)) continue
      if (!predicate(bar, context.bars[i - 1])) continue
      const trade = simulateSignal({
        context,
        signalBar: bar,
        ruleName: name,
        group: 'baseline',
        trailingStopPct,
        tier: bar.tier || 'Unknown',
      })
      if (!trade) continue
      trades.push(trade)
      openUntil = trade.exitSec + config.cooldownMinutes * 60
    }
  }
  return trades
}

function seededRandom(seed) {
  let state = seed >>> 0
  return () => {
    state = (1664525 * state + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

function runBaselines(contexts, targetCount) {
  const out = {
    momentum_alone: runBaselineRule(
      contexts,
      'momentum_alone',
      (bar, prev) => Number(prev?.changePct) <= config.baselines.momentumChangePct && Number(bar.changePct) > config.baselines.momentumChangePct,
      5,
    ),
    relvol_alone: runBaselineRule(
      contexts,
      'relvol_alone',
      (bar, prev) => Number(prev?.relVolume) <= config.baselines.relVolumeThreshold && Number(bar.relVolume) > config.baselines.relVolumeThreshold,
      5,
    ),
    screener_top_rank: runBaselineRule(
      contexts,
      'screener_top_rank',
      (bar, prev) => Number(bar.rank) > 0 &&
        Number(bar.rank) <= config.baselines.topRankThreshold &&
        (!prev || !Number.isFinite(Number(prev.rank)) || Number(prev.rank) > config.baselines.topRankThreshold),
      5,
    ),
  }

  const rng = seededRandom(42)
  const randomTrades = []
  const flatBars = contexts.flatMap(context => context.bars.filter(bar => config.sessionMode !== 'regular' || isRegularSession(bar.minute)).map(bar => ({ context, bar })))
  for (let i = 0; i < targetCount && flatBars.length; i += 1) {
    const picked = flatBars[Math.floor(rng() * flatBars.length)]
    const trade = simulateSignal({
      context: picked.context,
      signalBar: picked.bar,
      ruleName: 'random_matched_count',
      group: 'baseline',
      trailingStopPct: 5,
      tier: picked.bar.tier || 'Unknown',
    })
    if (trade) randomTrades.push(trade)
  }
  out.random_matched_count = randomTrades
  return out
}

function splitStats(trades) {
  const sorted = [...trades].sort((a, b) => a.signalSec - b.signalSec)
  const n = sorted.length
  const a = Math.floor(n * 0.6)
  const b = Math.floor(n * 0.8)
  return {
    development_60pct: summarizeTrades(sorted.slice(0, a)),
    validation_20pct: summarizeTrades(sorted.slice(a, b)),
    untouched_test_20pct: summarizeTrades(sorted.slice(b)),
  }
}

function temporalSplitStats(trades, startSec, endSec) {
  const span = Number(endSec) - Number(startSec)
  if (!Number.isFinite(span) || span <= 0) return splitStats(trades)
  const a = Number(startSec) + span * 0.6
  const b = Number(startSec) + span * 0.8
  return {
    development_60pct: summarizeTrades(trades.filter(t => Number(t.signalSec) < a)),
    validation_20pct: summarizeTrades(trades.filter(t => Number(t.signalSec) >= a && Number(t.signalSec) < b)),
    untouched_test_20pct: summarizeTrades(trades.filter(t => Number(t.signalSec) >= b)),
  }
}

function optimizationScore(stats, walk) {
  const trades = Number(stats.trades || 0)
  if (!trades) return -999
  const meanNet = Number(stats.meanNetReturnPct ?? -999)
  const pf = Number(stats.profitFactor ?? 0)
  const dd = Math.abs(Number(stats.maxDrawdownPctPoints ?? 0))
  const val = walk?.validation_20pct || {}
  const test = walk?.untouched_test_20pct || {}
  const valMean = Number(val.meanNetReturnPct ?? -999)
  const testMean = Number(test.meanNetReturnPct ?? -999)
  const sampleBonus = Math.min(1.5, Math.log10(Math.max(1, trades)) * 0.75)
  const pfBonus = Math.min(1.5, Math.max(0, pf - 1) * 0.75)
  const consistencyPenalty = (valMean <= 0 ? 2 : 0) + (testMean <= 0 ? 2 : 0)
  const sparsePenalty = trades < 20 ? 2 : trades < 35 ? 0.75 : 0
  const drawdownPenalty = Math.min(3, dd / 50)
  return Number((meanNet + sampleBonus + pfBonus - consistencyPenalty - sparsePenalty - drawdownPenalty).toFixed(4))
}

function promotionRows(tradesByName, startSec, endSec) {
  const minPromotionTrades = Math.max(20, Number(config.promotionMinTrades || 20))
  const minPromotionValidationTrades = Math.max(3, Number(config.promotionMinValidationTrades || 3))
  const minPromotionTestTrades = Math.max(3, Number(config.promotionMinTestTrades || 3))
  const minTemporalDevTrades = Math.max(0, Number(config.promotionMinTemporalDevTrades || 0))
  const minTemporalValidationTrades = Math.max(0, Number(config.promotionMinTemporalValidationTrades || 0))
  const minTemporalTestTrades = Math.max(0, Number(config.promotionMinTemporalTestTrades || 0))
  return Object.entries(tradesByName)
    .map(([name, trades]) => {
      const stats = summarizeTrades(trades)
      const sequenceWalk = splitStats(trades)
      const temporalWalk = temporalSplitStats(trades, startSec, endSec)
      const val = sequenceWalk.validation_20pct
      const test = sequenceWalk.untouched_test_20pct
      const temporalVal = temporalWalk.validation_20pct
      const temporalTest = temporalWalk.untouched_test_20pct
      const promotionRejectReasons = []
      if (Number(stats.trades || 0) < minPromotionTrades) promotionRejectReasons.push(`trades_lt_${minPromotionTrades}`)
      if (!(Number(stats.meanNetReturnPct ?? -999) > 0)) promotionRejectReasons.push('mean_net_not_positive')
      if (!(Number(stats.profitFactor ?? 0) >= 1.15)) promotionRejectReasons.push('profit_factor_lt_1.15')
      if (Number(val.trades || 0) < minPromotionValidationTrades) promotionRejectReasons.push(`validation_trades_lt_${minPromotionValidationTrades}`)
      if (Number(test.trades || 0) < minPromotionTestTrades) promotionRejectReasons.push(`test_trades_lt_${minPromotionTestTrades}`)
      if (!(Number(val.meanNetReturnPct ?? -999) > 0)) promotionRejectReasons.push('validation_mean_not_positive')
      if (!(Number(test.meanNetReturnPct ?? -999) > 0)) promotionRejectReasons.push('test_mean_not_positive')
      if (Number(temporalWalk.development_60pct.trades || 0) < minTemporalDevTrades) promotionRejectReasons.push(`temporal_dev_trades_lt_${minTemporalDevTrades}`)
      if (Number(temporalVal.trades || 0) < minTemporalValidationTrades) promotionRejectReasons.push(`temporal_validation_trades_lt_${minTemporalValidationTrades}`)
      if (Number(temporalTest.trades || 0) < minTemporalTestTrades) promotionRejectReasons.push(`temporal_test_trades_lt_${minTemporalTestTrades}`)
      if (Number(temporalTest.trades || 0) > 0 && !(Number(temporalTest.meanNetReturnPct ?? -999) > 0)) promotionRejectReasons.push('temporal_test_mean_not_positive')
      const robustEnough = promotionRejectReasons.length === 0
      const score = optimizationScore(stats, sequenceWalk)
      return {
        name,
        promotionStatus: robustEnough ? 'promote_candidate' : 'watch_or_reject',
        promotionRejectReasons,
        optimizationScore: score,
        trades: stats.trades,
        winRate: stats.winRate,
        meanNetReturnPct: stats.meanNetReturnPct,
        medianNetReturnPct: stats.medianNetReturnPct,
        profitFactor: stats.profitFactor,
        maxDrawdownPctPoints: stats.maxDrawdownPctPoints,
        devTrades: sequenceWalk.development_60pct.trades,
        devMeanNetReturnPct: sequenceWalk.development_60pct.meanNetReturnPct,
        devProfitFactor: sequenceWalk.development_60pct.profitFactor,
        validationTrades: val.trades,
        validationMeanNetReturnPct: val.meanNetReturnPct,
        validationProfitFactor: val.profitFactor,
        testTrades: test.trades,
        testMeanNetReturnPct: test.meanNetReturnPct,
        testProfitFactor: test.profitFactor,
        temporalDevTrades: temporalWalk.development_60pct.trades,
        temporalDevMeanNetReturnPct: temporalWalk.development_60pct.meanNetReturnPct,
        temporalValidationTrades: temporalVal.trades,
        temporalValidationMeanNetReturnPct: temporalVal.meanNetReturnPct,
        temporalTestTrades: temporalTest.trades,
        temporalTestMeanNetReturnPct: temporalTest.meanNetReturnPct,
        exitCounts: stats.exitCounts,
      }
    })
    .sort((a, b) => {
      const ap = a.promotionStatus === 'promote_candidate' ? 1 : 0
      const bp = b.promotionStatus === 'promote_candidate' ? 1 : 0
      return bp - ap || Number(b.optimizationScore) - Number(a.optimizationScore)
    })
}

function buildReport(summary, statsRows, sensitivityRows, promotion = []) {
  const fmtDate = sec => sec ? `${new Date(sec * 1000).toISOString()} (${etParts(sec).date} ET)` : 'n/a'
  const lines = []
  lines.push('# Message-Density Threshold Audit And Backtest')
  lines.push('')
  lines.push('## Audit Summary')
  if (String(config.priceSource || '').toLowerCase() === 'yahoo_chart') {
    if (Array.isArray(summary.price.providerQueries) && summary.price.providerQueries.length > 1) {
      const queries = summary.price.providerQueries.map(q => `${q.range}/${q.interval}`).join(', ')
      lines.push(`- Price source: Yahoo chart OHLCV provider, queries=${queries}, tickers seeded from Mongo \`${config.priceCollection}\`.`)
    } else {
      lines.push(`- Price source: Yahoo chart OHLCV provider, range=${config.chartRange || summary.price.providerRange || '1mo'}, interval=${config.chartInterval || summary.price.providerInterval || '5m'}, tickers seeded from Mongo \`${config.priceCollection}\`.`)
    }
    lines.push('- Stops use bar high/low instead of close-only snapshots. Same-bar protective/trailing conflicts are handled conservatively for long entries.')
  } else {
    lines.push(`- Price source: Mongo \`${config.priceCollection}\` snapshots, expanded into per-ticker real snapshot bars. No durable Yahoo/candle collection was selected, so this is a snapshot-bar backtest, not a full exchange OHLC backtest.`)
  }
  lines.push(`- Price coverage: ${fmtDate(summary.price.priceStartSec)} to ${fmtDate(summary.price.priceEndSec)}.`)
  lines.push(`- Eligible tickers: ${summary.price.eligibleTickers}; dropped sparse/static tickers: ${summary.price.droppedStaticOrSparseTickers}.`)
  lines.push(`- Social source: Mongo \`${config.socialCollection}\`; platforms in range: ${JSON.stringify(summary.social.platformCounts)}.`)
  if (summary.catalysts) {
    lines.push(`- Catalyst/news source: Mongo \`${summary.catalysts.collection || config.articleCollection || 'articles'}\`; matched docs in range: ${summary.catalysts.inBacktestRangeMatchedDocs}; categories: ${JSON.stringify(summary.catalysts.categoryCounts || {})}.`)
  }
  if (config.referencePolicy?.version || config.promotionMinTrades) {
    lines.push(`- Promotion gate: candidate must materially beat reference policy ${config.referencePolicy?.version || 'n/a'} (${config.referencePolicy?.bestCandidateTrades ?? 'n/a'} trades) with at least ${config.promotionMinTrades || 20} trades and configured temporal split coverage.`)
  }
  lines.push('- Density unit used by the app/backend: messages per minute (`message_count / bucket_minutes`). Screener rows use count divided by the selected rolling window.')
  lines.push('- Missing social minutes are omitted by the UI/backend series; this backtest fills missing social minutes as 0 messages for causal trailing density.')
  lines.push('- Price bars are not fabricated or forward-filled. Signals execute at the next real regular-session snapshot bar.')
  lines.push('- Look-ahead finding: `app/src/lib/chartAgg.ts` uses centered `smoothSame` for chart overlays. This report does not use it for deployable results; all backtest smoothing is trailing/causal.')
  lines.push('- Duplicate risk: raw message counts and per-minute dedup event counts are both recorded. Duplicate-driven signals are flagged when 3+ raw messages collapse to 1-2 dedup events.')
  lines.push('- Market-cap tier caveat: FinViz market cap values are normalized as millions when sourced from FinViz. If older rows use mixed units, tier assignment has classification risk.')
  if (String(config.priceSource || '').toLowerCase() === 'yahoo_chart') {
    lines.push('- Stop caveat: OHLC bars show whether a level traded inside the bar, but not tick order inside the bar; same-bar conflicts are intentionally conservative.')
  } else {
    lines.push('- Stop caveat: FinViz snapshots provide close-like prices, not intrabar OHLC. Stops are close-based and therefore cannot prove true intrabar stop ordering.')
  }
  lines.push('')
  lines.push('## Exact Submitted Config Results')
  for (const row of statsRows.filter(r => r.group === 'tier_exact' || r.group === 'pooled_exact')) {
    lines.push(`- ${row.group}/${row.name}: trades=${row.trades}, winRate=${row.winRate}, meanNet=${row.meanNetReturnPct}, PF=${row.profitFactor}, exits=${JSON.stringify(row.exitCounts)}`)
  }
  lines.push('')
  lines.push('## Baselines')
  for (const row of statsRows.filter(r => r.group === 'baseline')) {
    lines.push(`- ${row.name}: trades=${row.trades}, winRate=${row.winRate}, meanNet=${row.meanNetReturnPct}, PF=${row.profitFactor}`)
  }
  lines.push('')
  lines.push('## Robustness Snapshot')
  const top = [...sensitivityRows].filter(r => r.trades >= 5).sort((a, b) => (b.meanNetReturnPct ?? -999) - (a.meanNetReturnPct ?? -999)).slice(0, 10)
  if (top.length) {
    for (const row of top) lines.push(`- ${row.family}: window=${row.windowMinutes}, C=${row.thresholdC ?? ''}, trail=${row.trailingStopPct}, nanoRise=${row.densityRiseMultiple ?? ''}, min60=${row.minTrailing60Messages ?? ''}, trades=${row.trades}, meanNet=${row.meanNetReturnPct}, winRate=${row.winRate}`)
  } else {
    lines.push('- No sensitivity setting produced at least 5 trades in the available snapshot data.')
  }
  lines.push('')
  lines.push('## Improvement Tests')
  const improved = statsRows
    .filter(r => r.group === 'improvement')
    .filter(r => r.trades >= 5)
    .sort((a, b) => (b.meanNetReturnPct ?? -999) - (a.meanNetReturnPct ?? -999))
  if (improved.length) {
    for (const row of improved.slice(0, 12)) {
      lines.push(`- ${row.name}: trades=${row.trades}, winRate=${row.winRate}, meanNet=${row.meanNetReturnPct}, PF=${row.profitFactor}, exits=${JSON.stringify(row.exitCounts)}`)
    }
  } else {
    lines.push('- No improved variant produced at least 5 trades in the available snapshot data.')
  }
  lines.push('')
  lines.push('## Peer Research Entry/Exit Thresholds')
  const peerRows = statsRows
    .filter(r => r.group === 'peer_research')
    .filter(r => r.trades >= 5)
    .sort((a, b) => (b.meanNetReturnPct ?? -999) - (a.meanNetReturnPct ?? -999))
  if (peerRows.length) {
    lines.push('- Peer scripts used price rising plus both price-density and price-sentiment correlation for entry; exits used either price decreasing, fixed correlation exit threshold, or correlation trailing stop. The original future percent-change winner filter is reported in CSV diagnostics but not used as a deployable entry gate.')
    for (const row of peerRows.slice(0, 12)) {
      lines.push(`- ${row.name}: trades=${row.trades}, winRate=${row.winRate}, meanNet=${row.meanNetReturnPct}, PF=${row.profitFactor}, exits=${JSON.stringify(row.exitCounts)}`)
    }
  } else if (peerResearchConfig().enabled) {
    lines.push('- No peer-research threshold setting produced at least 5 trades.')
  } else {
    lines.push('- Peer-research threshold sweep was disabled for this config.')
  }
  if (Array.isArray(summary.peerResearchPromotion) && summary.peerResearchPromotion.length) {
    const topPeer = summary.peerResearchPromotion.slice(0, 10)
    lines.push('- Top peer-research candidate gate rows:')
    for (const row of topPeer) {
      const reasons = Array.isArray(row.promotionRejectReasons) && row.promotionRejectReasons.length ? `, rejectReasons=${row.promotionRejectReasons.join('|')}` : ''
      lines.push(`- ${row.promotionStatus} ${row.name}: trades=${row.trades}, meanNet=${row.meanNetReturnPct}, PF=${row.profitFactor}, valMean=${row.validationMeanNetReturnPct}, testMean=${row.testMeanNetReturnPct}${reasons}`)
    }
  }
  lines.push('')
  lines.push('## V6 Full Improvement Candidates')
  const v6Rows = statsRows
    .filter(r => r.group === 'v6_full_improvement')
    .filter(r => r.trades >= 5)
    .sort((a, b) => (b.meanNetReturnPct ?? -999) - (a.meanNetReturnPct ?? -999))
  if (v6Rows.length) {
    lines.push('- These candidates preserve the v6 correlation/density policy shape while adding tested overlays for real catalysts, bullish social sentiment, peer-style confirmation, profit targets, and time stops.')
    for (const row of v6Rows.slice(0, 12)) {
      lines.push(`- ${row.name}: trades=${row.trades}, winRate=${row.winRate}, meanNet=${row.meanNetReturnPct}, PF=${row.profitFactor}, exits=${JSON.stringify(row.exitCounts)}`)
    }
  } else if (v6FullImprovementConfig().enabled) {
    lines.push('- No v6 full-improvement setting produced at least 5 trades.')
  } else {
    lines.push('- V6 full-improvement sweep was disabled for this config.')
  }
  if (Array.isArray(summary.v6FullImprovementPromotion) && summary.v6FullImprovementPromotion.length) {
    lines.push('- Top v6 full-improvement candidate gate rows:')
    for (const row of summary.v6FullImprovementPromotion.slice(0, 10)) {
      const reasons = Array.isArray(row.promotionRejectReasons) && row.promotionRejectReasons.length ? `, rejectReasons=${row.promotionRejectReasons.join('|')}` : ''
      lines.push(`- ${row.promotionStatus} ${row.name}: score=${row.optimizationScore}, trades=${row.trades}, meanNet=${row.meanNetReturnPct}, PF=${row.profitFactor}, valMean=${row.validationMeanNetReturnPct}, testMean=${row.testMeanNetReturnPct}${reasons}`)
    }
  }
  lines.push('')
  lines.push('## V6 Win-Rate Quality Candidates')
  const winRows = statsRows
    .filter(r => r.group === 'v6_winrate_quality')
    .filter(r => r.trades >= 5)
    .sort((a, b) => (b.winRate ?? -999) - (a.winRate ?? -999) || (b.meanNetReturnPct ?? -999) - (a.meanNetReturnPct ?? -999))
  if (winRows.length) {
    lines.push('- These candidates keep v6-style correlation entries but require dashboard confirmation from rank, relative volume, healthy momentum, message flow, catalysts, sentiment, and peer-style confirmation.')
    for (const row of winRows.slice(0, 12)) {
      lines.push(`- ${row.name}: trades=${row.trades}, winRate=${row.winRate}, meanNet=${row.meanNetReturnPct}, PF=${row.profitFactor}, exits=${JSON.stringify(row.exitCounts)}`)
    }
  } else if (v6WinRateQualityConfig().enabled) {
    lines.push('- No v6 win-rate quality setting produced at least 5 trades.')
  } else {
    lines.push('- V6 win-rate quality sweep was disabled for this config.')
  }
  if (Array.isArray(summary.v6WinRateQualityCandidates) && summary.v6WinRateQualityCandidates.length) {
    lines.push('- Top v6 win-rate quality candidate gate rows:')
    for (const row of summary.v6WinRateQualityCandidates.slice(0, 10)) {
      const reasons = Array.isArray(row.winRateRejectReasons) && row.winRateRejectReasons.length ? `, rejectReasons=${row.winRateRejectReasons.join('|')}` : ''
      lines.push(`- ${row.winRateStatus} ${row.name}: trades=${row.trades}, winRate=${row.winRate}, meanNet=${row.meanNetReturnPct}, PF=${row.profitFactor}${reasons}`)
    }
  }
  lines.push('')
  lines.push('## Optimization Promotion Candidates')
  const promoted = promotion.filter(row => row.promotionStatus === 'promote_candidate').slice(0, 10)
  const topWatched = promotion.slice(0, 10)
  if (promoted.length) {
    for (const row of promoted) {
      lines.push(`- PROMOTE ${row.name}: score=${row.optimizationScore}, trades=${row.trades}, meanNet=${row.meanNetReturnPct}, PF=${row.profitFactor}, valMean=${row.validationMeanNetReturnPct}, testMean=${row.testMeanNetReturnPct}`)
    }
  } else {
    lines.push('- No parameter set passed the full promotion gate. Top watch/reject rows are listed below for diagnosis.')
  }
  for (const row of topWatched) {
    const reasons = Array.isArray(row.promotionRejectReasons) && row.promotionRejectReasons.length ? `, rejectReasons=${row.promotionRejectReasons.join('|')}` : ''
    lines.push(`- ${row.promotionStatus} ${row.name}: score=${row.optimizationScore}, trades=${row.trades}, meanNet=${row.meanNetReturnPct}, PF=${row.profitFactor}, valMean=${row.validationMeanNetReturnPct}, testMean=${row.testMeanNetReturnPct}${reasons}`)
  }
  lines.push('')
  lines.push('## Files')
  lines.push('- `tier_exact_trades.csv`, `pooled_exact_trades.csv`, `baseline_trades.csv`, `improved_trades.csv`')
  lines.push('- `strategy_summary.csv`, `sensitivity_summary.csv`, `improvement_summary.csv`, `peer_research_summary.csv`, `peer_research_candidates.csv`, `optimization_summary.csv`, `promotion_candidates.csv`, `v6_full_improvement_summary.csv`, `v6_full_improvement_candidates.csv`, `v6_winrate_quality_summary.csv`, `v6_winrate_quality_candidates.csv`, `summary.json`')
  return lines.join('\n') + '\n'
}

async function main() {
  const client = new MongoClient(config.mongoUri)
  await client.connect()
  try {
    const db = client.db(config.database)
    progress('loading price snapshots')
    const price = await loadPriceBars(db)
    const priceTickers = [...price.barsByTicker.keys()].slice(0, config.maxTickers)
    const barsByTicker = new Map(priceTickers.map(t => [t, price.barsByTicker.get(t)]))
    progress(`loading social events for ${priceTickers.length} tickers`)
    const social = await loadSocialEvents(db, priceTickers, price.diagnostics.priceStartSec, price.diagnostics.priceEndSec)
    progress(`loading article catalysts for ${priceTickers.length} tickers`)
    const catalysts = await loadCatalystEvents(db, priceTickers, price.diagnostics.priceStartSec, price.diagnostics.priceEndSec)
    progress('building ticker contexts')
    const contexts = [...barsByTicker.entries()].map(([ticker, bars]) => buildTickerContext(ticker, bars, social, catalysts))

    progress('running exact tier rules')
    const tier = runTierRules(contexts)
    progress('running exact pooled rules')
    const pooled = runPooledRules(contexts)
    const exactTierTrades = Object.values(tier).flat().sort((a, b) => a.signalSec - b.signalSec)
    const exactPooledTrades = Object.values(pooled).flat().sort((a, b) => a.signalSec - b.signalSec)
    progress('running sensitivity rules')
    const sensitivityRows = runSensitivity(contexts)
    progress('running improvement tests')
    const improvements = runImprovementTests(contexts)
    const improvementTrades = Object.values(improvements).flat().sort((a, b) => a.signalSec - b.signalSec)
    progress('running peer research entry/exit threshold rules')
    const peerResearch = runPeerResearchGrid(contexts)
    const peerResearchRows = buildStatsRows('peer_research', peerResearch)
    const peerResearchPromotion = promotionRows(peerResearch, price.diagnostics.priceStartSec, price.diagnostics.priceEndSec)
    const peerResearchTrades = Object.values(peerResearch).flat().sort((a, b) => a.signalSec - b.signalSec)
    progress('running optimization grid')
    const optimization = runOptimizationGrid(contexts)
    const optimizationRows = buildStatsRows('optimization', optimization)
    const promotion = promotionRows(optimization, price.diagnostics.priceStartSec, price.diagnostics.priceEndSec)
    const bestPromotionName = promotion[0]?.name || null
    const bestPromotionTrades = bestPromotionName ? (optimization[bestPromotionName] || []) : []
    progress('running v6 full improvement grid')
    const v6FullImprovement = runV6FullImprovementGrid(contexts)
    const v6FullImprovementRows = buildStatsRows('v6_full_improvement', v6FullImprovement)
    const v6FullImprovementPromotion = promotionRows(v6FullImprovement, price.diagnostics.priceStartSec, price.diagnostics.priceEndSec)
    const bestV6FullImprovementName = v6FullImprovementPromotion[0]?.name || null
    const bestV6FullImprovementTrades = bestV6FullImprovementName ? (v6FullImprovement[bestV6FullImprovementName] || []) : []
    const v6FullImprovementTrades = Object.values(v6FullImprovement).flat().sort((a, b) => a.signalSec - b.signalSec)
    progress('running v6 win-rate quality grid')
    const v6WinRateQuality = runV6WinRateQualityGrid(contexts)
    const v6WinRateQualityRows = buildStatsRows('v6_winrate_quality', v6WinRateQuality)
    const v6WinRateQualityCandidates = winRateRows(v6WinRateQuality)
    const bestV6WinRateQualityName = v6WinRateQualityCandidates[0]?.name || null
    const bestV6WinRateQualityTrades = bestV6WinRateQualityName ? (v6WinRateQuality[bestV6WinRateQualityName] || []) : []
    const v6WinRateQualityTrades = Object.values(v6WinRateQuality).flat().sort((a, b) => a.signalSec - b.signalSec)
    progress('running baselines')
    const baselines = runBaselines(contexts, exactTierTrades.length || exactPooledTrades.length || 50)
    const baselineTrades = Object.values(baselines).flat().sort((a, b) => a.signalSec - b.signalSec)
    const statsRows = [
      ...buildStatsRows('tier_exact', tier),
      ...buildStatsRows('pooled_exact', pooled),
      ...buildStatsRows('improvement', improvements),
      ...peerResearchRows,
      ...optimizationRows,
      ...v6FullImprovementRows,
      ...v6WinRateQualityRows,
      ...buildStatsRows('baseline', baselines),
    ]

    const allExact = [...exactTierTrades, ...exactPooledTrades]
    const signalAudit = {
      exactSignalCount: allExact.length,
      duplicateDrivenPct: allExact.length ? pct(allExact.filter(t => t.duplicateDriven).length / allExact.length * 100) : null,
      alreadyUpMoreThan3PctBeforeEntryPct: allExact.length ? pct(allExact.filter(t => t.alreadyUpMoreThan3PctBeforeEntry).length / allExact.length * 100) : null,
      halfMoveBeforeEntryPct: allExact.length ? pct(allExact.filter(t => t.halfMoveBeforeEntry).length / allExact.length * 100) : null,
    }

    const summary = {
      generatedAt: new Date().toISOString(),
      config,
      price: price.diagnostics,
      social: social.diagnostics,
      catalysts: catalysts.diagnostics,
      exactTier: Object.fromEntries(Object.entries(tier).map(([k, v]) => [k, summarizeTrades(v)])),
      exactPooled: Object.fromEntries(Object.entries(pooled).map(([k, v]) => [k, summarizeTrades(v)])),
      improvements: Object.fromEntries(Object.entries(improvements).map(([k, v]) => [k, summarizeTrades(v)])),
      improvementWalkForward: Object.fromEntries(Object.entries(improvements).map(([k, v]) => [k, splitStats(v)])),
      peerResearch: Object.fromEntries(Object.entries(peerResearch).map(([k, v]) => [k, summarizeTrades(v)])),
      peerResearchPromotion: peerResearchPromotion.slice(0, 50),
      bestPeerResearchCandidate: peerResearchPromotion[0] || null,
      optimization: Object.fromEntries(Object.entries(optimization).map(([k, v]) => [k, summarizeTrades(v)])),
      optimizationPromotion: promotion.slice(0, 50),
      bestOptimizationCandidate: promotion[0] || null,
      v6FullImprovement: Object.fromEntries(Object.entries(v6FullImprovement).map(([k, v]) => [k, summarizeTrades(v)])),
      v6FullImprovementPromotion: v6FullImprovementPromotion.slice(0, 50),
      bestV6FullImprovementCandidate: v6FullImprovementPromotion[0] || null,
      v6WinRateQuality: Object.fromEntries(Object.entries(v6WinRateQuality).map(([k, v]) => [k, summarizeTrades(v)])),
      v6WinRateQualityCandidates: v6WinRateQualityCandidates.slice(0, 50),
      bestV6WinRateQualityCandidate: v6WinRateQualityCandidates[0] || null,
      baselines: Object.fromEntries(Object.entries(baselines).map(([k, v]) => [k, summarizeTrades(v)])),
      signalAudit,
      walkForward: splitStats(allExact),
    }

    writeCsv('tier_exact_trades.csv', exactTierTrades)
    writeCsv('pooled_exact_trades.csv', exactPooledTrades)
    writeCsv('improved_trades.csv', improvementTrades)
    writeCsv('peer_research_trades.csv', peerResearchTrades)
    writeCsv('baseline_trades.csv', baselineTrades)
    writeCsv('best_optimization_trades.csv', bestPromotionTrades.sort((a, b) => a.signalSec - b.signalSec))
    writeCsv('v6_full_improvement_trades.csv', v6FullImprovementTrades)
    writeCsv('best_v6_full_improvement_trades.csv', bestV6FullImprovementTrades.sort((a, b) => a.signalSec - b.signalSec))
    writeCsv('v6_winrate_quality_trades.csv', v6WinRateQualityTrades)
    writeCsv('best_v6_winrate_quality_trades.csv', bestV6WinRateQualityTrades.sort((a, b) => a.signalSec - b.signalSec))
    writeCsv('strategy_summary.csv', statsRows)
    writeCsv('improvement_summary.csv', buildStatsRows('improvement', improvements))
    writeCsv('peer_research_summary.csv', peerResearchRows)
    writeCsv('peer_research_candidates.csv', peerResearchPromotion)
    writeCsv('optimization_summary.csv', optimizationRows)
    writeCsv('promotion_candidates.csv', promotion)
    writeCsv('v6_full_improvement_summary.csv', v6FullImprovementRows)
    writeCsv('v6_full_improvement_candidates.csv', v6FullImprovementPromotion)
    writeCsv('v6_winrate_quality_summary.csv', v6WinRateQualityRows)
    writeCsv('v6_winrate_quality_candidates.csv', v6WinRateQualityCandidates)
    writeCsv('sensitivity_summary.csv', sensitivityRows)
    fs.writeFileSync(path.join(outputDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
    fs.writeFileSync(path.join(outputDir, 'report.md'), buildReport(summary, statsRows, sensitivityRows, promotion))
    progress('wrote outputs')

    console.log(JSON.stringify({
      ok: true,
      outputDir,
      eligibleTickers: price.diagnostics.eligibleTickers,
      exactTierTrades: exactTierTrades.length,
      exactPooledTrades: exactPooledTrades.length,
      improvementTrades: improvementTrades.length,
      peerResearchVariants: Object.keys(peerResearch).length,
      peerResearchTrades: peerResearchTrades.length,
      bestPeerResearchCandidate: peerResearchPromotion[0] || null,
      optimizationVariants: Object.keys(optimization).length,
      bestOptimizationCandidate: promotion[0] || null,
      v6FullImprovementVariants: Object.keys(v6FullImprovement).length,
      v6FullImprovementTrades: v6FullImprovementTrades.length,
      bestV6FullImprovementCandidate: v6FullImprovementPromotion[0] || null,
      v6WinRateQualityVariants: Object.keys(v6WinRateQuality).length,
      v6WinRateQualityTrades: v6WinRateQualityTrades.length,
      bestV6WinRateQualityCandidate: v6WinRateQualityCandidates[0] || null,
      baselineTrades: baselineTrades.length,
      sensitivityRows: sensitivityRows.length,
      signalAudit,
    }, null, 2))
  } finally {
    await client.close()
  }
}

main().catch(err => {
  console.error(err)
  process.exitCode = 1
})
