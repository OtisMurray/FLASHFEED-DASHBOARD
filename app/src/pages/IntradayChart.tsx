'use client'
import useSWR from 'swr'
import { CandlestickChart } from './CandlestickChart'

const fetcher = (url: string) => fetch(url).then(r => r.json())

interface Props { ticker: string }

export function IntradayChart({ ticker }: Props) {
  const { data, isLoading } = useSWR(`/api/charts/${ticker}?range=1d&interval=5m`, fetcher, { refreshInterval: 60_000 })

  if (isLoading) {
    return <div className="w-full h-full flex items-center justify-center text-[10px] text-neutral">Loading chart</div>
  }

  if (!data?.candles?.length) {
    return <div className="w-full h-full flex items-center justify-center text-[10px] text-neutral">No chart data</div>
  }

  return (
    <CandlestickChart
      candles={data.candles}
      bollinger={data.bollinger}
      predicted={[]}
      density={data.social_density}
      sentiment={data.sentiment}
      newsEvents={data.news_events}
    />
  )
}
