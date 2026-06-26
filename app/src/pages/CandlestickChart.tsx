'use client'
import { useEffect, useRef } from 'react'
import { ColorType, CrosshairMode, LineStyle, createChart } from 'lightweight-charts'

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
  showBollinger?: boolean
  showPrediction?: boolean
  chartStyle?: 'line' | 'candles'
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

export function CandlestickChart({
  candles,
  bollinger,
  predicted = [],
  density = [],
  sentiment = [],
  newsEvents = [],
  showSentiment = true,
  showDensity = true,
  showBollinger = false,
  showPrediction = false,
  chartStyle = 'line',
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

    // Density overlay (orange, own scale)
    if (showDensity && density.length) {
      const maxDensity = Math.max(...density.map(point => finiteNumber(point.scaled ?? point.value, 0)), 0)
      const densityData = normalizeSeries(density, point => ({ value: percentile(finiteNumber(point.scaled ?? point.value, 0), maxDensity) }))
        .filter(point => Number.isFinite(point.value))
      if (densityData.length) {
        chart.addLineSeries({
          color: '#FF9800',
          lineWidth: 2,
          priceScaleId: 'density',
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        }).setData(densityData as any)
        chart.priceScale('density').applyOptions({ scaleMargins: { top: 0.72, bottom: 0 } })
      }
    }

    // Sentiment overlay (green, own scale)
    if (showSentiment && sentiment.length) {
      const sentimentData = normalizeSeries(sentiment, point => ({ value: Math.max(0, Math.min(100, (finiteNumber(point.value, 0) + 1) * 50)) }))
        .filter(point => Number.isFinite(point.value))
      if (sentimentData.length) {
        chart.addLineSeries({
          color: '#4CAF50',
          lineWidth: 2,
          priceScaleId: 'sentiment',
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        }).setData(sentimentData as any)
        chart.priceScale('sentiment').applyOptions({ scaleMargins: { top: 0.05, bottom: 0.72 } })
      }
    }

    // News event markers
    if (newsEvents.length) {
      priceSeries.setMarkers(newsEvents.slice(-40).map(event => ({
        time: normalizeTime(event.time) as any,
        position: event.position === 'aboveBar' ? 'aboveBar' : 'belowBar',
        color: event.color || (event.position === 'aboveBar' ? '#ef4444' : '#10b981'),
        shape: event.shape === 'arrowDown' ? 'arrowDown' : 'arrowUp',
        text: event.text || (event.source || 'News').slice(0, 5),
      })))
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
  }, [candles, bollinger, predicted, density, sentiment, newsEvents, showDensity, showSentiment, showBollinger, showPrediction, chartStyle])

  return <div ref={containerRef} className="w-full h-full min-h-[340px]" />
}