import { useCallback, useEffect, useState } from 'react'
import { useAuth } from './useAuth'

const LOCAL_KEY = 'flashfeed_watchlist'

function readLocal(): string[] {
  try { return JSON.parse(localStorage.getItem(LOCAL_KEY) || '[]') } catch { return [] }
}
function writeLocal(tickers: string[]) {
  try { localStorage.setItem(LOCAL_KEY, JSON.stringify(tickers)) } catch { /* ignore (private mode etc.) */ }
}

/**
 * A per-account watchlist — the first real use of /api/auth/preferences.
 * Logged in: saved to the account (follows you across devices/browsers).
 * Logged out: falls back to this browser's localStorage, so it still works
 * without an account, it just doesn't follow you anywhere.
 */
export function useWatchlist() {
  const { user } = useAuth()
  const [tickers, setTickers] = useState<string[]>(() => readLocal())
  const [loading, setLoading] = useState(!!user)

  useEffect(() => {
    if (!user) { setTickers(readLocal()); setLoading(false); return }
    let cancelled = false
    setLoading(true)
    fetch('/api/auth/preferences', { credentials: 'include' })
      .then(r => r.json())
      .then(data => {
        if (cancelled || !data?.ok) return
        const saved: string[] = Array.isArray(data.preferences?.watchlist) ? data.preferences.watchlist : readLocal()
        setTickers(saved)
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [user])

  const persist = useCallback(async (next: string[]) => {
    setTickers(next)
    if (!user) { writeLocal(next); return }
    try {
      await fetch('/api/auth/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ preferences: { watchlist: next } }),
      })
    } catch { /* best-effort — local state already updated */ }
  }, [user])

  const add = useCallback((ticker: string) => {
    const t = ticker.trim().toUpperCase()
    if (!t) return
    persist(Array.from(new Set([...tickers, t])))
  }, [tickers, persist])

  const remove = useCallback((ticker: string) => {
    persist(tickers.filter(t => t !== ticker.toUpperCase()))
  }, [tickers, persist])

  const has = useCallback((ticker: string) => tickers.includes(ticker.toUpperCase()), [tickers])

  return { tickers, loading, add, remove, has, savedToAccount: !!user }
}
