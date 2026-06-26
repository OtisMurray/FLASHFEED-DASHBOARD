import useSWR from 'swr'

const fetcher = (url: string) => fetch(url).then(r => r.json())

function fmtBytes(n: number): string {
  if (!n) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(n) / Math.log(1024))
  return `${(n / Math.pow(1024, i)).toFixed(i ? 1 : 0)} ${u[i]}`
}

function fmtUptime(s: number): string {
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`
}

export function RamDbPanel() {
  const { data } = useSWR('/api/redis/stats', fetcher, { refreshInterval: 15_000 })

  const usedPct = data?.used_pct ?? null
  const barColor = usedPct === null ? 'bg-slate-600'
    : usedPct > 85 ? 'bg-red-500'
    : usedPct > 60 ? 'bg-amber-400'
    : 'bg-emerald-400'

  return (
    <div className="bg-surface border border-border rounded-lg overflow-hidden">
      <div className="px-4 py-3 border-b border-border flex items-center justify-between">
        <div>
          <h2 className="text-white font-semibold text-sm flex items-center gap-2">
            ⚡ RAM Database (Redis)
            <span className="text-[10px] font-normal uppercase tracking-wide bg-sky-500/15 border border-sky-500/30 text-sky-300 px-1.5 py-0.5 rounded">zero disk I/O</span>
          </h2>
          <p className="text-neutral text-xs mt-0.5">
            Pure in-memory cache — no disk persistence. Holds hot article cache and the Kafka event feed. Auto-evicts on LRU when full.
          </p>
        </div>
        <span className={`text-[11px] px-2 py-1 rounded border ${data?.available ? 'border-emerald-500/40 text-emerald-300 bg-emerald-500/10' : 'border-red-500/40 text-red-300 bg-red-500/10'}`}>
          {data ? (data.available ? '● connected' : '○ unavailable') : '…'}
        </span>
      </div>

      {data && !data.available ? (
        <div className="p-4 text-sm text-neutral">{data.error || 'Redis is not reachable.'}</div>
      ) : (
        <div className="p-4 space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <Stat label="Used memory" value={fmtBytes(data?.used_memory_bytes ?? 0)} />
            <Stat label="Max memory" value={data?.max_memory_bytes ? fmtBytes(data.max_memory_bytes) : '—'} />
            <Stat label="Total keys" value={String(data?.total_keys ?? 0)} />
            <Stat label="Uptime" value={data?.uptime_seconds ? fmtUptime(data.uptime_seconds) : '—'} />
          </div>

          {/* Memory bar */}
          {usedPct !== null && (
            <div>
              <div className="flex items-center justify-between text-[11px] text-neutral mb-1">
                <span>Memory usage</span>
                <span className="font-mono text-white">{usedPct}%</span>
              </div>
              <div className="h-2 bg-bg rounded-full overflow-hidden border border-border">
                <div className={`h-full ${barColor} transition-all`} style={{ width: `${usedPct}%` }} />
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
            <InfoRow label="Eviction policy" value={data?.policy ?? '—'} />
            <InfoRow label="Cache hit rate" value={data?.hit_rate_pct != null ? `${data.hit_rate_pct}%` : '—'} />
            <InfoRow label="Redis version" value={data?.version ?? '—'} />
          </div>

          <div className="flex items-start gap-2 text-[11px] text-neutral bg-bg/40 border border-border rounded-lg px-3 py-2">
            <span className="text-sky-300">⚡</span>
            <span>
              <span className="text-white font-medium">Auto-fetch schedule:</span>{' '}
              while you are <span className="text-emerald-300 font-medium">on the site</span> → fetches news every{' '}
              <span className="text-emerald-300 font-medium">20 minutes</span> and caches in Redis.{' '}
              While you are <span className="text-amber-300 font-medium">away</span> → server auto-grabs every{' '}
              <span className="text-amber-300 font-medium">5 minutes</span> and archives to disk.{' '}
              Both run automatically — no action needed.
            </span>
          </div>
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

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between bg-bg/40 border border-border rounded px-3 py-2">
      <span className="text-[11px] text-neutral">{label}</span>
      <span className="text-[11px] font-mono text-white">{value}</span>
    </div>
  )
}
