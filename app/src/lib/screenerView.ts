// Shared Screener "view" — the single source of truth for which tickers the
// Screener currently shows, so the Charts Grid can mirror it (Finviz v=321
// mirrors v=111). State lives in the URL (linkable + shareable); both pages read
// it with readView() and derive the same row set with applyScreenerView().
import type { ScreenerRow } from './types'

export interface ScreenerViewState {
  filters: Record<string, string>
  orderBy: string
  orderDir: 'asc' | 'desc'
  search: string
  signal: string
}

// URL keys that are NOT screener filters (reserved for sort/search/grid controls
// and per-view UI), so everything else in the query string is treated as a filter.
const RESERVED = new Set([
  'orderBy', 'orderDir', 'search', 'signal',  // shared view state
  'page', 'view', 'tf', 'refresh', 'cols',    // per-view UI (not part of the mirror)
  't', 'tab', 'chartTab',                         // Charts detail/grid UI, not Screener filters
])

/** Parse the shared view state out of the URL query string. */
export function readView(sp: URLSearchParams): ScreenerViewState {
  const filters: Record<string, string> = {}
  for (const [k, v] of sp.entries()) {
    if (!RESERVED.has(k) && v) filters[k] = v
  }
  return {
    filters,
    orderBy: sp.get('orderBy') || 'ticker',
    orderDir: (sp.get('orderDir') === 'desc' ? 'desc' : 'asc'),
    search: sp.get('search') || '',
    signal: sp.get('signal') || '',
  }
}

/** Serialize just the shared view state (filters + sort + search + signal) into a
 *  query string — used to carry the current view between Screener and Grid. */
export function viewToQuery(v: ScreenerViewState): string {
  const sp = new URLSearchParams()
  for (const [k, val] of Object.entries(v.filters)) if (val) sp.set(k, val)
  if (v.search) sp.set('search', v.search)
  if (v.signal) sp.set('signal', v.signal)
  if (v.orderBy && v.orderBy !== 'ticker') sp.set('orderBy', v.orderBy)
  if (v.orderDir && v.orderDir !== 'asc') sp.set('orderDir', v.orderDir)
  return sp.toString()
}

/** Apply the view's filters + sort to the raw rows. Pure — identical logic on
 *  both pages guarantees the grid shows exactly the Screener's current set. */
export function applyScreenerView(tickers: ScreenerRow[], v: ScreenerViewState): ScreenerRow[] {
  let rows = [...tickers]
  const { filters, search, signal, orderBy, orderDir } = v

  if (search) {
    const q = search.toLowerCase()
    // Exact ticker match first: if the query looks like a valid ticker (1-8 uppercase chars),
    // only match the exact ticker, not partial company/title matches
    const exactTicker = /^[a-z][a-z0-9.-]{0,7}$/i.test(q) ? q.toUpperCase() : ''
    rows = rows.filter(t => {
      if (exactTicker) return t.ticker.toUpperCase() === exactTicker
      return t.ticker.toLowerCase().includes(q) || (t.company ?? '').toLowerCase().includes(q)
    })
  }

  if (filters.sector) rows = rows.filter(t => t.sector === filters.sector)
  if (filters.industry) rows = rows.filter(t => t.industry === filters.industry)
  if (filters.market_cap) {
    const mc = filters.market_cap
    rows = rows.filter(t => {
      const cap = (t as any).market_cap ?? 0
      if (mc === 'micro') return cap < 300e6
      if (mc === 'small') return cap >= 300e6 && cap < 2e9
      if (mc === 'mid') return cap >= 2e9 && cap < 10e9
      if (mc === 'large') return cap >= 10e9 && cap < 200e9
      if (mc === 'mega') return cap >= 200e9
      return true
    })
  }
  if (filters.price_change) {
    const pc = filters.price_change
    rows = rows.filter(t => {
      const change = t.change_pct ?? 0
      if (pc === 'up') return change > 0
      if (pc === 'down') return change < 0
      if (pc === 'up2') return change >= 2
      if (pc === 'up5') return change >= 5
      if (pc === 'up10') return change >= 10
      if (pc === 'down2') return change <= -2
      if (pc === 'down5') return change <= -5
      return true
    })
  }
  if (filters.avg_volume) {
    const av = parseInt(filters.avg_volume)
    rows = rows.filter(t => (t.volume ?? 0) >= av)
  }
  if (filters.price_range) {
    const pr = filters.price_range
    rows = rows.filter(t => {
      const p = t.price ?? 0
      if (pr === 'under1') return p < 1
      if (pr === 'under5') return p < 5
      if (pr === 'under10') return p < 10
      if (pr === 'under20') return p < 20
      if (pr === 'over5') return p >= 5
      if (pr === 'over10') return p >= 10
      if (pr === 'over20') return p >= 20
      if (pr === 'over50') return p >= 50
      if (pr === 'over100') return p >= 100
      return true
    })
  }
  if (filters.social_sentiment) {
    const ss = filters.social_sentiment
    rows = rows.filter(t => {
      if (ss === 'bullish') return t.social_sentiment >= 0.2
      if (ss === 'bearish') return t.social_sentiment <= -0.2
      if (ss === 'neutral') return t.social_sentiment > -0.2 && t.social_sentiment < 0.2
      return true
    })
  }
  if (filters.news_sentiment) {
    const ns = filters.news_sentiment
    rows = rows.filter(t => {
      if (ns === 'bullish') return t.structured_sentiment >= 0.2
      if (ns === 'bearish') return t.structured_sentiment <= -0.2
      if (ns === 'neutral') return t.structured_sentiment > -0.2 && t.structured_sentiment < 0.2
      return true
    })
  }
  if (filters.min_posts) {
    const mp = parseInt(filters.min_posts)
    rows = rows.filter(t => t.message_count >= mp)
  }

  // Thresholds on the computed columns. Null (no source data) is excluded —
  // never treated as 0 — so a threshold only keeps rows that actually qualify.
  if (filters.min_news_sent) {
    const x = parseFloat(filters.min_news_sent)
    rows = rows.filter(t => t.news_sentiment != null && t.news_sentiment >= x)
  }
  if (filters.min_social_sent) {
    const x = parseFloat(filters.min_social_sent)
    rows = rows.filter(t => t.stocktwits_sentiment != null && t.stocktwits_sentiment >= x)
  }
  if (filters.min_density) {
    const x = parseFloat(filters.min_density)
    rows = rows.filter(t => t.stocktwits_density != null && t.stocktwits_density >= x)
  }

  if (signal === 'social_bullish') rows = rows.filter(t => t.social_sentiment >= 0.3)
  if (signal === 'social_bearish') rows = rows.filter(t => t.social_sentiment <= -0.3)
  if (signal === 'unusual_volume') rows = rows.filter(t => (t.volume ?? 0) > ((t as any).avg_volume ?? 1) * 2)

  // Sort — nulls/blanks always ordered last, in both directions.
  rows.sort((a, b) => {
    const av = (a as any)[orderBy]
    const bv = (b as any)[orderBy]
    const an = av == null || av === ''
    const bn = bv == null || bv === ''
    if (an && bn) return 0
    if (an) return 1
    if (bn) return -1
    if (typeof av === 'string') return orderDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av)
    return orderDir === 'desc' ? bv - av : av - bv
  })

  return rows
}
