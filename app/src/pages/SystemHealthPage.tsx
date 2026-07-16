import useSWR from 'swr'
import { clsx } from 'clsx'

const fetcher = (url: string) => fetch(url).then(r => r.json())

type CollectionHealth = {
  name: string
  status: string
  count: number
  latest_at?: string | null
  age_seconds?: number | null
  stale_after_seconds?: number | null
  latest_sample?: Record<string, unknown> | null
  error?: string
}

type SystemHealth = {
  ok?: boolean
  status?: string
  generated_at?: string
  ms?: number
  mongo?: Record<string, unknown>
  redis?: Record<string, unknown>
  kafka?: Record<string, unknown>
  auto_refresh?: Record<string, unknown>
  collections?: Record<string, CollectionHealth>
  sources?: {
    summary?: Record<string, number>
    rows?: Array<Record<string, unknown>>
  }
  prediction_pipeline?: Record<string, unknown>
  warnings?: string[]
  error?: string
}

function ageLabel(seconds?: number | null) {
  if (seconds == null || !Number.isFinite(Number(seconds))) return 'missing'
  if (seconds < 60) return `${Math.round(seconds)}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`
  return `${Math.round(seconds / 86_400)}d`
}

function compact(value: unknown) {
  const n = Number(value || 0)
  if (!Number.isFinite(n)) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 10_000) return `${Math.round(n / 1000)}k`
  if (n >= 1_000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

function tone(status?: string) {
  const s = String(status || '').toLowerCase()
  if (['healthy', 'fresh', 'working', 'ok'].includes(s) || s.includes('healthy')) return 'border-emerald-400/40 bg-emerald-500/10 text-emerald-200'
  if (s.includes('warning') || s.includes('stale') || s.includes('ready') || s.includes('unknown')) return 'border-amber-400/40 bg-amber-500/10 text-amber-200'
  if (s.includes('degraded') || s.includes('error') || s.includes('empty') || s.includes('blocked') || s.includes('unavailable')) return 'border-red-400/40 bg-red-500/10 text-red-200'
  return 'border-border bg-surface text-neutral'
}

function StatusPill({ status }: { status?: string }) {
  return (
    <span className={clsx('inline-flex rounded border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide', tone(status))}>
      {status || 'unknown'}
    </span>
  )
}

function Metric({ label, value, status, detail }: { label: string; value: string | number; status?: string; detail?: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] uppercase text-neutral">{label}</span>
        {status && <StatusPill status={status} />}
      </div>
      <div className="mt-2 font-mono text-xl font-semibold text-white">{value}</div>
      {detail && <div className="mt-1 text-xs text-neutral">{detail}</div>}
    </div>
  )
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function mapEntries(value: unknown) {
  return Object.entries(asRecord(value)).sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0))
}

export function SystemHealthPage() {
  const { data, error, isLoading, mutate } = useSWR<SystemHealth>('/api/system/health', fetcher, {
    refreshInterval: 60_000,
    dedupingInterval: 30_000,
    keepPreviousData: true,
  })

  const collections = Object.values(data?.collections || {})
  const pipeline = data?.prediction_pipeline || {}
  const auto = data?.auto_refresh || {}
  const sourceSummary = data?.sources?.summary || {}
  const sourceRows = data?.sources?.rows || []

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-white">System Health</h1>
          <p className="mt-1 text-sm text-neutral">
            Operational view for ingestion, storage, prediction freshness, and dashboard refresh cadence.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {data?.status && <StatusPill status={data.status} />}
          <button
            onClick={() => mutate()}
            className="rounded border border-border px-3 py-2 text-xs text-neutral hover:border-accent hover:text-white"
          >
            {isLoading ? 'Checking...' : 'Refresh'}
          </button>
        </div>
      </div>

      {(error || data?.error) && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200">
          {String(data?.error || error)}
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-4">
        <Metric label="Mongo" value={String(data?.mongo?.database || 'feedflash')} status={String(data?.mongo?.status || 'unknown')} detail={`ready state ${data?.mongo?.ready_state ?? '—'}`} />
        <Metric label="Redis" value={String(data?.redis?.available ? 'available' : 'offline')} status={String(data?.redis?.status || 'unknown')} detail={data?.redis?.latency_ms != null ? `${data.redis.latency_ms}ms ping` : 'Mongo fallback active'} />
        <Metric label="Auto Refresh" value={`${auto.onsite_interval_seconds ?? '—'}s`} status={auto.cadence_ok ? 'healthy' : 'degraded'} detail={`check ${auto.onsite_check_seconds ?? '—'}s · floor ${auto.cadence_floor_seconds ?? 60}s`} />
        <Metric label="Prediction Rows" value={compact(pipeline.final_rows)} status={Number(pipeline.final_rows || 0) || Number(pipeline.developing_candidate_rows || 0) ? 'healthy' : 'warning'} detail={`${compact(pipeline.developing_candidate_rows)} developing · ${compact(pipeline.strict_rows)} strict`} />
      </div>

      {!!data?.warnings?.length && (
        <section className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4">
          <h2 className="font-semibold text-amber-100">Warnings</h2>
          <div className="mt-2 flex flex-wrap gap-2">
            {data.warnings.map(warning => (
              <span key={warning} className="rounded border border-amber-400/30 bg-bg/40 px-2 py-1 font-mono text-[11px] text-amber-100">
                {warning}
              </span>
            ))}
          </div>
        </section>
      )}

      <section className="rounded-lg border border-border bg-surface p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="font-semibold text-white">Prediction Pipeline</h2>
            <p className="text-xs text-neutral">Latest persisted prediction audit from the screener flow.</p>
          </div>
          <div className="text-xs text-neutral">
            {pipeline.latest_archive_at ? `Updated ${ageLabel(Math.max(0, (Date.now() - Date.parse(String(pipeline.latest_archive_at))) / 1000))} ago` : 'No archive timestamp'}
          </div>
        </div>
        <div className="mt-3 grid gap-3 md:grid-cols-5">
          <Metric label="Live Signals" value={compact(pipeline.live_signal_rows)} />
          <Metric label="Evidence Rows" value={compact(pipeline.evidence_prediction_rows)} />
          <Metric label="Stored Rows" value={compact(pipeline.stored_prediction_rows)} />
          <Metric label="Fallback Rows" value={compact(pipeline.fallback_rows)} />
          <Metric label="Policy" value={String(pipeline.threshold_policy_version || '—')} />
        </div>
        <div className="mt-4 grid gap-4 lg:grid-cols-3">
          <CounterList title="Removed By Filter" rows={mapEntries(pipeline.removed_by_filter_counts)} />
          <CounterList title="Risk Flags" rows={mapEntries(pipeline.risk_flag_counts)} />
          <CounterList title="Reaction States" rows={mapEntries(pipeline.first_reaction_state_counts)} />
        </div>
      </section>

      <section className="rounded-lg border border-border bg-surface p-4">
        <h2 className="font-semibold text-white">Collection Freshness</h2>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border text-xs uppercase text-neutral">
              <tr>
                <th className="py-2 pr-4">Collection</th>
                <th className="py-2 pr-4">Status</th>
                <th className="py-2 pr-4">Rows</th>
                <th className="py-2 pr-4">Latest</th>
                <th className="py-2 pr-4">Age</th>
                <th className="py-2 pr-4">Sample</th>
              </tr>
            </thead>
            <tbody>
              {collections.map(row => (
                <tr key={row.name} className="border-b border-border/60">
                  <td className="py-2 pr-4 font-mono text-accent">{row.name}</td>
                  <td className="py-2 pr-4"><StatusPill status={row.status} /></td>
                  <td className="py-2 pr-4 font-mono text-white">{compact(row.count)}</td>
                  <td className="py-2 pr-4 text-xs text-neutral">{row.latest_at || '—'}</td>
                  <td className="py-2 pr-4 font-mono text-neutral">{ageLabel(row.age_seconds)}</td>
                  <td className="max-w-[420px] truncate py-2 pr-4 text-xs text-neutral" title={JSON.stringify(row.latest_sample || row.error || {})}>
                    {row.error || JSON.stringify(row.latest_sample || {})}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-lg border border-border bg-surface p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="font-semibold text-white">Source Workers</h2>
            <p className="text-xs text-neutral">Latest `source_status` rows from ingestion workers and backend importers.</p>
          </div>
          <div className="flex flex-wrap gap-2 text-xs">
            <span className="text-emerald-300">working {sourceSummary.working ?? 0}</span>
            <span className="text-sky-300">ready {sourceSummary.ready ?? 0}</span>
            <span className="text-amber-300">stale {sourceSummary.stale ?? 0}</span>
            <span className="text-red-300">blocked {sourceSummary.blocked ?? 0}</span>
          </div>
        </div>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border text-xs uppercase text-neutral">
              <tr>
                <th className="py-2 pr-4">Source</th>
                <th className="py-2 pr-4">Status</th>
                <th className="py-2 pr-4">Last Check</th>
                <th className="py-2 pr-4">Rows</th>
                <th className="py-2 pr-4">Accepted</th>
                <th className="py-2 pr-4">Malformed</th>
                <th className="py-2 pr-4">Detail</th>
              </tr>
            </thead>
            <tbody>
              {sourceRows.slice(0, 25).map((row, index) => (
                <tr key={`${row.source}-${index}`} className="border-b border-border/60">
                  <td className="py-2 pr-4 text-white">{String(row.source || 'unknown')}</td>
                  <td className="py-2 pr-4"><StatusPill status={String(row.status || 'unknown')} /></td>
                  <td className="py-2 pr-4 font-mono text-neutral">{ageLabel(Number(row.age_seconds ?? NaN))}</td>
                  <td className="py-2 pr-4 font-mono text-neutral">{compact(row.records_received ?? row.last_count)}</td>
                  <td className="py-2 pr-4 font-mono text-neutral">{compact(row.records_accepted)}</td>
                  <td className="py-2 pr-4 font-mono text-neutral">{compact(row.records_malformed)}</td>
                  <td className="max-w-[360px] truncate py-2 pr-4 text-xs text-neutral" title={String(row.error || row.detail || '')}>{String(row.error || row.detail || '—')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}

function CounterList({ title, rows }: { title: string; rows: Array<[string, unknown]> }) {
  return (
    <div>
      <h3 className="text-xs font-semibold uppercase text-neutral">{title}</h3>
      <div className="mt-2 space-y-1">
        {rows.length ? rows.slice(0, 8).map(([key, value]) => (
          <div key={key} className="flex items-center justify-between gap-3 border-b border-border/50 py-1 text-xs">
            <span className="truncate text-neutral" title={key}>{key.replace(/_/g, ' ')}</span>
            <span className="font-mono text-white">{compact(value)}</span>
          </div>
        )) : <div className="text-xs text-neutral">No rows recorded.</div>}
      </div>
    </div>
  )
}
