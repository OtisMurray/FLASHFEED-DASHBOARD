import { useEffect, useState } from 'react'

type KeywordRow = {
  keyword: string
  word?: string
  category?: string
  enabled?: boolean
  active?: boolean
  hits?: number
}

type SourceRow = {
  source?: string
  name?: string
  url?: string
  category?: string
  status?: string
  method?: string
  note?: string
  count?: number
  enabled?: boolean
  editable?: boolean
  configured?: boolean
  latest_fetch?: number | string | null
  detail?: string
  collection?: string
}

type ConnectionRow = {
  label: string
  url: string
  token: string
  login: string
}

type ConnectionSettings = Record<string, ConnectionRow>

async function jsonFetch(url: string, options?: RequestInit) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(options?.headers || {}) },
    ...options,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `Request failed: ${res.status}`)
  return data
}

export function SettingsPage() {
  const [keywords, setKeywords] = useState<KeywordRow[]>([])
  const [structured, setStructured] = useState<SourceRow[]>([])
  const [customSources, setCustomSources] = useState<SourceRow[]>([])
  const [sourceHealth, setSourceHealth] = useState<{ working_count?: number; ready_count?: number; blocked_count?: number; planned_count?: number; sources?: SourceRow[] }>({})
  const [connections, setConnections] = useState<ConnectionSettings>({})
  const [newKeyword, setNewKeyword] = useState('')
  const [newKeywordCategory, setNewKeywordCategory] = useState('custom')
  const [newSourceName, setNewSourceName] = useState('')
  const [newSourceUrl, setNewSourceUrl] = useState('')
  const [newSourceCategory, setNewSourceCategory] = useState('custom')
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const [loadingHealth, setLoadingHealth] = useState(false)

  const load = async () => {
    setError(null)
    setLoadingHealth(true)
    try {
      const [kw, src, conn, health] = await Promise.all([
        jsonFetch('/api/settings/keywords'),
        jsonFetch('/api/settings/sources'),
        jsonFetch('/api/settings/connections'),
        jsonFetch('/api/sources/health').catch(() => ({ sources: [] })),
      ])
      setKeywords(kw.keywords || [])
      setStructured(src.structured || [])
      setCustomSources(src.custom_rss_sources || [])
      setConnections(conn.connections || {})
      setSourceHealth(health || {})
    } finally {
      setLoadingHealth(false)
    }
  }

  useEffect(() => {
    load().catch(e => setError(String(e.message || e)))
  }, [])

  const addKeyword = async () => {
    setError(null); setSaved(null)
    await jsonFetch('/api/settings/keywords', {
      method: 'POST',
      body: JSON.stringify({ keyword: newKeyword, category: newKeywordCategory }),
    })
    setNewKeyword('')
    setSaved('Keyword saved')
    await load()
  }

  const removeKeyword = async (keyword: string) => {
    setError(null); setSaved(null)
    await jsonFetch(`/api/settings/keywords/${encodeURIComponent(keyword)}`, { method: 'DELETE' })
    setSaved('Keyword removed')
    await load()
  }

  const toggleKeyword = async (keyword: string, enabled: boolean) => {
    setError(null); setSaved(null)
    await jsonFetch(`/api/settings/keywords/${encodeURIComponent(keyword)}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    })
    await load()
  }

  const addSource = async () => {
    setError(null); setSaved(null)
    await jsonFetch('/api/settings/sources', {
      method: 'POST',
      body: JSON.stringify({ name: newSourceName, url: newSourceUrl, category: newSourceCategory }),
    })
    setNewSourceName('')
    setNewSourceUrl('')
    setSaved('RSS source saved')
    await load()
  }

  const removeSource = async (name: string) => {
    setError(null); setSaved(null)
    await jsonFetch(`/api/settings/sources/${encodeURIComponent(name)}`, { method: 'DELETE' })
    setSaved('RSS source removed')
    await load()
  }

  const toggleSource = async (name: string, enabled: boolean) => {
    setError(null); setSaved(null)
    await jsonFetch(`/api/settings/sources/${encodeURIComponent(name)}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    })
    await load()
  }

  const setConnectionField = (key: string, field: keyof ConnectionRow, value: string) => {
    setConnections(prev => ({
      ...prev,
      [key]: {
        ...(prev[key] || { label: key, url: '', token: '', login: '' }),
        [field]: value,
      },
    }))
  }

  const saveConnections = async () => {
    setError(null); setSaved(null)
    const data = await jsonFetch('/api/settings/connections', {
      method: 'PATCH',
      body: JSON.stringify({ connections }),
    })
    setConnections(data.connections || connections)
    setSaved('Connection settings saved')
  }

  const statusClass = (s?: string) => {
    if (!s) return 'text-slate-400 border-slate-600'
    if (s.includes('working') || s.includes('public') || s === 'enabled') return 'text-emerald-400 border-emerald-500/50'
    if (s.includes('ready')) return 'text-sky-400 border-sky-500/50'
    if (s.includes('required') || s.includes('contract')) return 'text-yellow-400 border-yellow-500/50'
    if (s.includes('disabled') || s.includes('invalid')) return 'text-red-400 border-red-500/50'
    return 'text-slate-400 border-slate-600'
  }

  const timeAgo = (value?: number | string | null) => {
    if (!value) return '--'
    const raw = Number(value)
    const ms = Number.isFinite(raw) ? (raw > 1_000_000_000_000 ? raw : raw * 1000) : Date.parse(String(value))
    if (!Number.isFinite(ms)) return '--'
    const diff = Math.max(0, Date.now() - ms)
    if (diff < 60_000) return 'now'
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
    return `${Math.floor(diff / 86_400_000)}d ago`
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-white font-semibold text-2xl">Settings</h1>
        <p className="text-sm text-neutral mt-1">
          Manage signal keywords and custom RSS sources. Custom keywords filter news articles and appear in article summaries. Licensed sources are listed with their current import status.
        </p>
      </div>

      {error && <div className="border border-red-500/40 bg-red-500/10 text-red-300 rounded-lg p-3 text-sm">{error}</div>}
      {saved && <div className="border border-emerald-500/40 bg-emerald-500/10 text-emerald-300 rounded-lg p-3 text-sm">{saved}</div>}

      <section className="bg-surface border border-border rounded-lg p-4">
        <div className="flex items-center justify-between gap-3 mb-3">
          <div>
            <h2 className="text-white font-medium">Live Source Health</h2>
            <p className="text-xs text-neutral">Counts and last-seen timestamps from the current MongoDB collections.</p>
          </div>
          <div className="hidden md:grid grid-cols-4 gap-2 text-center">
            <HealthMetric label="Working" value={sourceHealth.working_count ?? 0} tone="text-emerald-300" />
            <HealthMetric label="Ready" value={sourceHealth.ready_count ?? 0} tone="text-sky-300" />
            <HealthMetric label="Blocked" value={sourceHealth.blocked_count ?? 0} tone="text-yellow-300" />
            <HealthMetric label="Planned" value={sourceHealth.planned_count ?? 0} tone="text-neutral" />
          </div>
          <button
            onClick={() => load().catch(e => setError(String(e.message || e)))}
            className="border border-border text-neutral hover:text-white hover:border-accent rounded px-3 py-2 text-xs"
          >
            {loadingHealth ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-neutral border-b border-border">
                <th className="py-2 pr-3">Source</th>
                <th className="py-2 pr-3">Status</th>
                <th className="py-2 pr-3">Type</th>
                <th className="py-2 pr-3 text-right">Rows</th>
                <th className="py-2 pr-3">Last Seen</th>
                <th className="py-2 pr-3">Detail</th>
              </tr>
            </thead>
            <tbody>
              {(sourceHealth.sources || []).map(s => (
                <tr key={s.source || s.name} className="border-b border-border/50">
                  <td className="py-2 pr-3 text-white">{s.source || s.name}</td>
                  <td className="py-2 pr-3">
                    <span className={`inline-flex border rounded-full px-2 py-0.5 text-xs ${statusClass(s.status)}`}>
                      {s.status || 'unknown'}
                    </span>
                  </td>
                  <td className="py-2 pr-3 text-neutral">{s.collection || s.category || '--'}</td>
                  <td className="py-2 pr-3 text-right font-mono text-neutral">{s.count ?? 0}</td>
                  <td className="py-2 pr-3 text-neutral">{timeAgo(s.latest_fetch)}</td>
                  <td className="py-2 pr-3 text-neutral max-w-[280px] truncate" title={s.detail || s.note || s.method || ''}>
                    {s.detail || s.note || s.method || '--'}
                  </td>
                </tr>
              ))}
              {!(sourceHealth.sources || []).length && (
                <tr>
                  <td colSpan={6} className="py-4 text-center text-neutral">Source health has not loaded yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="bg-surface border border-border rounded-lg p-4">
        <div className="flex items-center justify-between gap-3 mb-3">
          <div>
            <h2 className="text-white font-medium">Platform Connections</h2>
            <p className="text-xs text-neutral">URLs and credentials reserved for Finviz, TradingView, TD/Schwab, and Interactive Brokers integrations.</p>
          </div>
          <button
            onClick={saveConnections}
            className="bg-accent text-white rounded px-4 py-2 text-sm"
          >
            Save
          </button>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
          {Object.entries(connections).map(([key, row]) => (
            <div key={key} className="border border-border rounded p-3 bg-bg/40">
              <div className="text-sm text-white mb-2">{row.label}</div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                <input
                  value={row.url}
                  onChange={e => setConnectionField(key, 'url', e.target.value)}
                  placeholder="URL"
                  className="bg-bg border border-border rounded px-3 py-2 text-sm text-white"
                />
                <input
                  value={row.login}
                  onChange={e => setConnectionField(key, 'login', e.target.value)}
                  placeholder="Login"
                  className="bg-bg border border-border rounded px-3 py-2 text-sm text-white"
                />
                <input
                  value={row.token}
                  onChange={e => setConnectionField(key, 'token', e.target.value)}
                  placeholder="Token / API key"
                  type="password"
                  className="bg-bg border border-border rounded px-3 py-2 text-sm text-white"
                />
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="bg-surface border border-border rounded-lg p-4">
        <div className="flex items-center justify-between gap-3 mb-3">
          <div>
            <h2 className="text-white font-medium">Keyword Dictionary</h2>
            <p className="text-xs text-neutral">Used by the news filter and keyword highlighting.</p>
          </div>
          <span className="text-xs text-neutral">{keywords.length} keywords</span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-[1fr_160px_auto] gap-2 mb-4">
          <input
            value={newKeyword}
            onChange={e => setNewKeyword(e.target.value)}
            placeholder="e.g. reverse split"
            className="bg-bg border border-border rounded px-3 py-2 text-sm text-white"
          />
          <input
            value={newKeywordCategory}
            onChange={e => setNewKeywordCategory(e.target.value)}
            placeholder="category"
            className="bg-bg border border-border rounded px-3 py-2 text-sm text-white"
          />
          <button
            onClick={addKeyword}
            disabled={!newKeyword.trim()}
            className="bg-accent text-white rounded px-4 py-2 text-sm disabled:opacity-40"
          >
            Add Keyword
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
          {keywords.map(k => {
            const kw = k.keyword || k.word || ''
            const enabled = k.enabled !== false && k.active !== false
            return (
              <div key={kw} className="flex items-center justify-between gap-2 border border-border rounded p-2 bg-bg/40">
                <div className="min-w-0">
                  <div className="text-sm text-white truncate">{kw}</div>
                  <div className="text-[11px] text-neutral">{k.category || 'custom'} · {enabled ? 'enabled' : 'disabled'}</div>
                </div>
                <div className="flex gap-1">
                  <button
                    onClick={() => toggleKeyword(kw, !enabled)}
                    className="text-xs border border-border text-neutral rounded px-2 py-1 hover:text-white"
                  >
                    {enabled ? 'Disable' : 'Enable'}
                  </button>
                  <button
                    onClick={() => removeKeyword(kw)}
                    className="text-xs border border-red-500/40 text-red-300 rounded px-2 py-1 hover:text-red-200"
                  >
                    Remove
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      </section>

      <section className="bg-surface border border-border rounded-lg p-4">
        <div className="mb-3">
          <h2 className="text-white font-medium">Add Custom RSS Source</h2>
          <p className="text-xs text-neutral">These are read by the RSS importer on the next fetch run.</p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[180px_1fr_150px_auto] gap-2 mb-4">
          <input
            value={newSourceName}
            onChange={e => setNewSourceName(e.target.value)}
            placeholder="Source name"
            className="bg-bg border border-border rounded px-3 py-2 text-sm text-white"
          />
          <input
            value={newSourceUrl}
            onChange={e => setNewSourceUrl(e.target.value)}
            placeholder="https://example.com/feed.xml"
            className="bg-bg border border-border rounded px-3 py-2 text-sm text-white"
          />
          <input
            value={newSourceCategory}
            onChange={e => setNewSourceCategory(e.target.value)}
            placeholder="category"
            className="bg-bg border border-border rounded px-3 py-2 text-sm text-white"
          />
          <button
            onClick={addSource}
            disabled={!newSourceName.trim() || !newSourceUrl.trim()}
            className="bg-accent text-white rounded px-4 py-2 text-sm disabled:opacity-40"
          >
            Add Source
          </button>
        </div>

        <div className="space-y-2">
          {customSources.length === 0 ? (
            <div className="text-sm text-neutral border border-border rounded p-3">No custom RSS sources yet.</div>
          ) : customSources.map(s => {
            const name = s.name || s.source || ''
            const enabled = s.enabled !== false
            return (
              <div key={name} className="flex items-center justify-between gap-3 border border-border rounded p-3 bg-bg/40">
                <div className="min-w-0">
                  <div className="text-sm text-white">{name}</div>
                  <div className="text-xs text-neutral truncate">{s.url}</div>
                  <div className="text-[11px] text-neutral">{s.category || 'custom'} · {enabled ? 'enabled' : 'disabled'}</div>
                </div>
                <div className="flex gap-1">
                  <button
                    onClick={() => toggleSource(name, !enabled)}
                    className="text-xs border border-border text-neutral rounded px-2 py-1 hover:text-white"
                  >
                    {enabled ? 'Disable' : 'Enable'}
                  </button>
                  <button
                    onClick={() => removeSource(name)}
                    className="text-xs border border-red-500/40 text-red-300 rounded px-2 py-1 hover:text-red-200"
                  >
                    Remove
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      </section>

      <section className="bg-surface border border-border rounded-lg p-4">
        <div className="mb-3">
          <h2 className="text-white font-medium">Professor Structured Sources</h2>
          <p className="text-xs text-neutral">Working sources show article counts. Licensed/API-gated sources stay visible instead of being hidden.</p>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-neutral border-b border-border">
                <th className="py-2 pr-3">Source</th>
                <th className="py-2 pr-3">Status</th>
                <th className="py-2 pr-3">Method</th>
                <th className="py-2 pr-3 text-right">Articles</th>
              </tr>
            </thead>
            <tbody>
              {structured.map(s => (
                <tr key={s.source || s.name} className="border-b border-border/50">
                  <td className="py-2 pr-3 text-white">{s.source || s.name}</td>
                  <td className="py-2 pr-3">
                    <span className={`inline-flex border rounded-full px-2 py-0.5 text-xs ${statusClass(s.status)}`}>
                      {s.status}
                    </span>
                  </td>
                  <td className="py-2 pr-3 text-neutral">{s.method}</td>
                  <td className="py-2 pr-3 text-right font-mono text-neutral">{s.count ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}

function HealthMetric({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="border border-border rounded px-3 py-2 bg-bg/40 min-w-[78px]">
      <div className={`font-mono text-base ${tone}`}>{value}</div>
      <div className="text-[10px] text-neutral uppercase">{label}</div>
    </div>
  )
}
