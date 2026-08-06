import { useEffect, useState } from 'react'
import { jsonFetch, inputCls } from './shared'

type ConnectionRow = {
  label: string
  url: string
  login: string
  builtin?: boolean
  token_configured?: boolean
  token_last4?: string
}

type ConnectionSettings = Record<string, ConnectionRow>

export function AccountsTab() {
  const [connections, setConnections] = useState<ConnectionSettings>({})
  const [tokenDrafts, setTokenDrafts] = useState<Record<string, string>>({})
  const [locked, setLocked] = useState(false)
  const [newLabel, setNewLabel] = useState('')
  const [newUrl, setNewUrl] = useState('')
  const [newLogin, setNewLogin] = useState('')
  const [newToken, setNewToken] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)

  const load = async () => {
    setError(null)
    try {
      const conn = await jsonFetch('/api/settings/connections')
      setLocked(false)
      setConnections(conn.connections || {})
    } catch (e: any) {
      setLocked(true)
      setError(String(e.message || e))
    }
  }

  useEffect(() => { load() }, [])

  const setField = (key: string, field: 'url' | 'login', value: string) => {
    setConnections(prev => ({
      ...prev,
      [key]: { ...(prev[key] || { label: key, url: '', login: '' }), [field]: value },
    }))
  }

  const saveConnections = async () => {
    setError(null); setSaved(null)
    try {
      const payload = Object.fromEntries(Object.entries(connections).map(([key, row]) => {
        const draft = (tokenDrafts[key] || '').trim()
        return [key, draft ? { url: row.url, login: row.login, token: draft } : { url: row.url, login: row.login }]
      }))
      const data = await jsonFetch('/api/settings/connections', {
        method: 'PATCH',
        body: JSON.stringify({ connections: payload }),
      })
      setConnections(data.connections || connections)
      setTokenDrafts({})
      setSaved('Account settings saved')
    } catch (e: any) {
      setError(String(e.message || e))
    }
  }

  const addAccount = async () => {
    setError(null); setSaved(null)
    try {
      await jsonFetch('/api/settings/connections', {
        method: 'POST',
        body: JSON.stringify({ label: newLabel, url: newUrl, login: newLogin, token: newToken }),
      })
      setNewLabel(''); setNewUrl(''); setNewLogin(''); setNewToken('')
      setSaved('Account added')
      await load()
    } catch (e: any) {
      setError(String(e.message || e))
    }
  }

  const removeAccount = async (key: string) => {
    setError(null); setSaved(null)
    try {
      await jsonFetch(`/api/settings/connections/${encodeURIComponent(key)}`, { method: 'DELETE' })
      setSaved('Account removed')
      await load()
    } catch (e: any) {
      setError(String(e.message || e))
    }
  }

  return (
    <div className="space-y-6">
      <p className="text-sm text-neutral">
        Accounts for investment platforms, social media, and other integrations. Saved tokens are write-only — they are never sent back to the browser.
      </p>

      {error && <div className="border border-red-500/40 bg-red-500/10 text-red-300 rounded-lg p-3 text-sm">{error}</div>}
      {saved && <div className="border border-emerald-500/40 bg-emerald-500/10 text-emerald-300 rounded-lg p-3 text-sm">{saved}</div>}

      {locked ? (
        <p className="text-xs text-neutral border border-border rounded p-3 bg-bg/40">
          Account storage is not configured on this server, or this account does not have access.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-[1fr_1fr_1fr_1fr_auto] gap-2">
            <input value={newLabel} onChange={e => setNewLabel(e.target.value)} placeholder="Label (e.g. Reddit API)" className={inputCls} />
            <input value={newUrl} onChange={e => setNewUrl(e.target.value)} placeholder="URL" className={inputCls} />
            <input value={newLogin} onChange={e => setNewLogin(e.target.value)} placeholder="Login" className={inputCls} />
            <input value={newToken} onChange={e => setNewToken(e.target.value)} placeholder="Token / API key" type="password" className={inputCls} />
            <button onClick={addAccount} disabled={!newLabel.trim()}
              className="bg-sky-700 text-white rounded px-4 py-2 text-sm disabled:opacity-40 whitespace-nowrap">
              Add Account
            </button>
          </div>

          <div className="flex justify-end">
            <button onClick={saveConnections} className="bg-sky-700 text-white rounded px-4 py-2 text-sm">
              Save Changes
            </button>
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
            {Object.entries(connections).map(([key, row]) => (
              <div key={key} className="border border-border rounded p-3 bg-bg/40">
                <div className="flex items-center justify-between mb-2">
                  <div className="text-sm text-white">{row.label}</div>
                  {!row.builtin && (
                    <button onClick={() => removeAccount(key)} className="text-xs text-red-400 hover:text-red-300">Remove</button>
                  )}
                </div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                  <input value={row.url} onChange={e => setField(key, 'url', e.target.value)}
                    placeholder="URL" className={inputCls} />
                  <input value={row.login} onChange={e => setField(key, 'login', e.target.value)}
                    placeholder="Login" className={inputCls} />
                  <input
                    value={tokenDrafts[key] || ''}
                    onChange={e => setTokenDrafts(prev => ({ ...prev, [key]: e.target.value }))}
                    placeholder={row.token_configured ? `Saved — ends ${row.token_last4} (type to replace)` : 'Token / API key'}
                    type="password"
                    className={inputCls}
                  />
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
