#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { etParts } from './features.mjs'
import { simulatePayoffCapture } from '../../Infrastructure/server/lib/payoffCapture.js'

const require = createRequire(new URL('../../Infrastructure/server/package.json', import.meta.url))
const { MongoClient } = require('mongodb')

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const OUTPUT_DIR = path.join(ROOT, 'backtests/message_density_thresholds/outputs_v12_final_confirmation_mongo_ohlc')
const TRADES_CSV = path.join(OUTPUT_DIR, 'v6_winrate_quality_trades.csv')
const OUTPUT_JSON = path.join(OUTPUT_DIR, 'v12_validation.json')
const RULE = 'v12_w180_c040_ps3_score0_rankany_rvany_mom0to20_gb4_a10'
const ITERATIONS = Math.max(100, Number(process.env.V12_VALIDATION_ITERATIONS || 5000))
const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/feedflash'
const DATABASE = process.env.MONGODB_DATABASE || 'feedflash'

function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"'
        i += 1
      } else if (char === '"') quoted = false
      else field += char
    } else if (char === '"') quoted = true
    else if (char === ',') {
      row.push(field)
      field = ''
    } else if (char === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else if (char !== '\r') field += char
  }
  if (field || row.length) {
    row.push(field)
    rows.push(row)
  }
  const headers = rows.shift() || []
  return rows.filter(values => values.some(Boolean)).map(values => Object.fromEntries(headers.map((key, i) => [key, values[i] ?? ''])))
}

function mulberry32(seed) {
  return () => {
    let value = seed += 0x6D2B79F5
    value = Math.imul(value ^ value >>> 15, value | 1)
    value ^= value + Math.imul(value ^ value >>> 7, value | 61)
    return ((value ^ value >>> 14) >>> 0) / 4294967296
  }
}

function percentile(values, fraction) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const position = (sorted.length - 1) * fraction
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  if (lower === upper) return sorted[lower]
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower)
}

function stats(values) {
  const finite = values.map(Number).filter(Number.isFinite)
  if (!finite.length) return { observations: 0, meanPct: null, medianPct: null, winRate: null }
  return {
    observations: finite.length,
    meanPct: finite.reduce((sum, value) => sum + value, 0) / finite.length,
    medianPct: percentile(finite, 0.5),
    winRate: finite.filter(value => value > 0).length / finite.length,
  }
}

function key(ticker, date) {
  return `${ticker}|${date}`
}

function regularCandidate(bar) {
  const et = etParts(bar.time)
  const minuteOfDay = et.hour * 60 + et.minute
  return minuteOfDay >= 9 * 60 + 50 && minuteOfDay <= 15 * 60 + 30
}

function round(value, places = 4) {
  return Number.isFinite(Number(value)) ? Number(Number(value).toFixed(places)) : null
}

function dayBlockBootstrap(rows, field, random, iterations = ITERATIONS) {
  const byDay = new Map()
  for (const row of rows) {
    const value = Number(row[field])
    if (!Number.isFinite(value)) continue
    if (!byDay.has(row.signalEtDate)) byDay.set(row.signalEtDate, [])
    byDay.get(row.signalEtDate).push(value)
  }
  const days = [...byDay.keys()]
  const means = []
  for (let i = 0; i < iterations; i += 1) {
    const sample = []
    for (let j = 0; j < days.length; j += 1) {
      const day = days[Math.floor(random() * days.length)]
      sample.push(...byDay.get(day))
    }
    means.push(stats(sample).meanPct)
  }
  return {
    days: days.length,
    iterations,
    observedMeanPct: round(stats(rows.map(row => row[field])).meanPct),
    confidence95Pct: [round(percentile(means, 0.025)), round(percentile(means, 0.975))],
    probabilityMeanAboveZero: round(means.filter(value => value > 0).length / means.length, 6),
  }
}

async function main() {
  const allRows = parseCsv(fs.readFileSync(TRADES_CSV, 'utf8'))
  const rows = allRows.filter(row => row.ruleName === RULE).sort((a, b) => Number(a.signalSec) - Number(b.signalSec))
  if (!rows.length) throw new Error(`No rows found for ${RULE}`)

  const tickers = [...new Set(rows.map(row => row.ticker))]
  const minSec = Math.min(...rows.map(row => Number(row.signalSec))) - 24 * 60 * 60
  const maxSec = Math.max(...rows.map(row => Number(row.signalSec))) + 24 * 60 * 60
  const client = new MongoClient(MONGO_URI)
  await client.connect()
  const barsByTickerDate = new Map()
  try {
    const cursor = client.db(DATABASE).collection('ohlcv_bars').find({
      source: 'yahoo_chart_ohlcv',
      ticker: { $in: tickers },
      minute: { $gte: minSec, $lte: maxSec },
    }, {
      projection: { _id: 0, ticker: 1, minute: 1, open: 1, high: 1, low: 1, close: 1, providerIntervalSec: 1 },
    }).sort({ ticker: 1, minute: 1 })
    for await (const doc of cursor) {
      const time = Number(doc.minute)
      const bar = { time, open: Number(doc.open), high: Number(doc.high), low: Number(doc.low), close: Number(doc.close) }
      if (![bar.time, bar.open, bar.high, bar.low, bar.close].every(Number.isFinite)) continue
      const mapKey = key(doc.ticker, etParts(time).date)
      if (!barsByTickerDate.has(mapKey)) barsByTickerDate.set(mapKey, new Map())
      const minuteMap = barsByTickerDate.get(mapKey)
      const existing = minuteMap.get(time)
      if (!existing || Number(doc.providerIntervalSec || Infinity) < Number(existing.providerIntervalSec || Infinity)) {
        minuteMap.set(time, { ...bar, providerIntervalSec: Number(doc.providerIntervalSec || 0) || null })
      }
    }
  } finally {
    await client.close()
  }

  const usableRows = rows.filter(row => {
    const bars = [...(barsByTickerDate.get(key(row.ticker, row.signalEtDate))?.values() || [])]
    return bars.filter(regularCandidate).length >= 2
  })
  const random = mulberry32(0x12C0FFEE)
  const portfolioStrategyMeans = []
  const portfolioEodMeans = []
  for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
    const strategyReturns = []
    const eodReturns = []
    for (const row of usableRows) {
      const bars = [...barsByTickerDate.get(key(row.ticker, row.signalEtDate)).values()].sort((a, b) => a.time - b.time)
      const candidates = bars.filter(regularCandidate)
      const entryBar = candidates[Math.floor(random() * candidates.length)]
      const exitBars = bars.filter(bar => bar.time >= entryBar.time)
      const result = simulatePayoffCapture(entryBar.close, exitBars, {
        protectiveStopPct: 3,
        profitGivebackPct: 4,
        profitGivebackActivationPct: 10,
        partialExitFraction: 0,
      })
      const roundTripCost = Number(row.slippagePctOneWay || 0) * 2
      strategyReturns.push(Number(result.return_pct) - roundTripCost)
      eodReturns.push(((bars[bars.length - 1].close - entryBar.close) / entryBar.close) * 100 - roundTripCost)
    }
    portfolioStrategyMeans.push(stats(strategyReturns).meanPct)
    portfolioEodMeans.push(stats(eodReturns).meanPct)
  }

  const actualStrategy = stats(rows.map(row => row.netReturnPct))
  const actualEod = stats(rows.map(row => row.benchmarkEodNetReturnPct))
  const validation = {
    generatedAt: new Date().toISOString(),
    rule: RULE,
    interpretation: 'Retrospective same-ticker/same-market-day timing placebo. Ticker-day selection remains conditioned on the historical signal; this does not replace future out-of-sample validation.',
    sourceTrades: rows.length,
    usableTimingPlaceboTrades: usableRows.length,
    iterations: ITERATIONS,
    actual: {
      strategy: Object.fromEntries(Object.entries(actualStrategy).map(([name, value]) => [name, round(value, name === 'winRate' ? 6 : 4)])),
      endOfDayHold: Object.fromEntries(Object.entries(actualEod).map(([name, value]) => [name, round(value, name === 'winRate' ? 6 : 4)])),
      alphaVsEndOfDayPct: round(actualStrategy.meanPct - actualEod.meanPct),
    },
    randomTimingPlacebo: {
      strategyMeanDistributionPct: {
        mean: round(stats(portfolioStrategyMeans).meanPct),
        confidence95Pct: [round(percentile(portfolioStrategyMeans, 0.025)), round(percentile(portfolioStrategyMeans, 0.975))],
      },
      endOfDayMeanDistributionPct: {
        mean: round(stats(portfolioEodMeans).meanPct),
        confidence95Pct: [round(percentile(portfolioEodMeans, 0.025)), round(percentile(portfolioEodMeans, 0.975))],
      },
      probabilityRandomStrategyMeanAtLeastActual: round(portfolioStrategyMeans.filter(value => value >= actualStrategy.meanPct).length / portfolioStrategyMeans.length, 6),
      probabilityRandomEodMeanAtLeastActual: round(portfolioEodMeans.filter(value => value >= actualEod.meanPct).length / portfolioEodMeans.length, 6),
    },
    dayBlockBootstrap: {
      strategyMean: dayBlockBootstrap(rows, 'netReturnPct', random),
      alphaVsSameExitBar: dayBlockBootstrap(rows, 'strategyVsSameWindowAlphaPct', random),
      alphaVsEndOfDay: dayBlockBootstrap(rows, 'strategyVsEodAlphaPct', random),
    },
  }
  fs.writeFileSync(OUTPUT_JSON, `${JSON.stringify(validation, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify(validation, null, 2)}\n`)
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
