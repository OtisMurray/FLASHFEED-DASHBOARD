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

export const statusClass = (s?: string) => {
  if (!s) return 'text-slate-400 border-slate-600'
  if (s.includes('working') || s.includes('public') || s === 'enabled') return 'text-emerald-400 border-emerald-500/50'
  if (s.includes('ready')) return 'text-sky-400 border-sky-500/50'
  if (s.includes('required') || s.includes('contract')) return 'text-yellow-400 border-yellow-500/50'
  if (s.includes('disabled') || s.includes('invalid')) return 'text-red-400 border-red-500/50'
  return 'text-slate-400 border-slate-600'
}

export const timeAgo = (value?: number | string | null) => {
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

export const inputCls = 'bg-bg border border-border rounded px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-accent'
