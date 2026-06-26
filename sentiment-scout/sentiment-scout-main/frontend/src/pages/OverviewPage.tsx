'use client'
import useSWR from 'swr'
import { Link } from 'react-router-dom'
import { SentimentBadge } from '@/components/shared/SentimentBadge'

// How many AI Top Picks the Overview shows. Single knob — the backend supplies a
// larger deduped, conviction-ranked pool (cached, no model call), so raising this
// only shows more of it; it never adds OpenRouter calls.
const TOP_PICKS_COUNT = 20

// AI Top Picks — the centerpiece of the landing view. Renders entirely from the
// cached /api/screener payload (the screener run's stored AI insights); there is
// NO live model call on load — SWR just reads the same cached ranking the
// Screener page uses. Each row's `direction`, `conviction`, and `news_catalyst`
// come straight from that stored conviction ranking.
const fetcher = (url: string) => fetch(url).then(r => r.json())

interface Pick {
  ticker: string
  company?: string
  direction?: 'long' | 'short' | 'neutral' | string | null
  conviction?: number | null
  news_catalyst?: string | null
  price?: number | null
  change_pct?: number | null
}

const dirToSentiment = (d?: string | null): 'bullish' | 'bearish' | 'neutral' =>
  d === 'long' ? 'bullish' : d === 'short' ? 'bearish' : 'neutral'

function ConvictionMeter({ value, direction }: { value: number; direction?: string | null }) {
  const color = direction === 'long' ? 'bg-emerald-500' : direction === 'short' ? 'bg-red-500' : 'bg-slate-400'
  return (
    <div className="flex items-center gap-2">
      <div className="w-20 h-1.5 rounded-full bg-slate-700 overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.max(0, Math.min(10, value)) * 10}%` }} />
      </div>
      <span className="font-mono text-sm text-white tabular-nums">{value}<span className="text-neutral text-xs">/10</span></span>
    </div>
  )
}

export function OverviewPage() {
  const { data, isLoading } = useSWR('/api/screener', fetcher, { refreshInterval: 30_000 })

  // Prefer the backend's `top_picks` board (AI picks across recent runs, deduped
  // by ticker and conviction-ranked) so the landing fills even when a single run
  // yields one pick. Fall back to filtering the current-run tickers.
  const picks: Pick[] = (data?.top_picks ?? null)
    ? (data.top_picks as Pick[]).slice(0, TOP_PICKS_COUNT)
    : (data?.tickers ?? [])
        .filter((t: Pick) => t.conviction != null)
        .sort((a: Pick, b: Pick) => (b.conviction ?? 0) - (a.conviction ?? 0))
        .slice(0, TOP_PICKS_COUNT)

  return (
    <div className="max-w-4xl mx-auto">
      <div className="mb-3">
        <h1 className="text-white font-semibold text-lg">Overview</h1>
      </div>

      {/* AI Top Picks panel — centerpiece */}
      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        {/* Header */}
        <div className="px-5 py-4 border-b border-border bg-gradient-to-r from-accent/10 to-transparent">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xl">🎯</span>
            <h2 className="text-white font-semibold text-base">AI Top Picks</h2>
            <span className="text-[10px] uppercase tracking-wide bg-accent/15 border border-accent/30 text-accent px-1.5 py-0.5 rounded">
              AI · cached
            </span>
          </div>
          <p className="text-neutral text-xs mt-1.5 leading-relaxed">
            Sentiment-based AI ranking from news &amp; social — the model&apos;s directional view, ordered by
            conviction. This is the model&apos;s opinion, <span className="text-slate-300">not a guarantee or investment advice</span>.
          </p>
        </div>

        {/* Picks */}
        {isLoading ? (
          <div className="p-6 text-neutral text-sm animate-pulse">Loading AI ranking…</div>
        ) : picks.length === 0 ? (
          <div className="p-8 text-center text-neutral">
            <div className="text-3xl mb-2">🤖</div>
            <div className="text-sm">No ranked picks in the latest screener run yet.</div>
          </div>
        ) : (
          <ul className="divide-y divide-slate-700/40">
            {picks.map((p, i) => (
              <li key={p.ticker} className="flex items-start gap-4 px-5 py-3.5 hover:bg-card-hover transition-colors">
                {/* Rank */}
                <span className="w-6 h-6 mt-0.5 flex-shrink-0 rounded-full bg-accent/15 text-accent text-xs font-bold flex items-center justify-center">
                  {i + 1}
                </span>

                {/* Ticker + direction + reason */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono font-bold text-accent text-base">{p.ticker}</span>
                    <SentimentBadge sentiment={dirToSentiment(p.direction)} />
                    <span className={`text-[11px] font-semibold uppercase tracking-wide ${
                      p.direction === 'long' ? 'text-emerald-400' : p.direction === 'short' ? 'text-red-400' : 'text-neutral'
                    }`}>
                      {p.direction === 'long' ? '▲ Long' : p.direction === 'short' ? '▼ Short' : '● Neutral'}
                    </span>
                    {p.company && <span className="text-neutral text-xs truncate hidden sm:block">{p.company}</span>}
                  </div>
                  {p.news_catalyst && (
                    <p className="text-sm text-slate-300 mt-1 leading-snug">
                      <span className="text-neutral text-[11px] uppercase tracking-wide mr-1">Why:</span>
                      {p.news_catalyst}
                    </p>
                  )}
                </div>

                {/* Conviction */}
                <div className="flex-shrink-0 mt-0.5">
                  <ConvictionMeter value={p.conviction ?? 0} direction={p.direction} />
                </div>

                {/* Open this ticker on the Charts tab (SPA nav, ?t= deep link) */}
                <Link
                  to={`/charts?t=${encodeURIComponent(p.ticker)}`}
                  title={`Open ${p.ticker} chart`}
                  aria-label={`Open ${p.ticker} chart`}
                  className="flex-shrink-0 mt-0.5 flex items-center gap-1 text-xs px-2 py-1 rounded border border-border text-neutral hover:text-white hover:border-accent transition-colors"
                >
                  <span aria-hidden>📈</span><span className="hidden sm:inline">Chart</span>
                </Link>
              </li>
            ))}
          </ul>
        )}

        {/* Footer source note */}
        <div className="px-5 py-2.5 border-t border-border text-[11px] text-neutral">
          Ranked by conviction from the latest cached screener run · reads <span className="font-mono text-slate-400">/api/screener</span> · no live model call.
        </div>
      </div>
    </div>
  )
}
