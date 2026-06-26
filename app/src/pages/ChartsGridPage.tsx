'use client'
import useSWR from 'swr'
import { useState, useEffect, useMemo } from 'react'
import { useSearchParams, Link } from 'react-router-dom'
import { clsx } from 'clsx'
import type { ScreenerRow } from '../lib/types'
import { readView, applyScreenerView } from '../lib/screenerView'

const fetcher = (url: string) => fetch(url).then(r => r.json())

const TIMEFRAMES: Array<{ key: string; label: string }> = [
  { key: '1m', label: '1m' },
  { key: '3m', label: '3m' },
  { key: '5m', label: '5m' },
  { key: '15m', label: '15m' },
  { key: '1h', label: '1h' },
  { key: 'd', label: 'Daily' },
  { key: 'w', label: 'Weekly' },
]

const REFRESH: Array<{ key: string; label: string; ms: number }> = [
  { key: 'off', label: 'Off', ms: 0 },
  { key: '10s', label: '10s', ms: 10_000 },
  { key: '60s', label: '1min', ms: 60_000 },
]

const PAGE_SIZE = 12

function fmtCompact(n: number | undefined | null): string {
  if (n == null) return '—'
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`
  return n.toLocaleString()
}

function sentClass(v: number | null | undefined) {
  if (v == null) return 'text-slate-600'
  return v >= 0.2 ? 'text-emerald-400' : v <= -0.2 ? 'text-red-400' : 'text-neutral'
}

export function ChartsGridPage() {
  const { data, isLoading } = useSWR('/api/screener', fetcher, { refreshInterval: 30_000 })
  const [sp] = useSearchParams()
  const view = useMemo(() => readView(sp), [sp])

  const [tf, setTf] = useState('5m')
  const [refresh, setRefresh] = useState('off')
  const [page, setPage] = useState(0)
  const [nonce, setNonce] = useState(0)

  const tickers: ScreenerRow[] = data?.tickers ?? []
  const rows = useMemo(() => applyScreenerView(tickers, view), [tickers, view])

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages - 1)
  const paged = rows.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE)

  useEffect(() => {
    const ms = REFRESH.find(r => r.key === refresh)?.ms ?? 0
    if (!ms) return
    const id = setInterval(() => setNonce(n => n + 1), ms)
    return () => clearInterval(id)
  }, [refresh])

  const chips = [
    ...Object.entries(view.filters).map(([k, v]) => `${k}: ${v}`),
    ...(view.search ? [`search: ${view.search}`] : []),
    ...(view.signal ? [`signal: ${view.signal}`] : []),
  ]

  return (
    <div>
      {/* Header + mirror banner */}
      <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <h1 className="text-white font-semibold text-lg">Charts Grid</h1>
          <span className="text-[10px] uppercase tracking-wide bg-accent/15 border border-accent/30 text-accent px-1.5 py-0.5 rounded">
            Mirrors Screener
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-neutral text-sm">{rows.length} charts</span>
          <Link
            to={{ pathname: '/screener', search: sp.toString() }}
            className="text-xs px-3 py-1.5 rounded border border-border text-neutral hover:text-white hover:border-accent transition-colors"
          >
            ← Back to Screener
          </Link>
        </div>
      </div>

      {/* Mirror summary */}
      <div className="flex items-center gap-1.5 mb-3 flex-wrap text-[11px]">
        <span className="text-neutral">Showing the Screener's current set ·</span>
        <span className="text-neutral">sort {view.orderBy} {view.orderDir === 'asc' ? '↑' : '↓'}</span>
        {chips.length === 0 ? (
          <span className="text-slate-600">· no filters</span>
        ) : chips.map(c => (
          <span key={c} className="bg-accent/10 border border-accent/30 text-accent px-2 py-0.5 rounded">{c}</span>
        ))}
      </div>

      {/* Controls: timeframe + refresh */}
      <div className="flex items-center gap-3 mb-3 flex-wrap bg-surface border border-border rounded-lg px-3 py-2">
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-neutral uppercase mr-1">Timeframe</span>
          <div className="flex items-stretch rounded overflow-hidden border border-border">
            {TIMEFRAMES.map(t => (
              <button key={t.key} onClick={() => setTf(t.key)}
                className={clsx('px-2.5 py-1 text-xs transition-colors',
                  tf === t.key ? 'bg-accent text-white' : 'bg-surface text-neutral hover:text-white')}>
                {t.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-neutral uppercase mr-1">Refresh</span>
          <div className="flex items-stretch rounded overflow-hidden border border-border">
            {REFRESH.map(r => (
              <button key={r.key} onClick={() => setRefresh(r.key)}
                className={clsx('px-2.5 py-1 text-xs transition-colors',
                  refresh === r.key ? 'bg-accent text-white' : 'bg-surface text-neutral hover:text-white')}>
                {r.label}
              </button>
            ))}
          </div>
          {refresh !== 'off' && <span className="text-[10px] text-slate-500">cached ≤45s · only visible page loads</span>}
        </div>
      </div>

      {/* Grid */}
      {isLoading ? (
        <div className="text-neutral text-sm animate-pulse p-4">Loading screener universe…</div>
      ) : rows.length === 0 ? (
        <div className="text-center py-16 text-neutral">
          <div className="text-3xl mb-2">📉</div>
          <div className="text-sm">No tickers match the current Screener filters.</div>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {paged.map(row => (
            <GridCell key={row.ticker} row={row} tf={tf} nonce={nonce} />
          ))}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-3">
          <span className="text-xs text-neutral">
            {safePage * PAGE_SIZE + 1}–{Math.min((safePage + 1) * PAGE_SIZE, rows.length)} of {rows.length}
          </span>
          <div className="flex gap-1">
            <button disabled={safePage === 0} onClick={() => setPage(p => Math.max(0, p - 1))}
              className="px-2 py-1 text-xs bg-surface border border-border rounded text-neutral disabled:opacity-40 hover:text-white">Prev</button>
            {Array.from({ length: Math.min(7, totalPages) }, (_, i) => {
              let pn: number
              if (totalPages <= 7) pn = i
              else if (safePage < 4) pn = i
              else if (safePage >= totalPages - 4) pn = totalPages - 7 + i
              else pn = safePage - 3 + i
              return (
                <button key={pn} onClick={() => setPage(pn)}
                  className={clsx('w-6 h-6 text-xs rounded',
                    safePage === pn ? 'bg-accent text-white' : 'bg-surface border border-border text-neutral hover:text-white')}>
                  {pn + 1}
                </button>
              )
            })}
            <button disabled={safePage >= totalPages - 1} onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
              className="px-2 py-1 text-xs bg-surface border border-border rounded text-neutral disabled:opacity-40 hover:text-white">Next</button>
          </div>
        </div>
      )}
    </div>
  )
}

function GridCell({ row, tf, nonce }: { row: ScreenerRow; tf: string; nonce: number }) {
  const [imgError, setImgError] = useState(false)
  const src = `/api/charts/grid-image/${encodeURIComponent(row.ticker)}?tf=${tf}&_r=${nonce}`

  return (
    <div className="bg-surface border border-border rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border">
        <div className="flex items-baseline gap-2">
          <Link to={{ pathname: '/charts', search: `?t=${encodeURIComponent(row.ticker)}` }}
                className="font-mono font-bold text-accent hover:text-sky-300 transition-colors"
                title={`Open ${row.ticker} detail`}>
            {row.ticker}
          </Link>
          <span className="font-mono text-xs">{row.price != null ? `$${row.price.toFixed(2)}` : '—'}</span>
          <span className={clsx('font-mono text-xs', (row.change_pct ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400')}>
            {row.change_pct != null ? `${row.change_pct >= 0 ? '+' : ''}${row.change_pct.toFixed(2)}%` : '—'}
          </span>
        </div>
        <span className="text-[10px] text-neutral uppercase truncate max-w-[90px]">{row.sector ?? ''}</span>
      </div>

      {/* Chart image */}
      <div className="bg-white flex items-center justify-center" style={{ minHeight: 120 }}>
        {imgError ? (
          <div className="text-slate-500 text-xs py-10">chart unavailable</div>
        ) : (
          <img
            src={src}
            alt={`${row.ticker} chart`}
            loading="lazy"
            className="w-full h-auto block"
            onError={() => setImgError(true)}
          />
        )}
      </div>

      {/* Metrics strip */}
      <div className="grid grid-cols-5 gap-1 px-2 py-1.5 text-[10px] font-mono border-t border-border">
        <Metric label="VOL" value={fmtCompact(row.volume)} />
        <Metric label="RSI" value={(row as any).rsi != null ? (row as any).rsi.toFixed(0) : '—'} />
        <Metric label="NEWS" value={row.structured_sentiment != null ? row.structured_sentiment.toFixed(2) : '—'}
          cls={sentClass(row.structured_sentiment)} />
        <Metric label="SOC" value={row.social_sentiment != null ? row.social_sentiment.toFixed(2) : '—'}
          cls={sentClass(row.social_sentiment)} />
        <Metric label="DENS" value={row.message_count != null ? row.message_count.toLocaleString() : '—'}
          cls={row.message_count != null && row.message_count >= 50 ? 'text-accent' : 'text-neutral'} />
      </div>
    </div>
  )
}

function Metric({ label, value, cls }: { label: string; value: string; cls?: string }) {
  return (
    <div className="flex flex-col items-center">
      <span className="text-[8px] text-slate-500 uppercase tracking-wide">{label}</span>
      <span className={cls ?? 'text-neutral'}>{value}</span>
    </div>
  )
}