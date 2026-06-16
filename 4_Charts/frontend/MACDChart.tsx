'use client'
import { useEffect, useRef } from 'react'

interface MACDData {
  macd: Array<{ time: string; value: number }>
  signal: Array<{ time: string; value: number }>
  histogram: Array<{ time: string; value: number }>
}

interface Props { data?: MACDData }

export function MACDChart({ data }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<any>(null)

  useEffect(() => {
    if (!containerRef.current || !data || data.macd.length === 0) return

    let disposed = false
    import('lightweight-charts').then(({ createChart, ColorType }) => {
      if (disposed || !containerRef.current) return

      if (chartRef.current) { chartRef.current.remove(); chartRef.current = null }

      const chart = createChart(containerRef.current, {
        width: containerRef.current.clientWidth,
        height: containerRef.current.clientHeight,
        layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#94a3b8', fontSize: 11 },
        grid: { vertLines: { color: '#1e293b' }, horzLines: { color: '#1e293b' } },
        rightPriceScale: { borderColor: '#334155' },
        timeScale: { borderColor: '#334155', visible: false },
      })
      chartRef.current = chart

      // MACD line
      const macdSeries = chart.addLineSeries({ color: '#0ea5e9', lineWidth: 2 })
      macdSeries.setData(data.macd as any)

      // Signal line
      const signalSeries = chart.addLineSeries({ color: '#f97316', lineWidth: 2 })
      signalSeries.setData(data.signal as any)

      // Histogram
      const histSeries = chart.addHistogramSeries({
        color: '#334155',
      })
      histSeries.setData(data.histogram.map(h => ({
        time: h.time,
        value: h.value,
        color: h.value >= 0 ? 'rgba(16, 185, 129, 0.5)' : 'rgba(239, 68, 68, 0.5)',
      })) as any)

      chart.timeScale().fitContent()

      const ro = new ResizeObserver(entries => {
        for (const entry of entries) chart.applyOptions({ width: entry.contentRect.width })
      })
      ro.observe(containerRef.current)
      return () => ro.disconnect()
    })

    return () => { disposed = true; if (chartRef.current) { chartRef.current.remove(); chartRef.current = null } }
  }, [data])

  return <div ref={containerRef} className="w-full h-full" />
}
