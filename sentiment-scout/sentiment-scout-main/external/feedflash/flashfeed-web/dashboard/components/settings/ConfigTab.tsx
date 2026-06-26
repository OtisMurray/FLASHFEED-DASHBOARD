'use client'
import useSWR from 'swr'
import { useState, useEffect } from 'react'

const fetcher = (url: string) => fetch(url).then(r => r.json())

export function ConfigTab() {
  const { data, mutate } = useSWR('/api/config', fetcher)
  const [raw, setRaw] = useState('')
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState<string | null>(null)

  const config = data?.config

  useEffect(() => {
    if (config) setRaw(JSON.stringify(config, null, 2))
  }, [config])

  // Quick toggles
  const impersonate = config?.impersonate?.enabled ?? false
  const browser = config?.impersonate?.browser ?? 'rotate'
  const logLevel = config?.logging?.level ?? 'info'

  const saveField = async (patch: object) => {
    setSaving(true)
    setStatus(null)
    try {
      const res = await fetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      const j = await res.json()
      if (j.success) { setStatus('Saved'); mutate() }
      else setStatus('Error: ' + (j.error ?? 'Unknown'))
    } finally { setSaving(false) }
  }

  const saveRaw = async () => {
    try {
      const parsed = JSON.parse(raw)
      await saveField(parsed)
    } catch (e) {
      setStatus('Invalid JSON')
    }
  }

  return (
    <div>
      {/* Quick toggles */}
      <div className="space-y-3 mb-6">
        <div className="flex items-center justify-between bg-surface border border-border rounded-lg px-4 py-3">
          <div>
            <div className="text-sm text-white">TLS Impersonation (curl-impersonate)</div>
            <div className="text-xs text-neutral">Bypass Cloudflare & bot detection by impersonating browser TLS fingerprints</div>
          </div>
          <button
            onClick={() => saveField({ impersonate: { enabled: !impersonate } })}
            className={`w-10 h-5 rounded-full transition-colors relative ${impersonate ? 'bg-accent' : 'bg-slate-600'}`}
          >
            <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full transition-transform ${impersonate ? 'left-5' : 'left-0.5'}`} />
          </button>
        </div>

        <div className="flex items-center justify-between bg-surface border border-border rounded-lg px-4 py-3">
          <div>
            <div className="text-sm text-white">Browser Profile</div>
            <div className="text-xs text-neutral">Which browser fingerprint to impersonate</div>
          </div>
          <select
            value={browser}
            onChange={e => saveField({ impersonate: { browser: e.target.value } })}
            className="bg-bg border border-border text-sm text-neutral rounded px-3 py-1.5 focus:outline-none focus:border-accent"
          >
            <option value="rotate">Rotate (random)</option>
            <option value="chrome">Chrome</option>
            <option value="firefox">Firefox</option>
            <option value="safari">Safari</option>
          </select>
        </div>

        <div className="flex items-center justify-between bg-surface border border-border rounded-lg px-4 py-3">
          <div>
            <div className="text-sm text-white">Log Level</div>
            <div className="text-xs text-neutral">Verbosity of feedflash.log</div>
          </div>
          <select
            value={logLevel}
            onChange={e => saveField({ logging: { level: e.target.value } })}
            className="bg-bg border border-border text-sm text-neutral rounded px-3 py-1.5 focus:outline-none focus:border-accent"
          >
            <option value="debug">Debug</option>
            <option value="info">Info</option>
            <option value="warning">Warning</option>
            <option value="error">Error</option>
          </select>
        </div>
      </div>

      {/* Raw JSON editor */}
      <div className="border-t border-border pt-4">
        <p className="text-xs text-neutral mb-2">Full config.json — edit raw JSON below:</p>
        <textarea
          value={raw}
          onChange={e => setRaw(e.target.value)}
          spellCheck={false}
          className="w-full h-64 bg-bg border border-border text-xs font-mono text-slate-300 rounded-lg p-3 focus:outline-none focus:border-accent resize-y"
        />
        <div className="flex items-center gap-3 mt-3">
          <button onClick={saveRaw} disabled={saving}
            className="px-4 py-2 bg-accent text-white text-sm font-medium rounded hover:bg-sky-400 disabled:opacity-50 transition-colors">
            {saving ? 'Saving...' : 'Save Config'}
          </button>
          <button onClick={() => { if (config) setRaw(JSON.stringify(config, null, 2)) }}
            className="px-4 py-2 bg-surface border border-border text-neutral text-sm rounded hover:text-white transition-colors">
            Reset
          </button>
          {status && <span className={`text-xs ${status === 'Saved' ? 'text-bull' : 'text-bear'}`}>{status}</span>}
        </div>
      </div>
    </div>
  )
}
