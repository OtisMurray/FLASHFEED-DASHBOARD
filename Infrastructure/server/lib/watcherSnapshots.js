const DEFAULT_MAX_AGE_SECONDS = 72 * 60 * 60
const DEFAULT_GROWTH_WINDOW_SECONDS = 24 * 60 * 60
const MAX_RANK_POINTS = 2

function finiteNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

export function watcherSnapshotMinute(sec = Math.floor(Date.now() / 1000)) {
  const value = finiteNumber(sec)
  return value != null && value > 0 ? Math.floor(value / 60) * 60 : null
}

export function watcherRankScore(value = {}) {
  const feature = value.watcher_feature || value
  if (feature.status !== 'fresh') return 0
  const ageSeconds = finiteNumber(feature.age_seconds)
  const sampleCount = finiteNumber(feature.sample_count) || 0
  const delta = finiteNumber(feature.delta)
  const growthPct = finiteNumber(feature.growth_pct)
  if (ageSeconds == null || ageSeconds < 0 || sampleCount < 2 || delta == null || delta <= 0 || growthPct == null || growthPct <= 0) return 0
  const growthPoints = Math.min(1.5, growthPct * 0.75)
  const deltaScale = Math.min(0.5, Math.log1p(delta) / Math.log1p(100) * 0.5)
  const relativeGuard = Math.min(1, growthPct / 2)
  return Number(Math.min(MAX_RANK_POINTS, growthPoints + deltaScale * relativeGuard).toFixed(3))
}

export async function persistWatcherSnapshot(db, fetched = {}, metadata = {}) {
  const ticker = String(fetched.ticker || '').trim().toUpperCase()
  const watcherCount = finiteNumber(fetched.watcher_count)
  if (!db || !/^[A-Z][A-Z0-9.-]{0,7}$/.test(ticker) || watcherCount == null || watcherCount < 0) return null
  const nowSec = Math.floor(Date.now() / 1000)
  const fetchedSec = Math.min(nowSec, Math.max(1, Math.floor(finiteNumber(metadata.fetched_sec) || nowSec)))
  const snapshotMinute = watcherSnapshotMinute(fetchedSec)
  const doc = {
    ...fetched,
    ...metadata,
    ticker,
    watcher_count: watcherCount,
    fetched_sec: fetchedSec,
    fetched_at: new Date(fetchedSec * 1000),
    snapshot_minute: snapshotMinute,
  }
  await db.collection('stocktwits_watcher_snapshots').updateOne(
    { ticker, snapshot_minute: snapshotMinute },
    { $set: doc, $setOnInsert: { created_at: new Date(fetchedSec * 1000) } },
    { upsert: true },
  )
  return doc
}

export function dedupeWatcherSeries(rows = [], options = {}) {
  const nowSec = finiteNumber(options.nowSec) || Math.floor(Date.now() / 1000)
  const startSec = finiteNumber(options.startSec) || 0
  const endSec = Math.min(nowSec, finiteNumber(options.endSec) || nowSec)
  const latestByMinute = new Map()
  for (const row of rows) {
    const fetchedSec = finiteNumber(row.fetched_sec)
    const watcherCount = finiteNumber(row.watcher_count)
    if (fetchedSec == null || fetchedSec < startSec || fetchedSec > endSec || watcherCount == null || watcherCount < 0) continue
    const minute = finiteNumber(row.snapshot_minute) || watcherSnapshotMinute(fetchedSec)
    const existing = latestByMinute.get(minute)
    if (!existing || fetchedSec >= Number(existing.fetched_sec || 0)) latestByMinute.set(minute, { ...row, fetched_sec: fetchedSec, watcher_count: watcherCount, snapshot_minute: minute })
  }
  return [...latestByMinute.values()].sort((a, b) => Number(a.fetched_sec) - Number(b.fetched_sec))
}

export async function loadWatcherFeatureMap(db, tickers = [], options = {}) {
  const wanted = Array.from(new Set(tickers.map(value => String(value || '').trim().toUpperCase()).filter(Boolean)))
  if (!db || !wanted.length) return new Map()
  const nowSec = finiteNumber(options.nowSec) || Math.floor(Date.now() / 1000)
  const maxAgeSeconds = Math.max(60, finiteNumber(options.maxAgeSeconds) || DEFAULT_MAX_AGE_SECONDS)
  const growthWindowSeconds = Math.max(60, finiteNumber(options.growthWindowSeconds) || DEFAULT_GROWTH_WINDOW_SECONDS)
  const cutoffSec = nowSec - Math.max(maxAgeSeconds, growthWindowSeconds)
  const docs = await db.collection('stocktwits_watcher_snapshots').find({
    ticker: { $in: wanted },
    watcher_count: { $gte: 0 },
    fetched_sec: { $gte: cutoffSec, $lte: nowSec },
  }, {
    projection: { _id: 0, ticker: 1, fetched_sec: 1, snapshot_minute: 1, watcher_count: 1, source: 1, collector: 1 },
  }).sort({ ticker: 1, fetched_sec: 1 }).toArray().catch(() => [])

  const histories = new Map()
  for (const ticker of wanted) histories.set(ticker, [])
  for (const doc of docs) {
    const ticker = String(doc.ticker || '').toUpperCase()
    if (!histories.has(ticker)) continue
    histories.get(ticker).push(doc)
  }

  const result = new Map()
  for (const [ticker, rawRows] of histories.entries()) {
    const rows = dedupeWatcherSeries(rawRows, { startSec: cutoffSec, endSec: nowSec, nowSec })
    const latest = rows.at(-1)
    if (!latest || nowSec - Number(latest.fetched_sec) > maxAgeSeconds) continue
    const growthRows = rows.filter(row => Number(row.fetched_sec) >= Number(latest.fetched_sec) - growthWindowSeconds)
    const baseline = growthRows[0] || latest
    const sampleCount = growthRows.length
    const delta = sampleCount >= 2 ? Number(latest.watcher_count) - Number(baseline.watcher_count) : null
    const growthPct = delta != null && Number(baseline.watcher_count) > 0
      ? Number((delta / Number(baseline.watcher_count) * 100).toFixed(4))
      : null
    const feature = {
      status: 'fresh',
      source: latest.source || 'stocktwits_watcher_snapshots',
      snapshot_sec: Number(latest.fetched_sec),
      age_seconds: Math.max(0, nowSec - Number(latest.fetched_sec)),
      current_count: Number(latest.watcher_count),
      baseline_count: sampleCount >= 2 ? Number(baseline.watcher_count) : null,
      baseline_sec: sampleCount >= 2 ? Number(baseline.fetched_sec) : null,
      delta,
      growth_pct: growthPct,
      sample_count: sampleCount,
      growth_window_seconds: growthWindowSeconds,
      definition: 'current StockTwits watchlist count plus causal 24-hour growth from deduplicated real snapshots',
      normalization: 'positive growth rate with absolute-delta guard; capped at 2 ranking points',
      max_rank_points: MAX_RANK_POINTS,
      missing_behavior: 'zero rank points; never creates or rejects a candidate',
    }
    feature.score_points = watcherRankScore(feature)
    result.set(ticker, {
      ...latest,
      watcher_count: Number(latest.watcher_count),
      watcher_snapshot_age_seconds: feature.age_seconds,
      watcher_feature: feature,
    })
  }
  return result
}

export const WATCHER_MAX_RANK_POINTS = MAX_RANK_POINTS
