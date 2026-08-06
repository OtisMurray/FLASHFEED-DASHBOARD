import { useState } from 'react'
import {
  jsonFetch, inputCls, Section, Badge, AuditLine, ScopeTag, timeAgo, statusClass,
  type SourceRow, type RegistryRow,
} from './shared'

type Health = {
  working_count?: number
  ready_count?: number
  blocked_count?: number
  planned_count?: number
  sources?: SourceRow[]
}

type Props = {
  registry: RegistryRow[]
  customSources: SourceRow[]
  structured: SourceRow[]
  health: Health
  loading: boolean
  reload: () => void
  onError: (msg: string) => void
  onSaved: (msg: string) => void
}

/**
 * Sources.
 *
 * Every row here is GLOBAL: switching a source off stops the server collecting
 * it for everyone, so the switch is deliberately not per-user. The Connections
 * tab is where the per-user things live.
 *
 * Fixed sources have no delete. They are part of the approved registry, and a
 * deleted one could not be brought back from this page — disabling keeps every
 * row already collected and is reversible, which is what an operator actually
 * wants when a feed starts misbehaving.
 */
export function SourcesTab({
  registry, customSources, structured, health, loading, reload, onError, onSaved,
}: Props) {
  const [newSourceName, setNewSourceName] = useState('')
  const [newSourceUrl, setNewSourceUrl] = useState('')
  const [newSourceCategory, setNewSourceCategory] = useState('custom')
  const [busyKey, setBusyKey] = useState<string | null>(null)

  // Health rows keyed by source name so a registry row can show what its
  // collector last actually did.
  const healthBySource = new Map(
    (health.sources || []).map(row => [String(row.source || row.name || ''), row]),
  )

  const run = async (key: string, fn: () => Promise<void>, savedMsg?: string) => {
    setBusyKey(key)
    try {
      await fn()
      if (savedMsg) onSaved(savedMsg)
      reload()
    } catch (e) {
      onError(String((e as Error).message || e))
    } finally {
      setBusyKey(null)
    }
  }

  const toggleRegistry = (row: RegistryRow) =>
    run(row.key, async () => {
      await jsonFetch(`/api/settings/source-toggles/${encodeURIComponent(row.key)}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: !row.enabled }),
      })
    }, `${row.source} ${row.enabled ? 'disabled' : 'enabled'}`)

  const addSource = () =>
    run('new', async () => {
      await jsonFetch('/api/settings/sources', {
        method: 'POST',
        body: JSON.stringify({ name: newSourceName, url: newSourceUrl, category: newSourceCategory }),
      })
      setNewSourceName('')
      setNewSourceUrl('')
    }, 'RSS source saved')

  const toggleCustom = (name: string, enabled: boolean) =>
    run(name, async () => {
      await jsonFetch(`/api/settings/sources/${encodeURIComponent(name)}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled }),
      })
    }, `${name} ${enabled ? 'enabled' : 'disabled'}`)

  const removeCustom = (name: string) =>
    run(name, async () => {
      await jsonFetch(`/api/settings/sources/${encodeURIComponent(name)}`, { method: 'DELETE' })
    }, 'RSS source removed')

  const disabledCount = registry.filter(r => !r.enabled).length

  return (
    <div className="space-y-6">
      <Section
        title="Sources"
        hint={
          <>
            Switching a source off stops it being collected and stops its rows counting toward
            rankings and summaries. Nothing already collected is deleted, so switching it back on
            resumes against the same history.
          </>
        }
        right={
          <div className="flex items-center gap-3">
            <div className="hidden md:grid grid-cols-4 gap-2 text-center">
              <HealthMetric label="Working" value={health.working_count ?? 0} tone="text-emerald-300" />
              <HealthMetric label="Ready" value={health.ready_count ?? 0} tone="text-sky-300" />
              <HealthMetric label="Blocked" value={health.blocked_count ?? 0} tone="text-yellow-300" />
              <HealthMetric label="Off" value={disabledCount} tone="text-slate-400" />
            </div>
            <button
              onClick={reload}
              className="border border-border text-neutral hover:text-white hover:border-accent rounded px-3 py-2 text-xs whitespace-nowrap"
            >
              {loading ? 'Refreshing...' : 'Refresh'}
            </button>
          </div>
        }
      >
        {/* Cards on small screens, a table on wide ones — the row carries six
            facts, which does not fit a phone width without truncating the ones
            an operator is actually here to read. */}
        <div className="space-y-2 lg:hidden">
          {registry.map(row => {
            const h = healthBySource.get(row.source)
            return (
              <div key={row.key} className="border border-border rounded p-3 bg-bg/40">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-sm text-white truncate">{row.source}</div>
                    <div className="text-[11px] text-neutral">{row.collection || row.type || '--'}</div>
                  </div>
                  <ScopeTag scope={row.scope} />
                </div>
                <div className="flex flex-wrap items-center gap-2 mt-2">
                  <Badge>{row.enabled ? (h?.status || row.registry_status || 'unknown') : 'disabled'}</Badge>
                  <span className="text-xs text-neutral font-mono">{h?.count ?? 0} rows</span>
                  <span className="text-xs text-neutral">last fetch {timeAgo(h?.latest_fetch)}</span>
                </div>
                <ErrorLine row={h} />
                <AuditLine audit={row.audit} />
                <div className="mt-2">
                  <ToggleButton row={row} busy={busyKey === row.key} onClick={() => toggleRegistry(row)} />
                </div>
              </div>
            )
          })}
        </div>

        <div className="hidden lg:block overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-neutral border-b border-border">
                <th className="py-2 pr-3">Source</th>
                <th className="py-2 pr-3">Status</th>
                <th className="py-2 pr-3">Type</th>
                <th className="py-2 pr-3 text-right">Rows</th>
                <th className="py-2 pr-3">Last fetch</th>
                <th className="py-2 pr-3">Last error</th>
                <th className="py-2 pr-3">Scope</th>
                <th className="py-2 pr-3 text-right">Switch</th>
              </tr>
            </thead>
            <tbody>
              {registry.map(row => {
                const h = healthBySource.get(row.source)
                return (
                  <tr key={row.key} className="border-b border-border/50 align-top">
                    <td className="py-2 pr-3 text-white">
                      {row.source}
                      <AuditLine audit={row.audit} />
                    </td>
                    <td className="py-2 pr-3">
                      <Badge>{row.enabled ? (h?.status || row.registry_status || 'unknown') : 'disabled'}</Badge>
                    </td>
                    <td className="py-2 pr-3 text-neutral">{h?.collection || row.collection || row.type || '--'}</td>
                    <td className="py-2 pr-3 text-right font-mono text-neutral">{h?.count ?? 0}</td>
                    <td className="py-2 pr-3 text-neutral whitespace-nowrap">{timeAgo(h?.latest_fetch)}</td>
                    <td className="py-2 pr-3 text-neutral max-w-[240px]">
                      <ErrorLine row={h} inline />
                    </td>
                    <td className="py-2 pr-3"><ScopeTag scope={row.scope} /></td>
                    <td className="py-2 pr-3 text-right">
                      <ToggleButton row={row} busy={busyKey === row.key} onClick={() => toggleRegistry(row)} />
                    </td>
                  </tr>
                )
              })}
              {!registry.length && (
                <tr><td colSpan={8} className="py-4 text-center text-neutral">Sources have not loaded yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>

        {registry.some(r => !r.enabled && !r.has_collector) && (
          <p className="text-[11px] text-neutral mt-3">
            Sources marked off with no active collector in this service keep their existing rows out
            of rankings, but there was nothing left to stop collecting.
          </p>
        )}
      </Section>

      <Section
        title="Custom RSS sources"
        hint="Feeds added here are read by the RSS importer on its next run. These are yours to remove, unlike the approved sources above."
        right={<ScopeTag scope="global" />}
      >
        <div className="grid grid-cols-1 lg:grid-cols-[180px_1fr_150px_auto] gap-2 mb-4">
          <input
            value={newSourceName}
            onChange={e => setNewSourceName(e.target.value)}
            placeholder="Source name"
            className={inputCls}
          />
          <input
            value={newSourceUrl}
            onChange={e => setNewSourceUrl(e.target.value)}
            placeholder="https://example.com/feed.xml"
            className={inputCls}
          />
          <input
            value={newSourceCategory}
            onChange={e => setNewSourceCategory(e.target.value)}
            placeholder="category"
            className={inputCls}
          />
          <button
            onClick={addSource}
            disabled={!newSourceName.trim() || !newSourceUrl.trim() || busyKey === 'new'}
            className="bg-sky-700 text-white rounded px-4 py-2 text-sm disabled:opacity-40"
          >
            Add source
          </button>
        </div>

        <div className="space-y-2">
          {customSources.length === 0 ? (
            <div className="text-sm text-neutral border border-border rounded p-3">No custom RSS sources yet.</div>
          ) : customSources.map(s => {
            const name = s.name || s.source || ''
            const enabled = s.enabled !== false
            return (
              <div key={name} className="flex flex-wrap items-center justify-between gap-3 border border-border rounded p-3 bg-bg/40">
                <div className="min-w-0">
                  <div className="text-sm text-white">{name}</div>
                  <div className="text-xs text-neutral truncate">{s.url}</div>
                  <div className="text-[11px] text-neutral">{s.category || 'custom'} · {enabled ? 'enabled' : 'disabled'}</div>
                  <AuditLine audit={s.audit} />
                </div>
                <div className="flex gap-1">
                  <button
                    onClick={() => toggleCustom(name, !enabled)}
                    disabled={busyKey === name}
                    className="text-xs border border-border text-neutral rounded px-2 py-1 hover:text-white disabled:opacity-40"
                  >
                    {enabled ? 'Disable' : 'Enable'}
                  </button>
                  <button
                    onClick={() => removeCustom(name)}
                    disabled={busyKey === name}
                    className="text-xs border border-red-500/40 text-red-300 rounded px-2 py-1 hover:text-red-200 disabled:opacity-40"
                  >
                    Remove
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      </Section>

      <Section
        title="Approved structured sources"
        hint="The professor-approved newswire set, with article counts. Licensed and API-gated sources stay listed instead of being hidden."
      >
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
                    <span className={`inline-flex border rounded-full px-2 py-0.5 text-xs ${statusClass(s.enabled === false ? 'disabled' : s.status)}`}>
                      {s.enabled === false ? 'disabled' : s.status}
                    </span>
                  </td>
                  <td className="py-2 pr-3 text-neutral">{s.method}</td>
                  <td className="py-2 pr-3 text-right font-mono text-neutral">{s.count ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </div>
  )
}

function ToggleButton({ row, busy, onClick }: { row: RegistryRow; busy: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      className={`text-xs border rounded px-2 py-1 whitespace-nowrap disabled:opacity-40 ${
        row.enabled
          ? 'border-border text-neutral hover:text-white'
          : 'border-emerald-500/40 text-emerald-300 hover:text-emerald-200'
      }`}
    >
      {busy ? '…' : row.enabled ? 'Disable' : 'Enable'}
    </button>
  )
}

/**
 * The most recent thing the collector said about this source.
 *
 * `detail` is whatever the collector recorded, which is a failure message when
 * it failed and a progress note when it did not. Only shown when the status
 * looks like a problem, so a healthy source does not display its chatter as if
 * it were an error.
 */
function ErrorLine({ row, inline }: { row?: SourceRow; inline?: boolean }) {
  const status = String(row?.status || '').toLowerCase()
  const looksBad = /error|fail|invalid|blocked|required|limited/.test(status)
  const text = row?.detail || row?.note || ''
  if (!looksBad || !text) return inline ? <span className="text-neutral">--</span> : null
  return (
    <div className={`text-[11px] text-yellow-300/90 ${inline ? '' : 'mt-1'} break-words`} title={text}>
      {text}
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
