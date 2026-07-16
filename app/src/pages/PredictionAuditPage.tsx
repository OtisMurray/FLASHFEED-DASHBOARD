import useSWR from 'swr'
import { useState } from 'react'
import { clsx } from 'clsx'

const fetcher = (url: string) => fetch(url).then(r => r.json())

type AuditMetric = {
  key: string
  count: number
  labeled?: number
  avg_score?: number | null
  avg_return_pct?: number | null
  win_rate?: number | null
  directional_accuracy?: number | null
}

type AuditRow = {
  id: string
  ticker: string
  company?: string
  signal_at?: string | null
  decision?: string
  entry_price?: number | null
  rank?: number | null
  label_status?: string
  selected_horizon_label?: {
    labeled?: boolean
    return_pct?: number
    direction_correct?: boolean | null
    label_price?: number
    labeled_at?: string
    label_source?: string
    ohlc_source?: string
    provider_interval?: string
    label_delay_seconds?: number
  } | null
  baseline_signal?: { direction?: string; confidence?: number; entry_ready?: boolean; threshold_status?: string } | null
  model_signal?: { direction?: string; confidence?: number; predicted_return_5m?: number } | null
  entry_signal?: { status?: string; entry_ready?: boolean; reason?: string; policy_version?: string; tier?: string } | null
  audit_quality?: { valid?: boolean; flags?: string[] }
}

type AuditData = {
  ok?: boolean
  generated_at?: string
  days?: number
  horizon_minutes?: number
  rows?: AuditRow[]
  data_quality?: Record<string, unknown>
  summary?: {
    by_status?: AuditMetric[]
    by_decision?: AuditMetric[]
    by_confidence?: AuditMetric[]
    by_readiness?: AuditMetric[]
    by_label_source?: AuditMetric[]
  }
  latest_prediction_archive?: Record<string, unknown>
  model?: Record<string, unknown>
  threshold_policy?: Record<string, unknown>
  error?: string
}

function pct(value?: number | null) {
  if (value == null || !Number.isFinite(Number(value))) return '--'
  return `${(Number(value) * 100).toFixed(0)}%`
}

function ret(value?: number | null) {
  if (value == null || !Number.isFinite(Number(value))) return '--'
  return `${Number(value) >= 0 ? '+' : ''}${Number(value).toFixed(2)}%`
}

function compact(value: unknown) {
  const n = Number(value || 0)
  if (!Number.isFinite(n)) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 10_000) return `${Math.round(n / 1000)}k`
  if (n >= 1_000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

function timeLabel(value?: string | null) {
  if (!value) return '--'
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) return String(value)
  return new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function statusTone(value?: string) {
  const s = String(value || '').toLowerCase()
  if (s.includes('complete') || s.includes('ready') || s.includes('high')) return 'text-emerald-300'
  if (s.includes('pending') || s.includes('partial') || s.includes('medium')) return 'text-yellow-300'
  if (s.includes('missing') || s.includes('rejected') || s.includes('low')) return 'text-red-300'
  return 'text-neutral'
}

export function PredictionAuditPage() {
  const [days, setDays] = useState(7)
  const [horizon, setHorizon] = useState(60)
  const [refreshing, setRefreshing] = useState(false)
  const [message, setMessage] = useState('')
  const { data, error, isLoading, mutate } = useSWR<AuditData>(`/api/prediction/audit?days=${days}&horizon_minutes=${horizon}&limit=160`, fetcher, {
    refreshInterval: 60_000,
    keepPreviousData: true,
  })

  const runOutcomeCheck = async () => {
    if (refreshing) return
    setRefreshing(true)
    setMessage('')
    try {
      const res = await fetch('/api/prediction/audit/refresh', { method: 'POST' })
      const json = await res.json()
      if (!res.ok || json.ok === false) throw new Error(json.error || `Request failed ${res.status}`)
      setMessage(`Labeled ${json.labels?.labeled ?? 0} OHLC outcomes from ${json.labels?.checked ?? 0} checked signals; ${json.labels?.missing_ohlc ?? 0} missing OHLC; ${json.labels?.relabeled_legacy ?? 0} legacy labels replaced. Model ${json.model_updated ? 'updated' : 'left unchanged'} (${json.model?.status || 'unknown'}).`)
      mutate()
    } catch (err) {
      setMessage(String((err as Error).message || err))
    } finally {
      setRefreshing(false)
    }
  }

  const rows = data?.rows || []
  const quality = data?.data_quality || {}
  const archive = data?.latest_prediction_archive || {}

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-white">Prediction Audit</h1>
          <p className="mt-1 text-sm text-neutral">Live outcome validation for stored prediction signals and current threshold policy.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select value={days} onChange={event => setDays(Number(event.target.value))} className="rounded border border-border bg-surface px-2 py-2 text-xs text-neutral">
            <option value={3}>3 days</option>
            <option value={7}>7 days</option>
            <option value={14}>14 days</option>
            <option value={30}>30 days</option>
          </select>
          <select value={horizon} onChange={event => setHorizon(Number(event.target.value))} className="rounded border border-border bg-surface px-2 py-2 text-xs text-neutral">
            <option value={5}>5m</option>
            <option value={15}>15m</option>
            <option value={60}>60m</option>
          </select>
          <button onClick={runOutcomeCheck} className="rounded border border-accent/50 bg-accent/10 px-3 py-2 text-xs text-accent hover:bg-accent/20">
            {refreshing ? 'Checking...' : 'Run Outcome Check'}
          </button>
        </div>
      </div>

      {(error || data?.error || message) && (
        <div className={clsx('rounded-lg border p-3 text-sm',
          error || data?.error || message.toLowerCase().includes('failed')
            ? 'border-red-500/40 bg-red-500/10 text-red-200'
            : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
        )}>
          {String(data?.error || error || message)}
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-5">
        <Metric label="Valid Window" value={compact(quality.valid_records_in_window)} />
        <Metric label="Incomplete" value={compact(quality.incomplete_records_in_window)} tone={Number(quality.incomplete_records_in_window || 0) ? 'text-yellow-300' : 'text-emerald-300'} />
        <Metric label="Mature Pending" value={compact(quality.mature_pending_labels)} tone={Number(quality.mature_pending_labels || 0) ? 'text-yellow-300' : 'text-emerald-300'} />
        <Metric label="Archive Rows" value={compact(archive.finalRows ?? archive.rowCount)} detail={`${compact(archive.strictRows)} strict · ${compact(archive.candidatePoolRows)} developing`} />
        <Metric label="Model" value={String(data?.model?.status || 'unknown')} detail={`${compact(data?.model?.samples)} samples`} />
      </div>

      <section className="rounded-lg border border-border bg-surface p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="font-semibold text-white">{horizon}m Outcome Metrics</h2>
            <p className="text-xs text-neutral">Mongo OHLC close-label validation, not full intrabar execution P&L.</p>
          </div>
          <div className="text-xs text-neutral">Policy {String(data?.threshold_policy?.version || '—')}</div>
        </div>
        <div className="mt-4 grid gap-4 xl:grid-cols-5">
          <MetricList title="By Status" rows={data?.summary?.by_status || []} />
          <MetricList title="By Decision" rows={data?.summary?.by_decision || []} />
          <MetricList title="By Confidence" rows={data?.summary?.by_confidence || []} />
          <MetricList title="By Readiness" rows={data?.summary?.by_readiness || []} />
          <MetricList title="By Label Source" rows={data?.summary?.by_label_source || []} />
        </div>
      </section>

      <section className="rounded-lg border border-border bg-surface p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="font-semibold text-white">Recent Signal Audit</h2>
            <p className="text-xs text-neutral">{isLoading ? 'Loading...' : `${rows.length} rows · generated ${timeLabel(data?.generated_at)}`}</p>
          </div>
          <div className="max-w-xl truncate text-xs text-neutral" title={String(data?.threshold_policy?.caveat || '')}>
            {String(data?.threshold_policy?.candidate_rule || '')}
          </div>
        </div>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border text-xs uppercase text-neutral">
              <tr>
                <th className="py-2 pr-4">Ticker</th>
                <th className="py-2 pr-4">Signal</th>
                <th className="py-2 pr-4">Decision</th>
                <th className="py-2 pr-4">Entry</th>
                <th className="py-2 pr-4">Outcome</th>
                <th className="py-2 pr-4">Source</th>
                <th className="py-2 pr-4">Correct</th>
                <th className="py-2 pr-4">Readiness</th>
                <th className="py-2 pr-4">Quality</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(row => {
                const label = row.selected_horizon_label
                const flags = row.audit_quality?.flags || []
                return (
                  <tr key={row.id} className="border-b border-border/60">
                    <td className="py-2 pr-4">
                      <div className="font-mono font-semibold text-accent">{row.ticker}</div>
                      <div className="max-w-[180px] truncate text-[11px] text-neutral">{row.company || row.source || ''}</div>
                    </td>
                    <td className="py-2 pr-4 text-xs text-neutral">{timeLabel(row.signal_at)}</td>
                    <td className="py-2 pr-4">
                      <div className="font-mono text-white">{row.decision || '--'}</div>
                      <div className="text-[11px] text-neutral">
                        base {row.baseline_signal?.direction || '—'} · model {row.model_signal?.direction || '—'}
                      </div>
                    </td>
                    <td className="py-2 pr-4 font-mono text-neutral">{row.entry_price == null ? '--' : `$${Number(row.entry_price).toFixed(3)}`}</td>
                    <td className={clsx('py-2 pr-4 font-mono', Number(label?.return_pct || 0) >= 0 ? 'text-emerald-300' : 'text-red-300')}>
                      {label?.labeled ? ret(label.return_pct) : 'pending'}
                    </td>
                    <td className="py-2 pr-4">
                      <div className={clsx('font-mono text-xs', label?.label_source === 'mongo_ohlcv_bars' ? 'text-emerald-300' : label?.labeled ? 'text-yellow-300' : 'text-neutral')}>
                        {label?.label_source || (label?.labeled ? 'legacy' : '—')}
                      </div>
                      <div className="text-[11px] text-neutral">
                        {[label?.provider_interval, label?.label_delay_seconds != null ? `${label.label_delay_seconds}s delay` : ''].filter(Boolean).join(' · ')}
                      </div>
                    </td>
                    <td className="py-2 pr-4">
                      <span className={clsx('font-mono', label?.direction_correct === true ? 'text-emerald-300' : label?.direction_correct === false ? 'text-red-300' : 'text-neutral')}>
                        {label?.direction_correct === true ? 'yes' : label?.direction_correct === false ? 'no' : '—'}
                      </span>
                    </td>
                    <td className="py-2 pr-4">
                      <div className={clsx('font-mono text-xs', statusTone(row.entry_signal?.status))}>{row.entry_signal?.status || 'missing'}</div>
                      <div className="text-[11px] text-neutral">{row.entry_signal?.tier || row.entry_signal?.policy_version || ''}</div>
                    </td>
                    <td className="max-w-[280px] truncate py-2 pr-4 text-xs text-neutral" title={flags.join(', ') || row.entry_signal?.reason || ''}>
                      {flags.length ? flags.join(', ') : 'ok'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}

function Metric({ label, value, detail, tone = 'text-white' }: { label: string; value: string; detail?: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <div className="text-[11px] uppercase text-neutral">{label}</div>
      <div className={clsx('mt-2 font-mono text-xl font-semibold', tone)}>{value}</div>
      {detail && <div className="mt-1 text-xs text-neutral">{detail}</div>}
    </div>
  )
}

function MetricList({ title, rows }: { title: string; rows: AuditMetric[] }) {
  return (
    <div>
      <h3 className="text-xs font-semibold uppercase text-neutral">{title}</h3>
      <div className="mt-2 space-y-1">
        {rows.length ? rows.slice(0, 8).map(row => (
          <div key={row.key} className="rounded border border-border/60 bg-bg/40 p-2 text-xs">
            <div className="flex items-center justify-between gap-2">
              <span className={clsx('truncate font-mono', statusTone(row.key))} title={row.key}>{row.key.replace(/_/g, ' ')}</span>
              <span className="font-mono text-white">{compact(row.count)}</span>
            </div>
            <div className="mt-1 grid grid-cols-3 gap-2 text-[11px] text-neutral">
              <span>avg {ret(row.avg_return_pct)}</span>
              <span>win {pct(row.win_rate)}</span>
              <span>dir {pct(row.directional_accuracy)}</span>
            </div>
          </div>
        )) : <div className="text-xs text-neutral">No labeled rows yet.</div>}
      </div>
    </div>
  )
}
