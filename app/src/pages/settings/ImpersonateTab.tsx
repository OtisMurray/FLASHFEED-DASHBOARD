import { useEffect, useState } from 'react'
import { jsonFetch, statusClass, timeAgo } from './shared'

type HealthSourceRow = {
  source?: string
  name?: string
  status?: string
  collection?: string
  category?: string
  count?: number
  latest_fetch?: number | string | null
  detail?: string
  note?: string
  method?: string
}

type SourceHealth = {
  working_count?: number
  ready_count?: number
  blocked_count?: number
  planned_count?: number
  sources?: HealthSourceRow[]
}

export function ImpersonateTab() {
  const [health, setHealth] = useState<SourceHealth>({})
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const load = async () => {
    setError(null); setLoading(true)
    try {
      const data = await jsonFetch('/api/sources/health')
      setHealth(data || {})
    } catch (e: any) {
      setError(String(e.message || e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  return (
    <div className="space-y-6">
      <div className="border border-border rounded-lg p-4 bg-bg/40 space-y-2">
        <h2 className="text-white font-medium text-sm">How feeds get scraped</h2>
        <p className="text-xs text-neutral leading-relaxed">
          Feeds added on the Sources tab are fetched normally first. If a site blocks the plain
          request (a 403, or no response), the fetcher automatically retries using{' '}
          <span className="text-sky-300 font-mono">curl-impersonate</span> — it mimics a real
          Chrome browser's TLS fingerprint (via <span className="text-sky-300 font-mono">curl_cffi</span>,
          <span className="text-sky-300 font-mono ml-1">impersonate=&quot;chrome124&quot;</span>) so the
          request looks like it came from a browser instead of a script. This table shows which
          sources are working, which are blocked, and how each was last fetched.
        </p>
      </div>

      {error && <div className="border border-red-500/40 bg-red-500/10 text-red-300 rounded-lg p-3 text-sm">{error}</div>}

      <div className="flex items-center justify-between gap-3">
        <div className="grid grid-cols-4 gap-2 text-center">
          <HealthMetric label="Working" value={health.working_count ?? 0} tone="text-emerald-300" />
          <HealthMetric label="Ready" value={health.ready_count ?? 0} tone="text-sky-300" />
          <HealthMetric label="Blocked" value={health.blocked_count ?? 0} tone="text-yellow-300" />
          <HealthMetric label="Planned" value={health.planned_count ?? 0} tone="text-neutral" />
        </div>
        <button onClick={load} className="border border-border text-neutral hover:text-white hover:border-accent rounded px-3 py-2 text-xs">
          {loading ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      <div className="overflow-x-auto border border-border rounded-lg">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-neutral border-b border-border bg-surface">
              <th className="py-2 px-3">Source</th>
              <th className="py-2 px-3">Status</th>
              <th className="py-2 px-3">Type</th>
              <th className="py-2 px-3 text-right">Rows</th>
              <th className="py-2 px-3">Last Seen</th>
              <th className="py-2 px-3">Detail</th>
            </tr>
          </thead>
          <tbody>
            {(health.sources || []).map(s => (
              <tr key={s.source || s.name} className="border-b border-border/50">
                <td className="py-2 px-3 text-white">{s.source || s.name}</td>
                <td className="py-2 px-3">
                  <span className={`inline-flex border rounded-full px-2 py-0.5 text-xs ${statusClass(s.status)}`}>{s.status || 'unknown'}</span>
                </td>
                <td className="py-2 px-3 text-neutral">{s.collection || s.category || '--'}</td>
                <td className="py-2 px-3 text-right font-mono text-neutral">{s.count ?? 0}</td>
                <td className="py-2 px-3 text-neutral">{timeAgo(s.latest_fetch)}</td>
                <td className="py-2 px-3 text-neutral max-w-[280px] truncate" title={s.detail || s.note || s.method || ''}>
                  {s.detail || s.note || s.method || '--'}
                </td>
              </tr>
            ))}
            {!(health.sources || []).length && (
              <tr><td colSpan={6} className="py-4 text-center text-neutral">Source health has not loaded yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function HealthMetric({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="border border-border rounded px-3 py-2 bg-bg/40 min-w-[78px]">
      <div className={`font-mono text-base ${tone}`}>{value}</div>
      <div className="text-[10px] text-neutral uppercase">{label}</div>
    </div>
  )
}
