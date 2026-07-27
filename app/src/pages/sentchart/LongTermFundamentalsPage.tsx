'use client'
import useSWR from 'swr'
import { useState, useMemo } from 'react'
import { clsx } from 'clsx'
import type { LongTermFundamentalsRow } from '@/lib/types'

// Long-Term Fundamentals — the multi-month/multi-year counterpart to Entry/Exit/v11,
// which are all intraday (120-360 min price×density correlation windows). This
// page never touches the chart-service or the social store: it ranks the same
// clean listed-US universe on Finviz Elite fundamentals and long-horizon returns.
//
// The Long-Term Score is a display-ranking heuristic, NOT a validated predictive
// signal — same standing as the Entry Score. Its components are shown inline
// precisely so it reads as an auditable blend rather than a black-box number.
//
// Filters and horizon are SERVER-side (they change the SWR key and refetch);
// sorting is client-side over the returned page.

const fetcher = (url: string) => fetch(url).then(r => r.json())

const SECTORS = [
  'Basic Materials', 'Communication Services', 'Consumer Cyclical', 'Consumer Defensive',
  'Energy', 'Financial Services', 'Healthcare', 'Industrials', 'Real Estate',
  'Technology', 'Utilities',
]
const MARKET_CAPS = ['Mega', 'Large', 'Mid', 'Small', 'Micro']

const COMPONENT_LABELS: Record<string, string> = {
  range_position: '52W Range Position',
  return_1y: '1-Year Return',
  trend_200d: 'Trend vs 200-Day',
  analyst_rating: 'Analyst Consensus',
  fundamentals: 'Fundamentals',
}

function fmtCompact(n: number | undefined | null): string {
  if (n == null) return '—'
  if (n >= 1e12) return `${(n / 1e12).toFixed(1)}T`
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`
  return n.toLocaleString()
}

function fmtPct(n: number | undefined | null, signed = false): string {
  if (n == null) return '—'
  return `${signed && n > 0 ? '+' : ''}${n.toFixed(1)}%`
}

function scoreTone(score: number | null | undefined): string {
  if (score == null) return 'text-neutral'
  if (score >= 70) return 'text-emerald-400'
  if (score >= 55) return 'text-emerald-300/80'
  if (score >= 45) return 'text-slate-300'
  if (score >= 30) return 'text-amber-400'
  return 'text-red-400'
}

// A small 5-segment coverage meter — how much of the score was actually evidenced.
function CoverageDots({ available, total }: { available: number; total: number }) {
  return (
    <span className="inline-flex gap-0.5 align-middle" title={`${available} of ${total} components available`}>
      {Array.from({ length: total }, (_, i) => (
        <span
          key={i}
          className={clsx('inline-block w-1.5 h-1.5 rounded-full', i < available ? 'bg-sky-400' : 'bg-slate-600')}
        />
      ))}
    </span>
  )
}

const COLUMNS: Array<{ key: string; label: string }> = [
  { key: 'ticker', label: 'TICKER' },
  { key: 'company', label: 'COMPANY' },
  { key: 'sector', label: 'SECTOR' },
  { key: 'market_cap', label: 'MKT CAP' },
  { key: 'price', label: 'PRICE' },
  { key: 'horizon_return', label: 'RETURN' },
  { key: 'range_position', label: '52W POS' },
  { key: 'trend_200d', label: 'VS 200D' },
  { key: 'analyst_rating', label: 'ANALYST' },
  { key: 'fundamentals', label: 'FUND' },
  { key: 'long_term_score', label: 'LT SCORE' },
]

export function LongTermFundamentalsPage() {
  const [horizon, setHorizon] = useState('perf_year')
  const [sector, setSector] = useState('')
  const [marketCap, setMarketCap] = useState('')
  const [maxPe, setMaxPe] = useState('')
  const [minDividend, setMinDividend] = useState('')
  const [profitableOnly, setProfitableOnly] = useState(false)
  const [sort, setSort] = useState<'long_term_score' | 'horizon_return'>('long_term_score')
  const [orderBy, setOrderBy] = useState<string>('')
  const [orderDir, setOrderDir] = useState<'asc' | 'desc'>('desc')

  const query = useMemo(() => {
    const p = new URLSearchParams({ horizon, sort, limit: '100' })
    if (sector) p.set('sector', sector)
    if (marketCap) p.set('market_cap', marketCap)
    if (maxPe) p.set('max_pe', maxPe)
    if (minDividend) p.set('min_dividend', minDividend)
    if (profitableOnly) p.set('profitable_only', '1')
    return p.toString()
  }, [horizon, sector, marketCap, maxPe, minDividend, profitableOnly, sort])

  const { data, isLoading } = useSWR(`/api/long-term-fundamentals?${query}`, fetcher, {
    // Fundamentals move on an ingest cadence, not a market cadence — no polling.
    revalidateOnFocus: false,
  })

  const rows: LongTermFundamentalsRow[] = useMemo(() => {
    const all: LongTermFundamentalsRow[] = data?.rows ?? []
    if (!orderBy) return all                       // keep the server's evidence-aware ranking
    const pick = (r: LongTermFundamentalsRow) =>
      orderBy in (r.components ?? {})
        ? (r.components as unknown as Record<string, number | null>)[orderBy]
        : (r as unknown as Record<string, unknown>)[orderBy]
    return [...all].sort((a, b) => {
      const av = pick(a)
      const bv = pick(b)
      if (av == null && bv == null) return 0
      if (av == null) return 1                     // nulls always last
      if (bv == null) return -1
      if (typeof av === 'string' && typeof bv === 'string') {
        return orderDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av)
      }
      return orderDir === 'desc' ? Number(bv) - Number(av) : Number(av) - Number(bv)
    })
  }, [data, orderBy, orderDir])

  const toggleSort = (key: string) => {
    if (orderBy === key) setOrderDir(d => (d === 'asc' ? 'desc' : 'asc'))
    else { setOrderBy(key); setOrderDir('desc') }
  }

  const clearFilters = () => {
    setSector(''); setMarketCap(''); setMaxPe(''); setMinDividend('')
    setProfitableOnly(false); setOrderBy('')
  }

  const horizons: Record<string, string> = data?.horizons ?? {}
  const selectCls = 'bg-bg border border-border rounded px-2 py-1 text-xs text-white'

  return (
    <div>
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <h1 className="text-white font-semibold text-lg">Long-Term Fundamentals (Active Movers)</h1>
          {/* Scope disclosure. The Elite ingest's tier filters are intraday momentum
              screens (sh_relvol_o2.5, ta_change_u), so fundamentals only ever land on
              tickers that are unusually active today — roughly 250-300 names that
              rotate daily. Saying so here keeps the page from reading as a
              whole-market long-term screen, which it is not. */}
          <p className="text-neutral text-xs mt-1 max-w-3xl leading-relaxed">
            Scores today's intraday-active tickers on long-horizon fundamentals — not a full-market
            long-term screen. Coverage reflects Finviz's active-movers filter, not the entire market.
          </p>
        </div>
        <span className="text-neutral text-sm whitespace-nowrap">
          {data?.matched != null ? `${data.matched} of ${data.universe_size} match` : '—'}
          {data?.horizon_label ? ` · ${data.horizon_label} horizon` : ''}
        </span>
      </div>

      {/* Data prerequisite warning. The fundamentals come only from an
          Elite-authenticated export; when auth fails the ingest keeps running and
          silently serves a ~10-column public scrape, so this must name the actual
          condition (auth failure) rather than implying the ingest is stopped. The
          server distinguishes the two cases via the public-fallback fingerprint. */}
      {data && data.elite_fields_present === false && (
        <div className="bg-amber-500/10 border border-amber-500/40 rounded-lg px-4 py-3 mb-3">
          <div className="text-amber-300 text-xs font-semibold mb-1">
            {data.note_title ?? 'Limited data — scores are partial'}
          </div>
          <div className="text-[11px] text-amber-200/80 leading-relaxed">{data.note}</div>
        </div>
      )}

      {/* Controls */}
      <div className="bg-surface border border-border rounded-lg px-4 py-3 mb-3">
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-1.5">
            <span className="text-[10px] text-neutral uppercase tracking-wide font-medium">Horizon</span>
            <select value={horizon} onChange={e => setHorizon(e.target.value)} className={selectCls}>
              {Object.entries(horizons).length
                ? Object.entries(horizons).map(([k, v]) => <option key={k} value={k}>{v}</option>)
                : <option value="perf_year">1 Year</option>}
            </select>
          </label>

          <label className="flex items-center gap-1.5">
            <span className="text-[10px] text-neutral uppercase tracking-wide font-medium">Sector</span>
            <select value={sector} onChange={e => setSector(e.target.value)} className={selectCls}>
              <option value="">All</option>
              {SECTORS.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>

          <label className="flex items-center gap-1.5">
            <span className="text-[10px] text-neutral uppercase tracking-wide font-medium">Mkt Cap</span>
            <select value={marketCap} onChange={e => setMarketCap(e.target.value)} className={selectCls}>
              <option value="">All</option>
              {MARKET_CAPS.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>

          <label className="flex items-center gap-1.5">
            <span className="text-[10px] text-neutral uppercase tracking-wide font-medium">Max P/E</span>
            <input
              type="number" min={0} value={maxPe} onChange={e => setMaxPe(e.target.value)}
              placeholder="—" className={`${selectCls} w-16`}
            />
          </label>

          <label className="flex items-center gap-1.5">
            <span className="text-[10px] text-neutral uppercase tracking-wide font-medium">Min Div %</span>
            <input
              type="number" min={0} step={0.5} value={minDividend} onChange={e => setMinDividend(e.target.value)}
              placeholder="—" className={`${selectCls} w-16`}
            />
          </label>

          <label className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox" checked={profitableOnly}
              onChange={e => setProfitableOnly(e.target.checked)} className="accent-sky-500"
            />
            <span className="text-[10px] text-neutral uppercase tracking-wide font-medium">Profitable only</span>
          </label>

          <label className="flex items-center gap-1.5">
            <span className="text-[10px] text-neutral uppercase tracking-wide font-medium">Rank by</span>
            <select
              value={sort} onChange={e => setSort(e.target.value as 'long_term_score' | 'horizon_return')}
              className={selectCls}
            >
              <option value="long_term_score">LT Score</option>
              <option value="horizon_return">Return</option>
            </select>
          </label>

          <button
            onClick={clearFilters}
            className="text-[10px] text-neutral uppercase tracking-wide font-medium hover:text-white border border-border rounded px-2 py-1"
          >
            Clear
          </button>
        </div>

        <div className="text-[10px] text-slate-500 mt-2 leading-relaxed">
          <span className="text-slate-400 italic">
            Long-Term Score is a display-ranking heuristic over Finviz Elite fundamentals — it has not been
            backtested and is not a predictive signal. Treat it as a way to sort a research list, not as advice.
          </span>
          <br />
          Blend of 52-week range position, realized 1-year return, price vs the 200-day average, analyst
          consensus, and a profitability/leverage/valuation composite. Missing components are dropped and the
          rest renormalized, so gaps trend neutral rather than bearish; ranking additionally shrinks
          thinly-evidenced rows toward neutral. The dots in the SCORE column show how many of the five
          components were available.
        </div>
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="text-neutral text-sm animate-pulse p-4">Loading long-term fundamentals...</div>
      ) : rows.length === 0 ? (
        <div className="text-center py-12 text-neutral">
          <div className="text-3xl mb-2">🔍</div>
          <div className="text-sm">{data?.note ? 'No rows match these filters' : 'No results'}</div>
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
                      {orderBy === col.key && <span className="ml-0.5">{orderDir === 'desc' ? '▾' : '▴'}</span>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700/30">
                {rows.map(row => {
                  const c = row.components ?? ({} as LongTermFundamentalsRow['components'])
                  return (
                    <tr key={row.ticker} className="hover:bg-card-hover transition-colors">
                      <td className="px-2 py-2 whitespace-nowrap">
                        <span className="font-mono font-bold text-accent">{row.ticker}</span>
                      </td>
                      <td className="px-2 py-2 whitespace-nowrap">
                        <span className="text-slate-300 truncate block max-w-[150px]">{row.company || '—'}</span>
                      </td>
                      <td className="px-2 py-2 whitespace-nowrap">
                        <span className="text-neutral truncate block max-w-[120px]">{row.sector || '—'}</span>
                      </td>
                      <td className="px-2 py-2 whitespace-nowrap">
                        <span className="font-mono text-neutral">{fmtCompact(row.market_cap)}</span>
                      </td>
                      <td className="px-2 py-2 whitespace-nowrap">
                        <span className="font-mono text-white">
                          {row.price != null ? `$${row.price.toFixed(2)}` : '—'}
                        </span>
                      </td>
                      <td className="px-2 py-2 whitespace-nowrap">
                        <span
                          className={clsx('font-mono', row.horizon_return == null ? 'text-neutral'
                            : row.horizon_return >= 0 ? 'text-emerald-400' : 'text-red-400')}
                        >
                          {fmtPct(row.horizon_return, true)}
                        </span>
                      </td>
                      <td className="px-2 py-2 whitespace-nowrap">
                        <span className={clsx('font-mono', scoreTone(c.range_position))}>
                          {c.range_position != null ? c.range_position.toFixed(0) : '—'}
                        </span>
                      </td>
                      <td className="px-2 py-2 whitespace-nowrap">
                        <span
                          className={clsx('font-mono', row.sma200 == null ? 'text-neutral'
                            : row.sma200 >= 0 ? 'text-emerald-400' : 'text-red-400')}
                          title={COMPONENT_LABELS.trend_200d}
                        >
                          {fmtPct(row.sma200, true)}
                        </span>
                      </td>
                      <td className="px-2 py-2 whitespace-nowrap">
                        <span className="font-mono text-slate-300" title="Finviz consensus: 1.0 Strong Buy … 5.0 Strong Sell">
                          {row.analyst ?? '—'}
                        </span>
                      </td>
                      <td className="px-2 py-2 whitespace-nowrap">
                        <span className={clsx('font-mono', scoreTone(c.fundamentals))}>
                          {c.fundamentals != null ? c.fundamentals.toFixed(0) : '—'}
                        </span>
                      </td>
                      <td className="px-2 py-2 whitespace-nowrap">
                        <span className="inline-flex items-center gap-1.5">
                          <span
                            className={clsx('font-mono font-bold', scoreTone(row.long_term_score))}
                            title={Object.entries(c)
                              .map(([k, v]) => `${COMPONENT_LABELS[k] ?? k}: ${v ?? 'no data'}`)
                              .join('\n')}
                          >
                            {row.long_term_score != null ? row.long_term_score.toFixed(1) : '—'}
                          </span>
                          <CoverageDots
                            available={row.components_available ?? 0}
                            total={row.components_total ?? 5}
                          />
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
