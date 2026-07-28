'use client'
import useSWR from 'swr'
import { useState, useMemo } from 'react'
import { clsx } from 'clsx'
import type {
  SqueezeScreenerRow,
  SqueezeScreenerResponse,
  SqueezeGateCheck,
  SqueezeSiCoverage,
} from '@/lib/types'

// Short Squeeze — the existing squeeze-evidence gate from routes/screener.js,
// shown against live rows and joined with the FINRA-derived short-interest
// estimates. There is NO score on this page that does not already exist
// elsewhere: the squeeze score is the one /api/screener already computes, and the
// pass/fail column is predictionEvidenceValidation's own verdict.
//
// Two things this page must be honest about, per row and not merely in aggregate:
//
//   1. The short-interest number is UNCALIBRATED (k=0.25 fallback, never fitted
//      against a realised settlement), and some tickers have no FINRA daily
//      coverage at all and are showing a settlement figure passed through
//      unchanged — a materially different claim. The COVERAGE column carries that
//      distinction on every row.
//   2. The gate's social leg is measured over the ADAPTIVE rolling window
//      (5-120 minutes by market-cap tier), not a session total. That leg is what
//      blocks essentially every candidate during quiet windows, so the GATE
//      column names the failing leg rather than just showing a red dot.
//
// Near misses are shown by DEFAULT and ranked by how close they are. A page that
// only rendered passing rows would be empty most of the time and would teach
// nothing about why.

const fetcher = (url: string) => fetch(url).then(r => r.json())

const COVERAGE_LABEL: Record<SqueezeSiCoverage, string> = {
  live_estimate: 'Live estimate',
  settlement_only: 'Settlement only',
  finviz_only: 'Finviz only',
  none: 'No data',
}

const COVERAGE_TITLE: Record<SqueezeSiCoverage, string> = {
  live_estimate:
    'FINRA daily short volume layered on the last settlement figure. UNCALIBRATED: the dampening ' +
    'constant falls back to k=0.25 and has not been fitted against a realised settlement.',
  settlement_only:
    'No FINRA daily coverage for this ticker since the last settlement. This is the official ' +
    'settlement figure passed through unchanged — it is not an estimate and it is up to a month stale.',
  finviz_only:
    'No short-interest snapshot exists for this ticker at all. This is Finviz float_short off the ' +
    'quote row — the stale behaviour that predated the estimator.',
  none: 'No short-interest figure from any source.',
}

const COVERAGE_TONE: Record<SqueezeSiCoverage, string> = {
  live_estimate: 'text-sky-300 border-sky-500/40 bg-sky-500/10',
  settlement_only: 'text-amber-300 border-amber-500/40 bg-amber-500/10',
  finviz_only: 'text-amber-400 border-amber-600/40 bg-amber-600/10',
  none: 'text-neutral border-border bg-bg',
}

const CHECK_SHORT_LABEL: Record<string, string> = {
  squeeze_score: 'score',
  verified_short_interest: 'short int',
  social: 'social',
  not_bearish_catalyst: 'catalyst',
}

function fmtCompact(n: number | undefined | null): string {
  if (n == null) return '—'
  if (n >= 1e12) return `${(n / 1e12).toFixed(1)}T`
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`
  return n.toLocaleString()
}

function fmtPct(n: number | undefined | null, digits = 2, signed = false): string {
  if (n == null) return '—'
  return `${signed && n > 0 ? '+' : ''}${n.toFixed(digits)}%`
}

function squeezeTone(score: number | null | undefined): string {
  if (score == null) return 'text-neutral'
  if (score >= 70) return 'text-emerald-400'
  if (score >= 55) return 'text-emerald-300/80'
  if (score >= 40) return 'text-amber-400'
  return 'text-slate-400'
}

// Per-leg dots. Each carries the observed-vs-required numbers in its tooltip, so
// a blocked row explains itself without a drill-down.
function GateChecks({ checks }: { checks: SqueezeGateCheck[] }) {
  return (
    <span className="inline-flex items-center gap-1">
      {checks.map(check => (
        <span
          key={check.key}
          title={`${check.label}\nobserved: ${check.observed ?? 'none'}${
            check.required != null ? `\nrequired: ${check.required}` : ''
          }${check.window_minutes ? `\nwindow: ${check.window_minutes} min` : ''}`}
          className={clsx(
            'rounded px-1 py-0.5 text-[9px] uppercase tracking-wide border',
            check.ok
              ? 'text-emerald-300 border-emerald-500/40 bg-emerald-500/10'
              : 'text-red-300 border-red-500/40 bg-red-500/10'
          )}
        >
          {CHECK_SHORT_LABEL[check.key] ?? check.key}
        </span>
      ))}
    </span>
  )
}

function CoverageBadge({ row }: { row: SqueezeScreenerRow }) {
  const coverage = row.si_coverage ?? 'none'
  // Uncalibrated only means anything for an actual estimate; on a passthrough the
  // question does not apply and the server sends null, which must not read as
  // "calibrated".
  const uncalibrated = coverage === 'live_estimate' && row.si_uncalibrated === true
  return (
    <span className="inline-flex items-center gap-1">
      <span
        title={COVERAGE_TITLE[coverage]}
        className={clsx('rounded px-1.5 py-0.5 text-[9px] uppercase tracking-wide border whitespace-nowrap', COVERAGE_TONE[coverage])}
      >
        {COVERAGE_LABEL[coverage]}
      </span>
      {uncalibrated && (
        <span
          title={
            `Uncalibrated: ${row.si_calibration_status ?? 'no fitted constant'}. ` +
            'k falls back to 0.25 and has never been checked against a realised settlement.' +
            (row.si_note ? `\n\n${row.si_note}` : '')
          }
          className="rounded px-1 py-0.5 text-[9px] uppercase tracking-wide border border-amber-500/40 bg-amber-500/10 text-amber-300"
        >
          uncal
        </span>
      )}
    </span>
  )
}

const COLUMNS: Array<{ key: string; label: string; title?: string }> = [
  { key: 'ticker', label: 'TICKER' },
  { key: 'company', label: 'COMPANY' },
  { key: 'squeeze_score', label: 'SQUEEZE', title: 'Existing short_squeeze_score from /api/screener — not computed by this page' },
  { key: 'short_interest_official_pct', label: 'OFFICIAL SI%', title: 'Last FINRA settlement figure' },
  { key: 'short_interest_live_estimate', label: 'LIVE EST SI%', title: 'FINRA daily short volume layered on the settlement figure' },
  { key: 'short_interest_delta_pct', label: 'DELTA', title: 'Live estimate minus the official settlement figure' },
  { key: 'si_coverage', label: 'COVERAGE', title: 'Where this row\'s short-interest number came from, and whether it is calibrated' },
  { key: 'days_to_cover', label: 'D2C', title: 'Days to cover, where available' },
  { key: 'float_shares', label: 'FLOAT' },
  { key: 'social_messages', label: 'SOCIAL', title: 'Messages in the adaptive rolling window — the gate\'s social input' },
  { key: 'gate', label: 'EVIDENCE GATE', title: 'predictionEvidenceValidation\'s verdict and the leg that blocked it' },
]

export function SqueezeScreenerPage() {
  const [passingOnly, setPassingOnly] = useState(false)
  const [limit, setLimit] = useState('50')
  const [orderBy, setOrderBy] = useState<string>('')
  const [orderDir, setOrderDir] = useState<'asc' | 'desc'>('desc')

  const query = useMemo(() => {
    const p = new URLSearchParams({ limit })
    if (passingOnly) p.set('passing_only', '1')
    return p.toString()
  }, [limit, passingOnly])

  const { data, isLoading } = useSWR<SqueezeScreenerResponse>(`/api/squeeze-screener?${query}`, fetcher, {
    // Short interest moves on a daily ingest cadence; the social leg moves with
    // the market. A minute is a fair compromise and matches the other screeners.
    refreshInterval: 60_000,
  })

  const rows: SqueezeScreenerRow[] = useMemo(() => {
    const all = data?.rows ?? []
    if (!orderBy) return all               // keep the server's gate-aware ordering
    return [...all].sort((a, b) => {
      const av = (a as unknown as Record<string, unknown>)[orderBy]
      const bv = (b as unknown as Record<string, unknown>)[orderBy]
      if (av == null && bv == null) return 0
      if (av == null) return 1             // nulls always last
      if (bv == null) return -1
      if (typeof av === 'string' && typeof bv === 'string') {
        return orderDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av)
      }
      return orderDir === 'desc' ? Number(bv) - Number(av) : Number(av) - Number(bv)
    })
  }, [data, orderBy, orderDir])

  const toggleSort = (key: string) => {
    if (key === 'gate' || key === 'si_coverage') return    // not meaningfully orderable
    if (orderBy === key) setOrderDir(d => (d === 'asc' ? 'desc' : 'asc'))
    else { setOrderBy(key); setOrderDir('desc') }
  }

  const selectCls = 'bg-bg border border-border rounded px-2 py-1 text-xs text-white'
  const coverageCounts = data?.si_coverage_counts ?? {}

  return (
    <div>
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <h1 className="text-white font-semibold text-lg">Short Squeeze</h1>
          <p className="text-neutral text-xs mt-1 max-w-3xl leading-relaxed">
            The squeeze-evidence gate the prediction tabs already run, shown against live rows and joined
            with the daily FINRA-derived short-interest estimates. No scoring of its own — the squeeze
            score and the pass/fail verdict both come from the existing screener logic.
          </p>
        </div>
        <span className="text-neutral text-sm whitespace-nowrap">
          {data?.passing != null ? `${data.passing} passing` : '—'}
          {data?.candidate_pool != null ? ` · ${data.candidate_pool} candidates` : ''}
          {data?.universe_size != null ? ` of ${data.universe_size}` : ''}
        </span>
      </div>

      {/* Calibration disclosure. Same standing as the Long-Term Fundamentals data
          warning: the numbers are usable for ranking and unusable as a settled
          figure, and saying so once in the header is cheaper than a user
          discovering it from a bad fill. */}
      {data && (data.si_uncalibrated_rows ?? 0) > 0 && (
        <div className="bg-amber-500/10 border border-amber-500/40 rounded-lg px-4 py-3 mb-3">
          <div className="text-amber-300 text-xs font-semibold mb-1">
            Short-interest estimates are uncalibrated
            {data.si_all_uncalibrated ? ' — every live estimate on this page' : ` — ${data.si_uncalibrated_rows} of ${data.si_live_estimate_rows} live estimates`}
          </div>
          <div className="text-[11px] text-amber-200/80 leading-relaxed">{data.si_note}</div>
        </div>
      )}

      {/* Drift guard. If the per-check breakdown stops reproducing the gate's own
          verdict, the breakdown is wrong and must not be read as equal evidence. */}
      {data && (data.gate_trace_out_of_sync_rows ?? 0) > 0 && (
        <div className="bg-red-500/10 border border-red-500/40 rounded-lg px-4 py-3 mb-3">
          <div className="text-red-300 text-xs font-semibold mb-1">Gate trace is out of sync</div>
          <div className="text-[11px] text-red-200/80 leading-relaxed">{data.trace_warning}</div>
        </div>
      )}

      {/* Controls */}
      <div className="bg-surface border border-border rounded-lg px-4 py-3 mb-3">
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox" checked={passingOnly}
              onChange={e => setPassingOnly(e.target.checked)} className="accent-sky-500"
            />
            <span className="text-[10px] text-neutral uppercase tracking-wide font-medium">Passing gate only</span>
          </label>

          <label className="flex items-center gap-1.5">
            <span className="text-[10px] text-neutral uppercase tracking-wide font-medium">Rows</span>
            <select value={limit} onChange={e => setLimit(e.target.value)} className={selectCls}>
              <option value="25">25</option>
              <option value="50">50</option>
              <option value="100">100</option>
              <option value="200">200</option>
            </select>
          </label>

          {orderBy && (
            <button
              onClick={() => setOrderBy('')}
              className="text-[10px] text-neutral uppercase tracking-wide font-medium hover:text-white border border-border rounded px-2 py-1"
            >
              Reset order
            </button>
          )}

          <span className="flex flex-wrap items-center gap-2 text-[10px] text-neutral">
            {(['live_estimate', 'settlement_only', 'finviz_only'] as SqueezeSiCoverage[])
              .filter(key => (coverageCounts[key] ?? 0) > 0)
              .map(key => (
                <span
                  key={key}
                  title={COVERAGE_TITLE[key]}
                  className={clsx('rounded px-1.5 py-0.5 border uppercase tracking-wide', COVERAGE_TONE[key])}
                >
                  {coverageCounts[key]} {COVERAGE_LABEL[key]}
                </span>
              ))}
            {(data?.no_short_interest_data ?? 0) > 0 && (
              <span
                className="rounded px-1.5 py-0.5 border border-border bg-bg uppercase tracking-wide"
                title="Excluded from the candidate pool: no short-interest figure from any source, so the gate's verified-short-interest leg can never clear."
              >
                {data?.no_short_interest_data} no SI data (excluded)
              </span>
            )}
          </span>
        </div>

        <div className="text-[10px] text-slate-500 mt-2 leading-relaxed">
          <span className="text-slate-400 italic">{data?.gate_note}</span>
          <br />
          {data?.social_note}
        </div>
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="text-neutral text-sm animate-pulse p-4">Loading squeeze candidates...</div>
      ) : rows.length === 0 ? (
        <div className="text-center py-12 text-neutral">
          <div className="text-3xl mb-2">🔍</div>
          <div className="text-sm">
            {passingOnly && (data?.near_misses ?? 0) > 0
              ? `No candidate currently clears the full gate. ${data?.near_misses} near misses are hidden — untick "Passing gate only" to see what is blocking them.`
              : data?.note ?? 'No squeeze candidates'}
          </div>
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
                      title={col.title}
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
                {rows.map(row => (
                  <tr
                    key={row.ticker}
                    className={clsx('hover:bg-card-hover transition-colors', row.gate?.passed && 'bg-emerald-500/5')}
                  >
                    <td className="px-2 py-2 whitespace-nowrap">
                      <span className="font-mono font-bold text-accent">{row.ticker}</span>
                    </td>
                    <td className="px-2 py-2 whitespace-nowrap">
                      <span className="text-slate-300 truncate block max-w-[150px]" title={row.company}>
                        {row.company || '—'}
                      </span>
                    </td>
                    <td className="px-2 py-2 whitespace-nowrap">
                      <span className={clsx('font-mono font-bold', squeezeTone(row.squeeze_score))} title={row.squeeze_reason ?? undefined}>
                        {row.squeeze_score != null ? row.squeeze_score.toFixed(1) : '—'}
                      </span>
                    </td>
                    <td className="px-2 py-2 whitespace-nowrap">
                      <span
                        className="font-mono text-slate-300"
                        title={row.si_settlement_date ? `Settled ${row.si_settlement_date}` : undefined}
                      >
                        {fmtPct(row.short_interest_official_pct)}
                      </span>
                    </td>
                    <td className="px-2 py-2 whitespace-nowrap">
                      {/* Deliberately blank when there is no live estimate: a
                          settlement passthrough must not be shown in the estimate
                          column just because a number exists. */}
                      <span
                        className={clsx('font-mono', row.short_interest_live_estimate == null ? 'text-neutral' : 'text-sky-300')}
                        title={row.si_as_of_date ? `As of ${row.si_as_of_date}` : undefined}
                      >
                        {fmtPct(row.short_interest_live_estimate)}
                      </span>
                    </td>
                    <td className="px-2 py-2 whitespace-nowrap">
                      <span
                        className={clsx('font-mono', row.short_interest_delta_pct == null ? 'text-neutral'
                          : row.short_interest_delta_pct > 0 ? 'text-emerald-400' : 'text-red-400')}
                      >
                        {row.short_interest_delta_pct == null ? '—' : `${row.short_interest_delta_pct > 0 ? '+' : ''}${row.short_interest_delta_pct.toFixed(2)}`}
                      </span>
                    </td>
                    <td className="px-2 py-2 whitespace-nowrap">
                      <CoverageBadge row={row} />
                    </td>
                    <td className="px-2 py-2 whitespace-nowrap">
                      <span className="font-mono text-slate-300">
                        {row.days_to_cover != null ? row.days_to_cover.toFixed(2) : '—'}
                      </span>
                    </td>
                    <td className="px-2 py-2 whitespace-nowrap">
                      <span
                        className="font-mono text-neutral"
                        title={row.float_short_pct != null ? `${row.float_short_pct.toFixed(2)}% of float short (Finviz)` : undefined}
                      >
                        {fmtCompact(row.float_shares)}
                      </span>
                    </td>
                    <td className="px-2 py-2 whitespace-nowrap">
                      <span
                        className={clsx('font-mono', (row.social_messages ?? 0) >= 3 ? 'text-emerald-400' : 'text-neutral')}
                        title={`Messages in the adaptive rolling window (${row.social_window_minutes ?? '?'} min). This is the gate's social input, not a session total.`}
                      >
                        {row.social_messages ?? 0}
                        <span className="text-slate-600">/{row.social_window_minutes ?? '?'}m</span>
                      </span>
                    </td>
                    <td className="px-2 py-2 whitespace-nowrap">
                      <span className="inline-flex items-center gap-1.5">
                        <span
                          className={clsx(
                            'rounded px-1.5 py-0.5 text-[9px] uppercase tracking-wide border whitespace-nowrap',
                            row.gate?.passed
                              ? 'text-emerald-300 border-emerald-500/40 bg-emerald-500/10'
                              : 'text-slate-400 border-border bg-bg'
                          )}
                          title={row.gate?.reason}
                        >
                          {row.gate?.passed ? 'pass' : 'blocked'}
                        </span>
                        {row.gate?.trace_in_sync === false && (
                          <span
                            className="rounded px-1 py-0.5 text-[9px] uppercase tracking-wide border border-red-500/40 bg-red-500/10 text-red-300"
                            title="The per-check breakdown no longer reproduces the gate's verdict. Trust the pass/blocked label, not the legs."
                          >
                            drift
                          </span>
                        )}
                        <GateChecks checks={row.gate?.checks ?? []} />
                      </span>
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
