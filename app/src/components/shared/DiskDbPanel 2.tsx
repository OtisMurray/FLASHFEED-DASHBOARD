'use client'
import useSWR from 'swr'
import { useState } from 'react'
import { useToast } from '@/components/shared/Toast'

const fetcher = (url: string) => fetch(url).then(r => r.json())

interface DiskStats {
  enabled: boolean
  available: boolean
  path: string
  retention_days: { manual: number; auto: number; fetch: number }
  sweep_interval_sec: number
  last_sweep_at: number | null
  last_sweep_deleted: number
  db_size_bytes: number
  total: number
  by_bucket: { manual: number; auto: number; fetch: number }
  oldest_stored_at: number | null
  newest_stored_at: number | null
  presence?: { site_open: boolean; last_presence_at: number | null }
  auto_fetch?: {
    onsite_enabled: boolean
    onsite_interval_min: number
    onsite_last_at: number | null
    onsite_retention_days: number
    away_enabled: boolean
    away_interval_min: number
    away_retention_days: number
  }
}

function fmtBytes(n: number): string {
  if (!n) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(n) / Math.log(1024))
  return `${(n / Math.pow(1024, i)).toFixed(i ? 1 : 0)} ${u[i]}`
}
function fmtTime(ms: number | null): string {
  if (!ms) return '—'
  return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

const BUCKETS: Array<{ key: 'manual' | 'auto' | 'fetch'; label: string; desc: string; color: string }> = [
  { key: 'manual', label: 'Manual / On-exit', desc: '“Save 3d → Disk” button + automatic save when you exit the site', color: 'text-amber-300' },
  { key: 'auto', label: 'Auto-grab (away)', desc: 'Grabbed automatically while you are NOT on the site', color: 'text-sky-300' },
  { key: 'fetch', label: 'Fetch (Redis+Kafka)', desc: 'Run Now / Auto-watch + the on-site auto-fetch (every 20 min while you’re on the site)', color: 'text-emerald-300' },
]

export function DiskDbPanel() {
  const { toast } = useToast()
  const { data, mutate } = useSWR<DiskStats>('/api/disk/stats', fetcher, { refreshInterval: 15_000 })
  const [busy, setBusy] = useState<string | null>(null)

  const post = async (url: string, label: string, ok: (d: any) => string) => {
    setBusy(label)
    try {
      const d = await fetch(url, { method: 'POST' }).then(r => r.json())
      if (d.ok !== false) { toast(ok(d), undefined, 'success'); mutate() }
      else toast(`${label} failed`, d.error || '', 'error')
    } catch { toast(`${label} failed`, 'Could not reach API', 'error') }
    finally { setBusy(null) }
  }

  const unavailable = data && (!data.enabled || !data.available)

  return (
    <div className="bg-surface border border-border rounded-lg overflow-hidden">
      <div className="px-4 py-3 border-b border-border flex items-center justify-between">
        <div>
          <h2 className="text-white font-semibold text-sm flex items-center gap-2">
            💾 Hard-Disk Database
            <span className="text-[10px] font-normal uppercase tracking-wide bg-amber-500/15 border border-amber-500/30 text-amber-300 px-1.5 py-0.5 rounded">on-disk SQLite</span>
          </h2>
          <p className="text-neutral text-xs mt-0.5">
            Persistent companion to the RAM layer (Redis). News is stored on local disk with automatic retention &amp; deletion.
          </p>
        </div>
        <span className={`text-[11px] px-2 py-1 rounded border ${data?.available ? 'border-emerald-500/40 text-emerald-300 bg-emerald-500/10' : 'border-red-500/40 text-red-300 bg-red-500/10'}`}>
          {data ? (data.available ? '● connected' : '○ unavailable') : '…'}
        </span>
      </div>

      {unavailable ? (
        <div className="p-4 text-sm text-neutral">
          The hard-disk database is not active. Install <code className="text-amber-300">better-sqlite3</code> in the backend
          (or set <code>DISK_DB_ENABLED=true</code>) and restart the server.
        </div>
      ) : (
        <div className="p-4 space-y-4">
          {/* Top stats row */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <Stat label="Total stored" value={String(data?.total ?? 0)} />
            <Stat label="DB size" value={fmtBytes(data?.db_size_bytes ?? 0)} />
            <Stat
              label="Auto-fetch"
              value={data?.presence?.site_open
                ? `On-site · every ${data?.auto_fetch?.onsite_interval_min ?? 20}m`
                : `Away · every ${data?.auto_fetch?.away_interval_min ?? 5}m`}
            />
            <Stat label="Last cleanup" value={fmtTime(data?.last_sweep_at ?? null)} />
          </div>

          {/* Automatic fetching explainer */}
          <div className="flex items-start gap-2 text-[11px] text-neutral bg-bg/40 border border-border rounded-lg px-3 py-2">
            <span className="text-emerald-300">⏱</span>
            <span>
              <span className="text-white font-medium">Automatic fetching:</span> while you’re on the site, new articles are grabbed
              automatically <span className="text-emerald-300 font-medium">every {data?.auto_fetch?.onsite_interval_min ?? 20} minutes</span> and
              deleted after <span className="text-emerald-300 font-medium">{data?.auto_fetch?.onsite_retention_days ?? 3} days</span>.
              While you’re away, news is archived every {data?.auto_fetch?.away_interval_min ?? 5} min (kept {data?.auto_fetch?.away_retention_days ?? 2} days).
              {data?.auto_fetch?.onsite_last_at ? <> Last on-site fetch: {fmtTime(data.auto_fetch.onsite_last_at)}.</> : null}
            </span>
          </div>

          {/* Buckets + retention */}
          <div className="border border-border rounded-lg overflow-hidden">
            <div className="px-3 py-2 border-b border-border bg-bg/40">
              <span className="text-[10px] text-neutral uppercase tracking-wide font-medium">Buckets &amp; retention (auto-delete)</span>
            </div>
            <div className="divide-y divide-border/60">
              {BUCKETS.map(b => (
                <div key={b.key} className="flex items-center gap-3 px-3 py-2.5">
                  <div className="flex-1 min-w-0">
                    <div className={`text-sm font-medium ${b.color}`}>{b.label}</div>
                    <div className="text-[11px] text-neutral truncate">{b.desc}</div>
                  </div>
                  <div className="text-right">
                    <div className="font-mono text-white text-sm">{data?.by_bucket?.[b.key] ?? 0}</div>
                    <div className="text-[10px] text-neutral">items</div>
                  </div>
                  <div className="w-20 text-right">
                    <div className="font-mono text-sm text-white">{data?.retention_days?.[b.key] ?? 0}d</div>
                    <div className="text-[10px] text-neutral">keep</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Actions */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => post('/api/disk/save-news?days=3', 'Save', d => `Saved ${d.saved} news items to disk (3 days)`)}
              disabled={!!busy}
              className="px-3 py-1.5 text-xs font-medium rounded bg-accent text-white hover:bg-sky-400 disabled:opacity-50 transition-colors"
            >
              {busy === 'Save' ? 'Saving…' : 'Save last 3 days now'}
            </button>
            <a
              href="/api/disk/export?days=3"
              className="px-3 py-1.5 text-xs font-medium rounded border border-border text-neutral hover:text-white hover:border-accent transition-colors"
            >
              ⬇ Download JSON
            </a>
            <button
              onClick={() => post('/api/disk/sweep', 'Cleanup', d => `Cleanup complete — removed ${d.deleted} expired items`)}
              disabled={!!busy}
              className="px-3 py-1.5 text-xs font-medium rounded border border-border text-neutral hover:text-white hover:border-accent disabled:opacity-50 transition-colors"
            >
              {busy === 'Cleanup' ? 'Cleaning…' : 'Run cleanup now'}
            </button>
            <span className="text-[11px] text-neutral ml-auto">
              Sweeper runs every {Math.round((data?.sweep_interval_sec ?? 600) / 60)} min · removed {data?.last_sweep_deleted ?? 0} last pass
            </span>
          </div>

          <div className="text-[11px] text-slate-500 font-mono break-all">Path: {data?.path}</div>
        </div>
      )}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-bg border border-border rounded-lg px-3 py-2 min-w-0">
      <div className="font-mono text-sm text-white truncate">{value}</div>
      <div className="text-[10px] uppercase text-neutral mt-0.5">{label}</div>
    </div>
  )
}
