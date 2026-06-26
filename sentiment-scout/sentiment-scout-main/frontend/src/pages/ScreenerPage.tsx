'use client'
import useSWR from 'swr'
import { useState, useMemo } from 'react'
import { useSearchParams, Link } from 'react-router-dom'
import { ScreenerTable } from './ScreenerTable'
import { ScreenerFilterPanel } from './ScreenerFilterPanel'
import { SignalBar } from './SignalBar'
import type { ScreenerRow } from '@/lib/types'
import { readView, applyScreenerView } from '@/lib/screenerView'

const fetcher = (url: string) => fetch(url).then(r => r.json())

export type ViewMode = 'overview' | 'valuation' | 'technical' | 'sentiment'

// Columns the user can add/remove on top of the active view (Finviz-style).
// The three computed columns default on; a few existing columns are included so
// add/remove is clearly general. Rendering reuses ScreenerRow's renderCell.
const TOGGLE_COLUMNS: Array<{ key: string; label: string }> = [
  { key: 'news_sentiment', label: 'News Sent (3d)' },
  { key: 'stocktwits_sentiment', label: 'Social Sent' },
  { key: 'stocktwits_density', label: 'Social Density' },
  { key: 'rsi', label: 'RSI' },
  { key: 'rel_volume', label: 'Rel Vol' },
  { key: 'sector', label: 'Sector' },
]

export function ScreenerPage() {
  const { data, isLoading, mutate } = useSWR('/api/screener', fetcher, { refreshInterval: 30_000 })

  // Filters + sort + search + signal live in the URL so the Charts Grid mirrors
  // exactly this view (and the view is linkable). Per-view UI stays local.
  const [sp, setSp] = useSearchParams()
  const view = useMemo(() => readView(sp), [sp])
  const { filters, signal, orderBy, orderDir, search } = view

  const [showFilters, setShowFilters] = useState(false)
  const [showColumns, setShowColumns] = useState(false)
  const [extraCols, setExtraCols] = useState<string[]>(
    ['news_sentiment', 'stocktwits_sentiment', 'stocktwits_density'])
  const [filterTab, setFilterTab] = useState<'descriptive' | 'fundamental' | 'technical' | 'sentiment' | 'all'>('all')
  const [viewMode, setViewMode] = useState<ViewMode>('overview')
  const [page, setPage] = useState(0)
  const pageSize = 20

  const tickers: ScreenerRow[] = data?.tickers ?? []

  const filtered = useMemo(() => applyScreenerView(tickers, view), [tickers, view])

  const totalPages = Math.ceil(filtered.length / pageSize)
  const paged = filtered.slice(page * pageSize, (page + 1) * pageSize)

  // Every setter writes through the URL (the shared source of truth).
  const setParam = (k: string, v: string) => {
    setPage(0)
    setSp(prev => {
      const n = new URLSearchParams(prev)
      if (v) n.set(k, v); else n.delete(k)
      return n
    }, { replace: true })
  }
  const setFilter = setParam
  const setSignal = (v: string) => setParam('signal', v)
  const setOrderBy = (v: string) => setParam('orderBy', v)
  const setOrderDir = (v: 'asc' | 'desc') => setParam('orderDir', v)
  const setSearch = (v: string) => setParam('search', v)

  const resetFilters = () => { setSp(new URLSearchParams(), { replace: true }); setPage(0) }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h1 className="text-white font-semibold text-lg">Market Screener</h1>
        <div className="flex items-center gap-3">
          <span className="text-neutral text-sm">{filtered.length} tickers</span>
          {/* Mirror this exact view as a Finviz-style charts grid (v=321). */}
          <Link
            to={{ pathname: '/charts-grid', search: sp.toString() }}
            className="text-xs px-3 py-1.5 rounded border border-border text-neutral hover:text-white hover:border-accent transition-colors"
          >
            ⊞ Charts grid →
          </Link>
        </div>
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

        {/* Column customization (add/remove, Finviz-style) */}
        <div className="relative">
          <button
            onClick={() => setShowColumns(s => !s)}
            className={`text-xs px-3 py-1.5 rounded border transition-colors ${
              showColumns ? 'bg-accent/10 border-accent/40 text-accent' : 'border-border text-neutral hover:text-white hover:border-accent'
            }`}
          >
            ⊞ Columns
          </button>
          {showColumns && (
            <div className="absolute z-20 mt-1 left-0 bg-surface border border-border rounded-lg shadow-xl p-2 w-48">
              <div className="text-[10px] text-neutral uppercase tracking-wide px-1 pb-1 mb-1 border-b border-border">Add / remove columns</div>
              {TOGGLE_COLUMNS.map(c => (
                <label key={c.key} className="flex items-center gap-2 px-1 py-1 text-xs text-neutral hover:text-white cursor-pointer">
                  <input
                    type="checkbox"
                    checked={extraCols.includes(c.key)}
                    onChange={() => setExtraCols(cols =>
                      cols.includes(c.key) ? cols.filter(k => k !== c.key) : [...cols, c.key])}
                    className="accent-accent"
                  />
                  {c.label}
                </label>
              ))}
            </div>
          )}
        </div>
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
      <ScreenerTable
        rows={paged}
        isLoading={isLoading}
        viewMode={viewMode}
        extraColumns={TOGGLE_COLUMNS.filter(c => extraCols.includes(c.key))}
      />

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
