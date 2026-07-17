'use client'
import { useEffect, useRef } from 'react'
import {
  ColorType,
  CrosshairMode,
  LineStyle,
  createChart,
} from 'lightweight-charts'

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
export interface StrategyMarker { time: string | number; type: 'entry' | 'exit'; price?: number }

interface Props {
  candles: Candle[]
  bollinger?: BollingerData
  predicted?: SeriesPoint[]
  density?: SeriesPoint[]
  sentiment?: SeriesPoint[]
  densityOverlay?: SeriesPoint[]
  sentimentOverlay?: SeriesPoint[]
  watcherOverlay?: SeriesPoint[]
  newsEvents?: NewsEvent[]
  strategyMarkers?: StrategyMarker[]
  showSentiment?: boolean
  showDensity?: boolean
  showWatchers?: boolean
  showBollinger?: boolean
  showPrediction?: boolean
  showMarkers?: boolean
  chartStyle?: 'line' | 'candles'
  minHeight?: number
}

function finiteNumber(value: unknown, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function normalizeTime(value: string | number) {
  if (typeof value === 'number') return value
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : Number(value) || 0
}

function normalizeSeries<T extends { time: string | number }>(rows: T[], mapper: (row: T) => Record<string, unknown>) {
  const byTime = new Map<number, Record<string, unknown>>()
  rows.forEach(row => {
    const time = normalizeTime(row.time)
    if (time > 0) byTime.set(time, { ...mapper(row), time })
  })
  return [...byTime.values()].sort((a, b) => Number(a.time) - Number(b.time))
}

function percentile(value: number, max: number) {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return 0
  return Math.max(0, Math.min(100, (value / max) * 100))
}

function evidenceBandValue(percent: number, priceMin: number, priceMax: number) {
  const range = Math.max(0.01, priceMax - priceMin)
  const bandBottom = priceMin + range * 0.04
  const bandTop = priceMin + range * 0.24
  return bandBottom + ((Math.max(0, Math.min(100, percent)) / 100) * (bandTop - bandBottom))
}

type ChartMarker = {
  time: number
  position: 'aboveBar' | 'belowBar'
  color: string
  shape: 'arrowUp' | 'arrowDown'
  text: string
}

function medianIntervalSeconds(rows: Array<{ time: unknown }>) {
  const times = rows.map(row => Number(row.time)).filter(Number.isFinite).sort((a, b) => a - b)
  const diffs = times.slice(1).map((time, index) => time - times[index]).filter(diff => diff > 0)
  if (!diffs.length) return 60
  diffs.sort((a, b) => a - b)
  return diffs[Math.floor(diffs.length / 2)] || 60
}

function compactMarkerText(text?: string, fallback = 'NEWS') {
  const raw = String(text || fallback).toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!raw) return fallback
  if (raw.includes('LAWSUIT') || raw.includes('PROBE') || raw.includes('INVESTIGATION')) return 'LAWSUIT'
  if (raw.includes('OFFERING') || raw.includes('DILUTION')) return 'OFFER'
  if (raw.includes('FDA') || raw.includes('TRIAL') || raw.includes('PHASE')) return 'FDA'
  if (raw.includes('EARNINGS') || raw.includes('RESULTS')) return 'EARN'
  if (raw.includes('MERGER') || raw.includes('ACQUIRE') || raw.includes('BUYOUT')) return 'M&A'
  if (raw.includes('ENTRY')) return 'ENTRY'
  if (raw.includes('EXIT')) return 'EXIT'
  if (raw === 'PRED' || raw.includes('TRADE WATCH') || raw.startsWith('SOC ') || raw.includes('SOCIAL')) return 'SIGNAL'
  if (raw.includes('NEWS')) return 'NEWS'
  return raw.split(' ').slice(0, 2).join(' ').slice(0, 12)
}

function groupedMarkers(markers: ChartMarker[], candleRows: Array<{ time: unknown }>, maxGroups = 16) {
  const displayMarkers = markers.filter(marker => compactMarkerText(marker.text) !== 'SIGNAL')
  if (!displayMarkers.length) return []
  const interval = medianIntervalSeconds(candleRows)
  const span = Math.max(0, Number(candleRows[candleRows.length - 1]?.time || 0) - Number(candleRows[0]?.time || 0))
  const startingWindow = Math.max(interval * 6, span > 18 * 3600 ? 60 * 60 : 15 * 60)
  let bucketSeconds = startingWindow
  let grouped: ChartMarker[] = []

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const buckets = new Map<string, ChartMarker[]>()
    for (const marker of displayMarkers) {
      if (!Number.isFinite(marker.time) || marker.time <= 0) continue
      const bucket = Math.floor(marker.time / bucketSeconds) * bucketSeconds
      const key = `${bucket}|${marker.position}|${marker.shape}`
      const existing = buckets.get(key) || []
      existing.push(marker)
      buckets.set(key, existing)
    }

    grouped = [...buckets.entries()].map(([key, bucketMarkers]) => {
      const [bucketRaw, position, shape] = key.split('|')
      const labels = new Map<string, number>()
      for (const marker of bucketMarkers) {
        const label = compactMarkerText(marker.text)
        labels.set(label, (labels.get(label) || 0) + 1)
      }
      const [topLabel, topCount] = [...labels.entries()].sort((a, b) => b[1] - a[1])[0] || ['NEWS', bucketMarkers.length]
      const count = bucketMarkers.length
      const lowPriority = topLabel === 'SIGNAL'
      const text = count === 1 && lowPriority
        ? ''
        : count > 1
        ? labels.size > 1 ? `EVENTS x${count}` : `${topLabel} x${topCount}`
        : topLabel
      const first = bucketMarkers[0]
      return {
        time: first.time || Number(bucketRaw),
        position: position === 'aboveBar' ? 'aboveBar' as const : 'belowBar' as const,
        color: first.color,
        shape: shape === 'arrowDown' ? 'arrowDown' as const : 'arrowUp' as const,
        text,
      }
    }).sort((a, b) => Number(a.time) - Number(b.time))

    if (grouped.length <= maxGroups) break
    bucketSeconds *= 2
  }

  return grouped
}

export function CandlestickChart({
  candles,
  bollinger,
  predicted = [],
  density = [],
  sentiment = [],
  densityOverlay,
  sentimentOverlay,
  watcherOverlay,
  newsEvents = [],
  strategyMarkers = [],
  showSentiment = true,
  showDensity = true,
  showWatchers = false,
  showBollinger = true,
  showPrediction = false,
  showMarkers = true,
  chartStyle = 'line',
  minHeight = 340,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<ReturnType<typeof createChart> | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const candleData = normalizeSeries(candles, candle => ({
      open: finiteNumber(candle.open),
      high: finiteNumber(candle.high),
      low: finiteNumber(candle.low),
      close: finiteNumber(candle.close),
      volume: finiteNumber(candle.volume),
    })).filter(candle =>
      Number(candle.open) > 0 &&
      Number(candle.high) > 0 &&
      Number(candle.low) > 0 &&
      Number(candle.close) > 0
    )

    if (!candleData.length) {
      container.innerHTML = '<div class="w-full h-full flex items-center justify-center text-sm text-neutral">No candle data</div>'
      return
    }

    container.innerHTML = ''
    chartRef.current?.remove()

    const chart = createChart(container, {
      width: container.clientWidth,
      height: container.clientHeight || 340,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#8b8f98',
        fontSize: 12,
      },
      grid: {
        vertLines: { color: 'rgba(148, 163, 184, 0.09)' },
        horzLines: { color: 'rgba(148, 163, 184, 0.14)' },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: {
        borderColor: 'rgba(148, 163, 184, 0.25)',
        scaleMargins: { top: 0.08, bottom: 0.22 },
      },
      leftPriceScale: {
        visible: showSentiment || showDensity,
        borderColor: 'rgba(148, 163, 184, 0.15)',
        scaleMargins: { top: 0.12, bottom: 0.22 },
      },
      timeScale: {
        borderColor: 'rgba(148, 163, 184, 0.25)',
        timeVisible: true,
        secondsVisible: false,
      },
    })
    chartRef.current = chart

    const closeLine = candleData.map(candle => ({ time: candle.time, value: Number(candle.close) }))
    const priceValues = candleData.flatMap(candle => [Number(candle.high), Number(candle.low), Number(candle.close)]).filter(Number.isFinite)
    const priceMin = Math.min(...priceValues)
    const priceMax = Math.max(...priceValues)
    const lastClose = (closeLine[closeLine.length - 1]?.value ?? closeLine[0]?.value ?? 0) as number
    const firstClose = (closeLine[0]?.value ?? lastClose) as number
    const priceUp = lastClose >= firstClose
    const trendColor = priceUp ? '#11b981' : '#ef4444'
    const priceColor = chartStyle === 'line' ? '#22c7a4' : trendColor

    const priceSeries = chartStyle === 'candles'
      ? chart.addCandlestickSeries({
          upColor: '#10b981',
          downColor: '#ef4444',
          borderUpColor: '#10b981',
          borderDownColor: '#ef4444',
          wickUpColor: '#10b981',
          wickDownColor: '#ef4444',
        })
      : chart.addAreaSeries({
          lineColor: priceColor,
          topColor: 'rgba(34, 199, 164, 0.16)',
          bottomColor: 'rgba(17, 185, 129, 0)',
          lineWidth: 3,
          priceLineColor: priceColor,
          lastValueVisible: true,
          priceLineVisible: true,
        })

    if (chartStyle === 'candles') {
      priceSeries.setData(candleData as any)
    } else {
      priceSeries.setData(closeLine as any)
    }

    // Volume histogram
    const volumeData = candleData
      .filter(candle => Number(candle.volume || 0) > 0)
      .map(candle => ({
        time: candle.time,
        value: Number(candle.volume || 0),
        color: Number(candle.close) >= Number(candle.open)
          ? 'rgba(34, 199, 164, 0.35)'
          : 'rgba(239, 68, 68, 0.32)',
      }))
    if (volumeData.length) {
      const volumeSeries = chart.addHistogramSeries({
        priceScaleId: 'volume',
        priceFormat: { type: 'volume' },
        priceLineVisible: false,
        lastValueVisible: false,
      })
      volumeSeries.setData(volumeData as any)
      chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } })
    }

    // Bollinger Bands
    const upper = normalizeSeries(bollinger?.upper || [], point => ({ value: finiteNumber(point.value, NaN) }))
      .filter(point => Number.isFinite(point.value))
    const lower = normalizeSeries(bollinger?.lower || [], point => ({ value: finiteNumber(point.value, NaN) }))
      .filter(point => Number.isFinite(point.value))

    if (showBollinger && upper.length) {
      chart.addLineSeries({
        color: 'rgba(139, 92, 246, 0.55)',
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        priceLineVisible: false,
        lastValueVisible: false,
      }).setData(upper as any)
    }

    if (showBollinger && lower.length) {
      chart.addLineSeries({
        color: 'rgba(139, 92, 246, 0.55)',
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        priceLineVisible: false,
        lastValueVisible: false,
      }).setData(lower as any)
    }

    // Prediction overlay
    const predictionData = normalizeSeries(predicted, point => ({ value: finiteNumber(point.value, NaN) }))
      .filter(point => Number.isFinite(point.value))
    if (showPrediction && predictionData.length) {
      chart.addLineSeries({
        color: '#f59e0b',
        lineWidth: 2,
        lineStyle: LineStyle.Dashed,
        priceLineVisible: false,
      }).setData(predictionData as any)
    }

    // Evidence overlays are normalized into a reserved bottom band of the price
    // pane. This keeps density/sentiment readable without pretending their
    // 0-100 values are price levels or letting them float over candles.

    // Density overlay (orange)
    const densityRows = densityOverlay?.length ? densityOverlay : density
    if (showDensity && densityRows.length) {
      const maxDensity = Math.max(...densityRows.map(point => finiteNumber(point.scaled ?? point.value, 0)), 0)
      const densityData = normalizeSeries(densityRows, point => ({
        value: evidenceBandValue(percentile(finiteNumber(point.scaled ?? point.value, 0), maxDensity), priceMin, priceMax),
      }))
        .filter(point => Number.isFinite(point.value))
      if (densityData.length) {
        chart.addLineSeries({
          color: '#FF9800',
          lineWidth: 2,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        }).setData(densityData as any)
      }
    }

    // Sentiment overlay (green)
    const sentimentRows = sentimentOverlay?.length ? sentimentOverlay : sentiment
    if (showSentiment && sentimentRows.length) {
      const sentimentData = normalizeSeries(sentimentRows, point => ({
        value: evidenceBandValue(Math.max(0, Math.min(100, (finiteNumber(point.value, 0) + 1) * 50)), priceMin, priceMax),
      }))
        .filter(point => Number.isFinite(point.value))
      if (sentimentData.length) {
        chart.addLineSeries({
          color: '#4CAF50',
          lineWidth: 2,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        }).setData(sentimentData as any)
      }
    }

    // Stocktwits watcher overlay (blue). Uses only stored real snapshots; if the
    // backend has not accumulated history yet this simply has no line to draw.
    const watcherRows = watcherOverlay || []
    if (showWatchers && watcherRows.length >= 2) {
      const watcherValues = watcherRows.map(point => finiteNumber(point.value, NaN)).filter(Number.isFinite)
      const minWatchers = Math.min(...watcherValues)
      const maxWatchers = Math.max(...watcherValues)
      const watcherData = normalizeSeries(watcherRows, point => {
        const value = finiteNumber(point.value, NaN)
        const percent = maxWatchers > minWatchers ? ((value - minWatchers) / (maxWatchers - minWatchers)) * 100 : 50
        return { value: evidenceBandValue(percent, priceMin, priceMax) }
      }).filter(point => Number.isFinite(point.value))
      if (watcherData.length >= 2) {
        chart.addLineSeries({
          color: '#60a5fa',
          lineWidth: 2,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        }).setData(watcherData as any)
      }
    }

    // Event markers
    const rawMarkers: ChartMarker[] = [
      ...(showMarkers ? newsEvents.map(event => ({
        time: normalizeTime(event.time),
        position: event.position === 'aboveBar' ? 'aboveBar' as const : 'belowBar' as const,
        color: event.color || (event.position === 'aboveBar' ? '#ef4444' : '#10b981'),
        shape: event.shape === 'arrowDown' ? 'arrowDown' as const : 'arrowUp' as const,
        text: event.text || event.title || event.source || 'News',
      })) : []),
      ...strategyMarkers.map(marker => ({
        time: normalizeTime(marker.time),
        position: marker.type === 'exit' ? 'aboveBar' as const : 'belowBar' as const,
        color: marker.type === 'exit' ? '#ef4444' : '#38bdf8',
        shape: marker.type === 'exit' ? 'arrowDown' as const : 'arrowUp' as const,
        text: marker.type === 'exit' ? 'EXIT' : 'ENTRY',
      })),
    ].sort((a, b) => Number(a.time) - Number(b.time))
    const chartMarkers = groupedMarkers(rawMarkers, candleData as Array<{ time: unknown }>)
    if (chartMarkers.length) {
      priceSeries.setMarkers(chartMarkers as any)
    }

    chart.timeScale().fitContent()

    const resizeObserver = new ResizeObserver(entries => {
      for (const entry of entries) {
        chart.applyOptions({
          width: Math.max(1, Math.floor(entry.contentRect.width)),
          height: Math.max(1, Math.floor(entry.contentRect.height || 340)),
        })
      }
    })
    resizeObserver.observe(container)

    return () => {
      resizeObserver.disconnect()
      chart.remove()
      chartRef.current = null
    }
  }, [candles, bollinger, predicted, density, sentiment, densityOverlay, sentimentOverlay, watcherOverlay, newsEvents, strategyMarkers, showDensity, showSentiment, showWatchers, showBollinger, showPrediction, showMarkers, chartStyle])

  return <div ref={containerRef} className="w-full h-full" style={{ minHeight }} />
}
