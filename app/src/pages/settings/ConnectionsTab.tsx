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

  // New-connection form. Held apart from `connections` so a half-typed row is
  // never mistaken for a stored one, and the token follows the same write-only
  // rule as the drafts above: it exists only until the POST returns.
  const [draftRow, setDraftRow] = useState({ label: '', url: '', login: '', token: '' })

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

  // Adds a connection the system does not ship with — a second brokerage, a
  // data provider that is not one of the four built-ins. The server derives the
  // key by slugifying the label and de-duplicating it, so two rows called the
  // same thing become e.g. schwab and schwab_2 rather than one overwriting the
  // other.
  const addConnection = async () => {
    const label = draftRow.label.trim()
    if (!label) return
    setBusy('__new__')
    try {
      const data = await jsonFetch('/api/settings/connections', {
        method: 'POST',
        body: JSON.stringify({
          label,
          url: draftRow.url.trim(),
          login: draftRow.login.trim(),
          token: draftRow.token,
        }),
      })
      if (data.connections) setConnections(data.connections)
      setDraftRow({ label: '', url: '', login: '', token: '' })
      onSaved(`${label} added`)
    } catch (e) {
      onError(String((e as Error).message || e))
    } finally {
      setBusy(null)
    }
  }

  // Removes a custom row entirely, credential included. Built-ins are refused
  // by the server and have no button here.
  const removeConnection = async (key: string, label: string) => {
    setBusy(key)
    try {
      await jsonFetch(`/api/settings/connections/${encodeURIComponent(key)}`, { method: 'DELETE' })
      const rest = { ...connections }
      delete rest[key]
      setConnections(rest)
      setTokenDrafts(prev => { const next = { ...prev }; delete next[key]; return next })
      onSaved(`${label} removed`)
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
      <div key={key} data-connection={key} className="border border-border rounded p-3 bg-bg/40">
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
          {/* Disconnect clears the credential and keeps the row; Remove takes
              the row with it. Only custom rows can go — a built-in would be
              re-created blank on the next load, so the server refuses it. */}
          {!row.builtin && (
            <button
              onClick={() => removeConnection(key, row.label)}
              disabled={busy === key}
              className="border border-red-500/40 text-red-300 hover:text-red-200 rounded px-3 py-1.5 text-xs disabled:opacity-40"
            >
              Remove
            </button>
          )}
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
        hint="Credentials for the providers the dashboard's own collectors use. Stored against your account and encrypted at rest — the server never sends a saved token back to the browser."
      >
        {/* Said plainly because the alternative is worse: someone pastes a
            working token, sees "Configured", and concludes ingestion is fixed
            when nothing about it changed. The collectors are separate
            processes reading their own environment; they have never read this
            store, and no save or refresh here will reach them. */}
        <div className="border border-yellow-500/40 bg-yellow-500/10 text-yellow-200 rounded p-3 text-xs mb-3">
          <span className="font-medium">Saving here does not switch a provider on.</span>{' '}
          The collectors run as separate services and read their credentials from the server
          environment — <span className="font-mono">FINVIZ_AUTH_TOKEN</span> and{' '}
          <span className="font-mono">FINVIZ_LOGIN</span>/<span className="font-mono">FINVIZ_PASSWORD</span> on
          Railway. What is stored here is kept per account and encrypted, and the badge below reflects
          the environment the server is running with. Changing what the collectors use is still a
          platform variable change and a redeploy.
        </div>
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">{system.map(renderRow)}</div>
      </Section>

      <Section
        title="Your brokerage logins"
        hint="Your own broker credentials. Separate from the system providers above: these are not used to collect the shared feeds."
      >
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">{personal.map(renderRow)}</div>
      </Section>

      <Section
        title="Add a connection"
        hint="For a provider or brokerage the dashboard does not ship with. Stored against your account and encrypted the same way as the rows above; the token is sent once and never returned."
        right={<ScopeTag scope="user" />}
      >
        <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
          <input
            value={draftRow.label}
            onChange={e => setDraftRow(prev => ({ ...prev, label: e.target.value }))}
            placeholder="Name (e.g. Schwab)"
            className={inputCls}
            aria-label="New connection name"
          />
          <input
            value={draftRow.url}
            onChange={e => setDraftRow(prev => ({ ...prev, url: e.target.value }))}
            placeholder="URL (optional)"
            className={inputCls}
            aria-label="New connection URL"
          />
          <input
            value={draftRow.login}
            onChange={e => setDraftRow(prev => ({ ...prev, login: e.target.value }))}
            placeholder="Login (optional)"
            className={inputCls}
            aria-label="New connection login"
          />
          <input
            value={draftRow.token}
            onChange={e => setDraftRow(prev => ({ ...prev, token: e.target.value }))}
            placeholder="Token / API key (optional)"
            type="password"
            autoComplete="new-password"
            className={inputCls}
            aria-label="New connection token"
          />
        </div>
        <div className="mt-3">
          <button
            onClick={addConnection}
            disabled={!draftRow.label.trim() || busy === '__new__'}
            className="bg-sky-700 text-white rounded px-4 py-2 text-sm disabled:opacity-40"
          >
            {busy === '__new__' ? 'Adding…' : 'Add connection'}
          </button>
          <p className="text-[11px] text-neutral mt-2">
            Only the name is required — a row can be created first and its credential added later.
            The name becomes its key, and a duplicate name is numbered rather than overwriting the
            row already there.
          </p>
        </div>
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
