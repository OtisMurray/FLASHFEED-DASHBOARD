import { useState, useEffect } from 'react'

interface Settings {
  theme?: string
  notifications?: boolean
  autoRefresh?: boolean
  refreshInterval?: number
}

interface CredField {
  group: string
  key: string
  label: string
  secret: boolean
  required: boolean
  set: boolean
  display: string   // masked (secret) or plaintext (non-secret)
  value: string     // editable prefill for non-secret; '' for secrets
}

interface CredView {
  fields: CredField[]
  encrypted: boolean
  store_path: string
  note: string
}

interface HealthComponent {
  key: string
  label: string
  group: string
  status: 'ok' | 'stale' | 'down' | 'off'
  detail: string
  last_success: string | null
  count: number | null
  last_pick?: string | null
}

interface HealthView {
  overall: 'ok' | 'degraded'
  checked_at: string
  components: HealthComponent[]
  summary: { ok: number; stale: number; down: number; off: number }
}

// Status → colour + dot, shared by the badges. 'off' is a neutral grey (a source
// that's intentionally not configured is not an alarm).
const STATUS_STYLE: Record<string, { dot: string; text: string; chip: string; label: string }> = {
  ok:    { dot: 'bg-green-400',  text: 'text-green-300',  chip: 'bg-green-500/10 border-green-500/30',  label: 'OK' },
  stale: { dot: 'bg-amber-400',  text: 'text-amber-300',  chip: 'bg-amber-500/10 border-amber-500/30',  label: 'STALE' },
  down:  { dot: 'bg-red-500',    text: 'text-red-300',    chip: 'bg-red-500/10 border-red-500/30',      label: 'DOWN' },
  off:   { dot: 'bg-gray-500',   text: 'text-gray-400',   chip: 'bg-gray-700/40 border-gray-700',       label: 'OFF' },
}

function relTime(iso: string | null): string {
  if (!iso) return 'never'
  const secs = (Date.now() - new Date(iso).getTime()) / 1000
  if (!isFinite(secs)) return 'unknown'
  if (secs < 90) return `${Math.max(0, Math.round(secs))}s ago`
  if (secs < 5400) return `${Math.round(secs / 60)}m ago`
  if (secs < 172800) return `${Math.round(secs / 3600)}h ago`
  return `${Math.round(secs / 86400)}d ago`
}

export function SettingsPage() {
  const [settings, setSettings] = useState<Settings>({
    theme: 'dark',
    notifications: true,
    autoRefresh: true,
    refreshInterval: 60,
  })
  const [saved, setSaved] = useState(false)

  // Credentials
  const [cred, setCred] = useState<CredView | null>(null)
  const [credInputs, setCredInputs] = useState<Record<string, string>>({})
  const [credMsg, setCredMsg] = useState('')
  // Admin API key (SENTIMENT_SCOUT_API_KEYS) — required to write a secret.
  // Kept in localStorage only; sent as X-API-Key on save, never persisted server-side.
  const [apiKey, setApiKey] = useState<string>(() => localStorage.getItem('ss_api_key') ?? '')
  // Result of validating a saved Finviz token against Finviz ("valid, N rows" / "rejected").
  const [finvizCheck, setFinvizCheck] = useState<{ ok: boolean; message: string } | null>(null)

  // Keyword dictionary (existing feature, surfaced next to credentials)
  const [keywords, setKeywords] = useState('')
  const [kwMsg, setKwMsg] = useState('')

  // News sources — which publishers the News feed + Charts detail panel surface
  const [sourceCatalog, setSourceCatalog] = useState<string[]>([])
  const [recognized, setRecognized] = useState<string[]>([])
  const [enabledSources, setEnabledSources] = useState<string[]>([])
  const [srcMsg, setSrcMsg] = useState('')

  // System health — per-component OK / stale / down, polled lightly.
  const [health, setHealth] = useState<HealthView | null>(null)
  const [healthRefreshing, setHealthRefreshing] = useState(false)

  const loadHealth = (refresh = false) => {
    if (refresh) setHealthRefreshing(true)
    return fetch(`/api/health${refresh ? '?refresh=1' : ''}`)
      .then(r => r.json()).then(setHealth)
      .catch(e => console.error('health load', e))
      .finally(() => setHealthRefreshing(false))
  }

  useEffect(() => {
    fetch('/api/settings').then(r => r.json()).then(setSettings).catch(e => console.error('settings load', e))
    loadCredentials()
    loadHealth()
    fetch('/api/settings/keywords').then(r => r.json()).then(d => setKeywords(d.raw ?? '')).catch(() => {})
    fetch('/api/settings/sources').then(r => r.json()).then(d => {
      setSourceCatalog(d.catalog ?? [])
      setRecognized(d.recognized ?? [])
      setEnabledSources(d.enabled ?? [])
    }).catch(() => {})
    const t = setInterval(() => loadHealth(), 30000)   // light poll; Finviz probe is server-cached
    return () => clearInterval(t)
  }, [])

  const toggleSource = (s: string) =>
    setEnabledSources(prev => prev.includes(s) ? prev.filter(x => x !== s) : [...prev, s])

  const saveSources = async () => {
    try {
      const res = await fetch('/api/settings/sources', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: enabledSources }),
      })
      const d = await res.json()
      setEnabledSources(d.enabled ?? enabledSources)
      setSrcMsg(`✓ Saved (${(d.enabled ?? []).length} sources)`); setTimeout(() => setSrcMsg(''), 2500)
    } catch (e) { console.error('save sources', e); setSrcMsg('Save failed') }
  }

  const loadCredentials = () =>
    fetch('/api/settings/credentials').then(r => r.json()).then((d: CredView) => {
      setCred(d)
      // Prefill non-secret fields so they're editable; secrets stay blank (masked).
      const init: Record<string, string> = {}
      d.fields.forEach(f => { if (!f.secret) init[f.key] = f.value })
      setCredInputs(init)
    }).catch(e => console.error('credentials load', e))

  const handleSave = async () => {
    try {
      const res = await fetch('/api/settings', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      })
      if (res.ok) { setSaved(true); setTimeout(() => setSaved(false), 2000) }
    } catch (error) { console.error('Failed to save settings:', error) }
  }

  const saveCredentials = async () => {
    // Send only non-empty inputs; blank secret fields keep their stored value.
    const payload: Record<string, string> = {}
    Object.entries(credInputs).forEach(([k, v]) => { if (v != null && v !== '') payload[k] = v })
    setFinvizCheck(null)
    const savingFinviz = 'finviz_token' in payload
    try {
      // Writing a secret requires the admin API key (SENTIMENT_SCOUT_API_KEYS).
      localStorage.setItem('ss_api_key', apiKey)
      const res = await fetch('/api/settings/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
        body: JSON.stringify(payload),
      })
      const d = await res.json()
      if (!res.ok) {
        // Auth failure (401/503) or other server error — never partially "saved".
        setCredMsg(d?.error?.message || `Save rejected (HTTP ${res.status})`)
        return
      }
      setCred(d)
      const init: Record<string, string> = {}
      d.fields.forEach((f: CredField) => { if (!f.secret) init[f.key] = f.value })
      setCredInputs(init)
      if (savingFinviz && d.finviz_validation) {
        setFinvizCheck({ ok: !!d.finviz_validation.ok, message: d.finviz_validation.message })
      }
      setCredMsg('✓ Saved securely'); setTimeout(() => setCredMsg(''), 2500)
    } catch (e) { console.error('save credentials', e); setCredMsg('Save failed') }
  }

  const saveKeywords = async () => {
    try {
      const res = await fetch('/api/settings/keywords', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keywords }),
      })
      const d = await res.json()
      setKwMsg(`✓ Saved (${d.count} keywords)`); setTimeout(() => setKwMsg(''), 2500)
    } catch (e) { console.error('save keywords', e); setKwMsg('Save failed') }
  }

  // Group credential fields by their `group` for rendering.
  const groups = (cred?.fields ?? []).reduce<Record<string, CredField[]>>((acc, f) => {
    (acc[f.group] = acc[f.group] || []).push(f); return acc
  }, {})

  return (
    <div className="max-w-2xl mx-auto p-6">
      <h1 className="text-3xl font-bold mb-8">⚙ Settings</h1>

      {/* ── System Health (per-component OK / stale / down) ── */}
      <div className="bg-gray-900 rounded-lg p-6 mb-6">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-lg font-bold flex items-center gap-2">
            🩺 System Health
            {health && (
              <span className={`text-[11px] font-bold border rounded px-2 py-0.5 ${
                health.overall === 'ok'
                  ? 'text-green-300 bg-green-500/10 border-green-500/30'
                  : 'text-amber-300 bg-amber-500/10 border-amber-500/30'
              }`}>
                {health.overall === 'ok' ? 'ALL OK' : 'DEGRADED'}
              </span>
            )}
          </h2>
          <button onClick={() => loadHealth(true)} disabled={healthRefreshing}
            className="text-xs px-3 py-1 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg text-gray-300 transition-colors disabled:opacity-50">
            {healthRefreshing ? 'Checking…' : '↻ Recheck'}
          </button>
        </div>
        <p className="text-[11px] text-gray-500 mb-4">
          {health
            ? <>Last checked {relTime(health.checked_at)} · {health.summary.ok} OK · {health.summary.stale} stale · {health.summary.down} down{health.summary.off ? ` · ${health.summary.off} off` : ''}</>
            : 'Loading…'}
        </p>
        <div className="space-y-2">
          {(health?.components ?? []).map(c => {
            const s = STATUS_STYLE[c.status] ?? STATUS_STYLE.off
            return (
              <div key={c.key} className={`flex items-center gap-3 px-3 py-2 rounded-lg border ${s.chip}`}>
                <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${s.dot}`} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-gray-100">{c.label}</span>
                    <span className="text-[10px] text-gray-500 border border-gray-700 rounded px-1">{c.group}</span>
                  </div>
                  <div className="text-[11px] text-gray-400 truncate">
                    {c.detail}
                    {c.count != null && <span className="text-gray-500"> · {c.count.toLocaleString()} stored</span>}
                    {c.last_pick && <span className="text-gray-500"> · last pick {relTime(c.last_pick)}</span>}
                  </div>
                </div>
                <span className={`text-[11px] font-bold shrink-0 ${s.text}`}>{s.label}</span>
              </div>
            )
          })}
          {!health && <div className="text-sm text-gray-500">Fetching component status…</div>}
        </div>
      </div>

      <div className="bg-gray-900 rounded-lg p-6 space-y-6">
        {/* Theme */}
        <div className="border-b border-gray-800 pb-6">
          <label className="block text-sm font-semibold mb-3">Theme</label>
          <select
            value={settings.theme || 'dark'}
            onChange={(e) => setSettings({ ...settings, theme: e.target.value })}
            className="w-full px-4 py-2 bg-gray-800 text-white rounded-lg border border-gray-700 focus:border-blue-500 outline-none"
          >
            <option value="dark">Dark</option>
            <option value="light">Light</option>
            <option value="auto">Auto</option>
          </select>
        </div>

        {/* Notifications */}
        <div className="border-b border-gray-800 pb-6">
          <label className="flex items-center gap-3">
            <input type="checkbox" checked={settings.notifications !== false}
              onChange={(e) => setSettings({ ...settings, notifications: e.target.checked })}
              className="w-5 h-5 cursor-pointer" />
            <span className="text-sm font-semibold">Enable Notifications</span>
          </label>
        </div>

        {/* Auto Refresh */}
        <div className="border-b border-gray-800 pb-6">
          <label className="flex items-center gap-3 mb-3">
            <input type="checkbox" checked={settings.autoRefresh !== false}
              onChange={(e) => setSettings({ ...settings, autoRefresh: e.target.checked })}
              className="w-5 h-5 cursor-pointer" />
            <span className="text-sm font-semibold">Auto Refresh</span>
          </label>
          {settings.autoRefresh !== false && (
            <div className="ml-8">
              <label className="block text-xs text-gray-400 mb-2">Refresh Interval (seconds)</label>
              <input type="number" min="10" max="3600" value={settings.refreshInterval || 60}
                onChange={(e) => setSettings({ ...settings, refreshInterval: parseInt(e.target.value) })}
                className="w-32 px-4 py-2 bg-gray-800 text-white rounded-lg border border-gray-700 focus:border-blue-500 outline-none" />
            </div>
          )}
        </div>

        {/* Save Button */}
        <div className="flex gap-3 pt-2">
          <button onClick={handleSave}
            className="px-6 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-semibold transition-colors">
            💾 Save Settings
          </button>
          {saved && <div className="flex items-center gap-2 text-green-400"><span>✓ Saved!</span></div>}
        </div>
      </div>

      {/* ── Keyword Dictionary (existing feature) ── */}
      <div className="bg-gray-900 rounded-lg p-6 mt-6">
        <h2 className="text-lg font-bold mb-1">📑 Keyword Dictionary</h2>
        <p className="text-xs text-gray-400 mb-3">
          Comma- or newline-separated keywords the news/RSS filter matches on.
        </p>
        <textarea
          value={keywords}
          onChange={(e) => setKeywords(e.target.value)}
          rows={4}
          placeholder="earnings, FDA, merger, guidance…"
          className="w-full px-4 py-2 bg-gray-800 text-white rounded-lg border border-gray-700 focus:border-blue-500 outline-none font-mono text-sm"
        />
        <div className="flex items-center gap-3 mt-3">
          <button onClick={saveKeywords}
            className="px-5 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-semibold transition-colors">
            💾 Save Keywords
          </button>
          {kwMsg && <span className="text-green-400 text-sm">{kwMsg}</span>}
        </div>
      </div>

      {/* ── News Sources (publisher selection) ── */}
      <div className="bg-gray-900 rounded-lg p-6 mt-6">
        <h2 className="text-lg font-bold mb-1">📰 News Sources</h2>
        <p className="text-xs text-gray-400 mb-4">
          Which publishers the News feed and the Charts detail news panel surface.
          Selected sources are shown; unchecked ones are hidden. “Other” covers
          aggregators and any publisher outside the named wire/regulatory sources.
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {sourceCatalog.map(s => {
            const on = enabledSources.includes(s)
            const isRecognized = recognized.includes(s)
            return (
              <label key={s}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer transition-colors ${
                  on ? 'bg-blue-600/15 border-blue-500/40' : 'bg-gray-800 border-gray-700'
                }`}>
                <input type="checkbox" checked={on} onChange={() => toggleSource(s)}
                  className="w-4 h-4 cursor-pointer" />
                <span className={`text-sm ${on ? 'text-white' : 'text-gray-400'}`}>{s}</span>
                {!isRecognized && <span className="text-[10px] text-gray-500 ml-auto">catch-all</span>}
              </label>
            )
          })}
        </div>
        <div className="flex items-center gap-3 mt-4">
          <button onClick={saveSources}
            className="px-5 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-semibold transition-colors">
            💾 Save Sources
          </button>
          <button onClick={() => setEnabledSources(sourceCatalog)}
            className="px-3 py-2 text-sm text-gray-400 hover:text-white transition-colors">
            Select all
          </button>
          {srcMsg && <span className="text-green-400 text-sm">{srcMsg}</span>}
        </div>
      </div>

      {/* ── Credentials (Finviz / TradingView / TD / IB) ── */}
      <div className="bg-gray-900 rounded-lg p-6 mt-6">
        <h2 className="text-lg font-bold mb-1">🔐 Data Source &amp; Broker Credentials</h2>
        <p className="text-xs text-gray-400 mb-1">
          For Finviz and the brokerage connections. <span className="text-gray-300">Storage + UI only</span> —
          TD/IB trading connectivity is a separate workstream.
        </p>
        {cred && (
          <p className="text-[11px] text-gray-500 mb-4">
            {cred.encrypted ? '🔒' : '⚠'} {cred.note} Stored in <span className="font-mono">{cred.store_path}</span> (gitignored).
            <span className="text-red-400/80"> Required</span> = used now; the rest land with the broker work.
          </p>
        )}

        <div className="space-y-5">
          {Object.entries(groups).map(([group, fields]) => (
            <div key={group} className="border border-gray-800 rounded-lg p-4">
              <h3 className="text-sm font-semibold text-gray-200 mb-3">{group}</h3>
              <div className="space-y-3">
                {fields.map(f => (
                  <div key={f.key}>
                    <label className="flex items-center gap-2 text-xs text-gray-400 mb-1">
                      <span>{f.label}</span>
                      {f.required
                        ? <span className="text-[10px] font-bold text-red-400 bg-red-500/10 border border-red-500/30 rounded px-1">REQUIRED</span>
                        : <span className="text-[10px] text-gray-500 border border-gray-700 rounded px-1">optional</span>}
                      {f.secret && f.set && (
                        <span className="text-[10px] text-green-400/80 ml-auto font-mono">saved · {f.display}</span>
                      )}
                    </label>
                    <input
                      type={f.secret ? 'password' : 'text'}
                      value={credInputs[f.key] ?? ''}
                      onChange={(e) => setCredInputs({ ...credInputs, [f.key]: e.target.value })}
                      placeholder={f.secret
                        ? (f.set ? `${f.display} — enter to replace` : (f.required ? 'required' : 'not set'))
                        : (f.display || 'not set')}
                      autoComplete="off"
                      className="w-full px-3 py-2 bg-gray-800 text-white rounded-lg border border-gray-700 focus:border-blue-500 outline-none text-sm font-mono"
                    />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Admin API key — required to write a secret (gates the save endpoint). */}
        <div className="mt-5 border border-gray-800 rounded-lg p-4">
          <label className="flex items-center gap-2 text-xs text-gray-400 mb-1">
            <span>Admin API Key</span>
            <span className="text-[10px] font-bold text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded px-1">REQUIRED TO SAVE</span>
          </label>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="SENTIMENT_SCOUT_API_KEYS value"
            autoComplete="off"
            className="w-full px-3 py-2 bg-gray-800 text-white rounded-lg border border-gray-700 focus:border-blue-500 outline-none text-sm font-mono"
          />
          <p className="text-[10px] text-gray-600 mt-1">
            Sent as <span className="font-mono">X-API-Key</span> to authorize the write. Stored in this browser only — never saved on the server.
          </p>
        </div>

        <div className="flex items-center gap-3 mt-4">
          <button onClick={saveCredentials}
            className="px-5 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-semibold transition-colors">
            🔐 Save Credentials
          </button>
          {credMsg && <span className={`text-sm ${credMsg.startsWith('✓') ? 'text-green-400' : 'text-red-400'}`}>{credMsg}</span>}
        </div>

        {/* Finviz token validation result (valid, N rows / rejected, 401). */}
        {finvizCheck && (
          <div className={`mt-3 text-sm rounded-lg px-3 py-2 border ${
            finvizCheck.ok
              ? 'text-green-300 bg-green-500/10 border-green-500/30'
              : 'text-red-300 bg-red-500/10 border-red-500/30'
          }`}>
            {finvizCheck.ok ? '✓ Finviz token ' : '✗ Finviz token '}{finvizCheck.message}
          </div>
        )}

        <p className="text-[10px] text-gray-600 mt-3">
          Secrets are masked here (last-4 only) and never sent back in plaintext. A saved Finviz token is validated against Finviz and used by the running app immediately — no restart.
        </p>
      </div>
    </div>
  )
}
