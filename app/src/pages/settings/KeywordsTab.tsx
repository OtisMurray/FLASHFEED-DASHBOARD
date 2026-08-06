import { useState } from 'react'
import { jsonFetch, inputCls, Section, timeAgo, type KeywordRow } from './shared'

type Props = {
  keywords: KeywordRow[]
  reload: () => void
  onError: (msg: string) => void
  onSaved: (msg: string) => void
}

/**
 * Keywords / catalyst rules.
 *
 * The same CRUD that was already here, moved onto its own tab. The write verbs
 * are admin-only on the server; this tab is only reachable from an admin-guarded
 * route, so it does not re-check — the API is the boundary.
 */
export function KeywordsTab({ keywords, reload, onError, onSaved }: Props) {
  const [newKeyword, setNewKeyword] = useState('')
  const [newKeywordCategory, setNewKeywordCategory] = useState('custom')
  const [filter, setFilter] = useState('')
  const [busy, setBusy] = useState<string | null>(null)

  const run = async (key: string, fn: () => Promise<void>, savedMsg?: string) => {
    setBusy(key)
    try {
      await fn()
      if (savedMsg) onSaved(savedMsg)
      reload()
    } catch (e) {
      onError(String((e as Error).message || e))
    } finally {
      setBusy(null)
    }
  }

  const addKeyword = () =>
    run('new', async () => {
      await jsonFetch('/api/settings/keywords', {
        method: 'POST',
        body: JSON.stringify({ keyword: newKeyword, category: newKeywordCategory }),
      })
      setNewKeyword('')
    }, 'Keyword saved')

  const removeKeyword = (keyword: string) =>
    run(keyword, async () => {
      await jsonFetch(`/api/settings/keywords/${encodeURIComponent(keyword)}`, { method: 'DELETE' })
    }, 'Keyword removed')

  const toggleKeyword = (keyword: string, enabled: boolean) =>
    run(keyword, async () => {
      await jsonFetch(`/api/settings/keywords/${encodeURIComponent(keyword)}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled }),
      })
    }, `${keyword} ${enabled ? 'enabled' : 'disabled'}`)

  const needle = filter.trim().toLowerCase()
  const shown = needle
    ? keywords.filter(k => `${k.keyword || k.word || ''} ${k.category || ''}`.toLowerCase().includes(needle))
    : keywords

  return (
    <Section
      title="Keyword dictionary"
      hint="Drives the news filter, keyword highlighting and the catalyst rules that read it."
      right={
        <span className="text-xs text-neutral whitespace-nowrap">
          {needle ? `${shown.length} of ${keywords.length}` : `${keywords.length} keywords`}
        </span>
      }
    >
      <div className="grid grid-cols-1 md:grid-cols-[1fr_160px_auto] gap-2 mb-3">
        <input
          value={newKeyword}
          onChange={e => setNewKeyword(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && newKeyword.trim()) addKeyword() }}
          placeholder="e.g. reverse split"
          className={inputCls}
        />
        <input
          value={newKeywordCategory}
          onChange={e => setNewKeywordCategory(e.target.value)}
          placeholder="category"
          className={inputCls}
        />
        <button
          onClick={addKeyword}
          disabled={!newKeyword.trim() || busy === 'new'}
          className="bg-sky-700 text-white rounded px-4 py-2 text-sm disabled:opacity-40"
        >
          Add keyword
        </button>
      </div>

      {/* The dictionary runs to a few hundred entries, so it needs a way to
          reach one without scrolling the whole grid. */}
      <input
        value={filter}
        onChange={e => setFilter(e.target.value)}
        placeholder="Filter keywords"
        className={`${inputCls} w-full md:max-w-xs mb-4`}
      />

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
        {shown.map(k => {
          const kw = k.keyword || k.word || ''
          const enabled = k.enabled !== false && k.active !== false
          return (
            <div key={kw} className="flex items-center justify-between gap-2 border border-border rounded p-2 bg-bg/40">
              <div className="min-w-0">
                <div className="text-sm text-white truncate">{kw}</div>
                <div className="text-[11px] text-neutral">
                  {k.category || 'custom'} · {enabled ? 'enabled' : 'disabled'}
                </div>
                {/* Absent for the seeded defaults and for anything changed
                    before the stamp existed — shown as absent, not guessed. */}
                {(k.updated_by || k.updated_at) && (
                  <div className="text-[11px] text-neutral">
                    changed {k.updated_at ? timeAgo(k.updated_at) : ''}{k.updated_by ? ` by ${k.updated_by}` : ''}
                  </div>
                )}
              </div>
              <div className="flex gap-1 shrink-0">
                <button
                  onClick={() => toggleKeyword(kw, !enabled)}
                  disabled={busy === kw}
                  className="text-xs border border-border text-neutral rounded px-2 py-1 hover:text-white disabled:opacity-40"
                >
                  {enabled ? 'Disable' : 'Enable'}
                </button>
                <button
                  onClick={() => removeKeyword(kw)}
                  disabled={busy === kw}
                  className="text-xs border border-red-500/40 text-red-300 rounded px-2 py-1 hover:text-red-200 disabled:opacity-40"
                >
                  Remove
                </button>
              </div>
            </div>
          )
        })}
        {!shown.length && (
          <div className="text-sm text-neutral border border-border rounded p-3 md:col-span-2 xl:col-span-3">
            {keywords.length ? 'No keywords match that filter.' : 'No keywords yet.'}
          </div>
        )}
      </div>
    </Section>
  )
}
