'use client'
import useSWR from 'swr'
import { useState, useMemo } from 'react'
import { clsx } from 'clsx'
import type { EntryScreenerRow } from '@/lib/types'

// Entry Screener — ranks the most StockTwits-active tickers by the strategy's
// rolling price×density correlation (360-min window, computed server-side by
// the chart-service; joined with quote rows by /api/entry-screener). The
// threshold slider filters CLIENT-SIDE: failing rows are dimmed, no refetch.
//
// Entry Score is a display-ranking heuristic (evidence-shrunk correlation),
// NOT a predictive signal — density is known to lag price.

const fetcher = (url: string) => fetch(url).then(r => r.json())

const COLUMNS: Array<{ key: keyof EntryScreenerRow | 'passes'; label: string; numeric?: boolean }> = [
  { key: 'ticker', label: 'TICKER' },
  { key: 'company', label: 'COMPANY' },
  { key: 'market_cap', label: 'MKT CAP', numeric: true },
  { key: 'price', label: 'PRICE', numeric: true },
  { key: 'change_pct', label: 'CHG%', numeric: true },
  { key: 'msg_density_rolling', label: 'MSG DENSITY', numeric: true },
  { key: 'price_density_corr', label: 'P×D CORR', numeric: true },
  { key: 'entry_score', label: 'ENTRY SCORE', numeric: true },
  { key: 'passes', label: 'PASSES' },
]

function fmtCompact(n: number | undefined | null): string {
  if (n == null) return '—'
  if (n >= 1e12) return `${(n / 1e12).toFixed(1)}T`
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`
  return n.toLocaleString()
}

export function EntryScreenerPage() {
  const [threshold, setThreshold] = useState(0.5)
  const [orderBy, setOrderBy] = useState<string>('entry_score')
  const [orderDir, setOrderDir] = useState<'asc' | 'desc'>('desc')

  // threshold is intentionally NOT in the SWR key — the slider re-filters
  // client-side against price_density_corr, so moving it never refetches
  const { data, isLoading } = useSWR('/api/entry-screener?limit=30', fetcher, { refreshInterval: 30_000 })

  const rows = useMemo(() => {
    const all: Array<EntryScreenerRow & { passes: boolean }> = (data?.rows ?? []).map((r: EntryScreenerRow) => ({
      ...r,
      passes: r.price_density_corr != null && r.price_density_corr >= threshold,
    }))
    return all.sort((a, b) => {
      const av = (a as any)[orderBy]
      const bv = (b as any)[orderBy]
      if (av == null && bv == null) return 0
      if (av == null) return 1                    // nulls always last
      if (bv == null) return -1
      if (typeof av === 'string') return orderDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av)
      return orderDir === 'desc' ? Number(bv) - Number(av) : Number(av) - Number(bv)
    })
  }, [data, threshold, orderBy, orderDir])

  const passing = rows.filter(r => r.passes).length
  const warming = rows.filter(r => r.corr_status === 'warming').length

  const toggleSort = (key: string) => {
    if (key === 'passes') key = 'price_density_corr'
    if (orderBy === key) setOrderDir(d => (d === 'asc' ? 'desc' : 'asc'))
    else { setOrderBy(key); setOrderDir('desc') }
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-3">
        <h1 className="text-white font-semibold text-lg">Entry Screener</h1>
        <span className="text-neutral text-sm">
          {rows.length} most active StockTwits tickers · {data?.corr_window_minutes ?? 360}m correlation window
        </span>
      </div>

      {/* Threshold slider */}
      <div className="bg-surface border border-border rounded-lg px-4 py-3 mb-3">
        <div className="flex flex-wrap items-center gap-4">
          <span className="text-[10px] text-neutral uppercase tracking-wide font-medium whitespace-nowrap">
            Entry Correlation Threshold
          </span>
          <input
            type="range"
            min={0.1}
            max={1}
            step={0.1}
            value={threshold}
            onChange={e => setThreshold(Number(e.target.value))}
            className="flex-1 min-w-[160px] accent-sky-500"
          />
          <span className="font-mono text-white text-sm w-10 text-right">{threshold.toFixed(1)}</span>
          <span className="text-xs text-neutral whitespace-nowrap">
            {passing} of {rows.length} pass
          </span>
        </div>
        <div className="text-[10px] text-slate-500 mt-2">
          Rolling Pearson correlation of price vs per-minute StockTwits message density (same math as the
          Charts strategy signals). Entry Score = correlation × evidence weight — a display ranking, not a
          predictive signal. Rows below the threshold are dimmed.
          {warming > 0 && ` · ${warming} ticker${warming > 1 ? 's' : ''} still collecting messages`}
        </div>
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="text-neutral text-sm animate-pulse p-4">Loading entry screener...</div>
      ) : rows.length === 0 ? (
        <div className="text-center py-12 text-neutral">
          <div className="text-3xl mb-2">🔍</div>
          <div className="text-sm">{data?.note || 'No active-social tickers to screen right now'}</div>
        </div>
      ) : (
        <div className="bg-surface border border-border rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="border-b border-border bg-bg/50">
                <tr>
                  {COLUMNS.map(col => (
                    <th
                      key={col.key}
                      onClick={() => toggleSort(col.key)}
                      className="px-2 py-2 text-left text-[10px] text-neutral uppercase tracking-wide font-medium whitespace-nowrap cursor-pointer hover:text-white select-none"
                    >
                      {col.label}
                      {(orderBy === col.key || (col.key === 'passes' && orderBy === 'price_density_corr')) && (
                        <span className="ml-0.5">{orderDir === 'desc' ? '▾' : '▴'}</span>
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700/30">
                {rows.map(row => (
                  <tr
                    key={row.ticker}
                    className={clsx('hover:bg-card-hover transition-colors', !row.passes && 'opacity-50')}
                  >
                    <td className="px-2 py-2 whitespace-nowrap">
                      <span className="font-mono font-bold text-accent">{row.ticker}</span>
                    </td>
                    <td className="px-2 py-2 whitespace-nowrap">
                      <span className="text-slate-300 truncate block max-w-[150px]">{row.company || '—'}</span>
                    </td>
                    <td className="px-2 py-2 whitespace-nowrap">
                      <span className="font-mono text-neutral">{fmtCompact(row.market_cap)}</span>
                    </td>
                    <td className="px-2 py-2 whitespace-nowrap">
                      <span className="font-mono text-white">{row.price != null ? `$${row.price.toFixed(2)}` : '—'}</span>
                    </td>
                    <td className="px-2 py-2 whitespace-nowrap">
                      <span className={clsx('font-mono', (row.change_pct ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                        {row.change_pct != null ? `${row.change_pct >= 0 ? '+' : ''}${row.change_pct.toFixed(2)}%` : '—'}
                      </span>
                    </td>
                    <td className="px-2 py-2 whitespace-nowrap">
                      <span className="font-mono text-neutral">
                        {row.msg_density_rolling != null ? `${row.msg_density_rolling.toFixed(3)}/m` : '—'}
                      </span>
                    </td>
                    <td className="px-2 py-2 whitespace-nowrap">
                      {row.price_density_corr != null ? (
                        <span className={clsx('font-mono', row.price_density_corr >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                          {row.price_density_corr.toFixed(3)}
                        </span>
                      ) : (
                        <span className="font-mono text-neutral" title={row.corr_status}>
                          {row.corr_status === 'warming' ? 'warming…' : '—'}
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-2 whitespace-nowrap">
                      <span className="font-mono text-white">
                        {row.entry_score != null ? row.entry_score.toFixed(3) : '—'}
                      </span>
                    </td>
                    <td className="px-2 py-2 whitespace-nowrap">
                      {row.passes ? (
                        <span className="font-mono text-emerald-400">PASS</span>
                      ) : (
                        <span className="font-mono text-neutral">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
