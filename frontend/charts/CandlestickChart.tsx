'use client'
import { useEffect, useRef } from 'react'

interface Candle { time: string; open: number; high: number; low: number; close: number }
interface BollingerData { upper: Array<{ time: string; value: number }>; lower: Array<{ time: string; value: number }> }

interface Props {
  candles: Candle[]
  bollinger?: BollingerData
}

export function CandlestickChart({ candles, bollinger }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<any>(null)

  useEffect(() => {
    if (!containerRef.current || candles.length === 0) return

    let disposed = false
    import('lightweight-charts').then(({ createChart, ColorType, CrosshairMode }) => {
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

      const candleSeries = chart.addCandlestickSeries({
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
        const upperSeries = chart.addLineSeries({
          color: 'rgba(139, 92, 246, 0.5)',
          lineWidth: 1,
          lineStyle: 2,
        })
        upperSeries.setData(bollinger.upper as any)

        const lowerSeries = chart.addLineSeries({
          color: 'rgba(139, 92, 246, 0.5)',
          lineWidth: 1,
          lineStyle: 2,
        })
        lowerSeries.setData(bollinger.lower as any)
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
  }, [candles, bollinger])

  return <div ref={containerRef} className="w-full h-full" />
}
