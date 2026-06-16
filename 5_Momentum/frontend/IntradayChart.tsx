'use client'
import { useEffect, useRef } from 'react'
import useSWR from 'swr'

const fetcher = (url: string) => fetch(url).then(r => r.json())

interface Props { ticker: string }

export function IntradayChart({ ticker }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<any>(null)
  const { data } = useSWR(`/api/charts/${ticker}?range=1d&interval=5m`, fetcher)

  useEffect(() => {
    if (!containerRef.current || !data?.candles?.length) return

    let disposed = false
    import('lightweight-charts').then(({ createChart, ColorType }) => {
      if (disposed || !containerRef.current) return

      if (chartRef.current) { chartRef.current.remove(); chartRef.current = null }

      const chart = createChart(containerRef.current, {
        width: containerRef.current.clientWidth,
        height: containerRef.current.clientHeight,
        layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#94a3b8', fontSize: 10 },
        grid: { vertLines: { color: '#1e293b' }, horzLines: { color: '#1e293b' } },
        rightPriceScale: { borderColor: '#334155', scaleMargins: { top: 0.1, bottom: 0.2 } },
        timeScale: { borderColor: '#334155', timeVisible: true, secondsVisible: false },
        handleScroll: false,
        handleScale: false,
      })
      chartRef.current = chart

      // Area chart for intraday
      const areaSeries = chart.addAreaSeries({
        topColor: 'rgba(14, 165, 233, 0.3)',
        bottomColor: 'rgba(14, 165, 233, 0.0)',
        lineColor: '#0ea5e9',
        lineWidth: 2,
      })
      areaSeries.setData(data.candles.map((c: any) => ({ time: c.time, value: c.close })))

      // Volume histogram
      const volSeries = chart.addHistogramSeries({
        color: 'rgba(148, 163, 184, 0.2)',
        priceFormat: { type: 'volume' },
        priceScaleId: '',
      })
      volSeries.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } })
      volSeries.setData(data.candles.map((c: any) => ({
        time: c.time,
        value: c.volume ?? 0,
        color: c.close >= c.open ? 'rgba(16, 185, 129, 0.3)' : 'rgba(239, 68, 68, 0.3)',
      })))

      chart.timeScale().fitContent()

      const ro = new ResizeObserver(entries => {
        for (const entry of entries) chart.applyOptions({ width: entry.contentRect.width })
      })
      ro.observe(containerRef.current)
      return () => ro.disconnect()
    })

    return () => { disposed = true; if (chartRef.current) { chartRef.current.remove(); chartRef.current = null } }
  }, [data])

  if (!data?.candles?.length) {
    return <div className="w-full h-full flex items-center justify-center text-[10px] text-neutral">No chart data</div>
  }

  return <div ref={containerRef} className="w-full h-full" />
}
