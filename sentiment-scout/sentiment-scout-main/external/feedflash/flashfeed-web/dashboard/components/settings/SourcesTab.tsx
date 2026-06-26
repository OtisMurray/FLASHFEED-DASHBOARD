
'use client'
import useSWR from 'swr'
import { useState } from 'react'

const fetcher = (url: string) => fetch(url).then(r => r.json())

export function SourcesTab() {
  const { data, mutate } = useSWR('/api/sources', fetcher)
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [category, setCategory] = useState('general')
  const [loading, setLoading] = useState(false)

  const sources: Array<{ name: string; url: string; category?: string }> = data?.sources ?? []

  const addSource = async () => {
    if (!name.trim() || !url.trim()) return
    setLoading(true)
    try {
      const res = await fetch('/api/sources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), url: url.trim(), category: category.trim() || 'general' }),
      })
      const j = await res.json()
      if (j.success) {
        setName(''); setUrl(''); setCategory('general')
        mutate()
      }
    } finally { setLoading(false) }
  }

  const removeSource = async (sourceName: string) => {
    await fetch(`/api/sources/${encodeURIComponent(sourceName)}`, { method: 'DELETE' })
    mutate()
  }

  return (
    <div>
      <p className="text-neutral text-xs mb-3">RSS feeds that FlashFeed scrapes for articles.</p>
      <div className="flex gap-2 mb-4 flex-wrap">
        <input
          value={name} onChange={e => setName(e.target.value)} placeholder="Feed name"
          className="flex-1 min-w-[140px] bg-bg border border-border text-sm text-white rounded px-3 py-2 focus:outline-none focus:border-accent placeholder:text-slate-600"
        />
        <input
          value={url} onChange={e => setUrl(e.target.value)} placeholder="RSS URL"
          className="flex-[2] min-w-[200px] bg-bg border border-border text-sm text-white rounded px-3 py-2 focus:outline-none focus:border-accent placeholder:text-slate-600"
        />
        <input
          value={category} onChange={e => setCategory(e.target.value)} placeholder="Category"
          className="w-[120px] bg-bg border border-border text-sm text-white rounded px-3 py-2 focus:outline-none focus:border-accent placeholder:text-slate-600"
        />
        <button onClick={addSource} disabled={loading || !name.trim() || !url.trim()}
          className="px-4 py-2 bg-accent text-white text-sm font-medium rounded hover:bg-sky-400 disabled:opacity-50 transition-colors">
          {loading ? 'Adding...' : 'Add'}
        </button>
      </div>
      <div className="bg-surface border border-border rounded-lg overflow-hidden">
        {sources.length === 0 ? (
          <div className="p-4 text-center text-neutral text-sm">No sources configured. Add an RSS feed above.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-border">
              <tr>
                <th className="px-3 py-2 text-left label">NAME</th>
                <th className="px-3 py-2 text-left label">URL</th>
                <th className="px-3 py-2 text-left label">CATEGORY</th>
                <th className="px-3 py-2 text-right label">ACTIONS</th>
              </tr>
            </thead>
            <tbody>
              {sources.map(s => (
                <tr key={s.name} className="border-b border-slate-700/30 hover:bg-card-hover">
                  <td className="px-3 py-2 text-white">{s.name}</td>
                  <td className="px-3 py-2 text-neutral text-xs max-w-[200px] truncate">{s.url}</td>
                  <td className="px-3 py-2 text-neutral text-xs">{s.category ?? 'general'}</td>
                  <td className="px-3 py-2 text-right">
                    <button onClick={() => removeSource(s.name)}
                      className="text-red-400 text-xs hover:text-red-300 transition-colors">Remove</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
