import { useEffect, useState } from 'react'
import { jsonFetch, inputCls } from './shared'
import { DangerZone } from './DangerZone'

type ConfigEntry = {
  key: string
  label: string
  description: string
  type: 'boolean' | 'number'
  default: number | boolean
  min?: number
  max?: number
  value: number | boolean
  source: 'override' | 'env' | 'default'
}

const sourceTone: Record<ConfigEntry['source'], string> = {
  override: 'text-sky-400 border-sky-500/50',
  env: 'text-emerald-400 border-emerald-500/50',
  default: 'text-slate-400 border-slate-600',
}

export function ConfigTab() {
  const [config, setConfig] = useState<ConfigEntry[]>([])
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)

  const load = async () => {
    setError(null)
    try {
      const data = await jsonFetch('/api/settings/config')
      setConfig(data.config || [])
    } catch (e: any) {
      setError(String(e.message || e))
    }
  }

  useEffect(() => { load() }, [])

  const saveValue = async (entry: ConfigEntry, value: number | boolean) => {
    setError(null); setSaved(null)
    try {
      const data = await jsonFetch('/api/settings/config', {
        method: 'PATCH',
        body: JSON.stringify({ key: entry.key, value }),
      })
      setConfig(data.config || [])
      setSaved(`${entry.label} updated`)
    } catch (e: any) {
      setError(String(e.message || e))
    }
  }

  const resetValue = async (entry: ConfigEntry) => {
    setError(null); setSaved(null)
    try {
      const data = await jsonFetch('/api/settings/config', {
        method: 'PATCH',
        body: JSON.stringify({ key: entry.key, value: null }),
      })
      setConfig(data.config || [])
      setSaved(`${entry.label} reset to default`)
    } catch (e: any) {
      setError(String(e.message || e))
    }
  }

  return (
    <div className="space-y-6">
      <p className="text-sm text-neutral">
        Operational settings that would otherwise need a Railway env var change and redeploy. Changes here take effect immediately for the website, and on the next fetch cycle for the RSS pipeline.
      </p>

      {error && <div className="border border-red-500/40 bg-red-500/10 text-red-300 rounded-lg p-3 text-sm">{error}</div>}
      {saved && <div className="border border-emerald-500/40 bg-emerald-500/10 text-emerald-300 rounded-lg p-3 text-sm">{saved}</div>}

      <div className="space-y-3">
        {config.map(entry => (
          <div key={entry.key} className="border border-border rounded-lg p-3 bg-bg/40 flex items-center justify-between gap-4 flex-wrap">
            <div className="min-w-0">
              <div className="text-sm text-white">{entry.label}</div>
              <div className="text-xs text-neutral mt-0.5">{entry.description}</div>
              <span className={`inline-flex mt-1.5 border rounded-full px-2 py-0.5 text-[10px] uppercase ${sourceTone[entry.source]}`}>
                {entry.source}
              </span>
            </div>

            <div className="flex items-center gap-2">
              {entry.type === 'boolean' ? (
                <button
                  onClick={() => saveValue(entry, !entry.value)}
                  className={`px-3 py-1.5 rounded border text-xs font-medium ${entry.value ? 'bg-sky-700 border-sky-700 text-white' : 'border-border text-neutral hover:text-white'}`}
                >
                  {entry.value ? 'On' : 'Off'}
                </button>
              ) : (
                <>
                  <input
                    type="number"
                    min={entry.min}
                    max={entry.max}
                    value={drafts[entry.key] ?? String(entry.value)}
                    onChange={e => setDrafts(prev => ({ ...prev, [entry.key]: e.target.value }))}
                    className={`${inputCls} w-24`}
                  />
                  <button
                    onClick={() => saveValue(entry, Number(drafts[entry.key] ?? entry.value))}
                    className="text-xs bg-sky-700 text-white rounded px-3 py-1.5"
                  >
                    Save
                  </button>
                </>
              )}
              {entry.source === 'override' && (
                <button onClick={() => resetValue(entry)} className="text-xs text-neutral hover:text-white">
                  Reset
                </button>
              )}
            </div>
          </div>
        ))}
        {!config.length && <div className="text-sm text-neutral border border-border rounded p-3">Loading configuration…</div>}
      </div>

      {/* Last on the page, and visually separated, so it is never the thing a
          hand lands on while reaching for a config toggle. */}
      <DangerZone onError={setError} onSaved={setSaved} />
    </div>
  )
}
