'use client'
import useSWR from 'swr'
import { useState, useEffect, useMemo } from 'react'
import { ScreenerTable } from '../ScreenerTable'
import { ScreenerFilterPanel } from '../ScreenerFilterPanel'
import { SignalBar } from '../SignalBar'
import type { ScreenerRow } from '@/lib/types'
import type { ViewMode } from '../ScreenerPage'

// Window Mirror — the main screener's table and filter row, driven by a single
// "Rolling Window" slider instead of the adaptive per-cap windows. The slider
// re-fetches /api/screener?window_minutes=X (debounced — density/sentiment are
// recomputed SERVER-side for the chosen window, unlike the Entry/Exit sliders'
// client-side math). Zero new backend code: window_minutes is a long-standing
// param of the screener endpoint. Fully separate from the Charts page's Window
// buttons (15m/30m/…) and the main screener's "Social Window" dropdown.

const fetcher = (url: string) => fetch(url).then(r => r.json())

type FilterTab = 'descriptive' | 'technical' | 'performance' | 'sentiment' | 'all'

const VIEW_MODES: ViewMode[] = ['overview', 'performance', 'technical', 'sentiment']
const PRESETS = [
  { key: 'top_gainers', label: 'Top Gainers' },
  { key: 'top_losers', label: 'Top Losers' },
  { key: 'unusual_volume', label: 'Unusual Volume' },
  { key: 'bullish_news', label: 'Bullish News' },
  { key: 'bearish_news', label: 'Bearish News' },
  { key: 'oversold', label: 'Oversold' },
  { key: 'overbought', label: 'Overbought' },
]

export function WindowMirrorPage() {
  const [windowMin, setWindowMin] = useState(60)
  const [debouncedWindow, setDebouncedWindow] = useState(60)
  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedWindow(windowMin), 400)
    return () => window.clearTimeout(t)
  }, [windowMin])

  const { data, isLoading, mutate } = useSWR(
    `/api/screener?limit=1500&window_minutes=${debouncedWindow}`,
    fetcher,
    { refreshInterval: 30_000, keepPreviousData: true }
  )
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [showFilters, setShowFilters] = useState(false)
  const [filterTab, setFilterTab] = useState<FilterTab>('all')
  const [viewMode, setViewMode] = useState<ViewMode>('overview')
  const [signal, setSignal] = useState('')
  const [orderBy, setOrderBy] = useState('ticker')
  const [orderDir, setOrderDir] = useState<'asc' | 'desc'>('asc')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)
  const pageSize = 50

  const tickers: ScreenerRow[] = Array.isArray(data) ? data : data?.tickers ?? data?.rows ?? []

  // Filtering/sorting mirrors ScreenerPage exactly so both pages screen the
  // same universe the same way
  const filtered = useMemo(() => {
    let rows = [...tickers].filter(t => (
      t.price != null &&
      t.change_pct != null &&
      ['NASDAQ', 'NYSE', 'AMEX'].includes(String((t as any).exchange || '').toUpperCase()) &&
      !String(t.ticker || '').includes('.')
    ))

    // Search
    if (search) {
      const q = search.toLowerCase()
      rows = rows.filter(t => t.ticker.toLowerCase().includes(q) || (t.company ?? '').toLowerCase().includes(q))
    }

    // Filters
    if (filters.sector) rows = rows.filter(t => t.sector === filters.sector)
    if (filters.exchange) rows = rows.filter(t => (t as any).exchange === filters.exchange)
    if (filters.index) rows = rows.filter(t => (t as any).index === filters.index)
    if (filters.country) rows = rows.filter(t => (t as any).country === filters.country)
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
        const change = t.change_pct
        if (change == null) return false
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
      rows = rows.filter(t => t.volume != null && t.volume >= av)
    }
    if (filters.rel_volume) {
      rows = rows.filter(t => {
        const rv = (t as any).rel_volume ?? 0
        if (filters.rel_volume === 'over1') return rv >= 1
        if (filters.rel_volume === 'over1_5') return rv >= 1.5
        if (filters.rel_volume === 'over2') return rv >= 2
        if (filters.rel_volume === 'over3') return rv >= 3
        return true
      })
    }
    if (filters.price_range) {
      const pr = filters.price_range
      rows = rows.filter(t => {
        const p = t.price
        if (p == null) return false
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
        const value = t.social_sentiment ?? 0
        if (ss === 'bullish') return value >= 0.2
        if (ss === 'bearish') return value <= -0.2
        if (ss === 'neutral') return value > -0.2 && value < 0.2
        return true
      })
    }
    if (filters.stocktwits_sentiment) {
      const ss = filters.stocktwits_sentiment
      rows = rows.filter(t => {
        const value = t.social_message_sentiment ?? 0
        if (ss === 'bullish') return value >= 0.2
        if (ss === 'bearish') return value <= -0.2
        if (ss === 'neutral') return value > -0.2 && value < 0.2
        return true
      })
    }
    if (filters.stocktwits_density) {
      rows = rows.filter(t => {
        const value = t.social_message_density ?? 0
        if (filters.stocktwits_density === 'over0_05') return value >= 0.05
        if (filters.stocktwits_density === 'over0_1') return value >= 0.1
        if (filters.stocktwits_density === 'over0_5') return value >= 0.5
        if (filters.stocktwits_density === 'over1') return value >= 1
        return true
      })
    }
    if (filters.news_sentiment) {
      const ns = filters.news_sentiment
      rows = rows.filter(t => {
        const value = t.structured_sentiment ?? 0
        if (ns === 'bullish') return value >= 0.2
        if (ns === 'bearish') return value <= -0.2
        if (ns === 'neutral') return value > -0.2 && value < 0.2
        return true
      })
    }
    if (filters.min_posts) {
      const mp = parseInt(filters.min_posts)
      rows = rows.filter(t => (t.message_count ?? 0) >= mp)
    }

    if (filters.pe_ratio) rows = rows.filter(t => {
      const pe = (t as any).pe_ratio ?? 0
      if (filters.pe_ratio === 'positive') return pe > 0
      if (filters.pe_ratio === 'low') return pe > 0 && pe < 15
      if (filters.pe_ratio === 'medium') return pe >= 15 && pe <= 25
      if (filters.pe_ratio === 'high') return pe > 25
      if (filters.pe_ratio === 'negative') return pe < 0
      return true
    })
    if (filters.forward_pe) rows = rows.filter(t => {
      const value = (t as any).forward_pe ?? 0
      if (filters.forward_pe === 'under10') return value < 10
      if (filters.forward_pe === 'under15') return value < 15
      if (filters.forward_pe === 'under25') return value < 25
      if (filters.forward_pe === 'over25') return value > 25
      return true
    })
    if (filters.peg) rows = rows.filter(t => {
      const value = (t as any).peg ?? 0
      if (filters.peg === 'under1') return value < 1
      if (filters.peg === 'under2') return value < 2
      if (filters.peg === 'over2') return value > 2
      return true
    })
    if (filters.dividend_yield) rows = rows.filter(t => {
      const value = (t as any).dividend_yield ?? 0
      if (filters.dividend_yield === 'positive') return value > 0
      if (filters.dividend_yield === 'over2') return value >= 2
      if (filters.dividend_yield === 'over4') return value >= 4
      return true
    })
    if (filters.analyst) rows = rows.filter(t => String((t as any).analyst || '') === filters.analyst)
    if (filters.rsi) rows = rows.filter(t => {
      const value = (t as any).rsi ?? 50
      if (filters.rsi === 'oversold') return value < 30
      if (filters.rsi === 'overbought') return value > 70
      if (filters.rsi === 'neutral') return value >= 30 && value <= 70
      return true
    })
    if (filters.sma20) rows = rows.filter(t => filters.sma20 === 'above' ? ((t as any).sma20 ?? 0) > 0 : ((t as any).sma20 ?? 0) < 0)
    for (const key of ['perf_week', 'perf_month', 'perf_year'] as const) {
      if (!filters[key]) continue
      rows = rows.filter(t => {
        const value = (t as any)[key] ?? 0
        if (filters[key] === 'up') return value > 0
        if (filters[key] === 'down') return value < 0
        if (filters[key] === 'up5') return value >= 5
        if (filters[key] === 'down5') return value <= -5
        if (filters[key] === 'up10') return value >= 10
        if (filters[key] === 'down10') return value <= -10
        if (filters[key] === 'up25') return value >= 25
        if (filters[key] === 'down25') return value <= -25
        return true
      })
    }
    if (filters.inst_own) rows = rows.filter(t => {
      const value = (t as any).inst_own ?? 0
      if (filters.inst_own === 'over50') return value >= 50
      if (filters.inst_own === 'over80') return value >= 80
      if (filters.inst_own === 'under30') return value < 30
      return true
    })
    if (filters.insider_own) rows = rows.filter(t => {
      const value = (t as any).insider_own ?? 0
      if (filters.insider_own === 'over5') return value >= 5
      if (filters.insider_own === 'over10') return value >= 10
      if (filters.insider_own === 'under1') return value < 1
      return true
    })
    if (filters.float_short) rows = rows.filter(t => {
      const value = (t as any).float_short ?? 0
      if (filters.float_short === 'over5') return value >= 5
      if (filters.float_short === 'over10') return value >= 10
      if (filters.float_short === 'over20') return value >= 20
      return true
    })

    // Signal
    if (signal === 'social_bullish') rows = rows.filter(t => (t.social_message_sentiment ?? t.social_sentiment ?? 0) >= 0.3)
    if (signal === 'social_bearish') rows = rows.filter(t => (t.social_message_sentiment ?? t.social_sentiment ?? 0) <= -0.3)
    if (signal === 'unusual_volume') rows = rows.filter(t => (t.volume ?? 0) > ((t as any).avg_volume ?? 1) * 2)
    if (signal === 'top_gainers') rows = rows.filter(t => (t.change_pct ?? 0) > 0)
    if (signal === 'top_losers') rows = rows.filter(t => (t.change_pct ?? 0) < 0)
    if (signal === 'bullish_news') rows = rows.filter(t => (t.structured_sentiment ?? 0) >= 0.2)
    if (signal === 'bearish_news') rows = rows.filter(t => (t.structured_sentiment ?? 0) <= -0.2)
    if (signal === 'oversold') rows = rows.filter(t => ((t as any).rsi ?? 50) < 30)
    if (signal === 'overbought') rows = rows.filter(t => ((t as any).rsi ?? 50) > 70)

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
  const activeSocialCount = filtered.filter(t => Number(t.message_count ?? t.stocktwits_message_count ?? 0) > 0).length

  const setFilter = (k: string, v: string) => {
    setPage(0)
    if (v) setFilters(f => ({ ...f, [k]: v }))
    else setFilters(f => { const n = { ...f }; delete n[k]; return n })
  }

  const resetFilters = () => { setFilters({}); setSignal(''); setSearch(''); setPage(0) }

  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-3">
        <h1 className="text-white font-semibold text-lg">Window Mirror</h1>
        <span className="text-neutral text-sm">
          {filtered.length} NASDAQ/NYSE/AMEX tickers · {activeSocialCount} with social activity in {debouncedWindow}m
        </span>
      </div>

      {/* Rolling window slider */}
      <div className="bg-surface border border-border rounded-lg px-4 py-3 mb-3">
        <div className="flex flex-wrap items-center gap-4">
          <span className="text-[10px] text-neutral uppercase tracking-wide font-medium whitespace-nowrap">
            Rolling Window
          </span>
          <input
            type="range"
            min={10}
            max={360}
            step={10}
            value={windowMin}
            onChange={e => setWindowMin(Number(e.target.value))}
            className="flex-1 min-w-[160px] accent-sky-500"
          />
          <span className="font-mono text-white text-sm w-14 text-right">{windowMin}m</span>
          {windowMin !== debouncedWindow || isLoading ? (
            <span className="text-xs text-sky-400 animate-pulse whitespace-nowrap">recomputing…</span>
          ) : (
            <span className="text-xs text-neutral whitespace-nowrap">window applied</span>
          )}
        </div>
        <div className="text-[10px] text-slate-500 mt-2">
          Message density and sentiment columns are recomputed server-side over the chosen window (msgs ÷ {debouncedWindow} min),
          replacing the main screener's adaptive per-market-cap windows. Independent of the Charts window buttons and the
          screener's Social Window dropdown.
        </div>
      </div>

      {/* Preset chips */}
      <div className="flex gap-1.5 overflow-x-auto pb-2 mb-2">
        {PRESETS.map(preset => (
          <button
            key={preset.key}
            onClick={() => {
              setSignal(signal === preset.key ? '' : preset.key)
              setOrderBy(preset.key === 'top_losers' ? 'change_pct' : preset.key === 'unusual_volume' ? 'rel_volume' : 'change_pct')
              setOrderDir(preset.key === 'top_losers' ? 'asc' : 'desc')
            }}
            className={`px-2.5 py-1 text-xs rounded border whitespace-nowrap ${signal === preset.key ? 'bg-accent/15 border-accent/50 text-accent' : 'bg-surface border-border text-neutral hover:text-white'}`}
          >
            {preset.label}
          </button>
        ))}
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
        {VIEW_MODES.map(mode => (
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
      <ScreenerTable rows={paged} isLoading={isLoading && !data} viewMode={viewMode} />

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
