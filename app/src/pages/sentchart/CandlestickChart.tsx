'use client'
import { useEffect, useRef } from 'react'

interface Candle { time: string; open: number; high: number; low: number; close: number }
interface BollingerData { upper: Array<{ time: string; value: number }>; lower: Array<{ time: string; value: number }> }
interface LinePoint { time: number; value: number }
// Strategy indicator marker: an entry (up-arrow) or exit (down-arrow) at a given
// candle time. `price` is informational; the arrow rides above/below the bar.
export interface StrategyMarker { time: number; type: 'entry' | 'exit'; price: number }

interface Props {
  candles: Candle[]
  bollinger?: BollingerData
  // Optional overlays on independent secondary scales (their units differ from
  // price): smoothed message density (msgs/min) and sentiment score (−1..+1).
  // Undefined = not shown. Mirrors the research views' orange/green styling.
  densityOverlay?: LinePoint[]
  sentimentOverlay?: LinePoint[]
  // Strategy entry/exit arrows (lightweight-charts v5 series markers). Undefined
  // = indicator off. Up-arrow (green) at entries, down-arrow (red) at exits.
  strategyMarkers?: StrategyMarker[]
}

export function CandlestickChart({ candles, bollinger, densityOverlay, sentimentOverlay, strategyMarkers }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<any>(null)

  useEffect(() => {
    if (!containerRef.current || candles.length === 0) return

    let disposed = false
    import('lightweight-charts').then(({ createChart, ColorType, CrosshairMode, CandlestickSeries, LineSeries, createSeriesMarkers }) => {
      if (disposed || !containerRef.current) return

      // Clear previous chart
      if (chartRef.current) {
        chartRef.current.remove()
        chartRef.current = null
      }

      const chart = createChart(containerRef.current, {
        width: containerRef.current.clientWidth,
        height: containerRef.current.clientHeight,
        layout: {
          background: { type: ColorType.Solid, color: 'transparent' },
          textColor: '#94a3b8',
          fontSize: 11,
        },
        grid: {
          vertLines: { color: '#1e293b' },
          horzLines: { color: '#1e293b' },
        },
        crosshair: { mode: CrosshairMode.Normal },
        rightPriceScale: { borderColor: '#334155' },
        timeScale: { borderColor: '#334155', timeVisible: true },
      })
      chartRef.current = chart

      const candleSeries = chart.addSeries(CandlestickSeries, {
        upColor: '#10b981',
        downColor: '#ef4444',
        borderUpColor: '#10b981',
        borderDownColor: '#ef4444',
        wickUpColor: '#10b981',
        wickDownColor: '#ef4444',
      })
      candleSeries.setData(candles as any)

      // Bollinger bands
      if (bollinger) {
        const upperSeries = chart.addSeries(LineSeries, {
          color: 'rgba(139, 92, 246, 0.5)',
          lineWidth: 1,
          lineStyle: 2,
        })
        upperSeries.setData(bollinger.upper as any)

        const lowerSeries = chart.addSeries(LineSeries, {
          color: 'rgba(139, 92, 246, 0.5)',
          lineWidth: 1,
          lineStyle: 2,
        })
        lowerSeries.setData(bollinger.lower as any)
      }

      // Density overlay (msgs/min, smoothed) — orange, lower band, own scale so
      // its magnitude never distorts the price axis.
      if (densityOverlay && densityOverlay.length) {
        const dens = chart.addSeries(LineSeries, {
          color: '#FF9800', lineWidth: 2, priceScaleId: 'density',
          priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
        })
        dens.setData(densityOverlay as any)
        chart.priceScale('density').applyOptions({ scaleMargins: { top: 0.72, bottom: 0 } })
      }

      // Sentiment overlay (−1..+1, 15-min smoothed) — green, own scale.
      if (sentimentOverlay && sentimentOverlay.length) {
        const sent = chart.addSeries(LineSeries, {
          color: '#4CAF50', lineWidth: 2, priceScaleId: 'sentiment',
          priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
        })
        sent.setData(sentimentOverlay as any)
        chart.priceScale('sentiment').applyOptions({ scaleMargins: { top: 0.05, bottom: 0.72 } })
      }

      // Strategy indicator — v5 series markers (createSeriesMarkers primitive;
      // v4's series.setMarkers was removed). Entry = green up-arrow below the bar,
      // exit = red down-arrow above the bar. Markers must be in ascending time.
      if (strategyMarkers && strategyMarkers.length) {
        const mk = [...strategyMarkers]
          .sort((a, b) => a.time - b.time)
          .map(m => m.type === 'entry'
            ? { time: m.time as any, position: 'belowBar' as const, color: '#10b981', shape: 'arrowUp' as const }
            : { time: m.time as any, position: 'aboveBar' as const, color: '#ef4444', shape: 'arrowDown' as const })
        createSeriesMarkers(candleSeries, mk)
      }

      chart.timeScale().fitContent()

      // Resize observer
      const ro = new ResizeObserver(entries => {
        for (const entry of entries) {
          chart.applyOptions({ width: entry.contentRect.width })
        }
      })
      ro.observe(containerRef.current)

      return () => { ro.disconnect() }
    })

    return () => {
      disposed = true
      if (chartRef.current) {
        chartRef.current.remove()
        chartRef.current = null
      }
    }
  }, [candles, bollinger, densityOverlay, sentimentOverlay, strategyMarkers])

  return <div ref={containerRef} className="w-full h-full" />
}
