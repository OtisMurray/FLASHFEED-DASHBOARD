'use client'
import { useEffect, useRef } from 'react'

interface Props { data: Array<{ time: string; value: number }> }

export function RSIChart({ data }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<any>(null)

  useEffect(() => {
    if (!containerRef.current || data.length === 0) return

    let disposed = false
    import('lightweight-charts').then(({ createChart, ColorType, LineSeries }) => {
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

      const series = chart.addSeries(LineSeries, { color: '#8b5cf6', lineWidth: 2 })
      series.setData(data as any)

      // Overbought/oversold lines
      const ob = chart.addSeries(LineSeries, { color: 'rgba(239, 68, 68, 0.4)', lineWidth: 1, lineStyle: 2 })
      ob.setData(data.map(d => ({ time: d.time, value: 70 })) as any)
      const os = chart.addSeries(LineSeries, { color: 'rgba(16, 185, 129, 0.4)', lineWidth: 1, lineStyle: 2 })
      os.setData(data.map(d => ({ time: d.time, value: 30 })) as any)

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
