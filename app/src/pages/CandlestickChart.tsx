'use client'

interface Candle { time: string | number; open: number; high: number; low: number; close: number; volume?: number }
interface SeriesPoint { time: string | number; value: number; scaled?: number; count?: number }
interface BollingerData { upper: SeriesPoint[]; lower: SeriesPoint[] }
interface NewsEvent {
  time: string | number
  position?: string
  color?: string
  shape?: string
  text?: string
  title?: string
  source?: string
}

interface Props {
  candles: Candle[]
  bollinger?: BollingerData
  predicted?: SeriesPoint[]
  density?: SeriesPoint[]
  sentiment?: SeriesPoint[]
  newsEvents?: NewsEvent[]
  showSentiment?: boolean
  showDensity?: boolean
  onToggleSentiment?: (show: boolean) => void
  onToggleDensity?: (show: boolean) => void
}

const WIDTH = 1000
const HEIGHT = 320
const PAD = { left: 48, right: 64, top: 20, bottom: 34 }
const PRICE_BOTTOM = 250

function finiteNumber(value: unknown, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function timeNumber(value: string | number) {
  if (typeof value === 'number') return value
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : Number(value) || 0
}

function pathFromPoints(points: Array<{ x: number; y: number }>) {
  return points.map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ')
}

function shortTime(value: string | number) {
  const sec = timeNumber(value)
  if (!sec) return ''
  return new Date(sec * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function nearestIndex(candles: Candle[], eventTime: string | number) {
  const target = timeNumber(eventTime)
  let best = 0
  let bestDistance = Number.POSITIVE_INFINITY
  candles.forEach((candle, index) => {
    const distance = Math.abs(timeNumber(candle.time) - target)
    if (distance < bestDistance) {
      best = index
      bestDistance = distance
    }
  })
  return best
}

export function CandlestickChart({ 
  candles, 
  bollinger, 
  predicted = [], 
  density = [], 
  sentiment = [], 
  newsEvents = [],
  showSentiment = true,
  showDensity = true,
  onToggleSentiment,
  onToggleDensity
}: Props) {
  const cleanCandles = candles
    .map(candle => ({
      ...candle,
      open: finiteNumber(candle.open),
      high: finiteNumber(candle.high),
      low: finiteNumber(candle.low),
      close: finiteNumber(candle.close),
      volume: finiteNumber(candle.volume),
    }))
    .filter(candle => candle.open > 0 && candle.high > 0 && candle.low > 0 && candle.close > 0)

  if (!cleanCandles.length) {
    return <div className="w-full h-full flex items-center justify-center text-xs text-neutral">No candle data</div>
  }

  const priceValues = [
    ...cleanCandles.flatMap(candle => [candle.high, candle.low]),
    ...(bollinger?.upper || []).map(point => finiteNumber(point.value)).filter(Boolean),
    ...(bollinger?.lower || []).map(point => finiteNumber(point.value)).filter(Boolean),
    ...predicted.map(point => finiteNumber(point.value)).filter(Boolean),
  ]
  const rawMin = Math.min(...priceValues)
  const rawMax = Math.max(...priceValues)
  const spread = Math.max(0.0001, rawMax - rawMin)
  const min = Math.max(0, rawMin - spread * 0.08)
  const max = rawMax + spread * 0.08
  const plotWidth = WIDTH - PAD.left - PAD.right
  const priceHeight = PRICE_BOTTOM - PAD.top
  const step = cleanCandles.length > 1 ? plotWidth / (cleanCandles.length - 1) : plotWidth
  const bodyWidth = Math.max(2.2, Math.min(10, step * 0.62))
  const maxDensity = Math.max(1, ...density.map(point => finiteNumber(point.scaled ?? point.value)))

  const xAt = (index: number) => PAD.left + index * step
  const yPrice = (value: number) => PAD.top + ((max - value) / (max - min)) * priceHeight
  const seriesPoint = (point: SeriesPoint) => {
    const target = timeNumber(point.time)
    let index = cleanCandles.findIndex(candle => timeNumber(candle.time) >= target)
    if (index < 0) index = cleanCandles.length - 1
    return { x: xAt(index), y: yPrice(finiteNumber(point.value)) }
  }

  const upperPath = bollinger?.upper?.length ? pathFromPoints(bollinger.upper.map(seriesPoint)) : ''
  const lowerPath = bollinger?.lower?.length ? pathFromPoints(bollinger.lower.map(seriesPoint)) : ''
  const predictedPath = predicted.length ? pathFromPoints(predicted.map(seriesPoint)) : ''
  const sentimentPath = sentiment.length && showSentiment
    ? pathFromPoints(sentiment.map(point => {
      const target = timeNumber(point.time)
      let index = cleanCandles.findIndex(candle => timeNumber(candle.time) >= target)
      if (index < 0) index = cleanCandles.length - 1
      const value = Math.max(-1, Math.min(1, finiteNumber(point.value)))
      return { x: xAt(index), y: 272 - ((value + 1) / 2) * 36 }
    }))
    : ''

  const yTicks = Array.from({ length: 5 }, (_, index) => min + (spread * index) / 4)
  const xTicks = Array.from({ length: Math.min(6, cleanCandles.length) }, (_, index) => {
    const candleIndex = Math.round((index / Math.max(1, Math.min(6, cleanCandles.length) - 1)) * (cleanCandles.length - 1))
    return { index: candleIndex, candle: cleanCandles[candleIndex] }
  })

  return (
    <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="w-full h-full" preserveAspectRatio="none" role="img" aria-label="Candlestick chart">
      <rect x="0" y="0" width={WIDTH} height={HEIGHT} fill="transparent" />

      {yTicks.map((tick, index) => {
        const y = yPrice(tick)
        return (
          <g key={`y-${index}`}>
            <line x1={PAD.left} x2={WIDTH - PAD.right} y1={y} y2={y} stroke="#1e293b" strokeWidth="1" />
            <text x={WIDTH - PAD.right + 10} y={y + 4} fill="#94a3b8" fontSize="11" fontFamily="monospace">
              {tick.toFixed(tick < 10 ? 2 : 1)}
            </text>
          </g>
        )
      })}

      {xTicks.map(({ index, candle }) => {
        const x = xAt(index)
        return (
          <g key={`x-${index}`}>
            <line x1={x} x2={x} y1={PAD.top} y2={PRICE_BOTTOM} stroke="#172033" strokeWidth="1" />
            <text x={x} y={HEIGHT - 11} fill="#64748b" fontSize="11" textAnchor="middle" fontFamily="monospace">
              {shortTime(candle.time)}
            </text>
          </g>
        )
      })}

      {showDensity && density.map((point, index) => {
        const candleIndex = nearestIndex(cleanCandles, point.time)
        const x = xAt(candleIndex) - bodyWidth / 2
        const value = finiteNumber(point.scaled ?? point.value)
        const barHeight = Math.max(1, (value / maxDensity) * 34)
        return (
          <rect
            key={`density-${index}`}
            x={x}
            y={PRICE_BOTTOM + 34 - barHeight}
            width={bodyWidth}
            height={barHeight}
            fill="rgba(251, 146, 60, 0.4)"
          />
        )
      })}

      {cleanCandles.map((candle, index) => {
        const x = xAt(index)
        const up = candle.close >= candle.open
        const color = up ? '#10b981' : '#ef4444'
        const openY = yPrice(candle.open)
        const closeY = yPrice(candle.close)
        const highY = yPrice(candle.high)
        const lowY = yPrice(candle.low)
        const bodyY = Math.min(openY, closeY)
        const bodyH = Math.max(1.8, Math.abs(closeY - openY))
        return (
          <g key={`${candle.time}-${index}`}>
            <line x1={x} x2={x} y1={highY} y2={lowY} stroke={color} strokeWidth="1.4" />
            <rect x={x - bodyWidth / 2} y={bodyY} width={bodyWidth} height={bodyH} fill={up ? 'rgba(16,185,129,0.8)' : 'rgba(239,68,68,0.8)'} stroke={color} strokeWidth="1" rx="1" />
          </g>
        )
      })}

      {upperPath && <path d={upperPath} fill="none" stroke="rgba(167,139,250,0.7)" strokeWidth="1.5" strokeDasharray="5 5" />}
      {lowerPath && <path d={lowerPath} fill="none" stroke="rgba(167,139,250,0.7)" strokeWidth="1.5" strokeDasharray="5 5" />}
      {predictedPath && <path d={predictedPath} fill="none" stroke="#f59e0b" strokeWidth="2" strokeDasharray="7 5" />}
      {sentimentPath && <path d={sentimentPath} fill="none" stroke="#a78bfa" strokeWidth="2" />}

      <line x1={PAD.left} x2={WIDTH - PAD.right} y1={PRICE_BOTTOM} y2={PRICE_BOTTOM} stroke="#334155" strokeWidth="1" />
      {showDensity && <text x={PAD.left} y={PRICE_BOTTOM + 27} fill="#fb923c" fontSize="11" fontFamily="monospace" fontWeight="600">Message Volume</text>}
      {showSentiment && <text x={PAD.left + (showDensity ? 120 : 70)} y={PRICE_BOTTOM + 27} fill="#a78bfa" fontSize="11" fontFamily="monospace" fontWeight="600">Sentiment</text>}

      {newsEvents.slice(-12).map((event, index) => {
        const candleIndex = nearestIndex(cleanCandles, event.time)
        const candle = cleanCandles[candleIndex]
        const x = xAt(candleIndex)
        const bearish = event.position === 'aboveBar' || event.shape === 'arrowDown'
        const y = bearish ? yPrice(candle.high) - 13 : yPrice(candle.low) + 15
        const color = event.color || '#f59e0b'
        const time = shortTime(event.time)
        return (
          <g key={`${event.time}-${index}`}>
            <title>{`${event.source || 'News'}: ${event.title || event.text || 'matched signal'}\n${time}`}</title>
            {bearish ? (
              <path d={`M${x},${y + 7} L${x - 6},${y - 5} L${x + 6},${y - 5} Z`} fill={color} />
            ) : (
              <path d={`M${x},${y - 7} L${x - 6},${y + 5} L${x + 6},${y + 5} Z`} fill={color} />
            )}
            <text x={x + 8} y={y + 4} fill={color} fontSize="9" fontFamily="monospace" fontWeight="600">
              {time}
            </text>
          </g>
        )
      })}
    </svg>
  )
}
