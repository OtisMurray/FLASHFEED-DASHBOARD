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
    blurb: 'Exited during the CURRENT calendar session, simulated live. Empty outside market hours — once the date '
      + 'rolls past midnight ET the session that just ended is a previous session, and its trades move down.',
    sortKey: 'exit_time',
    dir: 'desc',
  },
  {
    key: 'closed_earlier',
    title: 'Closed earlier',
    blurb: 'Sessions that are over, read back from recorded history at the canonical parameters. Strictly before '
      + 'today\'s date — a trade is never in both groups. These never disappear; they only move down.',
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
  // A real fill at the 16:00 bar, not a stop and not a mid-session mark: the
  // regular-hours gate flattens a non-exempt position at the close rather than
  // carrying it into hours it could not be managed in.
  if (value === 'rth_close') return 'Closed 16:00'
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
    const visibleRows = rows.filter(row => row.data_status !== 'stale')
    const out = {} as Record<PositionGroup, PositionScreenerRow[]>
    for (const group of ['open', 'closed_today', 'closed_earlier', 'watch'] as PositionGroup[]) {
      const subset = visibleRows.filter(row => row.group === group)
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
  const visibleCounts = useMemo(() => ({
    open: grouped.open?.length ?? 0,
    closed_today: grouped.closed_today?.length ?? 0,
    closed_earlier: grouped.closed_earlier?.length ?? 0,
  }), [grouped])
  const offCanonical = data ? !data.is_canonical : false
  const watchRows = grouped.watch ?? []

  // Overall P&L. Two buckets, kept apart on purpose:
  //
  //   realized   — pnl_is_realized === true. The trade reached a conclusion, so
  //                the number is final. Covers today's closed rows (simulated
  //                live) and earlier sessions (read back from history).
  //   unrealized — still open, marked to the latest bar. Moves until it closes.
  // Watch rows have no P&L at all and fall out naturally.
  //
  // DEDUPLICATION IS NOW DEFENCE IN DEPTH. It was originally load-bearing: the
  // route hardcoded live rows as closed_today regardless of which session the
  // simulator had actually covered, so after midnight ET the same trade came
  // back twice — once live, once from recorded history — and summing them
  // reported +5.46% where the truth was +24.94%.
  //
  // positionScreener.js now classifies live rows by their real session date and
  // drops any that recorded history already describes, so the response should no
  // longer contain a duplicate at all. This stays because the cost is one Map
  // and the failure it prevents is silent and financial: a total that
  // double-counts looks entirely plausible. `collapsed` is surfaced in the UI,
  // so if the server ever regresses, the page says so instead of quietly
  // inflating. Expect it to read 0.
  //
  // Identity is ticker + session + entry time + entry price: the same strategy
  // entry, however it was reconstructed. Where a trade appears as both, the
  // RECORDED row wins — it is the settled figure written at the canonical
  // parameters, whereas the live row reflects whatever the sliders currently say.
  //
  // UNITS: every pnl_pct is a per-trade percentage return, and the API carries no
  // position size. Summing them is only meaningful if each trade got the same
  // capital, so the total is labelled in percentage points and the assumption is
  // stated in the UI rather than implied by a dollar sign.
  const pnl = useMemo(() => {
    const rows = (data?.rows ?? []).filter(row => row.data_status !== 'stale')
    const identity = (r: PositionScreenerRow) =>
      [r.ticker, r.date ?? '', r.entry_time ?? '', r.entry_price ?? ''].join('|')
    const dedupe = (subset: PositionScreenerRow[]) => {
      const byTrade = new Map<string, PositionScreenerRow>()
      for (const row of subset) {
        const k = identity(row)
        const held = byTrade.get(k)
        if (!held || (held.data_status !== 'recorded' && row.data_status === 'recorded')) byTrade.set(k, row)
      }
      return [...byTrade.values()]
    }
    const bucket = (subset: PositionScreenerRow[]) => {
      const unique = dedupe(subset)
      const values = unique.map(r => r.pnl_pct).filter((v): v is number => v != null)
      const sum = values.reduce((a, b) => a + b, 0)
      return {
        n: values.length,
        sum,
        mean: values.length ? sum / values.length : null,
        wins: values.filter(v => v > 0).length,
        collapsed: subset.length - unique.length,
      }
    }
    const realized = bucket(rows.filter(r => r.pnl_is_realized === true))
    const unrealized = bucket(rows.filter(r => r.group === 'open' && r.pnl_is_realized !== true))
    return {
      realized,
      unrealized,
      combined: realized.sum + unrealized.sum,
      collapsed: realized.collapsed + unrealized.collapsed,
      sessions: new Set(rows.map(r => r.date).filter(Boolean)).size,
    }
  }, [data])

  const COLUMNS: Array<{ key: string; label: string; title?: string }> = [
    { key: 'ticker', label: 'TICKER' },
    { key: 'ai_rank_score', label: 'AI SUGGESTION', title: 'The AI ranking snapshot that admitted this ticker to the Positions candidate set' },
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
            The dashboard&apos;s non-bearish AI suggestions are passed through Aman&apos;s rolling-correlation entry and
            trailing-stop exit simulation. Open positions sit at the top; closed ones move down and stay. Today is
            simulated live; earlier sessions are read back from recorded history.
          </p>
        </div>
        <span className="text-neutral text-sm whitespace-nowrap">
          {counts
            ? `${visibleCounts.open} open · ${visibleCounts.closed_today} closed today · ${visibleCounts.closed_earlier} earlier`
            : '—'}
        </span>
      </div>

      {data && (
        <div className="bg-sky-500/10 border border-sky-500/40 rounded-lg px-4 py-3 mb-3">
          <div className="text-sky-200 text-xs font-semibold mb-1">AI-qualified candidate universe</div>
          <div className="text-[11px] text-sky-100/75 leading-relaxed">
            New candidates come from the canonical AI Rankings feed, exclude bearish/down predictions, and require
            an AI score of at least {data.ai_status?.min_score ?? 50}. The AI chooses what to inspect; the existing
            correlation and trailing-stop strategy still decides entries and exits.
            {data.ai_status?.generated_at && ` Ranking snapshot: ${new Date(data.ai_status.generated_at).toLocaleString()}.`}
            {data.ai_status?.error && ` AI feed unavailable: ${data.ai_status.error}`}
          </div>
        </div>
      )}

      {/* Overall P&L. Sits above the fold because it is the question the page
          exists to answer, but every figure is qualified in place rather than in
          a footnote: realized vs unrealized are never merged into a single
          number without both being shown. */}
      {data && (pnl.realized.n > 0 || pnl.unrealized.n > 0) && (
        <div className="bg-surface border border-border rounded-lg px-4 py-3 mb-3">
          <div className="flex flex-wrap items-stretch gap-x-8 gap-y-3">
            <PnlStat
              label="Realized"
              hint="Closed positions that reached a conclusion — stopped out, correlation break, or closed at the bell. Final."
              sum={pnl.realized.sum}
              n={pnl.realized.n}
              mean={pnl.realized.mean}
              wins={pnl.realized.wins}
            />
            <PnlStat
              label="Unrealized"
              hint="Open positions, marked to the latest bar. Moves until the position closes."
              sum={pnl.unrealized.sum}
              n={pnl.unrealized.n}
              mean={pnl.unrealized.mean}
              wins={pnl.unrealized.wins}
              emptyLabel={pnl.unrealized.n === 0 ? 'No open positions' : undefined}
            />
            <div className="border-l border-border pl-8">
              <PnlStat
                label="Combined"
                hint="Realized + unrealized."
                sum={pnl.combined}
                n={pnl.realized.n + pnl.unrealized.n}
                emphasis
              />
            </div>
          </div>

          {/* The two things that would otherwise make the headline misleading. */}
          <div className="text-[10px] text-slate-500 mt-3 leading-relaxed border-t border-border pt-2 space-y-1">
            <div>
              Percentage points, summed across distinct trades — equivalent to equal capital per position. The API
              carries no position size, so this is deliberately not shown as a dollar figure.
              {pnl.sessions === 1 && ' All rows are from a single session, so this is one day, not a track record.'}
            </div>
            {pnl.collapsed > 0 && (
              <div>
                {pnl.collapsed} duplicate row{pnl.collapsed === 1 ? '' : 's'} collapsed. A trade from a session that has
                since closed is returned twice — once simulated live, once read back from recorded history. The table
                shows both so the Data badge stays meaningful; the total counts each trade once.
              </div>
            )}
            {offCanonical ? (
              <div className="text-amber-200/80">
                Sliders are off canonical ({data.threshold} / {data.stopPct}%). Only today&apos;s live rows were
                re-simulated at these settings — recorded history is still at the canonical{' '}
                {data.canonical.threshold} / {data.canonical.stop_pct}%, so this total mixes two parameter sets and is
                not a what-if for the full period.
              </div>
            ) : (
              <div>
                Canonical {data.canonical.threshold} / {data.canonical.stop_pct}% history only. Moving a slider
                re-simulates today but cannot re-simulate past sessions, so this total is not a what-if.
              </div>
            )}
          </div>
        </div>
      )}

      {/* Simulated, never executed. The first thing to say on a page whose
          headline column is profit. */}
      <div className="bg-slate-500/10 border border-slate-500/40 rounded-lg px-4 py-3 mb-3">
        <div className="text-slate-200 text-xs font-semibold mb-1">Simulated positions — never executed</div>
        <div className="text-[11px] text-slate-300/80 leading-relaxed">
          {data?.simulation_note
            ?? 'No order was placed and no fill is real. These are the entries and exits the strategy would have taken.'}
        </div>
      </div>

      {/* Session boundary. Between midnight ET and the next premarket open the
          simulator is still covering YESTERDAY, so "Closed today" is legitimately
          empty and the most recent trades sit under Closed earlier. Without this
          the page looks broken for those hours — the professor checking at 1am
          sees an empty top group and 16 rows below it with no explanation. */}
      {data?.live_session_is_today === false && data.live_session_date && (
        <div className="bg-slate-500/10 border border-slate-500/40 rounded-lg px-4 py-3 mb-3">
          <div className="text-slate-200 text-xs font-semibold mb-1">
            Between sessions — the latest simulated session is {data.live_session_date}, not today
          </div>
          <div className="text-[11px] text-slate-300/80 leading-relaxed">
            Today&apos;s session has not produced bars yet, so &ldquo;Closed today&rdquo; is empty and {data.live_session_date}&apos;s
            trades appear under &ldquo;Closed earlier&rdquo; from recorded history. They will stay there. This is the
            normal state outside market hours, not missing data.
          </div>
        </div>
      )}

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
      {data && (data.tickers_warming > 0 || data.tickers_no_bars > 0 || !data.chart_service_ok || data.superseded_rows > 0) && (
        <div className="bg-surface border border-border rounded-lg px-4 py-3 mb-3">
          <div className="text-[11px] text-neutral leading-relaxed">
            <span className="text-slate-300 font-semibold">Coverage: </span>
            {data.tickers_scanned} tickers scanned of {data.universe_size} in the clean listed-US universe
            {data.tickers_warming > 0 && ` · ${data.tickers_warming} still collecting messages`}
            {data.tickers_no_bars > 0 && ` · ${data.tickers_no_bars} with no intraday bars`}
            {data.superseded_rows > 0 && ` · ${data.superseded_rows} withdrawn after a later simulation of the same session no longer produced them`}
            {!data.chart_service_ok && ' · chart-service unreachable, so no live positions could be simulated'}
            {data.history_truncated && ` · history truncated at ${data.history_rows} rows`}
            . Tickers that could not be simulated appear in Watch with the reason, not omitted.
          </div>
        </div>
      )}

      {/* Trading hours. Rendered UNCONDITIONALLY when the chart-service reports
          it: the restriction changes which trades exist at all, so it is stated
          on every load rather than surfacing only when something went wrong.
          A missing policy is reported as unreported, never as unrestricted. */}
      {data && (
        <div className="bg-surface border border-border rounded-lg px-4 py-3 mb-3">
          <div className="text-[11px] text-neutral leading-relaxed">
            <span className="text-slate-300 font-semibold">Trading hours: </span>
            {!data.rth ? (
              <>not reported by the chart-service, so whether the regular-hours
                restriction applied to these rows is unknown.</>
            ) : !data.rth.restricted ? (
              <>unrestricted — entries and exits may fire across the full
                04:00–20:00 ET session for every ticker.</>
            ) : (
              <>
                entries and exits only fire {data.rth.open_et}–{data.rth.close_et} ET.
                A correlation crossing outside those hours is dropped, not deferred,
                and an open position is flattened at {data.rth.close_et} rather than
                carried into hours it cannot be managed in. The 360-minute
                correlation still warms up across the whole session — this gates
                the action, not the indicator.
                {data.rth.exempt_count > 0 ? (
                  <> Exempt ({data.rth.exempt_count}), trading the full session:{' '}
                    <span className="text-slate-300 font-mono">
                      {data.rth.exempt_tickers.join(', ')}
                    </span>.
                  </>
                ) : (
                  <> No tickers are exempt.</>
                )}
              </>
            )}
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

function PnlStat({
  label, hint, sum, n, mean, wins, emphasis, emptyLabel,
}: {
  label: string
  hint: string
  sum: number
  n: number
  mean?: number | null
  wins?: number
  emphasis?: boolean
  emptyLabel?: string
}) {
  // A zero total from zero trades is not a flat result — it is an absent one.
  // Showing "0.00%" for both would make "no open positions" read as "open
  // positions are breaking even".
  const empty = n === 0
  const tone = empty ? 'text-neutral' : sum > 0 ? 'text-emerald-400' : sum < 0 ? 'text-red-400' : 'text-slate-300'
  return (
    <div title={hint}>
      <div className="text-[10px] text-neutral uppercase tracking-wide font-medium">{label}</div>
      <div className={clsx('font-mono tabular-nums leading-tight', emphasis ? 'text-2xl' : 'text-xl', tone)}>
        {empty ? (emptyLabel ?? '—') : fmtPct(sum, true)}
      </div>
      <div className="text-[10px] text-slate-500 mt-0.5">
        {empty
          ? '0 trades'
          : `${n} trade${n === 1 ? '' : 's'}`
            + (mean != null ? ` · avg ${fmtPct(mean, true)}` : '')
            + (wins != null ? ` · ${wins}/${n} up` : '')}
      </div>
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
  // Entered on the newest real bar, so there is no elapsed session to have a
  // return over yet. Same honesty convention as `unsettled`: the P&L cell says
  // what the row is instead of printing a 0.00% that reads as a flat outcome.
  const pnlPending = row.pnl_pending === true && !unsettled

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
        {row.ai_rank_score == null ? (
          <span className="text-neutral" title="This recorded row predates AI candidate provenance.">prior history</span>
        ) : (
          <span className="font-mono">
            <span className={row.ai_direction === 'bullish' ? 'text-emerald-400' : 'text-sky-300'}>
              {row.ai_direction === 'bullish' ? 'Bullish' : 'Watch'} {row.ai_rank_score.toFixed(1)}
            </span>
            {row.ai_rank != null && <span className="text-slate-500 ml-1">#{row.ai_rank}</span>}
            {row.candidate_source === 'tracked_open_position' && (
              <span className="text-amber-300 ml-1" title="Kept in the scan after leaving the current AI list so its exit can still be recorded.">tracked</span>
            )}
          </span>
        )}
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
        ) : pnlPending ? (
          // No percentage at all: the fill IS the mark, so any number here would
          // be asserting an outcome the position has not had time to have.
          <span
            className="font-mono text-[11px] text-sky-300 italic"
            title={'Entered on the newest bar of the session — the mark is the fill, so there is no '
              + 'elapsed session to measure a return over yet. A P&L appears once the tape prints '
              + 'past the entry.'}
          >
            just entered
            <span className="text-[9px] uppercase tracking-wide ml-1 not-italic text-sky-500/80">
              no elapsed session
            </span>
          </span>
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
