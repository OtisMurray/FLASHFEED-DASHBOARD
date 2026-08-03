import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '@/lib/useAuth'
import { useWatchlist } from '@/lib/useWatchlist'

// The first real thing an account "caches": add tickers here while logged in
// and they follow you to any device/browser instead of living only in this
// browser's localStorage.
export function WatchlistPage() {
  const { user } = useAuth()
  const { tickers, loading, add, remove, savedToAccount } = useWatchlist()
  const [input, setInput] = useState('')

  function handleAdd(e: React.FormEvent) {
    e.preventDefault()
    add(input)
    setInput('')
  }

  return (
    <div className="p-4 max-w-2xl mx-auto space-y-4">
      <div>
        <h1 className="text-lg font-bold text-white">Watchlist</h1>
        <p className="text-xs text-neutral mt-1">
          {savedToAccount
            ? `Saved to your account (${user?.username}) — follows you to any device.`
            : <>Saved to this browser only. <Link to="/login" className="text-accent hover:underline">Log in</Link> to save it to your account instead.</>}
        </p>
      </div>

      <form onSubmit={handleAdd} className="flex gap-2">
        <input
          value={input}
          onChange={e => setInput(e.target.value.toUpperCase())}
          placeholder="Ticker (e.g. AAPL)"
          className="flex-1 bg-bg border border-border rounded px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-accent font-mono"
        />
        <button type="submit" disabled={!input.trim()}
          className="px-4 py-2 bg-accent text-white text-sm font-medium rounded hover:bg-sky-400 disabled:opacity-50">
          Add
        </button>
      </form>

      {loading ? (
        <div className="text-sm text-neutral">Loading…</div>
      ) : tickers.length === 0 ? (
        <div className="bg-surface border border-border rounded-lg p-6 text-center text-neutral text-sm">
          No tickers yet — add one above.
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {tickers.map(t => (
            <span key={t} className="inline-flex items-center gap-1.5 bg-surface border border-border rounded-full pl-3 pr-1.5 py-1 text-sm font-mono text-white">
              {t}
              <button onClick={() => remove(t)} title={`Remove ${t}`}
                className="w-5 h-5 flex items-center justify-center rounded-full text-neutral hover:text-red-400 hover:bg-red-500/10">
                ×
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
