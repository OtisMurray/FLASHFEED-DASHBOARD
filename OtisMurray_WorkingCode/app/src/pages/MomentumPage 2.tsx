'use client'
import useSWR from 'swr'
import { useState } from 'react'
import { MomentumCard } from './MomentumCard'
import { TrendingBar } from './TrendingBar'
import { MarketBanner } from './MarketBanner'
import type { MomentumRow } from '@/lib/types'

const fetcher = (url: string) => fetch(url).then(r => r.json())

export function MomentumPage() {
  const [minVol, setMinVol] = useState('0')
  const [minRelVol, setMinRelVol] = useState('0')
  const [topN, setTopN] = useState('30')
  const [maxPrice, setMaxPrice] = useState('')
  const [sentFilter, setSentFilter] = useState('')
  const [socialWindow, setSocialWindow] = useState('1440')

  const params = new URLSearchParams({
    min_news: minVol,
    min_rel_vol: minRelVol,
    limit: topN,
    order: 'absolute_momentum',
    window_minutes: socialWindow,
    ...(maxPrice && { max_price: maxPrice }),
    ...(sentFilter && { sentiment: sentFilter }),
  })
  const { data, isLoading, mutate } = useSWR(`/api/momentum?${params}`, fetcher, { refreshInterval: 30_000 })
  const { data: trending } = useSWR(`/api/momentum/trending?window_minutes=${socialWindow}`, fetcher, { refreshInterval: 60_000 })
  const { data: tradeWatch } = useSWR(`/api/trade-watch?limit=5&window_minutes=${socialWindow}`, fetcher, { refreshInterval: 30_000 })
  const { data: predictionSignals } = useSWR('/api/prediction/signals?limit=80', fetcher, { refreshInterval: 60_000 })
  const { data: marketStatus } = useSWR('/api/market/status', fetcher, { refreshInterval: 60_000 })

  const tickers: MomentumRow[] = (data?.tickers ?? []).filter((row: MomentumRow) => {
    const exchange = String((row as any).exchange || '').toUpperCase()
    return ['NASDAQ', 'NYSE', 'AMEX'].includes(exchange) && !String(row.ticker || '').includes('.')
  })
  const tradeWatchRows: MomentumRow[] = tradeWatch?.tickers ?? []

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div>
          <h1 className="text-white font-semibold text-lg">Momentum</h1>
          <p className="text-xs text-neutral mt-0.5">Positive price movers enriched with structured news, public news, and ticker-specific social.</p>
        </div>
        <span className="text-neutral text-sm">{tickers.length} tickers</span>
      </div>

      {/* Market status banner */}
      <MarketBanner status={marketStatus} />

      {/* Filter toolbar */}
      <div className="flex items-center gap-2 mb-4 flex-wrap bg-surface border border-border rounded-lg px-3 py-2">
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-neutral uppercase">Min News</span>
          <select value={minVol} onChange={e => setMinVol(e.target.value)}
            className="bg-bg border border-border text-xs text-neutral rounded px-1.5 py-1">
            <option value="0">Any</option>
            <option value="1">1</option>
            <option value="3">3</option>
            <option value="5">5</option>
            <option value="10">10</option>
          </select>
        </div>
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-neutral uppercase">Rel Vol</span>
          <select value={minRelVol} onChange={e => setMinRelVol(e.target.value)}
            className="bg-bg border border-border text-xs text-neutral rounded px-1.5 py-1">
            <option value="0">Any</option>
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
            <option value="30">30</option>
            <option value="50">50</option>
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
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-neutral uppercase">Social Window</span>
          <select value={socialWindow} onChange={e => setSocialWindow(e.target.value)}
            className="bg-bg border border-border text-xs text-neutral rounded px-1.5 py-1">
            <option value="5">5m</option>
            <option value="15">15m</option>
            <option value="30">30m</option>
            <option value="60">1h</option>
            <option value="120">2h</option>
            <option value="1440">24h</option>
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

      <TradeWatchPanel rows={tradeWatchRows} />

      <PredictionPerformancePanel data={predictionSignals} />

      {/* Momentum cards */}
      {isLoading ? (
        <div className="text-neutral text-sm animate-pulse p-4">Loading momentum data...</div>
      ) : tickers.length === 0 ? (
        <div className="text-center py-12 text-neutral">
          <div className="text-3xl mb-2">📈</div>
          <div className="text-sm">No positive momentum movers match current filters</div>
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

function PredictionPerformancePanel({ data }: { data: any }) {
  const summary = Array.isArray(data?.summary) ? data.summary : []
  const total = summary.reduce((sum: number, row: any) => sum + Number(row.count || 0), 0)
  if (!total) return null

  const complete = summary.find((row: any) => row.status === 'complete') || {}
  const partial = summary.find((row: any) => row.status === 'partially_labeled') || {}
  const pending = summary.find((row: any) => row.status === 'pending') || {}
  const accuracy = complete.directional_accuracy_5m ?? partial.directional_accuracy_5m
  const model = data?.model

  return (
    <section className="mb-4 border border-border rounded-lg bg-surface px-3 py-2">
      <div className="flex flex-wrap items-center gap-3">
        <div className="mr-auto">
          <h2 className="text-white text-sm font-semibold">Prediction Labels</h2>
          <p className="text-[11px] text-neutral">Trade Watch signals are being labeled against later quote moves.</p>
        </div>
        <MiniMetric label="Signals" value={String(total)} />
        <MiniMetric label="Pending" value={String(pending.count || 0)} />
        <MiniMetric label="Labeled" value={String(Number(complete.count || 0) + Number(partial.count || 0))} />
        <MiniMetric label="5m Acc." value={accuracy == null ? '--' : `${(Number(accuracy) * 100).toFixed(0)}%`} />
        <MiniMetric label="Avg 5m" value={complete.avg_return_5m == null ? '--' : `${Number(complete.avg_return_5m).toFixed(2)}%`} />
        <MiniMetric label="Model" value={model?.status === 'trained' ? 'trained' : `${model?.samples ?? 0}/20`} />
      </div>
    </section>
  )
}

function MiniMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-[76px] text-right">
      <div className="font-mono text-sm text-white">{value}</div>
      <div className="text-[9px] text-neutral uppercase">{label}</div>
    </div>
  )
}

function TradeWatchPanel({ rows }: { rows: MomentumRow[] }) {
  if (!rows.length) return null

  return (
    <section className="mb-4 border border-border rounded-lg bg-surface overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <div>
          <h2 className="text-white text-sm font-semibold">Trade Watch</h2>
          <p className="text-[11px] text-neutral">Ranked movers with price, news, and social support.</p>
        </div>
        <span className="text-[11px] text-neutral uppercase">Research only</span>
      </div>
      <div className="grid gap-px bg-border md:grid-cols-5">
        {rows.slice(0, 5).map(row => {
          const watch = row.trade_watch
          const change = Number(row.change_pct || 0)
          const sentiment = Number(row.sentiment || 0)
          const score = Number(watch?.confidence || 0)
          const decision = watch?.decision || 'Monitor'
          const evidence = Number(row.article_count || 0) + Number(row.message_count || 0)
          const primaryReasons = watch?.reasons?.slice(0, 2) ?? []
          const primaryRisks = watch?.risks?.slice(0, 1) ?? []

          return (
            <div key={row.ticker} className="bg-surface px-3 py-2 min-w-0">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-mono text-accent font-bold text-base leading-tight">{row.ticker}</div>
                  <div className="text-[10px] text-neutral truncate">{row.company || row.exchange || 'Listed equity'}</div>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-white font-mono text-sm">{score.toFixed(0)}</div>
                  <div className="text-[9px] text-neutral uppercase">score</div>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-2 mt-2 text-[11px]">
                <div>
                  <div className={change >= 0 ? 'text-emerald-400 font-mono' : 'text-red-400 font-mono'}>
                    {change >= 0 ? '+' : ''}{change.toFixed(2)}%
                  </div>
                  <div className="text-neutral uppercase text-[9px]">change</div>
                </div>
                <div>
                  <div className={sentiment >= 0 ? 'text-emerald-300 font-mono' : 'text-red-300 font-mono'}>
                    {sentiment >= 0 ? '+' : ''}{sentiment.toFixed(2)}
                  </div>
                  <div className="text-neutral uppercase text-[9px]">sent</div>
                </div>
                <div>
                  <div className="text-white font-mono">{evidence}</div>
                  <div className="text-neutral uppercase text-[9px]">evidence</div>
                </div>
              </div>
              <div className="mt-2 text-[11px] text-white font-medium truncate">{decision}</div>
              <div className="mt-1 min-h-[32px] text-[10px] text-neutral leading-snug">
                {[...primaryReasons, ...primaryRisks].join(' | ') || 'waiting for confirmation'}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}
