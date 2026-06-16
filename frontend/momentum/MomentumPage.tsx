'use client'
import useSWR from 'swr'
import { useState } from 'react'
import { MomentumCard } from './MomentumCard'
import { TrendingBar } from './TrendingBar'
import { MarketBanner } from './MarketBanner'
import type { MomentumRow } from '@/lib/types'

const fetcher = (url: string) => fetch(url).then(r => r.json())

export function MomentumPage() {
  const [minVol, setMinVol] = useState('100000')
  const [minRelVol, setMinRelVol] = useState('1')
  const [topN, setTopN] = useState('10')
  const [maxPrice, setMaxPrice] = useState('')
  const [sentFilter, setSentFilter] = useState('')

  const params = new URLSearchParams({
    min_volume: minVol,
    min_rel_vol: minRelVol,
    limit: topN,
    ...(maxPrice && { max_price: maxPrice }),
    ...(sentFilter && { sentiment: sentFilter }),
  })
  const { data, isLoading, mutate } = useSWR(`/api/momentum?${params}`, fetcher, { refreshInterval: 30_000 })
  const { data: trending } = useSWR('/api/momentum/trending', fetcher, { refreshInterval: 60_000 })
  const { data: marketStatus } = useSWR('/api/market/status', fetcher, { refreshInterval: 60_000 })

  const tickers: MomentumRow[] = data?.tickers ?? []

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h1 className="text-white font-semibold text-lg">Momentum Scanner</h1>
        <span className="text-neutral text-sm">{tickers.length} tickers</span>
      </div>

      {/* Market status banner */}
      <MarketBanner status={marketStatus} />

      {/* Filter toolbar */}
      <div className="flex items-center gap-2 mb-4 flex-wrap bg-surface border border-border rounded-lg px-3 py-2">
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-neutral uppercase">Min Vol</span>
          <select value={minVol} onChange={e => setMinVol(e.target.value)}
            className="bg-bg border border-border text-xs text-neutral rounded px-1.5 py-1">
            <option value="50000">50K</option>
            <option value="100000">100K</option>
            <option value="500000">500K</option>
            <option value="1000000">1M</option>
          </select>
        </div>
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-neutral uppercase">Rel Vol</span>
          <select value={minRelVol} onChange={e => setMinRelVol(e.target.value)}
            className="bg-bg border border-border text-xs text-neutral rounded px-1.5 py-1">
            <option value="1">1x</option>
            <option value="2">2x</option>
            <option value="3">3x</option>
            <option value="5">5x</option>
            <option value="10">10x</option>
            <option value="20">20x</option>
          </select>
        </div>
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-neutral uppercase">Top</span>
          <select value={topN} onChange={e => setTopN(e.target.value)}
            className="bg-bg border border-border text-xs text-neutral rounded px-1.5 py-1">
            <option value="3">3</option>
            <option value="5">5</option>
            <option value="10">10</option>
            <option value="20">20</option>
          </select>
        </div>
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-neutral uppercase">Max $</span>
          <select value={maxPrice} onChange={e => setMaxPrice(e.target.value)}
            className="bg-bg border border-border text-xs text-neutral rounded px-1.5 py-1">
            <option value="">Any</option>
            <option value="5">Under $5</option>
            <option value="10">Under $10</option>
            <option value="20">Under $20</option>
          </select>
        </div>
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-neutral uppercase">Sent</span>
          <select value={sentFilter} onChange={e => setSentFilter(e.target.value)}
            className="bg-bg border border-border text-xs text-neutral rounded px-1.5 py-1">
            <option value="">All</option>
            <option value="bullish">Bullish</option>
            <option value="bearish">Bearish</option>
          </select>
        </div>
        <div className="flex-1" />
        <button onClick={() => mutate()}
          className="px-2 py-1 text-xs bg-bg border border-border text-neutral rounded hover:text-white hover:border-accent transition-colors">
          ↻ Refresh
        </button>
      </div>

      {/* Trending bar */}
      <TrendingBar tickers={trending?.tickers ?? []} />

      {/* Momentum cards */}
      {isLoading ? (
        <div className="text-neutral text-sm animate-pulse p-4">Loading momentum data...</div>
      ) : tickers.length === 0 ? (
        <div className="text-center py-12 text-neutral">
          <div className="text-3xl mb-2">📈</div>
          <div className="text-sm">No momentum tickers match current filters</div>
        </div>
      ) : (
        <div className="space-y-2">
          {tickers.map((t, i) => (
            <MomentumCard key={t.ticker} row={t} rank={i + 1} />
          ))}
        </div>
      )}
    </div>
  )
}
