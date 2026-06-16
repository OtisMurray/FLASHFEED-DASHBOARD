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

function quoteAgeLabel(value: MomentumRow['quote_updated_at']): string {
  const raw = typeof value === 'number' ? value : Number(value || 0)
  if (!raw) return 'No quote time'
  const ts = raw > 1_000_000_000_000 ? Math.floor(raw / 1000) : raw
  const age = Math.max(0, Math.floor(Date.now() / 1000) - ts)
  if (age < 3600) return `${Math.floor(age / 60)}m old`
  if (age < 86_400) return `${Math.floor(age / 3600)}h old`
  return `${Math.floor(age / 86_400)}d old`
}

export function MomentumCard({ row, rank }: Props) {
  const [expanded, setExpanded] = useState(false)
  const chg = row.change_pct ?? 0
  const sent = row.sentiment ?? 0
  const structuredCount = row.structured_article_count ?? 0
  const publicNewsCount = row.unstructured_article_count ?? 0
  const socialCount = row.message_count ?? 0
  const bracket = row.bracket_order

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
          <MetricCell label="Abs Move" value={`${Math.abs(chg).toFixed(2)}%`} color="text-yellow-300" />
          <MetricCell label="Volume" value={fmtCompact(row.volume)} />
          <MetricCell label="Weighted Sent" value={`${sent >= 0 ? '+' : ''}${sent.toFixed(2)}`}
            color={sent >= 0.2 ? 'text-emerald-400' : sent <= -0.2 ? 'text-red-400' : 'text-neutral'} />
          <MetricCell label="Structured" value={String(structuredCount)} />
          <MetricCell label="Public News" value={String(publicNewsCount)} />
          <MetricCell label="Social" value={String(socialCount)} />
          <MetricCell
            label="AI Rank"
            value={bracket ? `${Math.round((bracket.confidence ?? 0) * 100)}%` : '—'}
            color={bracket?.candidate ? 'text-emerald-400' : 'text-neutral'}
          />
          <MetricCell
            label="Quote Age"
            value={row.quote_status === 'priced' ? quoteAgeLabel(row.quote_updated_at) : row.quote_status === 'estimated' ? 'Estimated' : 'No price data'}
            color={row.quote_status === 'priced' ? 'text-neutral' : 'text-yellow-300'}
          />
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
              Headlines ({headlines.length}; {structuredCount} structured, {publicNewsCount} public)
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
            {bracket && (
              <div className={clsx(
                'mb-2 rounded border px-2 py-1.5 text-[11px]',
                bracket.candidate ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200' : 'border-border bg-bg text-neutral'
              )}>
                <div className="flex items-center justify-between gap-2">
                  <span>{bracket.candidate ? 'Bracket watch candidate' : 'Bracket watch monitor'}</span>
                  <span className="font-mono">{Math.round((bracket.confidence ?? 0) * 100)}%</span>
                </div>
                <div className="mt-1 text-[10px] text-neutral">
                  Stop {bracket.stop_loss_pct ?? '—'}% · Target {bracket.take_profit_pct ?? '—'}% · Support {bracket.support_count ?? 0}
                </div>
              </div>
            )}
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
