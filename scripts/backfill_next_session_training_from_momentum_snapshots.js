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

function easternParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  return Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]))
}

function dateKeyEt(sec) {
  const p = easternParts(new Date(Number(sec || 0) * 1000))
  return `${String(p.year).padStart(4, '0')}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`
}

function nextTradingDateKey(dateKey) {
  const [year, month, day] = String(dateKey).split('-').map(Number)
  let d = new Date(Date.UTC(year, month - 1, day + 1, 12, 0, 0))
  while ([0, 6].includes(d.getUTCDay())) d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 12, 0, 0))
  return d.toISOString().slice(0, 10)
}

function sessionTarget(session = '') {
  const value = String(session || '').toLowerCase()
  if (value === 'premarket' || value === 'weekend' || value === 'overnight') return 'regular_session_risers'
  if (value === 'regular') return 'late_day_and_afterhours_continuation'
  if (value === 'postmarket' || value === 'afterhours') return 'afterhours_and_next_premarket_risers'
  return 'next_regular_session'
}

function compactTrainingRow(row = {}, rank = 1, snapshot = {}) {
  const ticker = String(row.ticker || '').toUpperCase()
  const session = String(row.active_session || snapshot.session || '').toLowerCase() || 'unknown'
  const price = toNumber(row.price, null)
  const changePct = toNumber(row.change_pct ?? row.regular_change_pct ?? row.premarket_change_pct ?? row.postmarket_change_pct, null)
  const relVolume = toNumber(row.rel_volume, null)
  return {
    rank,
    ticker,
    company: row.company || '',
    price,
    reference_price: price,
    reference_price_source: snapshot.source || 'finviz_momentum_snapshots',
    exchange: row.exchange || '',
    change_pct: changePct,
    rel_volume: relVolume,
    volume: toNumber(row.volume, null),
    market_cap: toNumber(row.market_cap, null),
    prediction_direction: 'up',
    predicted_direction: 'up',
    predicted_return: null,
    predicted_percent: null,
    prediction_confidence: null,
    confidence: null,
    probability_up: null,
    final_prediction_score: Number(Math.max(0, Math.min(100,
      Math.min(45, Math.max(0, Math.abs(changePct || 0)) * 1.25) +
      Math.min(35, Math.log1p(Math.max(0, relVolume || 0)) * 10) +
      Math.max(0, 20 - rank * 0.4)
    )).toFixed(1)),
    model_mode: 'historical_momentum_training_candidate',
    prediction_source_label: 'Historical Momentum Training Candidate',
    prediction_source_code: 'finviz_momentum_snapshot_backfill',
    prediction_session: session,
    prediction_target: sessionTarget(session),
    prediction: {
      model: 'historical_momentum_training_candidate',
      predictedDirection: 'up',
      predictedReturn: null,
      predictionSession: session,
      predictionTarget: sessionTarget(session),
      generatedAt: snapshot.snapshot_at || new Date(Number(snapshot.snapshot_sec || 0) * 1000),
      note: 'Backfilled from a real stored FinViz momentum snapshot for supervised next-session training. This row is not a fabricated prediction.',
    },
    risk_flags: ['HISTORICAL_BACKFILL_NOT_LIVE_PREDICTION'],
    outcome_status: 'pending',
    realized_return_pct: null,
    realized_price: null,
    realized_at: null,
  }
}

async function main() {
  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI || argValue('mongo', 'mongodb://localhost:27017/feedflash')
  const maxSnapshots = Math.max(1, Math.min(100, toNumber(argValue('maxSnapshots', '12'), 12)))
  const rowsPerSnapshot = Math.max(1, Math.min(100, toNumber(argValue('rowsPerSnapshot', '30'), 30)))
  const sourceLimit = Math.max(maxSnapshots, Math.min(5000, toNumber(argValue('sourceLimit', '800'), 800)))
  const tag = argValue('tag', 'momentum_backfill')
  const minAgeHours = Math.max(0, Math.min(720, toNumber(argValue('minAgeHours', '36'), 36)))
  const nowSec = Math.floor(Date.now() / 1000)

  await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 10000 })
  const db = mongoose.connection.db
  const docs = await db.collection('finviz_momentum_snapshots')
    .find({
      snapshot_sec: { $lte: nowSec - minAgeHours * 3600 },
      rows: { $type: 'array', $ne: [] },
    })
    .sort({ snapshot_sec: -1 })
    .limit(sourceLimit)
    .toArray()

  const selected = []
  const seenBuckets = new Set()
  for (const doc of docs) {
    const sec = Number(doc.snapshot_sec || 0)
    const p = easternParts(new Date(sec * 1000))
    const dateKey = dateKeyEt(sec)
    const session = String(doc.session || doc.rows?.[0]?.active_session || 'unknown').toLowerCase()
    const bucket = `${dateKey}:${session}:${Math.floor(p.hour / 2)}`
    if (seenBuckets.has(bucket)) continue
    seenBuckets.add(bucket)
    selected.push(doc)
    if (selected.length >= maxSnapshots) break
  }

  const writes = []
  for (const snapshot of selected) {
    const sec = Number(snapshot.snapshot_sec || 0)
    const dateKey = dateKeyEt(sec)
    const session = String(snapshot.session || snapshot.rows?.[0]?.active_session || 'unknown').toLowerCase()
    const rows = (snapshot.rows || [])
      .filter(row => row?.ticker && Number(row.price) > 0 && Number.isFinite(Number(row.change_pct ?? row.regular_change_pct ?? row.premarket_change_pct ?? row.postmarket_change_pct)))
      .slice(0, rowsPerSnapshot)
      .map((row, index) => compactTrainingRow(row, index + 1, snapshot))
    if (!rows.length) continue
    const id = `${dateKey}:1d:${tag}:${session}:${sec}`
    writes.push({
      updateOne: {
        filter: { _id: id },
        update: {
          $set: {
            _id: id,
            snapshot_id: id,
            source_snapshot_id: snapshot._id,
            source_collection: 'finviz_momentum_snapshots',
            date_key: dateKey,
            prediction_date_key: dateKey,
            predicted_for_date: nextTradingDateKey(dateKey),
            trading_date_predicted_for: nextTradingDateKey(dateKey),
            tag,
            horizon: '1d',
            generated_at: new Date(sec * 1000),
            generated_at_sec: sec,
            prediction_session_context: {
              session,
              source: 'finviz_momentum_snapshots',
              target: sessionTarget(session),
            },
            raw_rows: rows,
            high_conviction_rows: [],
            raw_count: rows.length,
            high_conviction_count: 0,
            archive_schema_version: 4,
            note: 'Historical momentum snapshot backfill for supervised next-session training. Outcomes must be labeled from real market candles before training.',
            updated_at: new Date(),
          },
          $setOnInsert: { created_at: new Date() },
        },
        upsert: true,
      },
    })
  }

  let upserted = 0
  let modified = 0
  if (writes.length) {
    const result = await db.collection('daily_prediction_snapshots').bulkWrite(writes, { ordered: false })
    upserted = Number(result.upsertedCount || 0)
    modified = Number(result.modifiedCount || 0)
  }
  await db.collection('daily_prediction_snapshots').createIndex({ tag: 1, generated_at_sec: -1 }).catch(() => {})

  console.log(JSON.stringify({
    ok: true,
    source_docs_scanned: docs.length,
    snapshots_selected: selected.length,
    snapshots_written: writes.length,
    upserted,
    modified,
    rows_written: writes.reduce((sum, op) => sum + (op.updateOne.update.$set.raw_rows || []).length, 0),
    examples: writes.slice(0, 5).map(op => ({
      id: op.updateOne.filter._id,
      rows: op.updateOne.update.$set.raw_rows.length,
      session: op.updateOne.update.$set.prediction_session_context.session,
      predicted_for_date: op.updateOne.update.$set.predicted_for_date,
      top: op.updateOne.update.$set.raw_rows.slice(0, 3).map(row => row.ticker),
    })),
  }, null, 2))

  await mongoose.disconnect()
}

main().catch(async err => {
  console.error(JSON.stringify({ ok: false, error: String(err.message || err) }, null, 2))
  try { await mongoose.disconnect() } catch (_) {}
  process.exit(1)
})
