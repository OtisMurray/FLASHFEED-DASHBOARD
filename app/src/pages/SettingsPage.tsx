import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  jsonFetch,
  type KeywordRow, type SourceRow, type RegistryRow, type ConnectionSettings,
} from './settings/shared'
import { SourcesTab } from './settings/SourcesTab'
import { KeywordsTab } from './settings/KeywordsTab'
import { ConnectionsTab, type DecryptError } from './settings/ConnectionsTab'
import { InvestmentTab, type InvestmentSettings } from './settings/InvestmentTab'
import { AccountTab } from './settings/AccountTab'
import { ConfigTab } from './settings/ConfigTab'
import { LogsTab } from './settings/LogsTab'
import { ApiTab } from './settings/ApiTab'
import { ImpersonateTab } from './settings/ImpersonateTab'

// The first five own the page's shared load (see below). The last four arrived
// with origin/main's parallel rebuild, each self-loading from an endpoint no
// other tab reads, so they stay self-loading rather than being forced through
// the shared fetch for symmetry's sake.
//
// "Scraping", not "Impersonate": the tab explains curl-impersonate's TLS
// fingerprinting for blocked feeds and has nothing to do with impersonating a
// user. The id keeps the original word so existing links still resolve.
const TABS = [
  { id: 'sources', label: 'Sources' },
  { id: 'keywords', label: 'Keywords & catalyst rules' },
  { id: 'connections', label: 'Connections & logins' },
  { id: 'investment', label: 'Investment & risk' },
  { id: 'account', label: 'Account' },
  { id: 'config', label: 'Config' },
  { id: 'logs', label: 'Logs' },
  { id: 'api', label: 'API' },
  { id: 'impersonate', label: 'Scraping' },
] as const

type TabId = typeof TABS[number]['id']

const isTabId = (v: string | null): v is TabId => TABS.some(t => t.id === v)

/**
 * Settings.
 *
 * The tab lives in the URL so a specific tab can be linked to and a reload
 * lands where the reader was, rather than dropping them back on Sources after
 * every save.
 *
 * The first five tabs share one load. They read overlapping data — the Sources
 * tab needs both the registry and the health rows, and the Connections tab's
 * status badges depend on the same connections response — so loading per tab
 * would mean the same endpoints being hit several times and, worse, two tabs
 * able to disagree about the same source. Config, Logs, API and Scraping each
 * read an endpoint nobody else reads, so they load themselves.
 *
 * MERGE NOTE: origin/main's rebuild also shipped an AccountsTab, a second UI
 * over the same /api/settings/connections store. It is not carried here —
 * two tabs writing one credential store is a way to lose a token, and that
 * one held complete secrets in component state, which Connections is
 * deliberately built to avoid. The one thing it could do that Connections
 * cannot is add an arbitrary new connection row; that capability is still
 * owed.
 */
export function SettingsPage() {
  const [params, setParams] = useSearchParams()
  const urlTab = params.get('tab')
  const tab: TabId = isTabId(urlTab) ? urlTab : 'sources'

  const [keywords, setKeywords] = useState<KeywordRow[]>([])
  const [structured, setStructured] = useState<SourceRow[]>([])
  const [registry, setRegistry] = useState<RegistryRow[]>([])
  const [customSources, setCustomSources] = useState<SourceRow[]>([])
  const [health, setHealth] = useState<Parameters<typeof SourcesTab>[0]['health']>({})
  const [connections, setConnections] = useState<ConnectionSettings>({})
  const [decryptErrors, setDecryptErrors] = useState<DecryptError[]>([])
  const [connectionsLocked, setConnectionsLocked] = useState(false)
  const [connectionsLockReason, setConnectionsLockReason] = useState<string | null>(null)
  const [stocktwits, setStocktwits] = useState<Parameters<typeof ConnectionsTab>[0]['stocktwits']>(null)
  const [investment, setInvestment] = useState<InvestmentSettings>(null)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const selectTab = (next: TabId) => {
    setError(null)
    setSaved(null)
    setParams(prev => {
      const q = new URLSearchParams(prev)
      q.set('tab', next)
      return q
    }, { replace: true })
  }

  const load = async () => {
    setLoading(true)
    try {
      const [kw, src, conn, healthRes, invest, st] = await Promise.all([
        jsonFetch('/api/settings/keywords'),
        jsonFetch('/api/settings/sources'),
        // Admin-only. A non-admin still gets the rest of the page rather than a
        // blank screen, with the connections tab shown as locked and told why —
        // 503 means the server has no encryption key configured, which is a
        // different problem from not being allowed to look.
        jsonFetch('/api/settings/connections').catch((e: Error) => ({
          connections: null,
          lock_reason: String(e.message || e),
        })),
        jsonFetch('/api/sources/health').catch(() => ({ sources: [] })),
        jsonFetch('/api/settings/investment').catch(() => null),
        jsonFetch('/api/auth/stocktwits/status').catch(() => null),
      ])
      setKeywords(kw.keywords || [])
      setStructured(src.structured || [])
      setRegistry(src.registry || [])
      setCustomSources(src.custom_rss_sources || [])
      setConnectionsLocked(!conn.connections)
      setConnectionsLockReason(conn.lock_reason || null)
      setConnections(conn.connections || {})
      setDecryptErrors(conn.decrypt_errors || [])
      setHealth(healthRes || {})
      setInvestment(invest?.ok ? invest : null)
      setStocktwits(st?.ok ? { configured: st.configured, connected: st.connected, username: st.username } : null)
    } finally {
      setLoading(false)
    }
  }

  const reload = () => { load().catch(e => setError(String(e.message || e))) }

  useEffect(() => { reload() }, [])

  const onError = (msg: string) => { setError(msg); setSaved(null) }
  const onSaved = (msg: string) => { setSaved(msg); setError(null) }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-white font-semibold text-2xl">Settings</h1>
        <p className="text-sm text-neutral mt-1">
          Sources the dashboard collects from, the keywords that classify them, the credentials it
          uses, and the parameters the screeners run under.
        </p>
      </div>

      {/* Horizontally scrollable on a phone rather than wrapped: five tabs wrap
          to three lines at that width and push the content off-screen. */}
      <div
        role="tablist"
        aria-label="Settings sections"
        className="flex items-center gap-1 border-b border-border overflow-x-auto -mx-1 px-1"
      >
        {TABS.map(t => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => selectTab(t.id)}
            className={`px-3 py-2 text-xs whitespace-nowrap transition-colors border-b-2 -mb-px ${
              tab === t.id
                ? 'border-accent text-white'
                : 'border-transparent text-neutral hover:text-white'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {error && <div className="border border-red-500/40 bg-red-500/10 text-red-300 rounded-lg p-3 text-sm">{error}</div>}
      {saved && <div className="border border-emerald-500/40 bg-emerald-500/10 text-emerald-300 rounded-lg p-3 text-sm">{saved}</div>}

      {tab === 'sources' && (
        <SourcesTab
          registry={registry}
          customSources={customSources}
          structured={structured}
          health={health}
          loading={loading}
          reload={reload}
          onError={onError}
          onSaved={onSaved}
        />
      )}

      {tab === 'keywords' && (
        <KeywordsTab keywords={keywords} reload={reload} onError={onError} onSaved={onSaved} />
      )}

      {tab === 'connections' && (
        <ConnectionsTab
          connections={connections}
          setConnections={setConnections}
          decryptErrors={decryptErrors}
          locked={connectionsLocked}
          lockReason={connectionsLockReason}
          stocktwits={stocktwits}
          setStocktwits={setStocktwits}
          reload={reload}
          onError={onError}
          onSaved={onSaved}
        />
      )}

      {tab === 'investment' && <InvestmentTab settings={investment} />}

      {tab === 'account' && <AccountTab />}

      {tab === 'config' && <ConfigTab />}

      {tab === 'logs' && <LogsTab />}

      {tab === 'api' && <ApiTab />}

      {tab === 'impersonate' && <ImpersonateTab />}
    </div>
  )
}
