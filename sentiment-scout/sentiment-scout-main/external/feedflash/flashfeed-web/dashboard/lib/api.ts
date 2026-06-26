const BASE = typeof window !== 'undefined' ? '' : 'http://localhost:3000'

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, options)
  if (!res.ok) throw new Error(`API error ${res.status}: ${path}`)
  return res.json()
}

export const api = {
  articles: (params?: Record<string, string>) => {
    const qs = params ? '?' + new URLSearchParams(params).toString() : ''
    return apiFetch<{ articles: import('./types').Article[]; total: number }>(`/api/articles${qs}`)
  },
  stats: () => apiFetch<any>('/api/stats'),
  status: () => apiFetch<import('./types').ApiStatus>('/api/status'),
  screener: () => apiFetch<{ tickers: import('./types').ScreenerRow[] }>('/api/screener'),
  momentum: (params?: Record<string, string>) => {
    const qs = params ? '?' + new URLSearchParams(params).toString() : ''
    return apiFetch<{ tickers: import('./types').MomentumRow[] }>(`/api/momentum${qs}`)
  },
  trending: () => apiFetch<{ tickers: import('./types').MomentumRow[] }>('/api/momentum/trending'),
  socialPosts: (params?: Record<string, string>) => {
    const qs = params ? '?' + new URLSearchParams(params).toString() : ''
    return apiFetch<{ posts: import('./types').SocialPost[] }>(`/api/social/posts${qs}`)
  },
  socialAlerts: () => apiFetch<{ alerts: any[] }>('/api/social/alerts'),
  socialPhrases: () => apiFetch<{ phrases: any[] }>('/api/social/phrases'),
  correlation: () => apiFetch<{ entries: import('./types').CorrelationEntry[]; accuracy?: any }>('/api/correlation'),
  runCorrelation: () => apiFetch<any>('/api/correlation/run', { method: 'POST' }),
  charts: (ticker: string, range = '3mo') => apiFetch<any>(`/api/charts/${ticker}?range=${range}`),
  workersHealth: () => apiFetch<{ sentiment: import('./types').WorkerHealth; correlation: import('./types').WorkerHealth }>('/api/workers/health'),
}
