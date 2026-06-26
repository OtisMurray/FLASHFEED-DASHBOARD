'use client'
import useSWR from 'swr'
import { CandlestickChart } from './CandlestickChart'  // Aman's chart — used for every price chart

const fetcher = (url: string) => fetch(url).then(r => r.json())

interface Props { ticker: string }

// Compact inline price chart for the Screener / Momentum cards. Uses the same
// Aman CandlestickChart component as the Charts tab (crosshair + Bollinger), at a
// fixed 5-minute timeframe served by /api/charts/:ticker?tf=5m.
export function IntradayChart({ ticker }: Props) {
  const { data, isLoading } = useSWR(`/api/charts/${ticker}?tf=5m`, fetcher, { refreshInterval: 60_000 })

  if (isLoading) {
    return <div className="w-full h-full flex items-center justify-center text-[10px] text-neutral">Loading chart</div>
  }
  if (!data?.candles?.length) {
    return <div className="w-full h-full flex items-center justify-center text-[10px] text-neutral">No chart data</div>
  }
  return <CandlestickChart candles={data.candles} bollinger={data.bollinger} />
}
