import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'

type SocialPost = {
  platform?: string
  source?: string
  collector?: string
  ticker?: string
  symbol?: string
  title?: string
  text?: string
  content?: string
  url?: string
  author?: string
  sentiment?: string
  sentiment_score?: number
  sentiment_confidence?: number
  ml_confidence?: number
  finance_keywords?: string[]
  keywords?: string[]
  gossip_keywords?: string[]
  gossip_score?: number
  fetched_at?: number
  detected_at?: number
  created_at?: number
  timestamp?: number
}

const tabs = [
  { id: 'all', label: 'All' },
  { id: 'reddit', label: 'Reddit' },
  { id: 'bluesky', label: 'Bluesky' },
  { id: 'twitter', label: 'Twitter' },
  { id: 'stocktwits', label: 'StockTwits' },
]

function ts(post: SocialPost) {
  return post.fetched_at || post.timestamp || post.detected_at || post.created_at || 0
}

function timeAgo(epoch?: number) {
  if (!epoch) return ''
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - epoch)
  if (diff < 60) return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  return `${Math.floor(diff / 3600)}h ago`
}

function displayText(post: SocialPost) {
  return post.text || post.title || post.content || ''
}

function sourceLabel(post: SocialPost) {
  return post.platform || post.source || 'Social'
}


function sentimentBadgeClass(sentiment?: string) {
  const s = String(sentiment || '').toLowerCase()

  if (s.includes('bull') || s.includes('positive')) {
    return 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300'
  }

  if (s.includes('bear') || s.includes('negative')) {
    return 'border-red-500/40 bg-red-500/15 text-red-300'
  }

  return 'border-yellow-500/40 bg-yellow-500/15 text-yellow-300'
}

function sentimentDisplay(sentiment?: string) {
  const s = String(sentiment || 'neutral').toLowerCase()

  if (s.includes('bull') || s.includes('positive')) return 'Bullish'
  if (s.includes('bear') || s.includes('negative')) return 'Bearish'
  return 'Neutral'
}

export default function SocialPage() {
  const [active, setActive] = useState('all')
  const [windowMinutes, setWindowMinutes] = useState('1440')
  const [posts, setPosts] = useState<SocialPost[]>([])
  const [loading, setLoading] = useState(false)
  const [searching, setSearching] = useState(false)
  const [lastUpdated, setLastUpdated] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tickerSearch, setTickerSearch] = useState('')
  const [tickerFilter, setTickerFilter] = useState('')

  async function loadSocial(filterTicker = tickerFilter) {
    setLoading(true)
    setError(null)

    try {
      const params = new URLSearchParams()
      params.set('window_minutes', windowMinutes)
      params.set('limit', '500')
      if (active !== 'all') params.set('platform', active)
      if (filterTicker) params.set('ticker', filterTicker)

      const res = await fetch(`/api/social/rolling?${params.toString()}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)

      const data = await res.json()
      setPosts(Array.isArray(data.rows) ? data.rows : [])
      setLastUpdated(Date.now())
    } catch (err: any) {
      setError(err?.message || 'Failed to load social feed')
      setPosts([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadSocial()
    const id = window.setInterval(loadSocial, 60000)
    return () => window.clearInterval(id)
  }, [active, windowMinutes, tickerFilter])

  async function searchTicker(event: FormEvent) {
    event.preventDefault()
    const ticker = tickerSearch.trim().toUpperCase().replace(/[^A-Z0-9.$-]/g, '').replace(/^\$/, '')
    if (!ticker) {
      setTickerFilter('')
      await loadSocial('')
      return
    }

    setSearching(true)
    setTickerFilter(ticker)
    setError(null)

    try {
      await loadSocial(ticker)
      const res = await fetch(`/api/social/fetch?ticker=${encodeURIComponent(ticker)}`, { method: 'POST' })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setError(data?.error || `Fresh fetch returned HTTP ${res.status}; showing stored rows.`)
      } else {
        await loadSocial(ticker)
      }
    } catch (err: any) {
      setError(err?.message || 'Fresh ticker fetch failed; showing stored rows if available.')
    } finally {
      setSearching(false)
    }
  }

  async function clearTickerSearch() {
    setTickerSearch('')
    setTickerFilter('')
    await loadSocial('')
  }

  const trending = useMemo(() => {
    const counts = new Map<string, number>()

    for (const post of posts) {
      const words = [
        ...(post.finance_keywords || []),
        ...(post.gossip_keywords || []),
        ...(post.keywords || []),
      ]

      for (const raw of words) {
        const key = String(raw || '').trim()
        if (!key || key.length < 2) continue
        counts.set(key, (counts.get(key) || 0) + 1)
      }
    }

    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
  }, [posts])

  return (
    <div className="p-6 md:p-8 text-white">
      <div className="flex items-center justify-between gap-4 mb-8">
        <div>
          <h1 className="text-3xl font-bold">Social Feed</h1>
          <p className="text-sm text-neutral mt-1">
            Rolling {windowMinutes}m window
            {lastUpdated ? ` • updated ${new Date(lastUpdated).toLocaleTimeString()}` : ''}
          </p>
        </div>

        <div className="flex items-center gap-3">
          <form onSubmit={searchTicker} className="flex items-center gap-2">
            <input
              value={tickerSearch}
              onChange={e => setTickerSearch(e.target.value.toUpperCase())}
              placeholder="Search ticker"
              className="w-32 bg-slate-900 border border-slate-600 rounded-md px-3 py-2 text-sm uppercase"
            />
            <button
              type="submit"
              disabled={searching}
              className="bg-sky-600 hover:bg-sky-500 disabled:opacity-50 rounded-md px-3 py-2 text-sm font-medium"
            >
              {searching ? 'Searching...' : 'Search'}
            </button>
            {tickerFilter && (
              <button
                type="button"
                onClick={clearTickerSearch}
                className="border border-slate-600 hover:border-sky-500 rounded-md px-3 py-2 text-sm text-neutral"
              >
                Clear
              </button>
            )}
          </form>
          <span className="text-[10px] text-neutral uppercase tracking-wider">Window</span>
          <select
            value={windowMinutes}
            onChange={e => setWindowMinutes(e.target.value)}
            className="bg-slate-900 border border-slate-600 rounded-md px-3 py-2 text-sm"
          >
            <option value="5">5m</option>
            <option value="15">15m</option>
            <option value="30">30m</option>
            <option value="60">60m</option>
            <option value="120">2h</option>
            <option value="1440">24h</option>
          </select>
          <div className="text-neutral text-lg">
            {posts.length} posts
          </div>
        </div>
      </div>

      <div className="flex gap-8 border-b border-slate-700 mb-6">
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActive(tab.id)}
            className={
              active === tab.id
                ? 'pb-4 text-white border-b-4 border-sky-500 font-semibold'
                : 'pb-4 text-neutral hover:text-white'
            }
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="border border-slate-700 bg-slate-800/60 rounded-xl p-6 mb-6">
        <h2 className="text-xl font-semibold mb-4">Trending Phrases</h2>
        {trending.length ? (
          <div className="flex flex-wrap gap-2">
            {trending.map(([phrase, count]) => (
              <span key={phrase} className="rounded-full bg-slate-900 border border-slate-700 px-3 py-1 text-sm">
                {phrase} <span className="text-neutral">×{count}</span>
              </span>
            ))}
          </div>
        ) : (
          <p className="text-neutral text-sm">No trending phrases</p>
        )}
      </div>

      {error && (
        <div className="border border-red-500/40 bg-red-950/30 rounded-xl p-4 mb-4 text-red-200">
          Social feed error: {error}
        </div>
      )}

      {loading && posts.length === 0 ? (
        <div className="text-neutral text-center py-20">Loading social posts...</div>
      ) : posts.length === 0 ? (
        <div className="text-neutral text-center py-20">
          <div className="text-5xl mb-4">💬</div>
          <div>No posts found for current filters</div>
          <div className="text-sm mt-2">Try 24h, or run the social collector to populate the live 5m window.</div>
        </div>
      ) : (
        <div className="space-y-3">
          {posts.map((post, idx) => {
            const text = displayText(post)
            const ticker = post.ticker || post.symbol
            return (
              <a
                key={`${post.platform}-${post.url}-${idx}`}
                href={post.url || '#'}
                target="_blank"
                rel="noreferrer"
                className="block border border-slate-700 bg-slate-900/60 rounded-xl p-4 hover:border-sky-500/60 transition"
              >
                <div className="flex items-center justify-between gap-4 mb-2">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold">{sourceLabel(post)}</span>
                    {ticker && <span className="text-sky-300 font-semibold">${ticker}</span>}
                    {post.sentiment && (
                      <span className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${sentimentBadgeClass(post.sentiment)}`}>
                        {sentimentDisplay(post.sentiment)}
                        {typeof post.sentiment_score === 'number' ? ` ${post.sentiment_score.toFixed(2)}` : ''}
                      </span>
                    )}
                  </div>
                  <span className="text-xs text-neutral">{timeAgo(ts(post))}</span>
                </div>

                <div className="text-sm leading-relaxed text-slate-100 line-clamp-3">
                  {ticker ? `$${ticker}: ${text}` : text}
                </div>

                <div className="mt-3 flex flex-wrap gap-2 text-xs text-neutral">
                  {post.author && <span>@{post.author}</span>}
                  {(post.gossip_keywords || []).slice(0, 4).map(k => (
                    <span key={k} className="text-amber-300">#{k}</span>
                  ))}
                  {(post.finance_keywords || post.keywords || []).slice(0, 4).map(k => (
                    <span key={k}>#{k}</span>
                  ))}
                </div>
              </a>
            )
          })}
        </div>
      )}
    </div>
  )
}
