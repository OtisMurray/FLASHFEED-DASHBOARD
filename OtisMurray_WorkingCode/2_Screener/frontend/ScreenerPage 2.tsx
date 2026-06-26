'use client'
import useSWR from 'swr'
import { useState, useMemo } from 'react'
import { ScreenerTable } from './ScreenerTable'
import { ScreenerFilterPanel } from './ScreenerFilterPanel'
import { SignalBar } from './SignalBar'
import type { ScreenerRow } from '@/lib/types'

const fetcher = (url: string) => fetch(url).then(r => r.json())

export type ViewMode = 'overview' | 'valuation' | 'technical' | 'sentiment'

export function ScreenerPage() {
  const { data, isLoading, mutate } = useSWR('/api/screener', fetcher, { refreshInterval: 30_000 })
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [showFilters, setShowFilters] = useState(false)
  const [filterTab, setFilterTab] = useState<'descriptive' | 'fundamental' | 'technical' | 'sentiment' | 'all'>('all')
  const [viewMode, setViewMode] = useState<ViewMode>('overview')
  const [signal, setSignal] = useState('')
  const [orderBy, setOrderBy] = useState('ticker')
  const [orderDir, setOrderDir] = useState<'asc' | 'desc'>('asc')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)
  const pageSize = 20

  const tickers: ScreenerRow[] = data?.tickers ?? []

  const filtered = useMemo(() => {
    let rows = [...tickers]

    // Search
    if (search) {
      const q = search.toLowerCase()
      rows = rows.filter(t => t.ticker.toLowerCase().includes(q) || (t.company ?? '').toLowerCase().includes(q))
    }

    // Filters
    if (filters.sector) rows = rows.filter(t => t.sector === filters.sector)
    if (filters.industry) rows = rows.filter(t => t.industry === filters.industry)
    if (filters.market_cap) {
      const mc = filters.market_cap
      rows = rows.filter(t => {
        const cap = (t as any).market_cap ?? 0
        if (mc === 'micro') return cap < 300e6
        if (mc === 'small') return cap >= 300e6 && cap < 2e9
        if (mc === 'mid') return cap >= 2e9 && cap < 10e9
        if (mc === 'large') return cap >= 10e9 && cap < 200e9
        if (mc === 'mega') return cap >= 200e9
        return true
      })
    }
    if (filters.price_change) {
      const pc = filters.price_change
      rows = rows.filter(t => {
        const change = t.change_pct ?? 0
        if (pc === 'up') return change > 0
        if (pc === 'down') return change < 0
        if (pc === 'up2') return change >= 2
        if (pc === 'up5') return change >= 5
        if (pc === 'up10') return change >= 10
        if (pc === 'down2') return change <= -2
        if (pc === 'down5') return change <= -5
        return true
      })
    }
    if (filters.avg_volume) {
      const av = parseInt(filters.avg_volume)
      rows = rows.filter(t => (t.volume ?? 0) >= av)
    }
    if (filters.price_range) {
      const pr = filters.price_range
      rows = rows.filter(t => {
        const p = t.price ?? 0
        if (pr === 'under1') return p < 1
        if (pr === 'under5') return p < 5
        if (pr === 'under10') return p < 10
        if (pr === 'under20') return p < 20
        if (pr === 'over5') return p >= 5
        if (pr === 'over10') return p >= 10
        if (pr === 'over20') return p >= 20
        if (pr === 'over50') return p >= 50
        if (pr === 'over100') return p >= 100
        return true
      })
    }
    if (filters.social_sentiment) {
      const ss = filters.social_sentiment
      rows = rows.filter(t => {
        if (ss === 'bullish') return t.social_sentiment >= 0.2
        if (ss === 'bearish') return t.social_sentiment <= -0.2
        if (ss === 'neutral') return t.social_sentiment > -0.2 && t.social_sentiment < 0.2
        return true
      })
    }
    if (filters.news_sentiment) {
      const ns = filters.news_sentiment
      rows = rows.filter(t => {
        if (ns === 'bullish') return t.structured_sentiment >= 0.2
        if (ns === 'bearish') return t.structured_sentiment <= -0.2
        if (ns === 'neutral') return t.structured_sentiment > -0.2 && t.structured_sentiment < 0.2
        return true
      })
    }
    if (filters.min_posts) {
      const mp = parseInt(filters.min_posts)
      rows = rows.filter(t => t.message_count >= mp)
    }

    // Signal
    if (signal === 'social_bullish') rows = rows.filter(t => t.social_sentiment >= 0.3)
    if (signal === 'social_bearish') rows = rows.filter(t => t.social_sentiment <= -0.3)
    if (signal === 'unusual_volume') rows = rows.filter(t => (t.volume ?? 0) > ((t as any).avg_volume ?? 1) * 2)

    // Sort
    rows.sort((a, b) => {
      const av = (a as any)[orderBy] ?? 0
      const bv = (b as any)[orderBy] ?? 0
      if (typeof av === 'string') return orderDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av)
      return orderDir === 'desc' ? bv - av : av - bv
    })

    return rows
  }, [tickers, filters, signal, orderBy, orderDir, search])

  const totalPages = Math.ceil(filtered.length / pageSize)
  const paged = filtered.slice(page * pageSize, (page + 1) * pageSize)

  const setFilter = (k: string, v: string) => {
    setPage(0)
    if (v) setFilters(f => ({ ...f, [k]: v }))
    else setFilters(f => { const n = { ...f }; delete n[k]; return n })
  }

  const resetFilters = () => { setFilters({}); setSignal(''); setSearch(''); setPage(0) }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h1 className="text-white font-semibold text-lg">Market Screener</h1>
        <span className="text-neutral text-sm">{filtered.length} tickers</span>
      </div>

      {/* Signal bar */}
      <SignalBar
        signal={signal} setSignal={setSignal}
        orderBy={orderBy} setOrderBy={setOrderBy}
        orderDir={orderDir} setOrderDir={setOrderDir}
        search={search} setSearch={setSearch}
        onRefresh={() => mutate()}
      />

      {/* Filter toggle + active pills */}
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        <button
          onClick={() => setShowFilters(s => !s)}
          className={`text-xs px-3 py-1.5 rounded border transition-colors ${
            showFilters ? 'bg-accent/10 border-accent/40 text-accent' : 'border-border text-neutral hover:text-white hover:border-accent'
          }`}
        >
          {showFilters ? '▾ Filters' : '▸ Filters'}
        </button>
        {Object.entries(filters).map(([k, v]) => (
          <span key={k} className="flex items-center gap-1 text-[11px] bg-accent/10 border border-accent/30 text-accent px-2 py-0.5 rounded">
            {k}: {v}
            <button onClick={() => setFilter(k, '')} className="hover:text-white ml-0.5">&times;</button>
          </span>
        ))}
        {Object.keys(filters).length > 0 && (
          <button onClick={resetFilters} className="text-[11px] text-red-400 hover:text-red-300">Clear All</button>
        )}
      </div>

      {/* Filter panel */}
      {showFilters && (
        <ScreenerFilterPanel
          filters={filters}
          setFilter={setFilter}
          activeTab={filterTab}
          setActiveTab={setFilterTab}
        />
      )}

      {/* View mode tabs */}
      <div className="flex items-center gap-1 mb-3 border-b border-border">
        {(['overview', 'valuation', 'technical', 'sentiment'] as ViewMode[]).map(mode => (
          <button
            key={mode}
            onClick={() => setViewMode(mode)}
            className={`px-3 py-1.5 text-xs capitalize transition-colors border-b-2 -mb-px ${
              viewMode === mode
                ? 'text-white border-accent'
                : 'text-neutral border-transparent hover:text-white'
            }`}
          >
            {mode}
          </button>
        ))}
      </div>

      {/* Table */}
      <ScreenerTable rows={paged} isLoading={isLoading} viewMode={viewMode} />

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-3">
          <span className="text-xs text-neutral">
            {page * pageSize + 1}–{Math.min((page + 1) * pageSize, filtered.length)} of {filtered.length}
          </span>
          <div className="flex gap-1">
            <button disabled={page === 0} onClick={() => setPage(p => p - 1)}
              className="px-2 py-1 text-xs bg-surface border border-border rounded text-neutral disabled:opacity-40 hover:text-white">Prev</button>
            {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
              let pn: number
              if (totalPages <= 5) pn = i
              else if (page < 3) pn = i
              else if (page >= totalPages - 3) pn = totalPages - 5 + i
              else pn = page - 2 + i
              return (
                <button key={pn} onClick={() => setPage(pn)}
                  className={`w-6 h-6 text-xs rounded ${page === pn ? 'bg-accent text-white' : 'bg-surface border border-border text-neutral hover:text-white'}`}>
                  {pn + 1}
                </button>
              )
            })}
            <button disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)}
              className="px-2 py-1 text-xs bg-surface border border-border rounded text-neutral disabled:opacity-40 hover:text-white">Next</button>
          </div>
        </div>
      )}
    </div>
  )
}
