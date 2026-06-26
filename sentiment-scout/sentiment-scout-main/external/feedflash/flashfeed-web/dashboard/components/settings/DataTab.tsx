'use client'
import useSWR from 'swr'
import { useState } from 'react'

const fetcher = (url: string) => fetch(url).then(r => r.json())

export function DataTab() {
  const { data: stats, mutate } = useSWR('/api/stats', fetcher)
  const [cleanupDays, setCleanupDays] = useState('30')
  const [clearing, setClearing] = useState(false)
  const [cleaning, setCleaning] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const doClear = async () => {
    if (!confirm('Delete ALL articles from the database? This cannot be undone.')) return
    setClearing(true)
    setMsg(null)
    try {
      const res = await fetch('/api/clear', { method: 'POST' })
      const data = await res.json()
      setMsg(data.success ? 'Database cleared.' : 'Error: ' + (data.error ?? 'Unknown'))
      mutate()
    } finally { setClearing(false) }
  }

  const doCleanup = async () => {
    setCleaning(true)
    setMsg(null)
    try {
      const res = await fetch('/api/cleanup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ days: parseInt(cleanupDays) }) })
      const data = await res.json()
      setMsg(data.success ? `Cleaned up articles older than ${cleanupDays} days.` : 'Error: ' + (data.error ?? 'Unknown'))
      mutate()
    } finally { setCleaning(false) }
  }

  const total = stats?.total ?? 0
  const sources: Array<{ source: string; count: number; last_fetched: number }> = stats?.sources ?? []
  const sentiment = stats?.sentiment

  return (
    <div>
      <p className="text-neutral text-xs mb-4">Database statistics and data management.</p>

      {/* Stats overview */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <StatCard label="Total Articles" value={total.toLocaleString()} />
        <StatCard label="Sources" value={String(sources.length)} />
        {sentiment && <StatCard label="Bullish" value={String(sentiment.bullish ?? 0)} color="text-emerald-400" />}
        {sentiment && <StatCard label="Bearish" value={String(sentiment.bearish ?? 0)} color="text-red-400" />}
        {sentiment && <StatCard label="Neutral" value={String(sentiment.neutral ?? 0)} color="text-neutral" />}
        {sentiment && <StatCard label="Unanalyzed" value={String(sentiment.unanalyzed ?? 0)} color="text-yellow-400" />}
      </div>

      {/* Source breakdown */}
      {sources.length > 0 && (
        <div className="bg-surface border border-border rounded-lg overflow-hidden mb-6">
          <div className="px-3 py-2 border-b border-border">
            <span className="label">Articles by source</span>
          </div>
          <div className="max-h-48 overflow-y-auto divide-y divide-slate-700/30">
            {sources.map(s => (
              <div key={s.source} className="flex items-center gap-3 px-3 py-2">
                <span className="text-sm text-white flex-1">{s.source}</span>
                <span className="text-xs font-mono text-neutral">{s.count}</span>
                <span className="text-xs text-neutral">
                  {s.last_fetched ? new Date(s.last_fetched * 1000).toLocaleDateString() : '—'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="space-y-3">
        <div className="flex items-center gap-3 bg-surface border border-border rounded-lg px-4 py-3">
          <div className="flex-1">
            <div className="text-sm text-white">Cleanup Old Articles</div>
            <div className="text-xs text-neutral">Remove articles older than N days</div>
          </div>
          <select value={cleanupDays} onChange={e => setCleanupDays(e.target.value)}
            className="bg-bg border border-border text-xs text-neutral rounded px-2 py-1.5">
            <option value="7">7 days</option>
            <option value="14">14 days</option>
            <option value="30">30 days</option>
            <option value="60">60 days</option>
            <option value="90">90 days</option>
          </select>
          <button onClick={doCleanup} disabled={cleaning}
            className="px-3 py-1.5 bg-surface border border-border text-neutral text-xs rounded hover:text-white hover:border-accent disabled:opacity-50 transition-colors">
            {cleaning ? 'Cleaning...' : 'Cleanup'}
          </button>
        </div>

        <div className="flex items-center gap-3 bg-surface border border-border rounded-lg px-4 py-3">
          <div className="flex-1">
            <div className="text-sm text-white">Clear All Data</div>
            <div className="text-xs text-neutral">Delete all articles from database (irreversible)</div>
          </div>
          <button onClick={doClear} disabled={clearing}
            className="px-3 py-1.5 bg-red-500/10 border border-red-500/30 text-red-400 text-xs rounded hover:bg-red-500/20 disabled:opacity-50 transition-colors">
            {clearing ? 'Clearing...' : 'Clear All'}
          </button>
        </div>

        {msg && <div className="text-xs text-emerald-400 px-1">{msg}</div>}
      </div>
    </div>
  )
}

function StatCard({ label, value, color = 'text-white' }: { label: string; value: string; color?: string }) {
  return (
    <div className="bg-surface border border-border rounded-lg px-3 py-2.5">
      <div className="label mb-1">{label}</div>
      <div className={`text-lg font-mono font-bold ${color}`}>{value}</div>
    </div>
  )
}
