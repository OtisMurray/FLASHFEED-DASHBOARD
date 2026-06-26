// Client-side chart aggregation shared by the Charts views.
// The backend serves ONE resolution: 1-minute extended-hours intraday OHLC
// (/api/charts) and per-minute social density + 5-min sliding sentiment
// (/api/chart/social). These helpers re-bucket and overlay that fine data in the
// browser so the price-chart timeframe selector and density/sentiment overlays
// recompute instantly with no extra server calls.

export interface Candle { time: string | number; open: number; high: number; low: number; close: number; volume?: number }
export interface LinePoint { time: number; value: number }
export interface BollingerBands { upper: LinePoint[]; lower: LinePoint[] }

// Social payload subset we read (from /api/chart/social).
export interface SocialSeries {
  labels: string[]; density: number[]
  sent_labels: string[]; scores_smooth: number[]
}

// TS port of the backend's _smooth_same(values, k): centered k-wide mean with
// zero padding at the edges (np.convolve mode='same'), skipping smoothing when
// len < k.
export function smoothSame(values: number[], k: number): number[] {
  const n = values.length
  if (k <= 1 || n < k) return values.slice()
  const lead = Math.floor((k - 1) / 2)
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    let s = 0
    for (let j = i - lead; j < i - lead + k; j++) {
      if (j >= 0 && j < n) s += values[j]
    }
    out.push(s / k)
  }
  return out
}

// Bucket start (unix seconds) for a clock-aligned timeframe of `tfMin` minutes.
export const bucketStart = (timeSec: number, tfMin: number): number => {
  const span = tfMin * 60
  return Math.floor(timeSec / span) * span
}

// Resample 1-minute candles into `tfMin`-minute buckets: open=first, high=max,
// low=min, close=last, volume=sum. Clock-aligned, newest order preserved.
export function resampleCandles(candles: Candle[], tfMin: number): Candle[] {
  if (tfMin <= 1 || candles.length === 0) return candles
  const buckets = new Map<number, Candle>()
  for (const c of candles) {
    const timeNum: number = typeof c.time === 'string' ? new Date(c.time).getTime() / 1000 : (c.time as number)
    const t = bucketStart(timeNum, tfMin)
    const b = buckets.get(t)
    if (!b) {
      buckets.set(t, { time: t, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume ?? 0 })
    } else {
      b.high = Math.max(b.high, c.high)
      b.low = Math.min(b.low, c.low)
      b.close = c.close
      b.volume = (b.volume ?? 0) + (c.volume ?? 0)
    }
  }
  return Array.from(buckets.values()).sort((a: any, b: any) => a.time - b.time) as any
}

// Bollinger(period, mult) from a candle series' closes.
export function bollingerFromCandles(candles: Candle[], period = 20, mult = 2): BollingerBands {
  const upper: LinePoint[] = [], lower: LinePoint[] = []
  if (candles.length < period) return { upper, lower }
  for (let i = period - 1; i < candles.length; i++) {
    let sum = 0
    for (let j = i - period + 1; j <= i; j++) sum += candles[j].close
    const m = sum / period
    let sq = 0
    for (let j = i - period + 1; j <= i; j++) sq += (candles[j].close - m) ** 2
    const sd = Math.sqrt(sq / period)
    const ti = typeof candles[i].time === 'string' ? new Date(candles[i].time as string).getTime() / 1000 : candles[i].time as number
    upper.push({ time: ti, value: +(m + mult * sd).toFixed(4) })
    lower.push({ time: ti, value: +(m - mult * sd).toFixed(4) })
  }
  return { upper, lower }
}

// EMA over a series, seeded with values[0].
export function emaList(values: number[], period: number): number[] {
  if (!values.length) return []
  const k = 2 / (period + 1)
  const out: number[] = []
  let ema: number | null = null
  for (const v of values) { ema = ema === null ? v : (v - ema) * k + ema; out.push(ema) }
  return out
}

// Wilder's RSI(period) on a candle series.
export function rsiFromCandles(candles: Candle[], period = 14): LinePoint[] {
  const times = candles.map(c => typeof c.time === 'string' ? new Date(c.time).getTime() / 1000 : c.time)
  const closes = candles.map(c => c.close)
  const n = closes.length
  if (n < period + 1) return []
  const ch: number[] = []
  for (let i = 1; i < n; i++) ch.push(closes[i] - closes[i - 1])
  const gains = ch.map(c => (c > 0 ? c : 0))
  const losses = ch.map(c => (c < 0 ? -c : 0))
  let ag = gains.slice(0, period).reduce((a, b) => a + b, 0) / period
  let al = losses.slice(0, period).reduce((a, b) => a + b, 0) / period
  const val = (g: number, l: number) => (l === 0 ? 100 : 100 - 100 / (1 + g / l))
  const out: LinePoint[] = [{ time: times[period], value: +val(ag, al).toFixed(2) }]
  for (let i = period; i < ch.length; i++) {
    ag = (ag * (period - 1) + gains[i]) / period
    al = (al * (period - 1) + losses[i]) / period
    out.push({ time: times[i + 1], value: +val(ag, al).toFixed(2) })
  }
  return out
}

export interface MacdSeries { macd: LinePoint[]; signal: LinePoint[]; histogram: LinePoint[] }

// MACD(fast,slow,signal) on a candle series.
export function macdFromCandles(candles: Candle[], fast = 12, slow = 26, signal = 9): MacdSeries {
  const times = candles.map(c => typeof c.time === 'string' ? new Date(c.time).getTime() / 1000 : c.time)
  const closes = candles.map(c => c.close)
  const n = closes.length
  if (n < slow) return { macd: [], signal: [], histogram: [] }
  const ef = emaList(closes, fast), es = emaList(closes, slow)
  const line = closes.map((_, i) => ef[i] - es[i])
  const sig = emaList(line, signal)
  const macd: LinePoint[] = [], signalOut: LinePoint[] = [], histogram: LinePoint[] = []
  for (let i = slow - 1; i < n; i++) {
    macd.push({ time: times[i], value: +line[i].toFixed(4) })
    signalOut.push({ time: times[i], value: +sig[i].toFixed(4) })
    histogram.push({ time: times[i], value: +(line[i] - sig[i]).toFixed(4) })
  }
  return { macd, signal: signalOut, histogram }
}

// "HH:MM" ET wall-clock label for a candle's unix time.
function etLabel(timeSec: number): string {
  const d = new Date(timeSec * 1000)
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mm = String(d.getUTCMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

// Build density / sentiment overlay lines aligned to the SAME timeframe buckets.
export function overlaySeries(
  rawCandles: Candle[],
  social: SocialSeries | null,
  tfMin: number,
  windowMin = 15,
): { density: LinePoint[]; sentiment: LinePoint[] } {
  if (!social || !rawCandles.length) return { density: [], sentiment: [] }

  const densSmooth = smoothSame(social.density || [], windowMin)
  const densByLabel = new Map<string, number>()
  ;(social.labels || []).forEach((l, i) => densByLabel.set(l, densSmooth[i]))
  const sentByLabel = new Map<string, number>()
  ;(social.sent_labels || []).forEach((l, i) => sentByLabel.set(l, (social.scores_smooth || [])[i]))

  const dAcc = new Map<number, { sum: number; n: number }>()
  const sAcc = new Map<number, { sum: number; n: number }>()
  for (const c of rawCandles) {
    const timeNum: number = typeof c.time === 'string' ? new Date(c.time).getTime() / 1000 : (c.time as number)
    const t = bucketStart(timeNum, tfMin)
    const label = etLabel(timeNum)
    if (densByLabel.has(label)) {
      const a = dAcc.get(t) || { sum: 0, n: 0 }; a.sum += densByLabel.get(label)!; a.n++; dAcc.set(t, a)
    }
    if (sentByLabel.has(label)) {
      const a = sAcc.get(t) || { sum: 0, n: 0 }; a.sum += sentByLabel.get(label)!; a.n++; sAcc.set(t, a)
    }
  }
  const toLine = (acc: Map<number, { sum: number; n: number }>): LinePoint[] =>
    Array.from(acc.entries()).filter(([, v]) => v.n > 0)
      .map(([time, v]) => ({ time, value: +(v.sum / v.n).toFixed(4) }))
      .sort((a, b) => a.time - b.time)

  return { density: toLine(dAcc), sentiment: toLine(sAcc) }
}