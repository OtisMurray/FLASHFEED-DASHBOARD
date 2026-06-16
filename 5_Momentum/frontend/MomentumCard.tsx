'use client'
import { useState } from 'react'
import useSWR from 'swr'
import { clsx } from 'clsx'
import type { MomentumRow } from '@/lib/types'
import { IntradayChart } from './IntradayChart'

const fetcher = (url: string) => fetch(url).then(r => r.json())

interface Props { row: MomentumRow; rank: number }

function fmtCompact(n: number | null | undefined): string {
  if (n == null) return '—'
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`
  return String(n)
}

export function MomentumCard({ row, rank }: Props) {
  const [expanded, setExpanded] = useState(false)
  const chg = row.change_pct ?? 0
  const sent = row.sentiment ?? 0

  // Only fetch details when expanded
  const { data: details } = useSWR(
    expanded ? `/api/momentum/${row.ticker}/details` : null, fetcher
  )

  const headlines: Array<{ title: string; source: string; sentiment?: string; time?: string; catalyst?: string }> = details?.headlines ?? []
  const posts: Array<{ content: string; platform: string; author: string; sentiment?: number }> = details?.posts ?? []

  return (
    <div className="bg-surface border border-border rounded-lg overflow-hidden">
      {/* Header - clickable to expand */}
      <div
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-card-hover transition-colors"
      >
        {/* Rank badge */}
        <span className="w-6 h-6 rounded-full bg-accent/20 text-accent text-xs font-bold flex items-center justify-center flex-shrink-0">
          {rank}
        </span>

        {/* Ticker info */}
        <div className="min-w-[100px]">
          <div className="font-mono font-bold text-accent text-sm">{row.ticker}</div>
          {row.company && <div className="text-[10px] text-neutral truncate max-w-[100px]">{row.company}</div>}
        </div>

        {/* Metrics */}
        <div className="flex items-center gap-4 flex-1 flex-wrap">
          <MetricCell label="Price" value={row.price != null ? `$${row.price.toFixed(2)}` : '—'} />
          <MetricCell label="Change" value={`${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%`}
            color={chg >= 0 ? 'text-emerald-400' : 'text-red-400'} />
          <MetricCell label="Volume" value={fmtCompact(row.volume)} />
          <MetricCell label="Sentiment" value={`${sent >= 0 ? '+' : ''}${sent.toFixed(2)}`}
            color={sent >= 0.2 ? 'text-emerald-400' : sent <= -0.2 ? 'text-red-400' : 'text-neutral'} />
          <MetricCell label="Articles" value={String(row.article_count ?? 0)} />
        </div>

        {/* Sentiment bar */}
        <div className="w-20 hidden sm:block">
          <SentimentBar value={sent} />
        </div>

        {/* Expand icon */}
        <span className="text-neutral text-sm flex-shrink-0">{expanded ? '▾' : '▸'}</span>
      </div>

      {/* Expanded body */}
      {expanded && (
        <div className="border-t border-border px-4 py-3 grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Intraday chart */}
          <div className="md:col-span-1">
            <div className="text-[10px] text-neutral uppercase tracking-wide mb-1">Intraday</div>
            <div className="h-[140px] bg-bg rounded border border-border">
              <IntradayChart ticker={row.ticker} />
            </div>
          </div>

          {/* Headlines */}
          <div className="md:col-span-1">
            <div className="text-[10px] text-neutral uppercase tracking-wide mb-1">
              News Headlines ({headlines.length})
            </div>
            <div className="space-y-1 max-h-[160px] overflow-y-auto">
              {headlines.length === 0 ? (
                <div className="text-xs text-neutral">No recent headlines</div>
              ) : headlines.slice(0, 8).map((h, i) => (
                <div key={i} className="text-xs">
                  <div className="flex items-center gap-1 mb-0.5">
                    {h.sentiment && (
                      <span className={`w-1.5 h-1.5 rounded-full ${
                        h.sentiment === 'bullish' ? 'bg-emerald-500' : h.sentiment === 'bearish' ? 'bg-red-500' : 'bg-slate-500'
                      }`} />
                    )}
                    <span className="text-[10px] text-neutral">{h.source}</span>
                    {h.time && <span className="text-[10px] text-neutral ml-auto">{h.time}</span>}
                  </div>
                  <div className="text-slate-300 line-clamp-1">{h.title}</div>
                  {h.catalyst && (
                    <span className="text-[9px] bg-yellow-500/15 text-yellow-400 px-1 py-0.5 rounded mt-0.5 inline-block">{h.catalyst}</span>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Social posts */}
          <div className="md:col-span-1">
            <div className="text-[10px] text-neutral uppercase tracking-wide mb-1">
              Social Sentiment ({posts.length})
            </div>
            <div className="space-y-1 max-h-[160px] overflow-y-auto">
              {posts.length === 0 ? (
                <div className="text-xs text-neutral">No recent posts</div>
              ) : posts.slice(0, 6).map((p, i) => (
                <div key={i} className="bg-bg border border-border rounded px-2 py-1.5">
                  <div className="flex items-center gap-1 mb-0.5">
                    <span className="text-[9px] bg-slate-700 text-neutral px-1 py-0.5 rounded capitalize">{p.platform}</span>
                    <span className="text-[10px] text-neutral">@{p.author}</span>
                    {p.sentiment != null && (
                      <span className={clsx('text-[10px] ml-auto font-mono', p.sentiment >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                        {p.sentiment >= 0 ? '+' : ''}{p.sentiment.toFixed(2)}
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-slate-300 line-clamp-2">{p.content}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function MetricCell({ label, value, color = 'text-white' }: { label: string; value: string; color?: string }) {
  return (
    <div className="min-w-[60px]">
      <div className="text-[9px] text-neutral uppercase">{label}</div>
      <div className={`text-xs font-mono ${color}`}>{value}</div>
    </div>
  )
}

function SentimentBar({ value }: { value: number }) {
  // Map -1..1 to 0..100
  const pct = Math.max(0, Math.min(100, (value + 1) * 50))
  return (
    <div className="h-1.5 rounded-full bg-slate-700 overflow-hidden">
      <div
        className={clsx('h-full rounded-full', value >= 0.2 ? 'bg-emerald-500' : value <= -0.2 ? 'bg-red-500' : 'bg-slate-400')}
        style={{ width: `${pct}%` }}
      />
    </div>
  )
}
