import useSWR, { useSWRConfig } from 'swr'
import { useState, useRef, useCallback, useEffect } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { clsx } from 'clsx'
import { StatusBadge } from './StatusBadge'
import { useToast } from '@/components/shared/Toast'
import { SentimentModal } from '@/components/shared/SentimentModal'
import { useTheme } from '@/hooks/useTheme'

const fetcher = (url: string) => fetch(url).then(r => r.json())

const FETCH_COOLDOWN_SECONDS = 60
const LAST_FETCH_KEY = 'flashfeed:lastFetchAt'

const NAV = [
  { href: '/overview', label: 'Overview' },
  { href: '/news', label: 'News' },
  { href: '/screener', label: 'Screener' },
  { href: '/social', label: 'Social' },
  { href: '/charts', label: 'Charts' },
  { href: '/momentum', label: 'Momentum' },
  { href: '/correlation', label: 'Correlation' },
  { href: '/settings', label: 'Settings' },
]

export function TopBar() {
  const { pathname } = useLocation()
  const { toast } = useToast()
  const { mutate } = useSWRConfig()
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const { data: status, mutate: mutateStatus } = useSWR('/api/status', fetcher, { refreshInterval: 30_000 })
  const { data: stats } = useSWR('/api/stats?days=0', fetcher, { refreshInterval: 30_000 })
  const { data: marketStatus } = useSWR('/api/market/status', fetcher, { refreshInterval: 60_000 })

  const [fetching, setFetching] = useState(false)
  const [fetchResult, setFetchResult] = useState<{ new_articles?: number; updated_articles?: number; refreshed_articles?: number; unchanged_articles?: number; total_articles?: number; ms?: number } | null>(null)
  const [cooldownRemaining, setCooldownRemaining] = useState(0)
  const [watching, setWatching] = useState(false)
  const [watchInterval, setWatchInterval] = useState('60')
  const [fetchMode, setFetchMode] = useState<'fast' | 'full'>('full')
  const [watchLines, setWatchLines] = useState<Array<{ text: string; type: string; ts: number }>>([])
  const [showSentiment, setShowSentiment] = useState(false)
  const [lastAutoResult, setLastAutoResult] = useState<{ new?: number; updated?: number; ms?: number; at: number } | null>(null)
  const watchRef = useRef<EventSource | null>(null)

  useEffect(() => {
    const updateCooldown = () => {
      const lastFetchAt = Number(localStorage.getItem(LAST_FETCH_KEY) || 0)
      const elapsed = Math.floor((Date.now() - lastFetchAt) / 1000)
      setCooldownRemaining(Math.max(0, FETCH_COOLDOWN_SECONDS - elapsed))
    }

    updateCooldown()
    const timer = window.setInterval(updateCooldown, 1000)

    return () => window.clearInterval(timer)
  }, [])

  const revalidateDashboardData = useCallback(() => {
    mutate(
      key => typeof key === 'string' && (
        key.startsWith('/api/articles') ||
        key.startsWith('/api/stats') ||
        key.startsWith('/api/status') ||
        key.startsWith('/api/screener') ||
        key.startsWith('/api/momentum') ||
        key.startsWith('/api/prices') ||
        key.startsWith('/api/prediction') ||
        key.startsWith('/api/sentiment') ||
        key.startsWith('/api/social/rolling') ||
        key.startsWith('/api/correlation')
      ),
      undefined,
      { revalidate: true }
    )
  }, [mutate])

  const doFetch = async () => {
    if (fetching || cooldownRemaining > 0) {
      return
    }

    localStorage.setItem(LAST_FETCH_KEY, String(Date.now()))
    setCooldownRemaining(FETCH_COOLDOWN_SECONDS)

    setFetching(true)
    setFetchResult(null)
    const t0 = Date.now()
    try {
      const res = await fetch(`/api/fetch?mode=${fetchMode}`, { method: 'POST' })
      const data = await res.json()
      const latency = Date.now() - t0
      setFetchResult(data)
      const socialNew = data.social_new ?? 0
      const socialUpdated = data.social_updated ?? 0
      const trackedMarketCount = data.tracked_market_ticker_count ? `; ${data.tracked_market_ticker_count} market tickers` : ''
      toast(
        `${data.quotes_updated ?? 0} quotes${trackedMarketCount}; +${data.new_articles ?? 0} new articles${data.updated_articles !== undefined ? `, ${data.updated_articles} refreshed` : ''}; +${socialNew} social${socialUpdated ? `, ${socialUpdated} refreshed` : ''}`,
        undefined,
        ((data.new_articles ?? 0) + (data.updated_articles ?? data.refreshed_articles ?? 0) + socialNew + socialUpdated) > 0 ? 'success' : 'info',
        latency
      )
      mutateStatus()
      revalidateDashboardData()
      setTimeout(() => setFetchResult(null), 8000)
    } catch {
      toast('Fetch failed', 'Could not reach API', 'error')
    } finally {
      setFetching(false)
    }
  }

  const toggleWatch = useCallback(() => {
    if (watching) {
      watchRef.current?.close()
      watchRef.current = null
      setWatching(false)
    } else {
      setWatchLines([])
      const es = new EventSource(`/api/watch?interval=${watchInterval}&mode=${fetchMode}`)

      es.addEventListener('start', (e) => {
        const d = JSON.parse(e.data)
        setWatchLines(l => [...l, { text: d.message, type: 'info', ts: Date.now() }])
      })
      es.addEventListener('line', (e) => {
        const d = JSON.parse(e.data)
        const isNew = d.new !== undefined && d.new > 0
        setWatchLines(l => [...l.slice(-200), { text: d.text, type: isNew ? 'new' : '', ts: Date.now() }])
        // Show toast notification with cycle results
        if (d.new !== undefined) {
          setLastAutoResult({ new: d.new, updated: d.updated, ms: d.ms, at: Date.now() })
          toast(
            `${d.quotes_updated ?? 0} quotes${d.tracked_market_ticker_count ? `; ${d.tracked_market_ticker_count} market tickers` : ''}; +${d.new} new articles${d.updated > 0 ? `, ${d.updated} refreshed` : ''}; +${d.social_new ?? 0} social${d.social_updated > 0 ? `, ${d.social_updated} refreshed` : ''}`,
            undefined,
            (d.new + d.updated + (d.social_new ?? 0) + (d.social_updated ?? 0)) > 0 ? 'success' : 'info',
            d.ms
          )
          mutateStatus()
          revalidateDashboardData()
        }
      })
      es.addEventListener('error', (e) => {
        try {
          const d = JSON.parse((e as any).data)
          setWatchLines(l => [...l, { text: d.message, type: 'err', ts: Date.now() }])
        } catch {}
      })
      es.addEventListener('end', (e) => {
        const d = JSON.parse(e.data)
        setWatchLines(l => [...l, { text: d.message, type: 'info', ts: Date.now() }])
        setWatching(false)
      })
      es.onerror = () => {
        setWatchLines(l => [...l, { text: 'Connection lost.', type: 'err', ts: Date.now() }])
        setWatching(false)
        watchRef.current = null
      }

      watchRef.current = es
      setWatching(true)
    }
  }, [watching, watchInterval, fetchMode, mutateStatus, revalidateDashboardData])

  return (
    <>
      <header className="bg-surface border-b border-border flex-shrink-0">
        <div className="min-h-14 flex items-center gap-3 px-4 py-2">
          <NavLink to="/overview" className="flex-shrink-0">
            <div className="text-accent font-bold text-lg tracking-tight font-mono leading-none">FlashFeed</div>
            <div className="text-neutral text-[10px] mt-1 uppercase tracking-wide">Financial Intelligence</div>
          </NavLink>

          <nav className="hidden xl:flex items-center gap-1 ml-2">
            {NAV.map(({ href, label }) => {
              const active = pathname === href || pathname.startsWith(`${href}/`)
              return (
                <NavLink
                  key={href}
                  to={href}
                  className={clsx(
                    'px-3 py-2 text-xs rounded-md border transition-colors',
                    active
                      ? 'bg-accent/15 border-accent/50 text-white'
                      : 'border-transparent text-neutral hover:text-white hover:bg-bg/60'
                  )}
                >
                  {label}
                </NavLink>
              )
            })}
          </nav>

          <div className="flex-1" />

          {fetchResult && (
            <span className="hidden lg:inline text-xs text-emerald-400 animate-in whitespace-nowrap">
              +{fetchResult.new_articles ?? 0} new{fetchResult.updated_articles !== undefined ? `, ${fetchResult.updated_articles} refreshed` : fetchResult.refreshed_articles !== undefined ? `, ${fetchResult.refreshed_articles} refreshed` : ''} ({((fetchResult.ms ?? 0) / 1000).toFixed(1)}s)
            </span>
          )}

          <button
            onClick={doFetch}
            disabled={fetching || cooldownRemaining > 0}
            title={cooldownRemaining > 0 ? `Fetch available in ${cooldownRemaining}s` : `${fetchMode === 'fast' ? 'Fast trader refresh' : 'Full source refresh'}`}
            className="px-3 py-1.5 bg-accent text-white text-xs font-medium rounded hover:bg-sky-400 disabled:opacity-50 transition-colors whitespace-nowrap"
          >
            {fetching ? 'Fetching...' : cooldownRemaining > 0 ? `Fetch ${cooldownRemaining}s` : 'Run Now'}
          </button>


          <div className="hidden md:flex items-stretch">
            <select
              value={watchInterval}
              onChange={e => setWatchInterval(e.target.value)}
              disabled={watching}
              className="bg-bg border border-border border-r-0 text-xs text-neutral rounded-l px-2 py-1.5 focus:outline-none disabled:opacity-50"
            >
              <option value="60">1m</option>
            </select>
            <button
              onClick={toggleWatch}
              className={`px-3 py-1.5 text-xs font-medium rounded-r border transition-colors ${
                watching
                  ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-400'
                  : 'bg-surface border-border text-neutral hover:text-white hover:border-accent'
              }`}
              title={watching ? 'Stop auto-watch' : 'Start auto-watch'}
            >
              {watching ? 'Stop' : 'Auto'}
            </button>
          </div>

          <button
            onClick={() => setShowSentiment(true)}
            className="hidden lg:inline-flex px-3 py-1.5 text-xs font-medium rounded border border-border text-neutral hover:text-white hover:border-accent transition-colors"
          >
            Sentiment
          </button>


          <button
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            className="xl:hidden p-2 rounded border border-border text-neutral hover:text-white hover:border-accent transition-colors"
            title="Menu"
          >
            {mobileMenuOpen ? '✕' : '☰'}
          </button>

          <div className="hidden sm:flex items-center gap-2">
            {(status || stats) && <StatusBadge ok={status?.ok !== false} label={`${stats?.total_all ?? status?.database?.total_all ?? status?.database?.articles ?? 0} articles`} />}
            {marketStatus && <StatusBadge ok={marketStatus.open} label={marketStatus.label || (marketStatus.open ? 'Market Open' : 'Market Closed')} />}
            {watching && <StatusBadge ok={true} label={`Auto ${watchInterval}s`} />}
            {lastAutoResult && (
              <StatusBadge
                ok={true}
                label={`Last +${lastAutoResult.new ?? 0}/${lastAutoResult.updated ?? 0} ${Math.floor((Date.now() - lastAutoResult.at) / 1000)}s ago`}
              />
            )}
          </div>
        </div>

        {mobileMenuOpen && (
          <nav className="xl:hidden flex flex-col gap-2 px-4 py-3 border-t border-border bg-surface">
            {NAV.map(({ href, label }) => {
              const active = pathname === href || pathname.startsWith(`${href}/`)
              return (
                <NavLink
                  key={href}
                  to={href}
                  onClick={() => setMobileMenuOpen(false)}
                  className={clsx(
                    'px-3 py-2 text-sm rounded-md border transition-colors',
                    active
                      ? 'bg-accent/15 border-accent/50 text-white'
                      : 'border-border text-neutral hover:text-white'
                  )}
                >
                  {label}
                </NavLink>
              )
            })}
          </nav>
        )}
        <nav className="xl:hidden flex items-center gap-1 overflow-x-auto px-4 pb-2">
          {NAV.map(({ href, label }) => {
            const active = pathname === href || pathname.startsWith(`${href}/`)
            return (
              <NavLink
                key={href}
                to={href}
                className={clsx(
                  'flex-shrink-0 px-3 py-1.5 text-xs rounded-md border transition-colors',
                  active
                    ? 'bg-accent/15 border-accent/50 text-white'
                    : 'border-border text-neutral hover:text-white'
                )}
              >
                {label}
              </NavLink>
            )
          })}
        </nav>
      </header>
      <SentimentModal open={showSentiment} onClose={() => setShowSentiment(false)} />
    </>
  )
}
