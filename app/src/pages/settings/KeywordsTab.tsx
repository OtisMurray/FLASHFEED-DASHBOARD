import { useEffect, useState } from 'react'
import { jsonFetch, inputCls } from './shared'

type KeywordRow = {
  keyword: string
  word?: string
  category?: string
  enabled?: boolean
  active?: boolean
}

export function KeywordsTab() {
  const [keywords, setKeywords] = useState<KeywordRow[]>([])
  const [newKeyword, setNewKeyword] = useState('')
  const [newKeywordCategory, setNewKeywordCategory] = useState('custom')
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)

  const load = async () => {
    setError(null)
    try {
      const kw = await jsonFetch('/api/settings/keywords')
      setKeywords(kw.keywords || [])
    } catch (e: any) {
      setError(String(e.message || e))
    }
  }

  useEffect(() => { load() }, [])

  const addKeyword = async () => {
    setError(null); setSaved(null)
    try {
      await jsonFetch('/api/settings/keywords', {
        method: 'POST',
        body: JSON.stringify({ keyword: newKeyword, category: newKeywordCategory }),
      })
      setNewKeyword('')
      setSaved('Keyword saved')
      await load()
    } catch (e: any) {
      setError(String(e.message || e))
    }
  }

  const removeKeyword = async (keyword: string) => {
    setError(null); setSaved(null)
    try {
      await jsonFetch(`/api/settings/keywords/${encodeURIComponent(keyword)}`, { method: 'DELETE' })
      setSaved('Keyword removed')
      await load()
    } catch (e: any) {
      setError(String(e.message || e))
    }
  }

  const toggleKeyword = async (keyword: string, enabled: boolean) => {
    setError(null); setSaved(null)
    try {
      await jsonFetch(`/api/settings/keywords/${encodeURIComponent(keyword)}`, {
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
      <p className="text-sm text-neutral">Used by the news filter and keyword highlighting.</p>

      {error && <div className="border border-red-500/40 bg-red-500/10 text-red-300 rounded-lg p-3 text-sm">{error}</div>}
      {saved && <div className="border border-emerald-500/40 bg-emerald-500/10 text-emerald-300 rounded-lg p-3 text-sm">{saved}</div>}

      <div className="grid grid-cols-1 md:grid-cols-[1fr_160px_auto] gap-2">
        <input value={newKeyword} onChange={e => setNewKeyword(e.target.value)}
          placeholder="e.g. reverse split" className={inputCls} />
        <input value={newKeywordCategory} onChange={e => setNewKeywordCategory(e.target.value)}
          placeholder="category" className={inputCls} />
        <button onClick={addKeyword} disabled={!newKeyword.trim()}
          className="bg-sky-700 text-white rounded px-4 py-2 text-sm disabled:opacity-40">
          Add Keyword
        </button>
      </div>

      <div className="overflow-x-auto border border-border rounded-lg">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-neutral border-b border-border bg-surface">
              <th className="py-2 px-3">Keyword</th>
              <th className="py-2 px-3">Category</th>
              <th className="py-2 px-3">Status</th>
              <th className="py-2 px-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {keywords.map(k => {
              const kw = k.keyword || k.word || ''
              const enabled = k.enabled !== false && k.active !== false
              return (
                <tr key={kw} className="border-b border-border/50">
                  <td className="py-2 px-3 text-white">{kw}</td>
                  <td className="py-2 px-3 text-neutral">{k.category || 'custom'}</td>
                  <td className="py-2 px-3 text-neutral">{enabled ? 'enabled' : 'disabled'}</td>
                  <td className="py-2 px-3 text-right space-x-3">
                    <button onClick={() => toggleKeyword(kw, !enabled)} className="text-xs text-neutral hover:text-white">
                      {enabled ? 'Disable' : 'Enable'}
                    </button>
                    <button onClick={() => removeKeyword(kw)} className="text-xs text-red-400 hover:text-red-300">
                      Remove
                    </button>
                  </td>
                </tr>
              )
            })}
            {!keywords.length && (
              <tr><td colSpan={4} className="py-4 text-center text-neutral">No keywords yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
