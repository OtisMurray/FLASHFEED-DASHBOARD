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
}

const WIDTH = 1000
const HEIGHT = 340
const PAD = { left: 56, right: 72, top: 24, bottom: 42 }
const PRICE_BOTTOM = 270

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
  const d = new Date(sec * 1000)
  const now = Date.now()
  const diff = now - d.getTime()
  if (diff < 86400000) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

function nearestIndex(candles: Candle[], eventTime: string | number) {
  const target = timeNumber(eventTime)
  let best = 0
  let bestDistance = Infinity
  candles.forEach((candle, index) => {
    const distance = Math.abs(timeNumber(candle.time) - target)
    if (distance < bestDistance) { best = index; bestDistance = distance }
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
}: Props) {
  const cleanCandles = candles
    .map(c => ({
      ...c,
      open: finiteNumber(c.open),
      high: finiteNumber(c.high),
      low: finiteNumber(c.low),
      close: finiteNumber(c.close),
      volume: finiteNumber(c.volume),
    }))
    .filter(c => c.open > 0 && c.high > 0 && c.low > 0 && c.close > 0)

  if (!cleanCandles.length) {
    return <div className="w-full h-full flex items-center justify-center text-sm text-neutral">No candle data</div>
  }

  const priceValues = [
    ...cleanCandles.flatMap(c => [c.high, c.low]),
    ...(bollinger?.upper || []).map(p => finiteNumber(p.value)).filter(Boolean),
    ...(bollinger?.lower || []).map(p => finiteNumber(p.value)).filter(Boolean),
    ...predicted.map(p => finiteNumber(p.value)).filter(Boolean),
  ]
  const rawMin = Math.min(...priceValues)
  const rawMax = Math.max(...priceValues)
  const spread = Math.max(0.0001, rawMax - rawMin)
  const min = Math.max(0, rawMin - spread * 0.08)
  const max = rawMax + spread * 0.08
  const plotWidth = WIDTH - PAD.left - PAD.right
  const priceHeight = PRICE_BOTTOM - PAD.top
  const step = cleanCandles.length > 1 ? plotWidth / (cleanCandles.length - 1) : plotWidth
  const bodyWidth = Math.max(2.5, Math.min(12, step * 0.65))
  const maxDensity = Math.max(1, ...density.map(p => finiteNumber(p.scaled ?? p.value)))

  const xAt = (i: number) => PAD.left + i * step
  const yPrice = (v: number) => PAD.top + ((max - v) / (max - min)) * priceHeight
  const seriesPoint = (p: SeriesPoint) => {
    const target = timeNumber(p.time)
    let i = cleanCandles.findIndex(c => timeNumber(c.time) >= target)
    if (i < 0) i = cleanCandles.length - 1
    return { x: xAt(i), y: yPrice(finiteNumber(p.value)) }
  }

  const upperPath = bollinger?.upper?.length ? pathFromPoints(bollinger.upper.map(seriesPoint)) : ''
  const lowerPath = bollinger?.lower?.length ? pathFromPoints(bollinger.lower.map(seriesPoint)) : ''
  const predictedPath = predicted.length ? pathFromPoints(predicted.map(seriesPoint)) : ''
  const sentimentPath = sentiment.length && showSentiment
    ? pathFromPoints(sentiment.map(p => {
        const target = timeNumber(p.time)
        let i = cleanCandles.findIndex(c => timeNumber(c.time) >= target)
        if (i < 0) i = cleanCandles.length - 1
        const v = Math.max(-1, Math.min(1, finiteNumber(p.value)))
        return { x: xAt(i), y: 290 - ((v + 1) / 2) * 30 }
      }))
    : ''

  const yTicks = Array.from({ length: 5 }, (_, i) => min + (spread * i) / 4)

  const xTicksCount = Math.min(8, cleanCandles.length)
  const xTicks = Array.from({ length: xTicksCount }, (_, i) => {
    const idx = Math.round((i / Math.max(1, xTicksCount - 1)) * (cleanCandles.length - 1))
    return { index: idx, candle: cleanCandles[idx] }
  })

  const lastPrice = cleanCandles[cleanCandles.length - 1].close
  const lastChange = ((lastPrice - cleanCandles[cleanCandles.length - 1].open) / cleanCandles[cleanCandles.length - 1].open) * 100

  return (
    <div className="w-full">
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="w-full" role="img" aria-label="Candlestick chart">
        <rect width={WIDTH} height={HEIGHT} fill="transparent" />

        {/* Price axis */}
        {yTicks.map((tick, i) => {
          const y = yPrice(tick)
          return (
            <g key={`y-${i}`}>
              <line x1={PAD.left} x2={WIDTH - PAD.right} y1={y} y2={y} stroke="#2a3a4a" strokeWidth="1" />
              <text x={WIDTH - PAD.right + 8} y={y + 4} fill="#E2E8F0" fontSize="13" fontFamily="monospace" fontWeight="600">
                {tick.toFixed(tick < 10 ? 2 : 0)}
              </text>
            </g>
          )
        })}

        {/* Time axis */}
        {xTicks.map(({ index: idx, candle }) => {
          const x = xAt(idx)
          return (
            <g key={`x-${idx}`}>
              <line x1={x} x2={x} y1={PAD.top} y2={PRICE_BOTTOM} stroke="#1a2836" strokeWidth="1" />
              <text x={x} y={HEIGHT - 14} fill="#94A3B8" fontSize="12" textAnchor="middle" fontFamily="monospace">
                {shortTime(candle.time)}
              </text>
            </g>
          )
        })}

        {/* Message volume bars */}
        {showDensity && density.map((point, i) => {
          const idx = nearestIndex(cleanCandles, point.time)
          const x = xAt(idx) - bodyWidth / 2
          const v = finiteNumber(point.scaled ?? point.value)
          const barH = Math.max(1, (v / maxDensity) * 28)
          return (
            <rect key={`d-${i}`} x={x} y={PRICE_BOTTOM + 28 - barH} width={bodyWidth} height={barH} fill="rgba(251, 146, 60, 0.45)" rx="1" />
          )
        })}

        {/* Candles */}
        {cleanCandles.map((candle, i) => {
          const x = xAt(i)
          const up = candle.close >= candle.open
          const color = up ? '#22C55E' : '#EF4444'
          const oy = yPrice(candle.open)
          const cy = yPrice(candle.close)
          const hy = yPrice(candle.high)
          const ly = yPrice(candle.low)
          const bodyY = Math.min(oy, cy)
          const bodyH = Math.max(2, Math.abs(cy - oy))
          return (
            <g key={`c-${i}`}>
              <line x1={x} x2={x} y1={hy} y2={ly} stroke={color} strokeWidth="1.5" />
              <rect x={x - bodyWidth / 2} y={bodyY} width={bodyWidth} height={bodyH} fill={up ? 'rgba(34,197,94,0.85)' : 'rgba(239,68,68,0.85)'} stroke={color} strokeWidth="1" rx="1" />
            </g>
          )
        })}

        {/* Bollinger */}
        {upperPath && <path d={upperPath} fill="none" stroke="rgba(167,139,250,0.6)" strokeWidth="1.5" strokeDasharray="6 4" />}
        {lowerPath && <path d={lowerPath} fill="none" stroke="rgba(167,139,250,0.6)" strokeWidth="1.5" strokeDasharray="6 4" />}
        {/* Prediction */}
        {predictedPath && <path d={predictedPath} fill="none" stroke="#F59E0B" strokeWidth="2.5" strokeDasharray="8 6" />}
        {/* Sentiment */}
        {sentimentPath && <path d={sentimentPath} fill="none" stroke="#A78BFA" strokeWidth="2.5" />}

        {/* Bottom divider */}
        <line x1={PAD.left} x2={WIDTH - PAD.right} y1={PRICE_BOTTOM} y2={PRICE_BOTTOM} stroke="#475569" strokeWidth="1" />
        <line x1={PAD.left} x2={WIDTH - PAD.right} y1={290} y2={290} stroke="#475569" strokeWidth="0.5" strokeDasharray="3 3" />

        {/* Labels */}
        <text x={PAD.left} y={PRICE_BOTTOM + 38} fill="#94A3B8" fontSize="13" fontFamily="monospace" fontWeight="500">
          Price ${lastPrice.toFixed(2)} ({lastChange >= 0 ? '+' : ''}{lastChange.toFixed(2)}%)
        </text>
        {showDensity && (
          <text x={PAD.left + 220} y={PRICE_BOTTOM + 38} fill="#FB923C" fontSize="12" fontFamily="monospace" fontWeight="700">
            ■ Volume
          </text>
        )}
        {showSentiment && (
          <text x={PAD.left + 220 + (showDensity ? 100 : 0)} y={PRICE_BOTTOM + 38} fill="#A78BFA" fontSize="12" fontFamily="monospace" fontWeight="700">
            ■ Sentiment
          </text>
        )}

        {/* News events */}
        {newsEvents.slice(-15).map((event, i) => {
          const idx = nearestIndex(cleanCandles, event.time)
          const candle = cleanCandles[idx]
          const x = xAt(idx)
          const bearish = event.position === 'aboveBar' || event.shape === 'arrowDown'
          const y = bearish ? yPrice(candle.high) - 16 : yPrice(candle.low) + 18
          const color = event.color || (bearish ? '#EF4444' : '#22C55E')
          const time = shortTime(event.time)
          const src = (event.source || 'News').substring(0, 5)
          return (
            <g key={`ne-${i}`}>
              {!bearish && <line x1={x} x2={x} y1={yPrice(candle.low)} y2={yPrice(candle.low) + 8} stroke={color} strokeWidth="1.5" strokeDasharray="2 2" />}
              <title>{`${event.source || 'News'} • ${event.title || event.text || 'signal'} • ${time}`}</title>
              <rect x={x - 6} y={y - 6} width="12" height="12" rx="3" fill={color} opacity="0.85" />
              <text x={x + 10} y={y + 4} fill={color} fontSize="11" fontFamily="monospace" fontWeight="700">{src}</text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}