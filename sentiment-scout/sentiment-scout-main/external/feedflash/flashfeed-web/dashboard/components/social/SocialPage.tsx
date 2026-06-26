'use client'
import useSWR from 'swr'
import { useState } from 'react'
import { SocialCard } from './SocialCard'
import { PlatformTabs } from './PlatformTabs'
import { TrendingPhrases } from './TrendingPhrases'
import { TickerSidebar } from './TickerSidebar'
import { SubredditHealth } from './SubredditHealth'
import type { SocialPost } from '@/lib/types'

const fetcher = (url: string) => fetch(url).then(r => r.json())

export function SocialPage() {
  const [platform, setPlatform] = useState<string>('all')
  const [selectedTicker, setSelectedTicker] = useState<string | null>(null)
  const [window, setWindow] = useState('5')

  const params = new URLSearchParams()
  if (platform !== 'all') params.set('platform', platform)
  if (selectedTicker) params.set('ticker', selectedTicker)
  params.set('window', window)

  const { data, isLoading } = useSWR(`/api/social/posts?${params}`, fetcher, { refreshInterval: 30_000 })
  const { data: phrasesData } = useSWR('/api/social/phrases', fetcher, { refreshInterval: 60_000 })
  const { data: tickerData } = useSWR('/api/social/tickers', fetcher, { refreshInterval: 30_000 })
  const { data: healthData } = useSWR('/api/social/health', fetcher, { refreshInterval: 60_000 })

  const posts: SocialPost[] = data?.posts ?? []
  const tickers: Array<{ ticker: string; count: number; sentiment?: number }> = tickerData?.tickers ?? []

  return (
    <div className="flex gap-4">
      {/* Left sidebar - Tickers + Subreddit Health */}
      <div className="w-[200px] flex-shrink-0 hidden lg:flex flex-col gap-3">
        <TickerSidebar
          tickers={tickers}
          activeTicker={selectedTicker}
          onSelect={t => setSelectedTicker(selectedTicker === t ? null : t)}
        />
        <SubredditHealth health={healthData?.subreddits ?? []} />
      </div>

      {/* Main content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <h1 className="text-white font-semibold text-lg">Social Feed</h1>
            {selectedTicker && (
              <span className="text-xs font-mono font-bold text-accent bg-accent/10 px-2 py-0.5 rounded">
                {selectedTicker}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-neutral uppercase">Window</span>
            <select value={window} onChange={e => setWindow(e.target.value)}
              className="bg-bg border border-border text-xs text-neutral rounded px-1.5 py-1 focus:outline-none focus:border-accent">
              <option value="1">1m</option>
              <option value="3">3m</option>
              <option value="5">5m</option>
              <option value="15">15m</option>
              <option value="60">60m</option>
            </select>
            <span className="text-neutral text-sm">{posts.length} posts</span>
          </div>
        </div>

        <PlatformTabs active={platform} onChange={setPlatform} />

        {/* Trending */}
        <div className="mt-3 mb-3">
          <TrendingPhrases phrases={phrasesData?.phrases ?? []} />
        </div>

        {/* Posts */}
        <div className="space-y-2">
          {isLoading ? (
            <div className="text-neutral text-sm animate-pulse p-4">Loading social posts...</div>
          ) : posts.length === 0 ? (
            <div className="text-neutral text-sm p-8 text-center">
              <div className="text-3xl mb-2">💬</div>
              <div>No posts found for current filters</div>
            </div>
          ) : (
            posts.map(p => <SocialCard key={p.id} post={p} />)
          )}
        </div>
      </div>
    </div>
  )
}
