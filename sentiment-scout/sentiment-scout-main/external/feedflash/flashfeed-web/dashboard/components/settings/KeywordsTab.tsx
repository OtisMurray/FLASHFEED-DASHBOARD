'use client'
import useSWR from 'swr'
import { useState } from 'react'
import { clsx } from 'clsx'

const fetcher = (url: string) => fetch(url).then(r => r.json())

const CATEGORIES = ['fundamental', 'corporate', 'regulatory', 'analyst', 'risk', 'general']

export function KeywordsTab() {
  const { data, mutate } = useSWR('/api/settings/keywords', fetcher)
  const [word, setWord] = useState('')
  const [category, setCategory] = useState('general')
  const [loading, setLoading] = useState(false)

  const keywords: Array<{ id: number; word: string; category: string; active: number }> = data?.keywords ?? []

  const addKeyword = async () => {
    if (!word.trim()) return
    setLoading(true)
    try {
      await fetch('/api/settings/keywords', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ word: word.trim(), category }),
      })
      setWord('')
      mutate()
    } finally { setLoading(false) }
  }

  const toggleActive = async (id: number, active: boolean) => {
    await fetch(`/api/settings/keywords/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active }),
    })
    mutate()
  }

  const remove = async (id: number) => {
    await fetch(`/api/settings/keywords/${id}`, { method: 'DELETE' })
    mutate()
  }

  return (
    <div>
      <p className="text-neutral text-xs mb-3">Keywords pre-filter headlines before ML scoring. Only articles matching active keywords are prioritized.</p>
      <div className="flex gap-2 mb-4 flex-wrap">
        <input
          value={word} onChange={e => setWord(e.target.value)} placeholder="Keyword (e.g. Earnings)"
          onKeyDown={e => e.key === 'Enter' && addKeyword()}
          className="flex-1 min-w-[160px] bg-bg border border-border text-sm text-white rounded px-3 py-2 focus:outline-none focus:border-accent placeholder:text-slate-600"
        />
        <select value={category} onChange={e => setCategory(e.target.value)}
          className="w-[150px] bg-bg border border-border text-sm text-neutral rounded px-3 py-2 focus:outline-none focus:border-accent">
          {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <button onClick={addKeyword} disabled={loading || !word.trim()}
          className="px-4 py-2 bg-accent text-white text-sm font-medium rounded hover:bg-sky-400 disabled:opacity-50 transition-colors">
          {loading ? 'Adding...' : 'Add'}
        </button>
      </div>
      <div className="bg-surface border border-border rounded-lg overflow-hidden">
        {keywords.length === 0 ? (
          <div className="p-4 text-center text-neutral text-sm">No keywords configured.</div>
        ) : (
          <div className="divide-y divide-slate-700/30">
            {keywords.map(k => (
              <div key={k.id} className="flex items-center gap-3 px-3 py-2.5 hover:bg-card-hover">
                <button
                  onClick={() => toggleActive(k.id, !k.active)}
                  className={clsx('w-3 h-3 rounded-full border-2 transition-colors',
                    k.active ? 'bg-bull border-bull' : 'bg-transparent border-slate-500'
                  )}
                  title={k.active ? 'Active — click to disable' : 'Inactive — click to enable'}
                />
                <span className={clsx('text-sm flex-1', k.active ? 'text-white' : 'text-neutral line-through')}>{k.word}</span>
                <span className="text-xs border border-border text-neutral px-2 py-0.5 rounded">{k.category}</span>
                <button onClick={() => remove(k.id)} className="text-red-400 text-xs hover:text-red-300">×</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
