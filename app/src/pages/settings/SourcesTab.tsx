import { useEffect, useState } from 'react'
import { jsonFetch, statusClass, inputCls } from './shared'

type SourceRow = {
  source?: string
  name?: string
  url?: string
  category?: string
  status?: string
  method?: string
  count?: number
  enabled?: boolean
}

export function SourcesTab() {
  const [structured, setStructured] = useState<SourceRow[]>([])
  const [customSources, setCustomSources] = useState<SourceRow[]>([])
  const [newSourceName, setNewSourceName] = useState('')
  const [newSourceUrl, setNewSourceUrl] = useState('')
  const [newSourceCategory, setNewSourceCategory] = useState('general')
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)

  const load = async () => {
    setError(null)
    try {
      const src = await jsonFetch('/api/settings/sources')
      setStructured(src.structured || [])
      setCustomSources(src.custom_rss_sources || [])
    } catch (e: any) {
      setError(String(e.message || e))
    }
  }

  useEffect(() => { load() }, [])

  const addSource = async () => {
    setError(null); setSaved(null)
    try {
      await jsonFetch('/api/settings/sources', {
        method: 'POST',
        body: JSON.stringify({ name: newSourceName, url: newSourceUrl, category: newSourceCategory }),
      })
      setNewSourceName(''); setNewSourceUrl('')
      setSaved('Source saved')
      await load()
    } catch (e: any) {
      setError(String(e.message || e))
    }
  }

  const removeSource = async (name: string) => {
    setError(null); setSaved(null)
    try {
      await jsonFetch(`/api/settings/sources/${encodeURIComponent(name)}`, { method: 'DELETE' })
      setSaved('Source removed')
      await load()
    } catch (e: any) {
      setError(String(e.message || e))
    }
  }

  const toggleSource = async (name: string, enabled: boolean) => {
    setError(null); setSaved(null)
    try {
      await jsonFetch(`/api/settings/sources/${encodeURIComponent(name)}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled }),
      })
      await load()
    } catch (e: any) {
      setError(String(e.message || e))
    }
  }

  return (
    <div className="space-y-6">
      <p className="text-sm text-neutral">RSS feeds that FlashFeed scrapes for articles.</p>

      {error && <div className="border border-red-500/40 bg-red-500/10 text-red-300 rounded-lg p-3 text-sm">{error}</div>}
      {saved && <div className="border border-emerald-500/40 bg-emerald-500/10 text-emerald-300 rounded-lg p-3 text-sm">{saved}</div>}

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_1fr_150px_auto] gap-2">
        <input value={newSourceName} onChange={e => setNewSourceName(e.target.value)}
          placeholder="Feed name" className={inputCls} />
        <input value={newSourceUrl} onChange={e => setNewSourceUrl(e.target.value)}
          placeholder="RSS URL" className={inputCls} />
        <input value={newSourceCategory} onChange={e => setNewSourceCategory(e.target.value)}
          placeholder="category" className={inputCls} />
        <button
          onClick={addSource}
          disabled={!newSourceName.trim() || !newSourceUrl.trim()}
          className="bg-sky-700 text-white rounded px-4 py-2 text-sm disabled:opacity-40 whitespace-nowrap"
        >
          Add
        </button>
      </div>

      <div className="overflow-x-auto border border-border rounded-lg">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-neutral border-b border-border bg-surface">
              <th className="py-2 px-3">Name</th>
              <th className="py-2 px-3">URL</th>
              <th className="py-2 px-3">Category</th>
              <th className="py-2 px-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {customSources.map(s => {
              const name = s.name || s.source || ''
              const enabled = s.enabled !== false
              return (
                <tr key={name} className="border-b border-border/50">
                  <td className="py-2 px-3 text-white">{name}</td>
                  <td className="py-2 px-3 text-sky-400 truncate max-w-[280px]" title={s.url}>{s.url}</td>
                  <td className="py-2 px-3 text-neutral">{s.category || 'general'}</td>
                  <td className="py-2 px-3 text-right space-x-3">
                    <button onClick={() => toggleSource(name, !enabled)} className="text-xs text-neutral hover:text-white">
                      {enabled ? 'Disable' : 'Enable'}
                    </button>
                    <button onClick={() => removeSource(name)} className="text-xs text-red-400 hover:text-red-300">
                      Remove
                    </button>
                  </td>
                </tr>
              )
            })}
            {!customSources.length && (
              <tr><td colSpan={4} className="py-4 text-center text-neutral">No sources yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div>
        <h2 className="text-white font-medium text-sm mb-2">Professor Structured Sources</h2>
        <p className="text-xs text-neutral mb-3">Working sources show article counts. Licensed/API-gated sources stay visible instead of being hidden.</p>
        <div className="overflow-x-auto border border-border rounded-lg">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-neutral border-b border-border bg-surface">
                <th className="py-2 px-3">Source</th>
                <th className="py-2 px-3">Status</th>
                <th className="py-2 px-3">Method</th>
                <th className="py-2 px-3 text-right">Articles</th>
              </tr>
            </thead>
            <tbody>
              {structured.map(s => (
                <tr key={s.source || s.name} className="border-b border-border/50">
                  <td className="py-2 px-3 text-white">{s.source || s.name}</td>
                  <td className="py-2 px-3">
                    <span className={`inline-flex border rounded-full px-2 py-0.5 text-xs ${statusClass(s.status)}`}>{s.status}</span>
                  </td>
                  <td className="py-2 px-3 text-neutral">{s.method}</td>
                  <td className="py-2 px-3 text-right font-mono text-neutral">{s.count ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
