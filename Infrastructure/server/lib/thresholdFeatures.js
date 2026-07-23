// Rolling price×density correlation primitives (shared ESM module).
//
// Faithful extraction of the causal rolling-correlation math from
// scripts/update_prediction_threshold_features.js, lifted into ESM so the v11
// screener route can recompute entry features at an ARBITRARY window (v11 needs
// a 120-minute window, which no stored tier feature uses) with the exact same
// definition the production feature-writer uses. Keep in sync with that script.
//
// Density is the causal trailing mean of per-minute message counts; correlation
// is a causal rolling Pearson corr(price close, smoothed density) over a
// `windowMinutes` window with a `minObservations` floor.
//
// CONFIDENTIALITY BOUNDARY: pure math over caller-supplied bars/counts. No
// Mongo, no network, nothing under ~/dev/research-students.

export function causalRollingMean(values, window) {
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

export function clampCorrelation(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  return Math.max(-1, Math.min(1, n))
}

// bars: [{ minute: epochSec, close }...] sorted ascending by minute.
// densityByMinute: Map<epochSec, number>. Returns Map<epochSec, corr|null>.
export function rollingCorrelation(bars, densityByMinute, windowMinutes, minObservations) {
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

export function findBarAtOrBefore(bars, sec) {
  let found = null
  for (const bar of bars) {
    if (bar.minute <= sec) found = bar
    else break
  }
  return found
}

export function pctReturn(from, to) {
  const a = Number(from)
  const b = Number(to)
  return Number.isFinite(a) && Number.isFinite(b) && a > 0 ? ((b - a) / a) * 100 : null
}

export function minuteRange(start, end) {
  const out = []
  for (let t = start; t <= end; t += 60) out.push(t)
  return out
}

// Build the causal density-by-minute map for one ticker over the bar span,
// from a raw per-(ticker|minute) count map (same shape as the feature-writer's
// social.rawByTickerMinute). Smoothing window == correlation window, matching
// the tier-profile convention (smoothingMinutes == windowMinutes).
export function densityByMinuteFor(ticker, bars, rawByTickerMinute, windowMinutes) {
  const first = bars[0]?.minute
  const last = bars[bars.length - 1]?.minute
  if (!first || !last) return new Map()
  const minutes = minuteRange(first - 6 * 3600, last)
  const counts = minutes.map(minute => rawByTickerMinute.get(`${ticker}|${minute}`) || 0)
  const smoothed = causalRollingMean(counts, windowMinutes)
  return new Map(minutes.map((minute, index) => [minute, smoothed[index] || 0]))
}

// Trailing raw message count over the last `minutes` minutes ending at `endSec`.
export function trailingMessageCount(ticker, endSec, rawByTickerMinute, minutes = 60) {
  let total = 0
  const startSec = endSec - (minutes - 1) * 60
  for (let t = startSec; t <= endSec; t += 60) {
    total += rawByTickerMinute.get(`${ticker}|${t}`) || 0
  }
  return total
}

// ── Social message matching (mirrors update_prediction_threshold_features.js) ──

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

// Build rawByTickerMinute (Map<"TICKER|minuteSec", count>) for `tickerSet` over
// [startSec-6h, endSec]. Scoped by the same ticker/time fields the feature-writer
// uses. NOTE: unlike the offline full-scan feature-writer, this queries by the
// indexed ticker fields, so free-text-only cashtag mentions (docs with no
// ticker/symbol/cashtag/tickers_mentioned field) are not counted — a bounded,
// documented approximation acceptable for this postmortem probe.
export async function loadRawSocialCountsFor(db, tickerSet, startSec, endSec) {
  const rawByTickerMinute = new Map()
  if (!db || !tickerSet || tickerSet.size === 0) return rawByTickerMinute
  const startLookback = startSec - 6 * 3600
  const tickers = [...tickerSet]
  const upper = tickers.map(t => String(t).toUpperCase())
  const docs = await db.collection('socials')
    .find({
      $or: [
        { ticker: { $in: upper } },
        { symbol: { $in: upper } },
        { cashtag: { $in: upper } },
        { tickers_mentioned: { $in: upper } },
      ],
    }, {
      projection: {
        _id: 1, id: 1, platform: 1, collector: 1, source: 1, ticker: 1, symbol: 1,
        cashtag: 1, tickers_mentioned: 1, text: 1, content: 1, title: 1, summary: 1,
        url: 1, link: 1, source_url: 1, fetched_at: 1, detected_at: 1, timestamp: 1,
        created_at: 1, publish_date: 1,
      },
    })
    .toArray()
    .catch(() => [])
  for (const doc of docs) {
    const sec = eventSec(doc)
    if (!sec || sec < startLookback || sec > endSec + 3600) continue
    const minute = floorMinute(sec)
    if (minute == null) continue
    for (const ticker of candidateTickers(doc)) {
      if (!tickerSet.has(ticker)) continue
      const key = `${ticker}|${minute}`
      rawByTickerMinute.set(key, (rawByTickerMinute.get(key) || 0) + 1)
    }
  }
  return rawByTickerMinute
}
