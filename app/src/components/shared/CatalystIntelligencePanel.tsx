import { useState } from 'react'
import useSWR from 'swr'
import { clsx } from 'clsx'

const fetcher = async (url: string) => {
  const response = await fetch(url)
  const payload = await response.json()
  if (!response.ok) throw new Error(payload?.error || `Request failed (${response.status})`)
  return payload
}

type CatalystEvent = {
  event_id: string
  title: string
  category: string
  subtype: string
  direction: 'bullish' | 'bearish' | 'mixed' | 'uncertain'
  severity: 'low' | 'medium' | 'high' | 'critical'
  confidence: number
  directness: 'direct' | 'indirect' | 'market_wide'
  time_horizon: string
  detected_sec: number
  timestamp_basis: string
  source_names: string[]
  source_urls: string[]
  source_document_ids: string[]
  duplicate_status: string
}

type CatalystPayload = {
  ok: boolean
  enabled: boolean
  ticker: string
  summary?: {
    event_count: number
    direction: CatalystEvent['direction']
    direction_score: number
    confidence: number
  }
  brief?: {
    brief: string
    risks: string[]
    data_quality: string
  } | null
  events: CatalystEvent[]
  diagnostics?: {
    queried_articles: number
    source_count: number
  }
}

type StatusPayload = {
  ok: boolean
  enabled: boolean
  mode?: string
  ranking_weight?: number
  max_ranking_adjustment?: number
}

function tone(direction?: CatalystEvent['direction']) {
  if (direction === 'bullish') return 'border-emerald-400/40 bg-emerald-500/10 text-emerald-200'
  if (direction === 'bearish') return 'border-red-400/40 bg-red-500/10 text-red-200'
  if (direction === 'mixed') return 'border-amber-400/40 bg-amber-500/10 text-amber-200'
  return 'border-slate-500/50 bg-slate-800/60 text-slate-300'
}

function formatLabel(value?: string) {
  return String(value || 'unknown').replaceAll('_', ' ')
}

function formatDetected(sec?: number) {
  if (!Number.isFinite(sec)) return 'time unavailable'
  return new Date(Number(sec) * 1000).toLocaleString([], {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  })
}

export function CatalystIntelligencePanel({
  ticker,
  className,
  controlledOpen,
  onOpenChange,
  hideTrigger = false,
}: {
  ticker: string
  className?: string
  controlledOpen?: boolean
  onOpenChange?: (open: boolean) => void
  hideTrigger?: boolean
}) {
  const [internalOpen, setInternalOpen] = useState(false)
  const open = controlledOpen ?? internalOpen
  const setOpen = (value: boolean) => {
    if (controlledOpen == null) setInternalOpen(value)
    onOpenChange?.(value)
  }
  const { data: status } = useSWR<StatusPayload>('/api/catalyst-intelligence/status', fetcher, {
    revalidateOnFocus: false,
    dedupingInterval: 60_000,
  })
  const key = open && status?.enabled
    ? `/api/catalyst-intelligence/ticker/${encodeURIComponent(ticker)}?hours=72&limit=250`
    : null
  const { data, error, isLoading } = useSWR<CatalystPayload>(key, fetcher, {
    revalidateOnFocus: false,
    dedupingInterval: 30_000,
  })

  if (!status?.enabled) return null

  return (
    <div className={clsx('text-left', className)}>
      {!hideTrigger && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="rounded border border-sky-500/40 bg-sky-500/10 px-2 py-1 text-[10px] font-medium text-sky-100 hover:bg-sky-500/20"
        >
          {open ? 'Hide catalyst brief' : 'Why this ticker?'}
        </button>
      )}

      {open && (
        <div className="mt-2 border-l-2 border-sky-500/40 bg-slate-950/35 px-3 py-2 text-[11px] text-slate-300">
          {isLoading && <div className="animate-pulse text-slate-400">Checking approved source evidence...</div>}
          {error && <div className="text-red-300">Catalyst evidence unavailable: {error.message}</div>}
          {data && data.events.length === 0 && (
            <div className="text-slate-400">No supported, ticker-matched catalyst found in the last 72 hours.</div>
          )}
          {data && data.events.length > 0 && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <span className={clsx('rounded border px-1.5 py-0.5 text-[9px] uppercase', tone(data.summary?.direction))}>
                  {data.summary?.direction || 'uncertain'}
                </span>
                <span className="text-slate-400">
                  {data.summary?.event_count} verified event{data.summary?.event_count === 1 ? '' : 's'} · {Math.round((data.summary?.confidence || 0) * 100)}% rule confidence
                </span>
                <span className="text-sky-300">active ranking validation</span>
              </div>
              {data.brief?.brief && <p className="mt-1.5 leading-relaxed text-slate-200">{data.brief.brief}</p>}
              <div className="mt-2 space-y-2">
                {data.events.slice(0, 3).map(event => (
                  <article key={event.event_id} className="border-t border-slate-700/60 pt-2">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className={clsx('rounded border px-1 py-0.5 text-[9px] uppercase', tone(event.direction))}>{event.direction}</span>
                      <span className="text-slate-300">{formatLabel(event.category)}</span>
                      <span className="text-slate-500">{event.severity} · {event.directness} · {event.time_horizon}</span>
                    </div>
                    <div className="mt-1 text-slate-100">{event.title}</div>
                    <div className="mt-1 flex flex-wrap gap-x-2 text-[10px] text-slate-500">
                      <span>{formatDetected(event.detected_sec)}</span>
                      <span>{event.timestamp_basis === 'trusted_publish_time' ? 'published time' : 'first-seen time'}</span>
                      <span>{event.source_names.join(', ') || 'source unavailable'}</span>
                      {event.source_urls[0] && (
                        <a href={event.source_urls[0]} target="_blank" rel="noreferrer" className="text-sky-300 hover:text-sky-200">Source</a>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
