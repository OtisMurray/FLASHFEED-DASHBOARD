import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '@/lib/useAuth'

const jsonFetch = (url: string, init?: RequestInit) =>
  fetch(url, { credentials: 'include', headers: { 'Content-Type': 'application/json' }, ...init }).then(r => r.json())

interface ApiKeyRow { id: string; label: string; keyPrefix: string; createdAt: string; lastUsedAt: string | null }
interface Status { mailerConfigured: boolean; smsConfigured: boolean }

const Card = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <section className="bg-surface border border-border rounded-lg p-4 space-y-3">
    <h2 className="text-sm font-semibold text-white">{title}</h2>
    {children}
  </section>
)
const inputCls = 'bg-bg border border-border rounded px-2 py-1.5 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-accent'

export function AccountPage() {
  const { user, loading: authLoading } = useAuth()
  const [status, setStatus] = useState<Status | null>(null)
  const [phone, setPhone] = useState('')
  const [twoFactorMethod, setTwoFactorMethod] = useState<'email' | 'sms'>('email')
  const [smsAlertsOptIn, setSmsAlertsOptIn] = useState(false)
  const [smsTickerInput, setSmsTickerInput] = useState('')
  const [smsAlertTickers, setSmsAlertTickers] = useState<string[]>([])
  const [apiKeys, setApiKeys] = useState<ApiKeyRow[]>([])
  const [newKeyLabel, setNewKeyLabel] = useState('')
  const [justCreatedKey, setJustCreatedKey] = useState<string | null>(null)
  const [stocktwits, setStocktwits] = useState<{ configured: boolean; connected: boolean; username: string | null } | null>(null)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    if (!user) return
    jsonFetch('/api/auth/status').then(setStatus)
    jsonFetch('/api/auth/api-keys').then(d => d?.ok && setApiKeys(d.keys))
    jsonFetch('/api/auth/stocktwits/status').then(d => d?.ok && setStocktwits(d))
  }, [user])

  async function saveProfile(patch: Record<string, unknown>) {
    setError(''); setNotice('')
    const data = await jsonFetch('/api/auth/profile', { method: 'PUT', body: JSON.stringify(patch) })
    if (!data.ok) { setError(data.error || 'Could not save.'); return }
    setNotice('Saved.')
  }

  async function createApiKey() {
    setError(''); setNotice(''); setJustCreatedKey(null)
    const data = await jsonFetch('/api/auth/api-keys', { method: 'POST', body: JSON.stringify({ label: newKeyLabel || 'API key' }) })
    if (!data.ok) { setError(data.error || 'Could not create key.'); return }
    setJustCreatedKey(data.key)
    setNewKeyLabel('')
    const list = await jsonFetch('/api/auth/api-keys')
    if (list.ok) setApiKeys(list.keys)
  }

  async function revokeApiKey(id: string) {
    await jsonFetch(`/api/auth/api-keys/${id}`, { method: 'DELETE' })
    setApiKeys(prev => prev.filter(k => k.id !== id))
  }

  async function connectStocktwits() {
    const data = await jsonFetch('/api/auth/stocktwits/connect')
    if (data.ok && data.authorizeUrl) window.location.href = data.authorizeUrl
    else setError(data.error || 'StockTwits login is not available yet.')
  }

  if (authLoading) return <div className="p-4 text-sm text-neutral">Loading…</div>
  if (!user) {
    return (
      <div className="p-4 text-sm text-neutral">
        <Link to="/login" className="text-accent hover:underline">Log in</Link> to manage your account.
      </div>
    )
  }

  return (
    <div className="p-4 max-w-2xl mx-auto space-y-4">
      <div>
        <h1 className="text-lg font-bold text-white">Account</h1>
        <p className="text-xs text-neutral mt-1">{user.username} · {user.email}</p>
      </div>

      {error && <div className="border border-red-500/40 bg-red-500/10 text-red-300 rounded p-2 text-xs">{error}</div>}
      {notice && !error && <div className="border border-emerald-500/40 bg-emerald-500/10 text-emerald-300 rounded p-2 text-xs">{notice}</div>}

      <Card title="Two-factor login">
        <p className="text-xs text-neutral">
          Email delivery: <span className={status?.mailerConfigured ? 'text-emerald-400' : 'text-amber-400'}>{status?.mailerConfigured ? 'configured' : 'not configured yet'}</span>
          {' · '}
          SMS delivery: <span className={status?.smsConfigured ? 'text-emerald-400' : 'text-amber-400'}>{status?.smsConfigured ? 'configured' : 'not configured yet'}</span>
        </p>
        <div className="flex items-center gap-3">
          <input value={phone} onChange={e => setPhone(e.target.value)} placeholder="+15551234567"
            className={`${inputCls} w-44`} />
          <button onClick={() => saveProfile({ phone })} className="text-xs text-accent hover:underline">Save phone</button>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span className="text-neutral">2FA code sent via:</span>
          {(['email', 'sms'] as const).map(m => (
            <button key={m} onClick={() => { setTwoFactorMethod(m); saveProfile({ twoFactorMethod: m }) }}
              className={`px-2 py-1 rounded border ${twoFactorMethod === m ? 'bg-accent text-white border-accent' : 'border-border text-neutral hover:text-white'}`}>
              {m === 'email' ? 'Email' : 'Text message'}
            </button>
          ))}
        </div>
      </Card>

      <Card title="SMS stock alerts">
        <label className="flex items-center gap-2 text-xs text-neutral">
          <input type="checkbox" checked={smsAlertsOptIn}
            onChange={e => { setSmsAlertsOptIn(e.target.checked); saveProfile({ smsAlertsOptIn: e.target.checked }) }} />
          Text me when there's news on a ticker I'm watching below
        </label>
        <div className="flex gap-2">
          <input value={smsTickerInput} onChange={e => setSmsTickerInput(e.target.value.toUpperCase())}
            placeholder="Ticker" className={`${inputCls} flex-1 font-mono`} />
          <button
            onClick={() => {
              const next = Array.from(new Set([...smsAlertTickers, smsTickerInput.trim()])).filter(Boolean)
              setSmsAlertTickers(next); setSmsTickerInput(''); saveProfile({ smsAlertTickers: next })
            }}
            className="px-3 py-1.5 bg-accent text-white text-xs rounded hover:bg-sky-400">Add</button>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {smsAlertTickers.map(t => (
            <span key={t} className="text-xs font-mono bg-bg border border-border rounded-full px-2 py-1 text-white">
              {t}
              <button onClick={() => { const next = smsAlertTickers.filter(x => x !== t); setSmsAlertTickers(next); saveProfile({ smsAlertTickers: next }) }}
                className="ml-1.5 text-neutral hover:text-red-400">×</button>
            </span>
          ))}
        </div>
      </Card>

      <Card title="Connected accounts">
        <div className="flex items-center justify-between text-xs">
          <span className="text-neutral">StockTwits {stocktwits?.connected ? `— @${stocktwits.username}` : ''}</span>
          {stocktwits?.connected ? (
            <button onClick={async () => { await jsonFetch('/api/auth/stocktwits/disconnect', { method: 'POST' }); setStocktwits(s => s ? { ...s, connected: false, username: null } : s) }}
              className="text-red-400 hover:underline">Disconnect</button>
          ) : (
            <button onClick={connectStocktwits} disabled={!stocktwits?.configured}
              className="text-accent hover:underline disabled:opacity-40 disabled:no-underline">
              {stocktwits?.configured ? 'Connect' : 'Not available yet'}
            </button>
          )}
        </div>
      </Card>

      <Card title="API keys">
        <p className="text-[11px] text-neutral">Read-only access to your screener/news data — see docs at <code className="text-slate-300">/api/v1</code>.</p>
        <div className="flex gap-2">
          <input value={newKeyLabel} onChange={e => setNewKeyLabel(e.target.value)} placeholder="Label (e.g. my script)"
            className={`${inputCls} flex-1`} />
          <button onClick={createApiKey} className="px-3 py-1.5 bg-accent text-white text-xs rounded hover:bg-sky-400">Generate key</button>
        </div>
        {justCreatedKey && (
          <div className="border border-amber-500/40 bg-amber-500/10 rounded p-2 text-xs text-amber-200">
            <div className="font-mono break-all">{justCreatedKey}</div>
            <div className="mt-1 text-amber-300/80">Copy this now — it won't be shown again.</div>
          </div>
        )}
        <div className="divide-y divide-border/40">
          {apiKeys.map(k => (
            <div key={k.id} className="flex items-center justify-between py-1.5 text-xs">
              <span className="text-slate-200">{k.label} <span className="text-neutral font-mono">{k.keyPrefix}…</span></span>
              <button onClick={() => revokeApiKey(k.id)} className="text-red-400 hover:underline">Revoke</button>
            </div>
          ))}
          {!apiKeys.length && <div className="py-2 text-xs text-neutral">No keys yet.</div>}
        </div>
      </Card>
    </div>
  )
}
