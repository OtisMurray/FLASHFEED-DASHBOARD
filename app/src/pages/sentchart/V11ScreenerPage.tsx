'use client'
import useSWR from 'swr'
import { clsx } from 'clsx'
import type { V11ScreenerResponse, V11ScreenerRow } from '@/lib/types'

// v11 Screener (EXPERIMENTAL PROFILE PROBE) — /api/v11-screener.
//
// This is NOT a third interchangeable screener. It replays ONE fixed backtest
// profile ("v11") over the catalyst-enriched prediction set, POSTMORTEM only, and
// reports what v11's entry gate + multi-leg exit would have done on each
// candidate's completed target session. Entry/exit reuse the production
// evaluatePredictionEntryThreshold + simulatePayoffCapture functions server-side.

const fetcher = (url: string) => fetch(url).then(r => r.json())

function fmtPct(n: number | null | undefined, digits = 2): string {
  if (n == null) return '—'
  return `${n >= 0 ? '+' : ''}${n.toFixed(digits)}%`
}
function fmtTime(sec: number | null | undefined): string {
  if (!sec) return '—'
  // Bars are naive-ET encoded as UTC seconds, so format in UTC to read back ET.
  const d = new Date(sec * 1000)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}
function pnlClass(n: number | null | undefined): string {
  if (n == null) return 'text-neutral'
  return n >= 0 ? 'text-emerald-400' : 'text-red-400'
}

const EXIT_REASON_LABEL: Record<string, string> = {
  profit_giveback_stop: 'Giveback stop',
  protective_stop: 'Protective stop (3%)',
  eod_flatten: 'EOD flatten',
  partial_profit_then_eod_flatten: 'Partial + EOD flatten',
  no_forward_bars: 'No forward bars',
}

function EvidenceCell({ row }: { row: V11ScreenerRow }) {
  const ev = row.evidence
  if (!ev || !ev.required) return <span className="text-neutral text-[10px]">n/a</span>
  if (ev.status === 'evidence_unavailable') {
    return <span className="text-amber-400 text-[10px]" title="Low-float name but no catalyst/social/short-interest data — guard fails closed">no data ✕</span>
  }
  const chips = [
    ev.catalystSupport && 'cat',
    ev.socialSupport && 'soc',
    ev.shortSupport && 'SI',
  ].filter(Boolean) as string[]
  return ev.ok
    ? <span className="text-emerald-400 text-[10px] font-mono" title="Low-float evidence support present">{chips.join('·') || 'ok'}</span>
    : <span className="text-red-400 text-[10px]" title="Low-float name with no supporting evidence">none ✕</span>
}

export function V11ScreenerPage() {
  const { data, isLoading } = useSWR<V11ScreenerResponse>('/api/v11-screener?limit=50', fetcher, { refreshInterval: 0 })
  const profile = data?.profile
  const rows = data?.rows ?? []

  return (
    <div>
      {/* Header with unmistakable experimental framing */}
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-2">
          <h1 className="text-white font-semibold text-lg">v11 Profile</h1>
          <span className="text-[10px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/40">
            Experimental · Postmortem
          </span>
        </div>
        <span className="text-neutral text-sm">
          {data ? `${data.entered} entered of ${data.candidates_scanned ?? rows.length} scanned` : '—'}
        </span>
      </div>

      {/* Profile banner — states exactly what is being tested */}
      <div className="bg-amber-500/5 border border-amber-500/30 rounded-lg px-4 py-3 mb-3">
        <div className="text-[11px] text-amber-200/90 font-medium mb-1">
          Testing a single fixed backtest profile — not a live trading screener, not comparable to the Entry/Exit Screeners.
        </div>
        {profile && (
          <div className="text-[11px] text-slate-300 font-mono leading-relaxed">
            ENTRY: {profile.windowMinutes}m corr(price,density) crosses above {profile.thresholdC}
            {' · '}prior-60m return ≤ {fmtPct(profile.maxPreSignalReturn60mPct, 0)}
            {' · '}active move in [{profile.activeMoveMinPct}%, {profile.activeMoveMaxPct}%]
            {' · '}≥ {profile.minTrailing60Messages} trailing-60m msgs
            {' · '}low-float ⇒ catalyst OR social OR short-interest support
            <br />
            EXIT: sell {Math.round(profile.partialExitFraction * 100)}% at {fmtPct(profile.partialProfitTargetPct, 0)}
            {' · '}runner gives back {profile.profitGivebackPct}% after peak ≥ {fmtPct(profile.profitGivebackActivationPct, 0)}
            {' · '}{profile.protectiveStopPct}% protective stop · EOD flatten
          </div>
        )}
        <div className="text-[10px] text-slate-500 mt-2">
          Universe: catalyst-enriched candidates only ({data?.universe ?? '—'}). 120m correlation, pre-60m return, and
          trailing-message features are recomputed live per candidate from ohlcv_bars + socials; entry gate and exit
          simulation reuse the production functions. Realized return is the 50/50 blend across the two exit legs.
        </div>
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="text-neutral text-sm animate-pulse p-4">Replaying v11 over completed sessions…</div>
      ) : rows.length === 0 ? (
        <div className="text-center py-12 text-neutral">
          <div className="text-3xl mb-2">🧪</div>
          <div className="text-sm">{data?.note || 'No catalyst-enriched candidates to replay right now'}</div>
        </div>
      ) : (
        <div className="bg-surface border border-border rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="border-b border-border bg-bg/50">
                <tr>
                  {['TICKER', 'TIER', 'SESSION', 'ENTRY', 'PRE-60m', 'ACT MOVE', 'MSGS', 'EVID', 'LEG 1 (50%@+5%)', 'RUNNER', 'REALIZED', 'STATUS'].map(h => (
                    <th key={h} className="px-2 py-2 text-left text-[10px] text-neutral uppercase tracking-wide font-medium whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700/30">
                {rows.map((row, idx) => {
                  const isEntered = row.status === 'entered'
                  return (
                    <tr
                      key={`${row.ticker}-${row.session_date}-${idx}`}
                      className={clsx('hover:bg-card-hover transition-colors', !isEntered && 'opacity-45')}
                    >
                      <td className="px-2 py-2 whitespace-nowrap">
                        <span className="font-mono font-bold text-accent">{row.ticker}</span>
                      </td>
                      <td className="px-2 py-2 whitespace-nowrap">
                        <span className="text-slate-400 text-[10px]">{row.tier || '—'}</span>
                      </td>
                      <td className="px-2 py-2 whitespace-nowrap">
                        <span className="font-mono text-neutral text-[10px]">{row.session_date || '—'}</span>
                      </td>
                      {/* Entry: corr @ price @ time */}
                      <td className="px-2 py-2 whitespace-nowrap">
                        {isEntered && row.entry ? (
                          <span className="font-mono text-slate-200 text-[11px]" title={row.entry.gate_reason}>
                            {row.entry.corr?.toFixed(3)} @ ${row.entry.price?.toFixed(2)}{' '}
                            <span className="text-neutral">{fmtTime(row.entry.entry_sec)}</span>
                          </span>
                        ) : (
                          <span className="text-neutral">—</span>
                        )}
                      </td>
                      <td className="px-2 py-2 whitespace-nowrap font-mono text-[11px] text-slate-300">
                        {isEntered ? fmtPct(row.entry?.pre_return_60m_pct) : '—'}
                      </td>
                      <td className="px-2 py-2 whitespace-nowrap font-mono text-[11px] text-slate-300">
                        {isEntered ? fmtPct(row.entry?.active_move_pct) : '—'}
                      </td>
                      <td className="px-2 py-2 whitespace-nowrap font-mono text-[11px] text-slate-300">
                        {isEntered ? (row.entry?.trailing_60m_messages ?? '—') : '—'}
                      </td>
                      <td className="px-2 py-2 whitespace-nowrap">
                        <EvidenceCell row={row} />
                      </td>
                      {/* Leg 1 partial */}
                      <td className="px-2 py-2 whitespace-nowrap">
                        {isEntered && row.legs?.partial?.filled ? (
                          <span className="font-mono text-emerald-400 text-[11px]" title={`filled @ $${row.legs.partial.price}`}>
                            ✓ {fmtPct(row.legs.partial.pnl_pct)}
                          </span>
                        ) : isEntered ? (
                          <span className="text-neutral text-[10px]">not hit</span>
                        ) : (
                          <span className="text-neutral">—</span>
                        )}
                      </td>
                      {/* Runner */}
                      <td className="px-2 py-2 whitespace-nowrap">
                        {isEntered && row.legs?.runner ? (
                          <span className="text-[10px]">
                            <span className={clsx('font-mono', pnlClass(row.legs.runner.pnl_pct))}>{fmtPct(row.legs.runner.pnl_pct)}</span>
                            <span className="text-neutral ml-1">{EXIT_REASON_LABEL[row.legs.runner.exit_reason || ''] || row.legs.runner.exit_reason}</span>
                          </span>
                        ) : (
                          <span className="text-neutral">—</span>
                        )}
                      </td>
                      {/* Realized (blended) */}
                      <td className="px-2 py-2 whitespace-nowrap">
                        {isEntered && row.outcome?.realized_return_pct != null ? (
                          <span className={clsx('font-mono font-semibold', pnlClass(row.outcome.realized_return_pct))}>
                            {fmtPct(row.outcome.realized_return_pct)}
                          </span>
                        ) : (
                          <span className="text-neutral">—</span>
                        )}
                      </td>
                      {/* Status / reject reason */}
                      <td className="px-2 py-2 whitespace-nowrap">
                        {isEntered ? (
                          <span className={clsx('font-mono text-[10px]', row.outcome?.won ? 'text-emerald-400' : 'text-red-400')}>
                            {row.outcome?.won ? 'WIN' : 'LOSS'}
                          </span>
                        ) : (
                          <span className="text-neutral text-[10px]" title={row.note}>
                            {row.status === 'no_entry' ? (row.reject?.reason || 'no entry') : row.status.replace(/_/g, ' ')}
                          </span>
                        )}
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
