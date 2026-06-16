import { useEffect, useMemo, useState } from 'react'

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
  finance_keywords?: string[]
  keywords?: string[]
  gossip_keywords?: string[]
  gossip_score?: number
  fetched_at?: number
  detected_at?: number
  created_at?: number
  timestamp?: number
}

const API_BASE =
  import.meta.env.VITE_API_BASE_URL ||
  import.meta.env.VITE_API_URL ||
  'http://localhost:3001'

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

export default function SocialPage() {
  const [active, setActive] = useState('all')
  const [windowMinutes, setWindowMinutes] = useState('5')
  const [posts, setPosts] = useState<SocialPost[]>([])
  const [loading, setLoading] = useState(false)
  const [lastUpdated, setLastUpdated] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function loadSocial() {
    setLoading(true)
    setError(null)

    try {
      const params = new URLSearchParams()
      params.set('window_minutes', windowMinutes)
      params.set('limit', '500')
      if (active !== 'all') params.set('platform', active)

      const res = await fetch(`${API_BASE}/api/social/rolling?${params.toString()}`)
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
    const id = window.setInterval(loadSocial, 30000)
    return () => window.clearInterval(id)
  }, [active, windowMinutes])

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
                    <span className="font-semibold">{post.platform || 'Social'}</span>
                    {ticker && <span className="text-sky-300 font-semibold">${ticker}</span>}
                    {post.sentiment && <span className="text-xs text-neutral">{post.sentiment}</span>}
                  </div>
                  <span className="text-xs text-neutral">{timeAgo(ts(post))}</span>
                </div>

                <div className="text-sm leading-relaxed text-slate-100 line-clamp-3">
                  {text}
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
