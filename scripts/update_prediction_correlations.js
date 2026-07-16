#!/usr/bin/env node

const path = require('path')
const mongoose = require(path.join(__dirname, '..', 'Infrastructure', 'server', 'node_modules', 'mongoose'))

function argValue(name, fallback = '') {
  const prefix = `--${name}=`
  const inline = process.argv.find(arg => arg.startsWith(prefix))
  if (inline) return inline.slice(prefix.length)
  const index = process.argv.indexOf(`--${name}`)
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1]
  return fallback
}

function toNumber(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function clamp(value, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return min
  return Math.max(min, Math.min(max, n))
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  })
  const text = await response.text()
  let body = null
  try { body = text ? JSON.parse(text) : null } catch (_) {}
  if (!response.ok) throw new Error(`${url} failed: HTTP ${response.status} ${text.slice(0, 300)}`)
  return body
}

async function main() {
  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI || argValue('mongo', 'mongodb://localhost:27017/feedflash')
  const baseUrl = String(argValue('baseUrl', process.env.FLASHFEED_API_BASE_URL || 'http://localhost:3001')).replace(/\/$/, '')
  const days = Math.max(1, Math.min(14, toNumber(argValue('days', '4'), 4)))
  const minSamples = Math.max(1, Math.min(100, toNumber(argValue('minSamples', '5'), 5)))

  let routeResult = null
  try {
    const url = new URL(`${baseUrl}/api/correlation/run`)
    url.searchParams.set('days', String(days))
    routeResult = await fetchJson(url, { method: 'POST', body: JSON.stringify({ days }) })
  } catch (err) {
    routeResult = { success: false, error: String(err.message || err) }
  }

  await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 10000 })
  const db = mongoose.connection.db

  const validationRows = await db.collection('prediction_signals').aggregate([
    {
      $match: {
        'labels.return_5m.labeled': true,
        'labels.return_5m.direction_correct': { $in: [true, false] },
      },
    },
    {
      $group: {
        _id: '$ticker',
        samples: { $sum: 1 },
        correct: { $sum: { $cond: ['$labels.return_5m.direction_correct', 1, 0] } },
        avg_return_5m: { $avg: '$labels.return_5m.return_pct' },
        latest_signal_sec: { $max: '$signal_sec' },
      },
    },
    { $match: { samples: { $gte: minSamples } } },
  ]).toArray()

  const updates = validationRows.map(row => {
    const accuracy = Number(row.correct || 0) / Math.max(1, Number(row.samples || 0))
    const validationCorrelation = Number(clamp((accuracy - 0.5) * 2, -1, 1).toFixed(3))
    return {
      updateOne: {
        filter: { ticker: String(row._id || '').toUpperCase() },
        update: {
          $set: {
            ticker: String(row._id || '').toUpperCase(),
            prediction_validation_correlation: validationCorrelation,
            prediction_validation_accuracy_5m: Number(accuracy.toFixed(3)),
            prediction_validation_samples: Number(row.samples || 0),
            prediction_validation_correct: Number(row.correct || 0),
            prediction_validation_avg_return_5m: row.avg_return_5m == null ? null : Number(Number(row.avg_return_5m).toFixed(3)),
            prediction_validation_latest_signal_sec: row.latest_signal_sec || null,
            prediction_validation_updated_at: new Date(),
            correlation_score: validationCorrelation,
            correlation_source: 'prediction_label_accuracy_proxy',
            updated_at: new Date(),
          },
          $setOnInsert: {
            generated: true,
            signal_type: 'prediction_label_accuracy_proxy',
            created_at: new Date(),
          },
        },
        upsert: true,
      },
    }
  })

  if (updates.length) await db.collection('correlations').bulkWrite(updates, { ordered: false })
  await db.collection('correlations').createIndex({ ticker: 1 }, { unique: true })
  await db.collection('correlations').createIndex({ updated_at: -1 })

  console.log(JSON.stringify({
    ok: true,
    route_correlation: routeResult,
    validation_rows: validationRows.length,
    min_samples: minSamples,
    top_validation: validationRows
      .map(row => {
        const accuracy = Number(row.correct || 0) / Math.max(1, Number(row.samples || 0))
        return {
          ticker: row._id,
          samples: row.samples,
          accuracy: Number(accuracy.toFixed(3)),
          correlation_score: Number(clamp((accuracy - 0.5) * 2, -1, 1).toFixed(3)),
          avg_return_5m: row.avg_return_5m == null ? null : Number(Number(row.avg_return_5m).toFixed(3)),
        }
      })
      .sort((a, b) => Math.abs(b.correlation_score) - Math.abs(a.correlation_score))
      .slice(0, 10),
  }, null, 2))

  await mongoose.disconnect()
}

main().catch(async err => {
  console.error(JSON.stringify({ ok: false, error: String(err.message || err) }, null, 2))
  try { await mongoose.disconnect() } catch (_) {}
  process.exit(1)
})
