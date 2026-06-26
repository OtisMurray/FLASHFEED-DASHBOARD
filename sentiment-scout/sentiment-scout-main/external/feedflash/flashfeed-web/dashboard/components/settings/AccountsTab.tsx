'use client'
import useSWR from 'swr'
import { useState } from 'react'
import { clsx } from 'clsx'

const fetcher = (url: string) => fetch(url).then(r => r.json())

export function AccountsTab() {
  const { data, mutate } = useSWR('/api/settings/accounts', fetcher)
  const [platform, setPlatform] = useState('reddit')
  const [handle, setHandle] = useState('')
  const [loading, setLoading] = useState(false)

  const accounts: Array<{ id: number; platform: string; handle: string; active: number }> = data?.accounts ?? []

  const addAccount = async () => {
    if (!handle.trim()) return
    setLoading(true)
    try {
      await fetch('/api/settings/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform, handle: handle.trim() }),
      })
      setHandle('')
      mutate()
    } finally { setLoading(false) }
  }

  const toggleActive = async (id: number, active: boolean) => {
    await fetch(`/api/settings/accounts/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active }),
    })
    mutate()
  }

  const remove = async (id: number) => {
    await fetch(`/api/settings/accounts/${id}`, { method: 'DELETE' })
    mutate()
  }

  const platformColor = (p: string) => {
    if (p === 'reddit') return 'border-orange-500/30 text-orange-400'
    if (p === 'twitter') return 'border-sky-400/30 text-sky-300'
    if (p === 'stocktwits') return 'border-emerald-500/30 text-emerald-400'
    return 'border-border text-neutral'
  }

  return (
    <div>
      <p className="text-neutral text-xs mb-3">Watched Reddit/X accounts — used by the social scraper pipeline.</p>
      <div className="flex gap-2 mb-4 flex-wrap">
        <select value={platform} onChange={e => setPlatform(e.target.value)}
          className="w-[130px] bg-bg border border-border text-sm text-neutral rounded px-3 py-2 focus:outline-none focus:border-accent">
          <option value="reddit">Reddit</option>
          <option value="twitter">Twitter/X</option>
          <option value="stocktwits">StockTwits</option>
        </select>
        <input
          value={handle} onChange={e => setHandle(e.target.value)} placeholder="Handle (e.g. wallstreetbets)"
          onKeyDown={e => e.key === 'Enter' && addAccount()}
          className="flex-1 min-w-[180px] bg-bg border border-border text-sm text-white rounded px-3 py-2 focus:outline-none focus:border-accent placeholder:text-slate-600"
        />
        <button onClick={addAccount} disabled={loading || !handle.trim()}
          className="px-4 py-2 bg-accent text-white text-sm font-medium rounded hover:bg-sky-400 disabled:opacity-50 transition-colors">
          {loading ? 'Adding...' : 'Add'}
        </button>
      </div>
      <div className="bg-surface border border-border rounded-lg overflow-hidden">
        {accounts.length === 0 ? (
          <div className="p-4 text-center text-neutral text-sm">No accounts configured.</div>
        ) : (
          <div className="divide-y divide-slate-700/30">
            {accounts.map(a => (
              <div key={a.id} className="flex items-center gap-3 px-3 py-2.5 hover:bg-card-hover">
                <button
                  onClick={() => toggleActive(a.id, !a.active)}
                  className={clsx('w-3 h-3 rounded-full border-2 transition-colors',
                    a.active ? 'bg-bull border-bull' : 'bg-transparent border-slate-500'
                  )}
                />
                <span className={clsx('text-xs font-medium px-2 py-0.5 rounded border', platformColor(a.platform))}>
                  {a.platform}
                </span>
                <span className={clsx('text-sm flex-1', a.active ? 'text-white' : 'text-neutral line-through')}>
                  {a.handle}
                </span>
                <button onClick={() => remove(a.id)} className="text-red-400 text-xs hover:text-red-300">×</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
