import { useState } from 'react'
import {
  jsonFetch, inputCls, Section, Badge, ScopeTag,
  type ConnectionSettings, type ConnectionRow,
} from './shared'

export type DecryptError = { connection: string; field: string; error: string }

type StocktwitsStatus = { configured: boolean; connected: boolean; username: string | null } | null

type Props = {
  connections: ConnectionSettings
  setConnections: (next: ConnectionSettings) => void
  decryptErrors: DecryptError[]
  locked: boolean
  lockReason: string | null
  stocktwits: StocktwitsStatus
  setStocktwits: (next: StocktwitsStatus) => void
  reload: () => void
  onError: (msg: string) => void
  onSaved: (msg: string) => void
}

// Which providers the system collects with, and which are one person's own
// login. They are separated because the consequences differ: clearing a system
// provider's token stops ingestion for everybody, clearing a brokerage login
// affects only the account that owns it.
const SYSTEM_PROVIDERS = new Set(['finviz', 'tradingview'])

type Status = 'connected' | 'configured' | 'attention' | 'absent'

const STATUS_LABEL: Record<Status, string> = {
  connected: 'Connected',
  configured: 'Configured',
  attention: 'Needs attention',
  absent: 'Not configured',
}

const STATUS_TONE: Record<Status, string> = {
  connected: 'text-emerald-400 border-emerald-500/50',
  configured: 'text-sky-400 border-sky-500/50',
  attention: 'text-yellow-400 border-yellow-500/50',
  absent: 'text-slate-400 border-slate-600',
}

/**
 * Connections & logins.
 *
 * Credentials are stored per user and encrypted at rest, and the API never
 * sends one back — only whether it is set and its last four characters. So
 * there is no complete token in this component's state at any point: the
 * password inputs are bound to a separate drafts object that starts empty, is
 * sent write-only, and is cleared on save.
 *
 * ON "Expired". The badge vocabulary has one state this page deliberately does
 * not emit: nothing in the system reports credential expiry. A stored Finviz
 * token that stopped working looks identical to one that still works, so
 * showing "Expired" would be a guess. "Needs attention" is emitted only where
 * there is a real signal — the server told us it could not decrypt the value.
 */
export function ConnectionsTab({
  connections, setConnections, decryptErrors, locked, lockReason,
  stocktwits, setStocktwits, reload, onError, onSaved,
}: Props) {
  // Tokens typed this session, keyed by connection. Never populated from a
  // response — the server does not send secrets back.
  const [tokenDrafts, setTokenDrafts] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)

  const brokenKeys = new Set(decryptErrors.map(e => e.connection))

  const statusFor = (key: string, row: ConnectionRow): Status => {
    if (brokenKeys.has(key)) return 'attention'
    return row.token_configured ? 'configured' : 'absent'
  }

  const setField = (key: string, field: 'url' | 'login', value: string) => {
    setConnections({
      ...connections,
      [key]: { ...(connections[key] || { label: key, url: '', login: '' }), [field]: value },
    })
  }

  const saveOne = async (key: string) => {
    setBusy(key)
    try {
      const row = connections[key]
      const draft = (tokenDrafts[key] || '').trim()
      // Only send a token when one was actually typed. Omitting it tells the
      // server to keep what it has, so saving a URL change cannot wipe a
      // credential this page never held a copy of.
      const patch = draft
        ? { url: row.url, login: row.login, token: draft }
        : { url: row.url, login: row.login }
      const data = await jsonFetch('/api/settings/connections', {
        method: 'PATCH',
        body: JSON.stringify({ connections: { [key]: patch } }),
      })
      if (data.connections) setConnections(data.connections)
      setTokenDrafts(prev => ({ ...prev, [key]: '' }))
      onSaved(`${row.label} saved`)
    } catch (e) {
      onError(String((e as Error).message || e))
    } finally {
      setBusy(null)
    }
  }

  const disconnect = async (key: string) => {
    setBusy(key)
    try {
      // An explicit null is how a secret is cleared. A blank string would mean
      // "leave it alone", which is the whole reason saving a URL cannot wipe a
      // token by accident.
      const data = await jsonFetch('/api/settings/connections', {
        method: 'PATCH',
        body: JSON.stringify({ connections: { [key]: { token: null } } }),
      })
      if (data.connections) setConnections(data.connections)
      setTokenDrafts(prev => ({ ...prev, [key]: '' }))
      onSaved(`${connections[key]?.label || key} credential cleared`)
    } catch (e) {
      onError(String((e as Error).message || e))
    } finally {
      setBusy(null)
    }
  }

  // Re-reads the stored record through the same path the server uses. It
  // verifies that a secret is present and that the server can still decrypt it
  // for this account — NOT that the provider accepts it. Labelled accordingly:
  // nothing here contacts the upstream provider.
  const check = async (key: string) => {
    setBusy(key)
    try {
      const data = await jsonFetch('/api/settings/connections')
      if (data.connections) setConnections(data.connections)
      const failed = (data.decrypt_errors || []).some((e: DecryptError) => e.connection === key)
      const configured = data.connections?.[key]?.token_configured
      onSaved(
        failed ? `${key}: stored credential could not be decrypted`
          : configured ? `${key}: credential stored and readable by the server`
            : `${key}: no credential stored`,
      )
      reload()
    } catch (e) {
      onError(String((e as Error).message || e))
    } finally {
      setBusy(null)
    }
  }

  const entries = Object.entries(connections)
  const system = entries.filter(([key]) => SYSTEM_PROVIDERS.has(key))
  const personal = entries.filter(([key]) => !SYSTEM_PROVIDERS.has(key))

  const renderRow = ([key, row]: [string, ConnectionRow]) => {
    const status = statusFor(key, row)
    const draft = tokenDrafts[key] || ''
    return (
      <div key={key} className="border border-border rounded p-3 bg-bg/40">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm text-white truncate">{row.label}</span>
            <ScopeTag scope="user" />
          </div>
          <Badge tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Badge>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
          <input
            value={row.url}
            onChange={e => setField(key, 'url', e.target.value)}
            placeholder="URL"
            className={inputCls}
            aria-label={`${row.label} URL`}
          />
          <input
            value={row.login}
            onChange={e => setField(key, 'login', e.target.value)}
            placeholder="Login"
            className={inputCls}
            aria-label={`${row.label} login`}
          />
          <input
            value={draft}
            onChange={e => setTokenDrafts(prev => ({ ...prev, [key]: e.target.value }))}
            placeholder={row.token_configured ? `Saved — ends ${row.token_last4} (type to replace)` : 'Token / API key'}
            type="password"
            autoComplete="new-password"
            className={inputCls}
            aria-label={`${row.label} token`}
          />
        </div>

        {brokenKeys.has(key) && (
          <p className="text-[11px] text-yellow-300/90 mt-2">
            A credential is stored but the server cannot decrypt it for this account. Re-enter it to replace the stored value.
          </p>
        )}

        <div className="flex flex-wrap gap-2 mt-3">
          <button
            onClick={() => saveOne(key)}
            disabled={busy === key}
            className="bg-sky-700 text-white rounded px-3 py-1.5 text-xs disabled:opacity-40"
          >
            {draft ? 'Save credential' : 'Save'}
          </button>
          <button
            onClick={() => check(key)}
            disabled={busy === key}
            className="border border-border text-neutral hover:text-white rounded px-3 py-1.5 text-xs disabled:opacity-40"
            title="Re-reads the stored credential and reports whether the server can decrypt it. Does not contact the provider."
          >
            Check stored credential
          </button>
          <button
            onClick={() => disconnect(key)}
            disabled={busy === key || !row.token_configured}
            className="border border-red-500/40 text-red-300 hover:text-red-200 rounded px-3 py-1.5 text-xs disabled:opacity-40"
          >
            Disconnect
          </button>
        </div>
      </div>
    )
  }

  if (locked) {
    return (
      <Section title="Connections & logins" hint="Credentials for the data providers this dashboard reads.">
        <p className="text-xs text-neutral border border-border rounded p-3 bg-bg/40">
          {lockReason || 'Platform connections are restricted to admin accounts.'}
        </p>
      </Section>
    )
  }

  return (
    <div className="space-y-6">
      <Section
        title="System providers"
        hint="Credentials the dashboard's own collectors use. Stored against your account and encrypted at rest — the server never sends a saved token back to the browser."
      >
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">{system.map(renderRow)}</div>
      </Section>

      <Section
        title="Your brokerage logins"
        hint="Your own broker credentials. Separate from the system providers above: these are not used to collect the shared feeds."
      >
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">{personal.map(renderRow)}</div>
      </Section>

      <Section
        title="Linked accounts"
        hint="Signed in through the provider rather than by storing a credential here."
      >
        <div className="flex flex-wrap items-center justify-between gap-3 border border-border rounded p-3 bg-bg/40">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm text-white">StockTwits</span>
            <ScopeTag scope="user" />
            {stocktwits?.connected && stocktwits.username && (
              <span className="text-xs text-neutral truncate">@{stocktwits.username}</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Badge tone={STATUS_TONE[stocktwits?.connected ? 'connected' : 'absent']}>
              {stocktwits?.connected ? STATUS_LABEL.connected : STATUS_LABEL.absent}
            </Badge>
            {stocktwits?.connected ? (
              <button
                onClick={async () => {
                  try {
                    await jsonFetch('/api/auth/stocktwits/disconnect', { method: 'POST' })
                    setStocktwits(stocktwits ? { ...stocktwits, connected: false, username: null } : null)
                    onSaved('StockTwits disconnected')
                  } catch (e) { onError(String((e as Error).message || e)) }
                }}
                className="border border-red-500/40 text-red-300 hover:text-red-200 rounded px-3 py-1.5 text-xs"
              >
                Disconnect
              </button>
            ) : (
              <button
                onClick={async () => {
                  try {
                    const data = await jsonFetch('/api/auth/stocktwits/connect')
                    if (data.authorizeUrl) window.location.href = data.authorizeUrl
                    else onError('StockTwits login is not available yet.')
                  } catch (e) { onError(String((e as Error).message || e)) }
                }}
                disabled={!stocktwits?.configured}
                className="border border-border text-neutral hover:text-white rounded px-3 py-1.5 text-xs disabled:opacity-40"
              >
                {stocktwits?.configured ? 'Connect' : 'Not available yet'}
              </button>
            )}
          </div>
        </div>
      </Section>
    </div>
  )
}
