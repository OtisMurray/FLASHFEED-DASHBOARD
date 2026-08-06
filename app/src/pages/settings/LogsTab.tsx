import { useEffect, useState } from 'react'
import { jsonFetch } from './shared'

type LogEntry = { ts: number; level: 'info' | 'warn' | 'error'; message: string }

const levelTone: Record<LogEntry['level'], string> = {
  info: 'text-slate-300',
  warn: 'text-yellow-400',
  error: 'text-red-400',
}

export function LogsTab() {
  const [entries, setEntries] = useState<LogEntry[]>([])
  const [level, setLevel] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [autoRefresh, setAutoRefresh] = useState(true)

  const load = async () => {
    setError(null)
    try {
      const data = await jsonFetch(`/api/settings/logs${level ? `?level=${level}` : ''}`)
      setEntries(data.entries || [])
    } catch (e: any) {
      setError(String(e.message || e))
    }
  }

  useEffect(() => {
    load()
    if (!autoRefresh) return
    const id = setInterval(load, 10_000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [level, autoRefresh])

  return (
    <div className="space-y-4">
      <p className="text-sm text-neutral">
        Recent server activity for this process only — it resets on every deploy or restart, and is not a substitute for Railway's own deployment logs.
      </p>

      {error && <div className="border border-red-500/40 bg-red-500/10 text-red-300 rounded-lg p-3 text-sm">{error}</div>}

      <div className="flex items-center gap-2">
        {(['', 'info', 'warn', 'error'] as const).map(l => (
          <button key={l} onClick={() => setLevel(l)}
            className={`px-3 py-1.5 rounded border text-xs capitalize ${level === l ? 'bg-slate-700/60 text-white border-border' : 'text-neutral border-border hover:text-white'}`}>
            {l || 'all'}
          </button>
        ))}
        <button onClick={load} className="ml-auto px-3 py-1.5 rounded border border-border text-xs text-neutral hover:text-white">
          Refresh
        </button>
        <label className="flex items-center gap-1.5 text-xs text-neutral">
          <input type="checkbox" checked={autoRefresh} onChange={e => setAutoRefresh(e.target.checked)} />
          Auto-refresh
        </label>
      </div>

      <div className="border border-border rounded-lg overflow-hidden">
        <div className="max-h-[60vh] overflow-y-auto font-mono text-xs divide-y divide-border/40">
          {entries.map((e, i) => (
            <div key={i} className="px-3 py-1.5 flex gap-3">
              <span className="text-neutral shrink-0">{new Date(e.ts).toLocaleTimeString()}</span>
              <span className={`shrink-0 uppercase ${levelTone[e.level]}`}>{e.level}</span>
              <span className="text-slate-300 break-all">{e.message}</span>
            </div>
          ))}
          {!entries.length && <div className="px-3 py-4 text-center text-neutral">No log entries yet.</div>}
        </div>
      </div>
    </div>
  )
}
