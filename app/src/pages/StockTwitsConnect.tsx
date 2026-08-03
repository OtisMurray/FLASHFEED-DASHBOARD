import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '@/lib/useAuth'

const jsonFetch = (url: string, init?: RequestInit) =>
  fetch(url, { credentials: 'include', ...init }).then(r => r.json())

interface StockTwitsStatus { configured: boolean; connected: boolean; username: string | null }

// Real StockTwits login (OAuth2 — their login page, FlashFeed never sees the
// password), surfaced directly on the StockTwits tab instead of buried in
// Account settings.
export function StockTwitsConnect() {
  const { user } = useAuth()
  const [status, setStatus] = useState<StockTwitsStatus | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!user) return
    jsonFetch('/api/auth/stocktwits/status').then(d => d?.ok && setStatus(d))
  }, [user])

  async function connect() {
    setError('')
    const data = await jsonFetch('/api/auth/stocktwits/connect')
    if (data.ok && data.authorizeUrl) window.location.href = data.authorizeUrl
    else setError(data.error || 'StockTwits login is not available yet.')
  }

  async function disconnect() {
    await jsonFetch('/api/auth/stocktwits/disconnect', { method: 'POST' })
    setStatus(s => (s ? { ...s, connected: false, username: null } : s))
  }

  if (!user) {
    return (
      <div className="border border-slate-700 bg-slate-800/60 rounded-xl p-4 mb-6 flex items-center justify-between gap-3">
        <span className="text-sm text-neutral">
          <Link to="/login" className="text-sky-400 hover:underline">Log in</Link> to connect your StockTwits account.
        </span>
      </div>
    )
  }

  return (
    <div className="border border-slate-700 bg-slate-800/60 rounded-xl p-4 mb-6 flex items-center justify-between gap-3 flex-wrap">
      <div>
        <div className="text-sm font-semibold text-white">StockTwits account</div>
        <div className="text-xs text-neutral mt-0.5">
          {status?.connected
            ? `Connected as @${status.username}`
            : status?.configured
              ? 'Not connected yet.'
              : 'Login isn\'t set up on the server yet.'}
        </div>
        {error && <div className="text-xs text-red-400 mt-1">{error}</div>}
      </div>
      {status?.connected ? (
        <button onClick={disconnect} className="px-3 py-1.5 text-xs font-medium rounded border border-slate-600 text-neutral hover:text-white hover:border-red-400">
          Disconnect
        </button>
      ) : (
        <button onClick={connect} disabled={!status?.configured}
          className="px-3 py-1.5 text-xs font-medium rounded bg-sky-600 hover:bg-sky-500 disabled:opacity-40 disabled:cursor-not-allowed text-white">
          {status?.configured ? 'Log in to StockTwits' : 'Not available yet'}
        </button>
      )}
    </div>
  )
}
