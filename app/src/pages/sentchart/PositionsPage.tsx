'use client'
import useSWR from 'swr'
import { useState, useMemo, useEffect } from 'react'
import { clsx } from 'clsx'
import type {
  PositionScreenerResponse,
  PositionScreenerRow,
  PositionGroup,
  PositionDataStatus,
} from '@/lib/types'
import { sortRows } from '@/lib/tableSort'

// Positions — the professor's unified view: the exact entry the strategy took,
// the exact exit it took (or the stop it is currently working), and the profit
// realized or currently being carried. One table, grouped so open positions sit
// at the top and closed ones move down rather than disappearing.
//
// BOTH SLIDERS ARE SERVER-BOUND. This is the fix for a real defect on the Exit
// Screener, not a preference: there the stop slider recomputes stop price and
// distance client-side while status, exit price and P&L stay frozen at the
// server's 5% sim, so at any other stop % it can show a "Stopped Out" row whose
// displayed stop sits far from the fill it claims. The entry threshold is worse
// still — it decides which trades EXIST, so it cannot be applied client-side at
// all. Both parameters go to the simulator, debounced, with the table dimmed
// while the answer is in flight.
//
// WHAT THE SLIDERS CANNOT DO: history was recorded at the canonical parameters
// and past sessions cannot be re-simulated on demand (Finviz intraday reaches
// back about two weeks; old StockTwits messages cannot be rebuilt at all). So
// off-canonical settings are a what-if over TODAY only, and the page says so
// instead of quietly letting the closed-earlier rows look re-simulated.

const fetcher = (url: string) => fetch(url).then(r => r.json())

const DEBOUNCE_MS = 400
const NEAR_STOP_PCT = 2

const STATUS_LABEL: Record<PositionDataStatus, string> = {
  live: 'Live',
  recorded: 'Recorded',
  stale: 'Unsettled',
  warming: 'Warming',
  no_bars: 'No bars',
  chart_service_unavailable: 'No sim',
}

const STATUS_TITLE: Record<PositionDataStatus, string> = {
  live: 'Simulated in this request from the current session\'s bars and messages.',
  recorded: 'Read back from screener_position_history. The session is over and this figure is settled.',
  stale: 'UNSETTLED — this position never reached a conclusion. The scheduler stopped observing it before its '
    + 'session ended, so the figure shown is a frozen mid-session mark, not a realized result. It never stopped '
    + 'out and it was never closed at the bell; treat the P&L as incomplete rather than as a trade outcome.',
  warming: 'Still collecting StockTwits messages for this ticker/session, so no correlation and no trades yet.',
  no_bars: 'No intraday bars available for this ticker and session, so the strategy could not be simulated.',
  chart_service_unavailable: 'The chart-service could not be reached, so no live position could be simulated.',
}

const STATUS_TONE: Record<PositionDataStatus, string> = {
  live: 'text-sky-300 border-sky-500/40 bg-sky-500/10',
  recorded: 'text-slate-300 border-slate-500/40 bg-slate-500/10',
  stale: 'text-fuchsia-200 border-fuchsia-400/70 border-dashed bg-fuchsia-500/20 font-semibold',
  warming: 'text-amber-400 border-amber-600/40 bg-amber-600/10',
  no_bars: 'text-neutral border-border bg-bg',
  chart_service_unavailable: 'text-red-300 border-red-500/40 bg-red-500/10',
}

const GROUPS: Array<{ key: PositionGroup; title: string; blurb: string; sortKey: string; dir: 'asc' | 'desc' }> = [
  {
    key: 'open',
    title: 'Open',
    blurb: 'Held right now. P&L is unrealized and marked to the latest bar; closest to its stop first.',
    sortKey: 'distance_to_stop_pct',
    dir: 'asc',
  },
  {
    key: 'closed_today',
    title: 'Closed today',
    blurb: 'Exited during the current session. P&L is realized at the fill.',
    sortKey: 'exit_time',
    dir: 'desc',
  },
  {
    key: 'closed_earlier',
    title: 'Closed earlier',
    blurb: 'Recorded from previous sessions. These never disappear — they only move down.',
    sortKey: 'date',
    dir: 'desc',
  },
]

function fmtMoney(n: number | null | undefined, digits = 2): string {
  return n == null ? '—' : `$${n.toFixed(digits)}`
}

function fmtPct(n: number | null | undefined, signed = false): string {
  if (n == null) return '—'
  return `${signed && n >= 0 ? '+' : ''}${n.toFixed(2)}%`
}

function exitReasonLabel(value?: string | null): string {
  if (value === 'price_trailing_stop') return 'Price stop'
  if (value === 'correlation_break') return 'Corr break'
  if (value === 'session_end') return 'Session end'
  return value || '—'
}

function DataBadge({ status }: { status: PositionDataStatus }) {
  return (
    <span
      title={STATUS_TITLE[status]}
      className={clsx('rounded px-1.5 py-0.5 text-[9px] uppercase tracking-wide border whitespace-nowrap', STATUS_TONE[status])}
    >
      {STATUS_LABEL[status]}
    </span>
  )
}

export function PositionsPage() {
  const [threshold, setThreshold] = useState(0.1)
  const [stopPct, setStopPct] = useState(5)
  const [showWatch, setShowWatch] = useState(false)
  const [orderBy, setOrderBy] = useState<string>('')
  const [orderDir, setOrderDir] = useState<'asc' | 'desc'>('desc')

  // Debounced mirror of the sliders. Only this drives the fetch key, so dragging
  // a slider does not fire a request per pixel — the simulator recomputes the
  // whole trade set on every parameter change.
  const [debounced, setDebounced] = useState({ threshold: 0.1, stopPct: 5 })
  useEffect(() => {
    const t = setTimeout(() => setDebounced({ threshold, stopPct }), DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [threshold, stopPct])

  const query = `threshold=${debounced.threshold}&stopPct=${debounced.stopPct}&limit=30`
  const { data, isLoading, isValidating } = useSWR<PositionScreenerResponse>(
    `/api/position-screener?${query}`,
    fetcher,
    { refreshInterval: 60_000, keepPreviousData: true },
  )

  // True while the displayed numbers belong to a previous parameter set: either
  // the debounce has not fired yet, or the refetch is still in flight.
  const pending = threshold !== debounced.threshold || stopPct !== debounced.stopPct
  const resimulating = pending || (isValidating && !isLoading)

  const grouped = useMemo(() => {
    const rows = data?.rows ?? []
    const out = {} as Record<PositionGroup, PositionScreenerRow[]>
    for (const group of ['open', 'closed_today', 'closed_earlier', 'watch'] as PositionGroup[]) {
      const subset = rows.filter(row => row.group === group)
      const spec = GROUPS.find(g => g.key === group)
      out[group] = orderBy
        ? sortRows(subset, orderBy, orderDir)
        : sortRows(subset, spec?.sortKey ?? 'ticker', spec?.dir ?? 'desc')
    }
    return out
  }, [data, orderBy, orderDir])

  const toggleSort = (key: string) => {
    if (key === 'data_status') return
    if (orderBy === key) setOrderDir(d => (d === 'asc' ? 'desc' : 'asc'))
    else { setOrderBy(key); setOrderDir(key === 'ticker' || key === 'entry_time' ? 'asc' : 'desc') }
  }

  const counts = data?.counts
  const offCanonical = data ? !data.is_canonical : false
  const watchRows = grouped.watch ?? []

  const COLUMNS: Array<{ key: string; label: string; title?: string }> = [
    { key: 'ticker', label: 'TICKER' },
    { key: 'date', label: 'SESSION' },
    { key: 'entry_price', label: 'ENTRY', title: 'The exact entry the strategy took: fill price, ET time, and the rolling correlation that triggered it' },
    { key: 'exit_price', label: 'EXIT / STOP', title: 'The exact exit taken, or for an open position the trailing stop currently being worked' },
    { key: 'pnl_pct', label: 'P&L', title: 'Realized at the fill for a closed position; unrealized and marked to the latest bar for an open one' },
    { key: 'distance_to_stop_pct', label: 'DIST TO STOP' },
    { key: 'threshold', label: 'PARAMS', title: 'The entry threshold and trailing stop this row was actually simulated under' },
    { key: 'data_status', label: 'DATA', title: 'Where this row came from and whether its number is settled' },
  ]

  return (
    <div>
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <h1 className="text-white font-semibold text-lg">Positions</h1>
          <p className="text-neutral text-xs mt-1 max-w-3xl leading-relaxed">
            Entry, exit and P&amp;L for the rolling-correlation strategy in one view. Open positions sit at the top;
            closed ones move down and stay. Today is simulated live; earlier sessions are read back from the
            recorded history.
          </p>
        </div>
        <span className="text-neutral text-sm whitespace-nowrap">
          {counts ? `${counts.open} open · ${counts.closed_today} closed today · ${counts.closed_earlier} earlier` : '—'}
        </span>
      </div>

      {/* Simulated, never executed. The first thing to say on a page whose
          headline column is profit. */}
      <div className="bg-slate-500/10 border border-slate-500/40 rounded-lg px-4 py-3 mb-3">
        <div className="text-slate-200 text-xs font-semibold mb-1">Simulated positions — never executed</div>
        <div className="text-[11px] text-slate-300/80 leading-relaxed">
          {data?.simulation_note
            ?? 'No order was placed and no fill is real. These are the entries and exits the strategy would have taken.'}
        </div>
      </div>

      {/* Parameter provenance. Only shown when it actually matters — at the
          canonical settings live and recorded rows agree and the banner would
          be noise. */}
      {offCanonical && (
        <div className="bg-amber-500/10 border border-amber-500/40 rounded-lg px-4 py-3 mb-3">
          <div className="text-amber-300 text-xs font-semibold mb-1">
            Live rows re-simulated at {data?.threshold} / {data?.stopPct}% — history is not
          </div>
          <div className="text-[11px] text-amber-200/80 leading-relaxed">{data?.parameter_note}</div>
        </div>
      )}

      {/* Coverage. Every candidate we could not simulate is accounted for
          rather than quietly missing from the table. */}
      {data && (data.tickers_warming > 0 || data.tickers_no_bars > 0 || !data.chart_service_ok || data.stale_rows > 0 || data.superseded_rows > 0) && (
        <div className="bg-surface border border-border rounded-lg px-4 py-3 mb-3">
          <div className="text-[11px] text-neutral leading-relaxed">
            <span className="text-slate-300 font-semibold">Coverage: </span>
            {data.tickers_scanned} tickers scanned of {data.universe_size} in the clean listed-US universe
            {data.tickers_warming > 0 && ` · ${data.tickers_warming} still collecting messages`}
            {data.tickers_no_bars > 0 && ` · ${data.tickers_no_bars} with no intraday bars`}
            {data.stale_rows > 0 && ` · ${data.stale_rows} recorded row${data.stale_rows === 1 ? '' : 's'} frozen mid-session (marked Stale)`}
            {data.superseded_rows > 0 && ` · ${data.superseded_rows} withdrawn after a later simulation of the same session no longer produced them`}
            {!data.chart_service_ok && ' · chart-service unreachable, so no live positions could be simulated'}
            {data.history_truncated && ` · history truncated at ${data.history_rows} rows`}
            . Tickers that could not be simulated appear in Watch with the reason, not omitted.
          </div>
        </div>
      )}

      {/* Controls: both parameters server-bound. */}
      <div className="bg-surface border border-border rounded-lg px-4 py-3 mb-3">
        <div className="grid gap-3 md:grid-cols-2">
          <label className="flex items-center gap-3">
            <span className="text-[10px] text-neutral uppercase tracking-wide font-medium whitespace-nowrap w-28">
              Entry threshold
            </span>
            <input
              type="range" min={0.05} max={1} step={0.05} value={threshold}
              onChange={e => setThreshold(Number(e.target.value))}
              className="flex-1 min-w-[120px] accent-sky-500"
            />
            <span className="font-mono text-white text-sm w-10 text-right">{threshold.toFixed(2)}</span>
          </label>
          <label className="flex items-center gap-3">
            <span className="text-[10px] text-neutral uppercase tracking-wide font-medium whitespace-nowrap w-28">
              Trailing stop %
            </span>
            <input
              type="range" min={1} max={30} step={1} value={stopPct}
              onChange={e => setStopPct(Number(e.target.value))}
              className="flex-1 min-w-[120px] accent-sky-500"
            />
            <span className="font-mono text-white text-sm w-10 text-right">{stopPct}%</span>
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-3 mt-3">
          {resimulating && (
            <span className="inline-flex items-center gap-1.5 rounded border border-sky-500/40 bg-sky-500/10 px-2 py-1 text-[10px] uppercase tracking-wide text-sky-300">
              <span className="h-1.5 w-1.5 rounded-full bg-sky-300 animate-pulse" />
              Re-simulating
            </span>
          )}
          {!resimulating && !offCanonical && (
            <span className="rounded border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-[10px] uppercase tracking-wide text-emerald-300">
              Canonical settings
            </span>
          )}
          <button
            onClick={() => { setThreshold(data?.canonical.threshold ?? 0.1); setStopPct(data?.canonical.stop_pct ?? 5) }}
            disabled={!offCanonical}
            className="rounded border border-border px-2 py-1 text-[10px] uppercase tracking-wide text-neutral hover:text-white disabled:opacity-40"
          >
            Reset to canonical
          </button>
          {orderBy && (
            <button
              onClick={() => setOrderBy('')}
              className="rounded border border-border px-2 py-1 text-[10px] uppercase tracking-wide text-neutral hover:text-white"
            >
              Reset order
            </button>
          )}
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input type="checkbox" checked={showWatch} onChange={e => setShowWatch(e.target.checked)} className="accent-sky-500" />
            <span className="text-[10px] text-neutral uppercase tracking-wide font-medium">
              Show watch candidates ({watchRows.length})
            </span>
          </label>
        </div>

        <div className="text-[10px] text-slate-500 mt-2 leading-relaxed">
          <span className="text-slate-400 italic">
            Canonical {data?.canonical.threshold ?? 0.1} / {data?.canonical.stop_pct ?? 5}% are the sweep-optimal values
            from the professor sweep analysis; provisional, pending validation against the corrected backtest.
          </span>
          <br />
          Both sliders re-run the simulation server-side — the entry threshold decides which trades exist at all, so it
          cannot be applied to an already-computed table. Recorded history is written only at the canonical settings.
        </div>
      </div>

      {isLoading && !data ? (
        <div className="text-neutral text-sm animate-pulse p-4">Loading positions...</div>
      ) : (data?.count ?? 0) === 0 ? (
        <div className="text-center py-12 text-neutral">
          <div className="text-3xl mb-2">📓</div>
          <div className="text-sm">{data?.note || 'No simulated positions and no recorded history yet'}</div>
        </div>
      ) : (
        <div className={clsx('space-y-4 transition-opacity', resimulating && 'opacity-50')}>
          {GROUPS.map(group => (
            <GroupTable
              key={group.key}
              title={group.title}
              blurb={group.blurb}
              rows={grouped[group.key] ?? []}
              columns={COLUMNS}
              orderBy={orderBy}
              orderDir={orderDir}
              onSort={toggleSort}
              emptyLabel={
                group.key === 'closed_earlier'
                  ? 'No recorded history yet — the scheduler writes it as sessions close.'
                  : `No ${group.title.toLowerCase()} positions.`
              }
            />
          ))}

          {showWatch && (
            <GroupTable
              title="Watch candidates"
              blurb="Scanned but never triggered an entry, or could not be simulated. Shown so the candidate count and the visible rows agree."
              rows={watchRows}
              columns={COLUMNS}
              orderBy={orderBy}
              orderDir={orderDir}
              onSort={toggleSort}
              emptyLabel="No watch candidates."
            />
          )}
        </div>
      )}
    </div>
  )
}

function GroupTable({
  title, blurb, rows, columns, orderBy, orderDir, onSort, emptyLabel,
}: {
  title: string
  blurb: string
  rows: PositionScreenerRow[]
  columns: Array<{ key: string; label: string; title?: string }>
  orderBy: string
  orderDir: 'asc' | 'desc'
  onSort: (key: string) => void
  emptyLabel: string
}) {
  return (
    <div className="bg-surface border border-border rounded-lg overflow-hidden">
      <div className="px-4 py-2 border-b border-border bg-bg/40">
        <div className="flex items-baseline gap-2">
          <span className="text-white text-sm font-semibold">{title}</span>
          <span className="font-mono text-xs text-neutral">{rows.length}</span>
        </div>
        <div className="text-[10px] text-slate-500 mt-0.5">{blurb}</div>
      </div>
      {rows.length === 0 ? (
        <div className="px-4 py-4 text-[11px] text-neutral">{emptyLabel}</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="border-b border-border bg-bg/50">
              <tr>
                {columns.map(col => (
                  <th
                    key={col.key}
                    title={col.title}
                    onClick={() => onSort(col.key)}
                    className="px-2 py-2 text-left text-[10px] text-neutral uppercase tracking-wide font-medium whitespace-nowrap cursor-pointer hover:text-white select-none"
                  >
                    {col.label}
                    {orderBy === col.key && <span className="ml-0.5">{orderDir === 'desc' ? '▾' : '▴'}</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700/30">
              {rows.map(row => (
                <PositionRow key={`${row.ticker}-${row.date}-${row.entry_epoch ?? 'watch'}`} row={row} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function PositionRow({ row }: { row: PositionScreenerRow }) {
  const isOpen = row.group === 'open'
  const nearStop = isOpen && row.distance_to_stop_pct != null && row.distance_to_stop_pct <= NEAR_STOP_PCT
  const isWatch = row.group === 'watch'
  // Never concluded: flagged on the row itself, not only in the DATA column.
  const unsettled = row.data_status === 'stale'

  return (
    <tr className={clsx(
      'hover:bg-card-hover transition-colors',
      nearStop && 'bg-amber-500/10',
      unsettled && 'bg-fuchsia-500/[0.07]',
    )}>
      <td className="px-2 py-2 whitespace-nowrap">
        <span className="font-mono font-bold text-accent">{row.ticker}</span>
        {row.company && <span className="text-slate-500 ml-1.5 truncate inline-block max-w-[110px] align-bottom">{row.company}</span>}
      </td>
      <td className="px-2 py-2 whitespace-nowrap">
        <span className="font-mono text-neutral">{row.date ?? '—'}</span>
      </td>

      {/* Entry: price, ET time, and the correlation that fired it */}
      <td className="px-2 py-2 whitespace-nowrap">
        {isWatch ? (
          <span className="text-neutral" title="No entry: the rolling correlation never crossed up through the threshold in this session.">
            never triggered
            {row.price_density_corr != null && (
              <span className="font-mono text-slate-500 ml-1">corr {row.price_density_corr.toFixed(3)}</span>
            )}
          </span>
        ) : (
          <span className="font-mono">
            <span className="text-white">{fmtMoney(row.entry_price)}</span>
            <span className="text-neutral ml-1">{row.entry_time ?? '—'}</span>
            {row.entry_corr != null && (
              <span className="text-slate-500 ml-1" title="Rolling price×density correlation at the entry bar">
                @{row.entry_corr.toFixed(3)}
              </span>
            )}
          </span>
        )}
      </td>

      {/* Exit if it happened, otherwise the stop currently being worked */}
      <td className="px-2 py-2 whitespace-nowrap">
        {isWatch ? (
          <span className="text-neutral">—</span>
        ) : isOpen ? (
          <span className="font-mono">
            <span className="text-neutral" title="Trailing stop = post-entry peak × (1 − stop%)">
              stop {fmtMoney(row.stop_price)}
            </span>
            <span className="text-slate-500 ml-1">peak {fmtMoney(row.peak_price)}</span>
          </span>
        ) : (
          <span className="font-mono">
            <span className={unsettled ? 'text-slate-400' : 'text-white'}>{fmtMoney(row.exit_price)}</span>
            <span className="text-neutral ml-1">{row.exit_time ?? ''}</span>
            <span
              className={clsx(
                'ml-1',
                row.exit_reason === 'correlation_break' ? 'text-amber-300'
                  : row.exit_reason === 'price_trailing_stop' ? 'text-red-300' : 'text-slate-500',
              )}
              title={row.exit_corr != null ? `Exit corr ${row.exit_corr.toFixed(3)}` : undefined}
            >
              {unsettled ? 'No close' : exitReasonLabel(row.exit_reason)}
            </span>
          </span>
        )}
      </td>

      {/* P&L, explicitly labelled realized or unrealized */}
      <td className="px-2 py-2 whitespace-nowrap">
        {row.pnl_pct == null ? (
          <span className="font-mono text-neutral">—</span>
        ) : (
          <span className="font-mono">
            <span
              className={clsx(
                unsettled
                  ? 'text-slate-400 italic'            // drained of the win/loss signal it has not earned
                  : row.pnl_pct >= 0 ? 'text-emerald-400' : 'text-red-400',
              )}
            >
              {unsettled ? '~' : ''}{fmtPct(row.pnl_pct, true)}
            </span>
            <span
              className={clsx(
                'text-[9px] uppercase tracking-wide ml-1',
                unsettled ? 'text-fuchsia-300' : 'text-slate-500',
              )}
              title={unsettled
                ? 'Not a result: a frozen mid-session mark from a position that never closed.'
                : row.pnl_is_realized
                  ? 'Realized: measured to the actual exit fill.'
                  : 'Unrealized: marked to the latest bar and still moving.'}
            >
              {unsettled ? 'not settled' : row.pnl_is_realized ? 'real' : 'unreal'}
            </span>
          </span>
        )}
      </td>

      {/* Only meaningful while a stop is actually being worked. On a closed
          position the stored distance is the gap between the fill and the stop
          it tripped through, which under this header reads as though the
          position were still live. */}
      <td className="px-2 py-2 whitespace-nowrap">
        {isOpen && row.distance_to_stop_pct != null ? (
          <span className={clsx('font-mono', nearStop ? 'text-amber-300' : 'text-white')}>
            {fmtPct(row.distance_to_stop_pct)}
          </span>
        ) : (
          <span className="font-mono text-neutral">—</span>
        )}
      </td>

      {/* The parameters THIS row was simulated under — not the slider position */}
      <td className="px-2 py-2 whitespace-nowrap">
        <span className="font-mono text-slate-500 text-[10px]">
          {row.threshold != null ? row.threshold.toFixed(2) : '—'} / {row.stop_pct != null ? `${row.stop_pct}%` : '—'}
        </span>
      </td>

      <td className="px-2 py-2 whitespace-nowrap">
        <DataBadge status={row.data_status} />
      </td>
    </tr>
  )
}
