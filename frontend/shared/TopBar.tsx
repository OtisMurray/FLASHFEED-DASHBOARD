'use client'
import useSWR from 'swr'
import { useState, useRef, useCallback } from 'react'
import { StatusBadge } from './StatusBadge'
import { WatchPanel } from './WatchPanel'
import { useToast } from '@/components/shared/Toast'

const fetcher = (url: string) => fetch(url).then(r => r.json())

export function TopBar() {
  const { toast } = useToast()
  const { data: status, mutate: mutateStatus } = useSWR('/api/status', fetcher, { refreshInterval: 30_000 })
  const { data: marketStatus } = useSWR('/api/market/status', fetcher, { refreshInterval: 60_000 })

  const [fetching, setFetching] = useState(false)
  const [fetchResult, setFetchResult] = useState<{ new_articles?: number; ms?: number } | null>(null)
  const [watching, setWatching] = useState(false)
  const [watchInterval, setWatchInterval] = useState('60')
  const [watchLines, setWatchLines] = useState<Array<{ text: string; type: string; ts: number }>>([])
  const watchRef = useRef<EventSource | null>(null)

  const doFetch = async () => {
    setFetching(true)
    setFetchResult(null)
    const t0 = Date.now()
    try {
      const res = await fetch('/api/fetch', { method: 'POST' })
      const data = await res.json()
      const latency = Date.now() - t0
      setFetchResult(data)
      toast(
        `+${data.new_articles ?? 0} new articles`,
        undefined,
        (data.new_articles ?? 0) > 0 ? 'success' : 'info',
        latency
      )
      mutateStatus()
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
      const es = new EventSource(`/api/watch?interval=${watchInterval}`)

      es.addEventListener('start', (e) => {
        const d = JSON.parse(e.data)
        setWatchLines(l => [...l, { text: d.message, type: 'info', ts: Date.now() }])
      })
      es.addEventListener('line', (e) => {
        const d = JSON.parse(e.data)
        const isNew = d.text.includes('new article') || d.text.startsWith('>')
        setWatchLines(l => [...l.slice(-200), { text: d.text, type: isNew ? 'new' : '', ts: Date.now() }])
        // Auto-refresh status when cycle completes
        if (d.text.includes('Cycle #') || d.text.includes('new articles')) {
          mutateStatus()
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
  }, [watching, watchInterval, mutateStatus])

  return (
    <>
      <header className="h-12 bg-surface border-b border-border flex items-center px-4 gap-3 flex-shrink-0">
        {/* Fetch button with result feedback */}
        <button
          onClick={doFetch}
          disabled={fetching}
          className="px-3 py-1.5 bg-accent text-white text-xs font-medium rounded hover:bg-sky-400 disabled:opacity-50 transition-colors"
        >
          {fetching ? 'Fetching...' : 'Fetch'}
        </button>

        {fetchResult && (
          <span className="text-xs text-emerald-400 animate-in">
            +{fetchResult.new_articles ?? 0} new articles ({((fetchResult.ms ?? 0) / 1000).toFixed(1)}s)
          </span>
        )}

        {/* Auto-watch controls */}
        <div className="flex items-stretch">
          <select
            value={watchInterval}
            onChange={e => setWatchInterval(e.target.value)}
            disabled={watching}
            className="bg-bg border border-border border-r-0 text-xs text-neutral rounded-l px-2 py-1.5 focus:outline-none disabled:opacity-50"
          >
            <option value="30">30s</option>
            <option value="60">1m</option>
            <option value="120">2m</option>
            <option value="300">5m</option>
            <option value="600">10m</option>
            <option value="1800">30m</option>
          </select>
          <button
            onClick={toggleWatch}
            className={`px-3 py-1.5 text-xs font-medium rounded-r border transition-colors ${
              watching
                ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-400'
                : 'bg-surface border-border text-neutral hover:text-white hover:border-accent'
            }`}
          >
            {watching ? 'Stop' : 'Auto'}
          </button>
        </div>

        <div className="flex-1" />

        {/* Status indicators */}
        <div className="flex items-center gap-3">
          {status && (
            <StatusBadge
              ok={status.ok}
              label={`${status.database?.articles ?? 0} articles`}
            />
          )}
          {marketStatus && (
            <StatusBadge
              ok={marketStatus.open}
              label={marketStatus.open ? 'Market Open' : 'Market Closed'}
            />
          )}
          {watching && <StatusBadge ok={true} label={`Auto every ${watchInterval}s`} />}
        </div>
      </header>

      {/* Watch mode floating terminal */}
      {watching && watchLines.length > 0 && (
        <WatchPanel
          lines={watchLines}
          interval={watchInterval}
          onStop={toggleWatch}
          onClear={() => setWatchLines([])}
        />
      )}
    </>
  )
}
