'use client'
import { useEffect, useRef } from 'react'

interface Props { data: Array<{ time: string; value: number }> }

export function SentimentChart({ data }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<any>(null)

  useEffect(() => {
    if (!containerRef.current || data.length === 0) return

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

      const series = chart.addHistogramSeries({ color: '#334155' })
      series.setData(data.map(d => ({
        time: d.time,
        value: d.value,
        color: d.value >= 0.2 ? 'rgba(16, 185, 129, 0.7)' :
               d.value <= -0.2 ? 'rgba(239, 68, 68, 0.7)' :
               'rgba(148, 163, 184, 0.5)',
      })) as any)

      // Zero line
      const zeroLine = chart.addLineSeries({ color: 'rgba(148, 163, 184, 0.3)', lineWidth: 1, lineStyle: 2 })
      zeroLine.setData(data.map(d => ({ time: d.time, value: 0 })) as any)

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
