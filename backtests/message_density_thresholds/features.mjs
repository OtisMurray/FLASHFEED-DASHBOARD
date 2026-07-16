import crypto from 'node:crypto'

export const MINUTE = 60

export function toSec(value) {
  if (value == null || value === '') return null
  if (value instanceof Date) return Math.floor(value.getTime() / 1000)
  if (typeof value === 'number') return Number.isFinite(value) ? Math.floor(value) : null
  const n = Number(value)
  if (Number.isFinite(n)) return Math.floor(n)
  const parsed = Date.parse(String(value))
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null
}

export function floorMinute(sec) {
  const n = toSec(sec)
  return n == null ? null : Math.floor(n / MINUTE) * MINUTE
}

export function eventSec(doc = {}) {
  return toSec(doc.fetched_at ?? doc.detected_at ?? doc.timestamp ?? doc.created_at ?? doc.publish_date)
}

export function normalizeMarketCap(raw, source = '') {
  const cap = Number(raw)
  if (!Number.isFinite(cap) || cap <= 0) return 0
  if (/finviz/i.test(String(source)) && cap < 10_000_000) return cap * 1_000_000
  return cap
}

export function marketCapTier(raw, source = '') {
  const cap = normalizeMarketCap(raw, source)
  if (cap >= 200e9) return 'Mega'
  if (cap >= 10e9) return 'Large'
  if (cap >= 2e9) return 'Mid'
  if (cap >= 300e6) return 'Small'
  if (cap > 0) return 'Nano'
  return 'Unknown'
}

export function candidateTickers(doc = {}) {
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

export function dedupeKey(doc = {}) {
  const platform = String(doc.platform || doc.collector || doc.source || '').toLowerCase()
  const stable = doc.id || doc.url || doc.link || doc.source_url || `${doc.title || ''}|${doc.text || doc.content || doc.summary || ''}`
  return crypto.createHash('sha1').update(`${platform}|${stable}`).digest('hex')
}

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

export function trailingSum(values, window) {
  const k = Math.max(1, Math.floor(window))
  const out = []
  const queue = []
  let sum = 0
  for (const raw of values) {
    const value = Number.isFinite(Number(raw)) ? Number(raw) : 0
    queue.push(value)
    sum += value
    while (queue.length > k) sum -= queue.shift()
    out.push(sum)
  }
  return out
}

export function pearson(xs, ys) {
  const pairs = []
  for (let i = 0; i < xs.length; i += 1) {
    const x = Number(xs[i])
    const y = Number(ys[i])
    if (Number.isFinite(x) && Number.isFinite(y)) pairs.push([x, y])
  }
  const n = pairs.length
  if (n < 2) return null
  const mx = pairs.reduce((a, p) => a + p[0], 0) / n
  const my = pairs.reduce((a, p) => a + p[1], 0) / n
  let cov = 0
  let vx = 0
  let vy = 0
  for (const [x, y] of pairs) {
    const dx = x - mx
    const dy = y - my
    cov += dx * dy
    vx += dx * dx
    vy += dy * dy
  }
  if (vx <= 0 || vy <= 0) return null
  return clampCorrelation(cov / Math.sqrt(vx * vy))
}

export function clampCorrelation(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  return Math.max(-1, Math.min(1, n))
}

export function rollingTimeCorrelation(bars, densityByMinute, windowMinutes, minObservations) {
  const out = new Map()
  const windowSec = windowMinutes * MINUTE
  const queue = []
  let sumX = 0
  let sumY = 0
  let sumXX = 0
  let sumYY = 0
  let sumXY = 0
  for (let i = 0; i < bars.length; i += 1) {
    const minute = bars[i].minute
    const x = Number(bars[i].close)
    const y = Number(densityByMinute.get(minute) ?? 0)
    if (Number.isFinite(x) && Number.isFinite(y)) {
      queue.push({ minute, x, y })
      sumX += x
      sumY += y
      sumXX += x * x
      sumYY += y * y
      sumXY += x * y
    }
    const start = minute - windowSec + MINUTE
    while (queue.length && queue[0].minute < start) {
      const old = queue.shift()
      sumX -= old.x
      sumY -= old.y
      sumXX -= old.x * old.x
      sumYY -= old.y * old.y
      sumXY -= old.x * old.y
    }
    const n = queue.length
    if (n >= minObservations) {
      const cov = sumXY - (sumX * sumY) / n
      const vx = sumXX - (sumX * sumX) / n
      const vy = sumYY - (sumY * sumY) / n
      const r = vx > 0 && vy > 0 ? clampCorrelation(cov / Math.sqrt(vx * vy)) : null
      out.set(minute, r == null ? null : Number(r.toFixed(6)))
    } else {
      out.set(minute, null)
    }
  }
  return out
}

export function thresholdCrossed(previous, current, threshold) {
  return Number.isFinite(previous) && Number.isFinite(current) && previous <= threshold && current > threshold
}

const etPartsCache = new Map()

export function etParts(sec) {
  const key = Number(sec || 0)
  if (etPartsCache.has(key)) return etPartsCache.get(key)
  const date = new Date(sec * 1000)
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  }).formatToParts(date)
  const get = type => parts.find(p => p.type === type)?.value || ''
  const value = {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    weekday: get('weekday'),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
  }
  etPartsCache.set(key, value)
  return value
}

export function isRegularSession(sec) {
  const p = etParts(sec)
  const dayIndex = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday)
  const minute = p.hour * 60 + p.minute
  return dayIndex >= 1 && dayIndex <= 5 && minute >= 9 * 60 + 30 && minute < 16 * 60
}

export function sameEtDate(a, b) {
  return etParts(a).date === etParts(b).date
}

export function pctReturn(from, to) {
  const a = Number(from)
  const b = Number(to)
  return Number.isFinite(a) && Number.isFinite(b) && a > 0 ? ((b - a) / a) * 100 : null
}

export function findBarAtOrBefore(bars, sec) {
  let found = null
  for (const bar of bars) {
    if (bar.minute <= sec) found = bar
    else break
  }
  return found
}

export function findBarAtOrAfter(bars, sec) {
  return bars.find(bar => bar.minute >= sec) || null
}

export function nextRealBarAfter(bars, sec, { regularOnly = true } = {}) {
  return bars.find(bar => bar.minute > sec && (!regularOnly || isRegularSession(bar.minute))) || null
}

export function summarizeTrades(trades) {
  const n = trades.length
  const gross = trades.map(t => Number(t.grossReturnPct)).filter(Number.isFinite)
  const net = trades.map(t => Number(t.netReturnPct)).filter(Number.isFinite)
  const wins = net.filter(v => v > 0)
  const losses = net.filter(v => v <= 0)
  const sum = arr => arr.reduce((a, b) => a + b, 0)
  const mean = arr => arr.length ? sum(arr) / arr.length : null
  const median = arr => {
    if (!arr.length) return null
    const s = [...arr].sort((a, b) => a - b)
    const mid = Math.floor(s.length / 2)
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
  }
  const grossProfit = sum(net.filter(v => v > 0))
  const grossLoss = Math.abs(sum(net.filter(v => v < 0)))
  const maxDrawdown = (() => {
    let equity = 0
    let peak = 0
    let dd = 0
    for (const v of net) {
      equity += v
      peak = Math.max(peak, equity)
      dd = Math.min(dd, equity - peak)
    }
    return dd
  })()
  const byExit = {}
  for (const trade of trades) byExit[trade.exitReason] = (byExit[trade.exitReason] || 0) + 1
  return {
    trades: n,
    winRate: n ? Number((wins.length / n).toFixed(4)) : null,
    meanGrossReturnPct: mean(gross) == null ? null : Number(mean(gross).toFixed(4)),
    medianGrossReturnPct: median(gross) == null ? null : Number(median(gross).toFixed(4)),
    meanNetReturnPct: mean(net) == null ? null : Number(mean(net).toFixed(4)),
    medianNetReturnPct: median(net) == null ? null : Number(median(net).toFixed(4)),
    expectancyPct: mean(net) == null ? null : Number(mean(net).toFixed(4)),
    profitFactor: grossLoss > 0 ? Number((grossProfit / grossLoss).toFixed(4)) : (grossProfit > 0 ? null : 0),
    maxDrawdownPctPoints: Number(maxDrawdown.toFixed(4)),
    exitCounts: byExit,
    avgMfePct: mean(trades.map(t => Number(t.mfePct)).filter(Number.isFinite)),
    avgMaePct: mean(trades.map(t => Number(t.maePct)).filter(Number.isFinite)),
  }
}
