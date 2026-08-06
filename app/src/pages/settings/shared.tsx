import type { ReactNode } from 'react'

// Shared shapes and primitives for the Settings tabs. Kept in one place so the
// five tabs render the same badge for the same state — a source reading
// "disabled" on one tab and "off" on another is how a reader stops trusting
// either.

export type KeywordRow = {
  keyword: string
  word?: string
  category?: string
  enabled?: boolean
  active?: boolean
  hits?: number
  updated_at?: number | null
  updated_by?: string | null
}

export type AuditRow = {
  enabled?: boolean
  updated_at?: number | null
  updated_by?: string | null
} | null

export type SourceRow = {
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
  last_checked_at?: number | string | null
  detail?: string
  collection?: string
  scope?: string
  audit?: AuditRow
}

/** One registry source with its switch, from GET /api/settings/sources. */
export type RegistryRow = {
  source: string
  key: string
  type?: string
  collection?: string
  registry_status?: string
  auth_required?: boolean
  env_var?: string | null
  enabled: boolean
  scope?: string
  has_collector?: boolean
  audit?: AuditRow
}

// The API never sends a token back — only whether one is set and its last 4
// characters — so there is no `token` field to bind an input to. Newly typed
// tokens live in their own state and are sent write-only on save.
export type ConnectionRow = {
  label: string
  url: string
  login: string
  token_configured?: boolean
  token_last4?: string
  /**
   * One of the four integrations the system ships with. The server stamps this
   * on every masked row. Built-ins cannot be removed — cleanConnectionPayload
   * always re-includes them, so a delete would only produce a blank row on the
   * next load; clearing their fields is the equivalent.
   */
  builtin?: boolean
}

export type ConnectionSettings = Record<string, ConnectionRow>

export async function jsonFetch(url: string, options?: RequestInit) {
  const res = await fetch(url, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(options?.headers || {}) },
    ...options,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `Request failed: ${res.status}`)
  return data
}

export const inputCls =
  'bg-bg border border-border rounded px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-accent'

export function Section({ title, hint, right, children }: {
  title: string
  hint?: ReactNode
  right?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="bg-surface border border-border rounded-lg p-4">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          <h2 className="text-white font-medium">{title}</h2>
          {hint && <p className="text-xs text-neutral mt-0.5">{hint}</p>}
        </div>
        {right}
      </div>
      {children}
    </section>
  )
}

/** Colour for a source/connection status string. */
export function statusClass(s?: string) {
  if (!s) return 'text-slate-400 border-slate-600'
  const v = s.toLowerCase()
  if (v.includes('disabled')) return 'text-slate-400 border-slate-600'
  if (v.includes('working') || v.includes('public') || v === 'enabled' || v.includes('connected')) {
    return 'text-emerald-400 border-emerald-500/50'
  }
  if (v.includes('ready') || v.includes('configured')) return 'text-sky-400 border-sky-500/50'
  if (v.includes('required') || v.includes('contract') || v.includes('attention') || v.includes('rate_limited')) {
    return 'text-yellow-400 border-yellow-500/50'
  }
  if (v.includes('invalid') || v.includes('expired') || v.includes('error')) return 'text-red-400 border-red-500/50'
  return 'text-slate-400 border-slate-600'
}

export function Badge({ children, tone }: { children: ReactNode; tone?: string }) {
  return (
    <span className={`inline-flex shrink-0 border rounded-full px-2 py-0.5 text-xs ${tone || statusClass(String(children))}`}>
      {children}
    </span>
  )
}

/**
 * Relative age of a timestamp. Accepts epoch seconds, epoch milliseconds or an
 * ISO string, because the collections this page reads use all three.
 */
export function timeAgo(value?: number | string | null) {
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

/**
 * "Disabled 2h ago by aman", or nothing at all.
 *
 * A source nobody has touched has no audit row, and this renders empty rather
 * than inventing a default actor — "changed by admin" for a change that never
 * happened is worse than silence.
 */
export function AuditLine({ audit }: { audit?: AuditRow }) {
  if (!audit || (!audit.updated_at && !audit.updated_by)) return null
  const what = audit.enabled === false ? 'Disabled' : 'Enabled'
  return (
    <div className="text-[11px] text-neutral">
      {what}
      {audit.updated_at ? ` ${timeAgo(audit.updated_at)}` : ''}
      {audit.updated_by ? ` by ${audit.updated_by}` : ''}
    </div>
  )
}

/** Where a setting lives: shared by everyone, or only this account's. */
export function ScopeTag({ scope }: { scope?: string }) {
  const perUser = scope === 'user'
  return (
    <span
      className="text-[10px] uppercase tracking-wide text-neutral border border-border rounded px-1.5 py-0.5"
      title={perUser
        ? 'Stored against your account. Other users have their own.'
        : 'Shared by every user of this dashboard.'}
    >
      {perUser ? 'Yours' : 'Global'}
    </span>
  )
}
