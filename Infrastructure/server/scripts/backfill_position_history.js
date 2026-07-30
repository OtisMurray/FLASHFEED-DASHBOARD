#!/usr/bin/env node
//
// One-off seed for screener_position_history.
//
// WHAT THIS CAN AND CANNOT DO — read before trusting the output.
//
// The strategy sim needs two inputs per (ticker, session): 1-minute bars and
// that session's StockTwits messages. Bars are re-fetchable for any past date
// from Finviz Elite. Messages are NOT: rebuilding a past day would mean paging
// StockTwits backwards from the newest message, and social_store.walk_stocktwits
// caps at 120 pages x 30 messages. For an active ticker that is hours of
// history, not weeks.
//
// So this script can only backfill the (ticker, day) pairs that already exist in
// flashfeed.social_history. Those are NOT historical AI suggestions: the
// collection was populated opportunistically by whoever opened a chart. This
// legacy source is sparse and viewing-biased and must never be presented as an
// AI-selected Positions history.
//
// Everything written here goes through the same normalizeTrade/mergeTradeSnapshot
// path as the live scheduler, at the same canonical parameters, so a backfilled
// row and a recorded row are the same kind of row.
//
// Usage:
//   node scripts/backfill_position_history.js --legacy-social-backfill [--dry-run] [--limit N]
//        [--chartService http://localhost:5058] [--threshold 0.10] [--stopPct 5]

import mongoose from 'mongoose'
import {
  ensurePositionHistoryIndexes,
  persistPositionSnapshot,
  rowsFromPositionsBatch,
  POSITION_HISTORY_COLLECTION,
} from '../lib/positionHistory.js'

function argValue(name, fallback = '') {
  const prefix = `--${name}=`
  const inline = process.argv.find(arg => arg.startsWith(prefix))
  if (inline) return inline.slice(prefix.length)
  const index = process.argv.indexOf(`--${name}`)
  if (index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--')) return process.argv[index + 1]
  return fallback
}
const hasFlag = name => process.argv.includes(`--${name}`)

const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI || argValue('mongo', 'mongodb://localhost:27017')
// These are TWO DIFFERENT DATABASES in a default local setup and conflating them
// silently writes the history where the server will never read it. The social
// store is the chart-service's (MONGO_DB, default "flashfeed"); the history is a
// backend-owned collection and belongs beside stocktwits_watcher_snapshots in
// the backend's database (MONGODB_URI's db, default "feedflash").
const SOCIAL_DB = process.env.MONGO_DB || argValue('socialDb', 'flashfeed')
const SOCIAL_COLL = process.env.MONGO_COLL || argValue('socialColl', 'social_history')
function backendDbName() {
  const explicit = argValue('historyDb', '')
  if (explicit) return explicit
  const uri = process.env.MONGODB_URI || ''
  const match = uri.match(/^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]+)/)
  return match ? decodeURIComponent(match[1]) : 'feedflash'
}
const HISTORY_DB = backendDbName()
const CHART_SERVICE_URL = String(argValue('chartService', process.env.CHART_SERVICE_URL || 'http://localhost:5058')).replace(/\/+$/, '')
const THRESHOLD = Number(argValue('threshold', '0.10'))
const STOP_PCT = Number(argValue('stopPct', '5'))
const BATCH = Math.max(1, Math.min(50, Number(argValue('batch', '25'))))
const LIMIT = Number(argValue('limit', '0')) || Infinity
const DRY_RUN = hasFlag('dry-run')
const LEGACY_SOCIAL_BACKFILL = hasFlag('legacy-social-backfill')

function todayKeyET(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date)
  const p = Object.fromEntries(parts.filter(x => x.type !== 'literal').map(x => [x.type, x.value]))
  return `${p.year}-${p.month}-${p.day}`
}

async function fetchPositionsBatch(tickers, date) {
  const params = new URLSearchParams({
    tickers: tickers.join(','),
    date,
    threshold: String(THRESHOLD),
    stop_pct: String(STOP_PCT),
  })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 180_000)
  try {
    const res = await fetch(`${CHART_SERVICE_URL}/api/sentchart/positions/batch?${params}`, { signal: controller.signal })
    if (!res.ok) throw new Error(`chart-service responded ${res.status}`)
    return (await res.json())?.results || {}
  } finally {
    clearTimeout(timer)
  }
}

async function main() {
  if (!LEGACY_SOCIAL_BACKFILL) {
    throw new Error(
      'Historical AI ranking snapshots are unavailable. Refusing to label chart-view social coverage as AI suggestions. ' +
      'Pass --legacy-social-backfill only for an explicitly labeled legacy research import.',
    )
  }
  await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 10_000 })
  const client = mongoose.connection.getClient()
  const socialColl = client.db(SOCIAL_DB).collection(SOCIAL_COLL)
  const historyDb = client.db(HISTORY_DB)
  const today = todayKeyET()

  console.log(`Reading social coverage from ${SOCIAL_DB}.${SOCIAL_COLL}; writing history to ${HISTORY_DB}.${POSITION_HISTORY_COLLECTION}`)
  const before = await historyDb.collection(POSITION_HISTORY_COLLECTION).countDocuments({}).catch(() => 0)

  // Only pairs with actual messages: a 0-message day cannot produce a
  // correlation, so simulating it would burn a Finviz fetch for a guaranteed
  // empty result.
  const pairs = await socialColl
    .find({ msg_count: { $gt: 0 } }, { projection: { _id: 0, ticker: 1, day: 1, msg_count: 1, complete: 1 } })
    .sort({ day: -1, ticker: 1 })
    .toArray()

  const byDay = new Map()
  for (const pair of pairs) {
    const day = String(pair.day || '')
    const ticker = String(pair.ticker || '').toUpperCase()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^[A-Z][A-Z0-9.-]{0,7}$/.test(ticker)) continue
    if (!byDay.has(day)) byDay.set(day, [])
    byDay.get(day).push({ ticker, msgCount: Number(pair.msg_count || 0), complete: Boolean(pair.complete) })
  }
  const days = [...byDay.keys()].sort().reverse()

  const partialWalks = pairs.filter(p => !p.complete).length
  console.log(`Source coverage: ${pairs.length} (ticker, day) pairs with messages across ${days.length} days ` +
    `(${days[days.length - 1] ?? '—'} .. ${days[0] ?? '—'})`)
  if (partialWalks) {
    console.log(`  ${partialWalks} of those pairs came from a PARTIAL StockTwits walk — their early-session ` +
      `density is under-counted and their correlations are correspondingly unreliable.`)
  }
  console.log(`screener_position_history rows before: ${before}`)
  if (DRY_RUN) console.log('DRY RUN — no writes will be made.\n')

  if (!DRY_RUN) await ensurePositionHistoryIndexes(historyDb)

  const totals = { inserted: 0, updated: 0, closed: 0, skipped_final: 0, failed: 0 }
  const coverageTotals = { ok: 0, warming: 0, no_bars: 0, error: 0, other: 0 }
  const perDay = []
  let simulated = 0

  for (const day of days) {
    if (simulated >= LIMIT) break
    // Today is still running: the live scheduler owns it. Backfilling it here
    // would race the scheduler over the same rows for no benefit.
    if (day >= today) {
      console.log(`  ${day}: skipped (current or future session — owned by the live scheduler)`)
      continue
    }
    const entries = byDay.get(day)
    let dayRows = 0
    const dayCoverage = { ok: 0, warming: 0, no_bars: 0, error: 0, other: 0 }

    for (let i = 0; i < entries.length && simulated < LIMIT; i += BATCH) {
      const chunk = entries.slice(i, i + BATCH).map(e => e.ticker)
      simulated += chunk.length
      let results = {}
      try {
        results = await fetchPositionsBatch(chunk, day)
      } catch (err) {
        console.log(`  ${day}: batch of ${chunk.length} failed — ${String(err.message || err).slice(0, 140)}`)
        dayCoverage.error += chunk.length
        continue
      }
      const { rows, coverage } = rowsFromPositionsBatch(results, {
        threshold: THRESHOLD,
        stopPct: STOP_PCT,
        corrExitThreshold: null,
        observedAt: new Date(),
        collector: 'legacy_social_backfill_v1',
        candidateMetadata: new Map(chunk.map(ticker => [ticker, {
          candidate_source: 'legacy_social_coverage',
        }])),
      })
      for (const key of Object.keys(dayCoverage)) dayCoverage[key] += coverage[key] || 0
      dayRows += rows.length
      if (!DRY_RUN && rows.length) {
        const summary = await persistPositionSnapshot(historyDb, rows, { today, now: new Date() })
        for (const key of Object.keys(totals)) totals[key] += Number(summary[key] || 0)
      }
    }

    for (const key of Object.keys(coverageTotals)) coverageTotals[key] += dayCoverage[key]
    perDay.push({ day, tickers: entries.length, trades: dayRows, ...dayCoverage })
    console.log(`  ${day}: ${entries.length} tickers -> ${dayRows} trades ` +
      `(ok ${dayCoverage.ok}, warming ${dayCoverage.warming}, no_bars ${dayCoverage.no_bars}, error ${dayCoverage.error})`)
  }

  const after = DRY_RUN ? before : await historyDb.collection(POSITION_HISTORY_COLLECTION).countDocuments({}).catch(() => 0)
  console.log('\n' + JSON.stringify({
    dry_run: DRY_RUN,
    threshold: THRESHOLD,
    stop_pct: STOP_PCT,
    source_pairs: pairs.length,
    source_days: days.length,
    partial_walk_pairs: partialWalks,
    tickers_simulated: simulated,
    sim_coverage: coverageTotals,
    persist_summary: totals,
    rows_before: before,
    rows_after: after,
    rows_added: after - before,
    per_day: perDay,
  }, null, 2))

  await mongoose.disconnect()
}

main().catch(async err => {
  console.error(JSON.stringify({ ok: false, error: String(err.message || err) }, null, 2))
  try { await mongoose.disconnect() } catch { /* already down */ }
  process.exit(1)
})
