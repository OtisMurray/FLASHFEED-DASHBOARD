'use client'
import { clsx } from 'clsx'

export interface EnrichArticle {
  id: string
  headline: string
  source: string
  url?: string | null
  published_at?: number | null
  sentiment?: 'bullish' | 'bearish' | 'neutral' | null
  sentiment_score?: number | null
  finbert_score?: number | null
  vader_score?: number | null
}

export interface EnrichData {
  ticker: string
  news_alert: boolean
  news_alert_count: number
  news: {
    days: number
    articles: EnrichArticle[]
    ai?: {
      catalyst: string | null
      summary: string | null
      direction: string | null
      conviction: number | null
      headlines: string[]
      sources: string[]
      assessed_at: number | null
    } | null
    sources: string[]
    source_filter_active: boolean
    note: string
  }
  social: {
    stocktwits: { sentiment: number | null; density: number | null; bull: number | null; bear: number | null; window_hours: number } | null
    bluesky?: {
      configured: boolean
      metrics: { sentiment: number | null; density: number | null; bull: number | null; bear: number | null; window_hours: number } | null
    }
    reddit?: {
      configured: boolean
      metrics: { sentiment: number | null; density: number | null; bull: number | null; bear: number | null; window_hours: number } | null
    }
    grok?: {
      configured: boolean
      metrics: { sentiment: number | null; density: number | null; bull: number | null; bear: number | null; window_hours: number } | null
    }
    rumor: { text: string | null; direction: string | null; time: number | null; author: string | null } | null
    future_sources: string[]
  }
}

function fmtTime(ts?: number | null): string {
  if (!ts) return ''
  const d = new Date(ts * 1000)
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function sentColor(s?: string | null) {
  return s === 'bullish' ? 'text-emerald-400' : s === 'bearish' ? 'text-red-400' : 'text-slate-400'
}
function dot(s?: string | null) {
  return s === 'bullish' ? 'bg-emerald-500' : s === 'bearish' ? 'bg-red-500' : 'bg-slate-500'
}

export function TickerEnrichPanels({ ticker, enrich }: { ticker: string; enrich: EnrichData | null }) {
  const news = enrich?.news
  const ai = news?.ai
  const hasNews = (news?.articles.length ?? 0) > 0 || !!ai
  const social = enrich?.social
  const st = social?.stocktwits
  const bsky = social?.bluesky
  const bs = bsky?.metrics
  const reddit = social?.reddit
  const rd = reddit?.metrics
  const grok = social?.grok
  const gx = grok?.metrics
  const rumor = social?.rumor

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 mt-3">
      {/* News panel: AI pick catalyst + FeedFlash articles */}
      <div className="lg:col-span-2 bg-surface border border-border rounded-lg overflow-hidden">
        <div className="px-3 py-2 border-b border-border flex items-center justify-between">
          <span className="text-xs text-neutral font-medium uppercase tracking-wide">
            News {news ? `(${news.articles.length + (ai?.headlines.length ?? 0)})` : ''}
          </span>
          <span className="text-[10px] text-slate-500">AI ranking + FeedFlash · FinBERT/VADER</span>
        </div>

        {!enrich ? (
          <div className="p-4 text-neutral text-sm animate-pulse">Loading news…</div>
        ) : hasNews ? (
          <>
            {ai && ai.catalyst && (
              <div className="px-3 py-2 bg-accent/5 border-b border-accent/20">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[10px] font-bold uppercase tracking-wide bg-accent/15 border border-accent/30 text-accent px-1.5 py-0.5 rounded">AI catalyst</span>
                  {ai.direction && (
                    <span className={clsx('text-[10px] font-bold uppercase',
                      ai.direction === 'long' ? 'text-emerald-400' : ai.direction === 'short' ? 'text-red-400' : 'text-slate-400')}>
                      {ai.direction === 'long' ? '▲ LONG' : ai.direction === 'short' ? '▼ SHORT' : ai.direction}
                    </span>
                  )}
                  {ai.conviction != null && <span className="text-[10px] text-neutral font-mono">{ai.conviction}/10</span>}
                  <span className="text-[10px] text-slate-500 ml-auto">{fmtTime(ai.assessed_at)}</span>
                </div>
                <p className="text-sm text-white">{ai.catalyst}</p>
                {ai.sources?.length > 0 && (
                  <div className="text-[10px] text-slate-500 mt-1">Scored from: {ai.sources.join(', ')}</div>
                )}
              </div>
            )}
            <ul className="divide-y divide-slate-700/30 max-h-[320px] overflow-y-auto">
              {(ai?.headlines ?? []).map((h, i) => (
                <li key={`ai-${i}`} className="px-3 py-2 hover:bg-card-hover transition-colors">
                  <div className="flex items-start gap-2">
                    <span className="mt-1.5 w-1.5 h-1.5 rounded-full flex-shrink-0 bg-accent" />
                    <div className="min-w-0 flex-1">
                      <span className="text-sm text-white line-clamp-2">{h}</span>
                      <div className="text-[11px] text-neutral mt-0.5">AI ranking · scored at pick time</div>
                    </div>
                  </div>
                </li>
              ))}
              {news!.articles.map(a => (
                <li key={a.id} className="px-3 py-2 hover:bg-card-hover transition-colors">
                  <div className="flex items-start gap-2">
                    <span className={clsx('mt-1.5 w-1.5 h-1.5 rounded-full flex-shrink-0', dot(a.sentiment))} />
                    <div className="min-w-0 flex-1">
                      {a.url ? (
                        <a href={a.url} target="_blank" rel="noopener noreferrer"
                           className="text-sm text-white hover:text-accent transition-colors line-clamp-2">{a.headline}</a>
                      ) : (
                        <span className="text-sm text-white line-clamp-2">{a.headline}</span>
                      )}
                      <div className="flex items-center gap-2 mt-0.5 text-[11px]">
                        <span className="text-neutral">{a.source}</span>
                        <span className="text-slate-600">·</span>
                        <span className="text-slate-500">{fmtTime(a.published_at)}</span>
                        <span className="text-slate-600">·</span>
                        <span className={clsx('font-mono', sentColor(a.sentiment))}>
                          {a.sentiment ?? 'neutral'}{a.sentiment_score != null ? ` ${a.sentiment_score >= 0 ? '+' : ''}${a.sentiment_score.toFixed(2)}` : ''}
                        </span>
                      </div>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
            <div className="px-3 py-1.5 border-t border-border text-[10px] text-slate-500">
              {news!.articles.length === 0 && ai
                ? 'No FeedFlash articles in the last 3 days — showing the news behind the AI pick.'
                : `Sources: ${news!.sources.join(', ') || '—'} · ${news!.note}`}
            </div>
          </>
        ) : (
          <div className="px-3 py-8 text-center text-neutral text-sm">
            <div className="text-2xl mb-1">📰</div>
            No news for {ticker} in any source (FeedFlash or AI ranking).
          </div>
        )}
      </div>

      {/* Social & gossip panel */}
      <div className="bg-surface border border-border rounded-lg overflow-hidden">
        <div className="px-3 py-2 border-b border-border">
          <span className="text-xs text-neutral font-medium uppercase tracking-wide">Social & Gossip</span>
        </div>

        <div className="p-3 space-y-3">
          {/* Stocktwits */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-[11px] text-neutral uppercase tracking-wide">Stocktwits</span>
              {st && <span className="text-[10px] text-slate-500">{st.window_hours}h window</span>}
            </div>
            {!enrich ? (
              <div className="text-neutral text-sm animate-pulse">Loading…</div>
            ) : st ? (
              <div className="flex items-center gap-3">
                <div>
                  <div className="text-[9px] text-slate-500 uppercase">Sentiment</div>
                  <div className={clsx('font-mono text-lg', (st.sentiment ?? 0) >= 0.2 ? 'text-emerald-400' : (st.sentiment ?? 0) <= -0.2 ? 'text-red-400' : 'text-neutral')}>
                    {st.sentiment != null ? st.sentiment.toFixed(2) : '—'}
                  </div>
                </div>
                <div>
                  <div className="text-[9px] text-slate-500 uppercase">Density</div>
                  <div className="font-mono text-lg text-accent">{st.density ?? '—'}</div>
                </div>
                <div className="text-[11px] font-mono">
                  <div className="text-emerald-400">▲ {st.bull ?? 0} bull</div>
                  <div className="text-red-400">▼ {st.bear ?? 0} bear</div>
                </div>
              </div>
            ) : (
              <div className="text-slate-500 text-xs py-1">No Stocktwits activity in the last 72h.</div>
            )}
          </div>

          <SocialMetricBlock label="Bluesky" metrics={bs} loading={!enrich} />
          <SocialMetricBlock label="Reddit" metrics={rd} loading={!enrich} />
          <SocialMetricBlock label="Grok/X" metrics={gx} loading={!enrich} />

          {/* Rumor / gossip */}
          <div>
            <span className="text-[11px] text-neutral uppercase tracking-wide">Detected rumor</span>
            {rumor && rumor.text ? (
              <div className="mt-1 bg-bg border border-border rounded p-2">
                <div className="flex items-center gap-2 mb-1">
                  <span className={clsx('text-[10px] font-bold px-1.5 py-0.5 rounded',
                    rumor.direction === 'Buy-In' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400')}>
                    {rumor.direction ?? 'rumor'}
                  </span>
                  {rumor.author && <span className="text-[10px] text-slate-500">@{rumor.author}</span>}
                  <span className="text-[10px] text-slate-500 ml-auto">{fmtTime(rumor.time)}</span>
                </div>
                <p className="text-[11px] text-neutral line-clamp-4 whitespace-pre-line">{rumor.text}</p>
              </div>
            ) : (
              <div className="text-slate-500 text-xs py-1 mt-0.5">No active rumor detected.</div>
            )}
          </div>

          {(social?.future_sources?.length ?? 0) > 0 && (
            <div>
              <span className="text-[11px] text-neutral uppercase tracking-wide">Other platforms</span>
              <div className="flex gap-1.5 mt-1 flex-wrap">
                {(social?.future_sources ?? []).map(s => (
                  <span key={s} className="text-[10px] px-2 py-0.5 rounded border border-dashed border-slate-600 text-slate-500">
                    {s} · soon
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function SocialMetricBlock({
  label,
  metrics,
  loading,
}: {
  label: string
  metrics?: { sentiment: number | null; density: number | null; bull: number | null; bear: number | null; window_hours: number } | null
  loading: boolean
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-[11px] text-neutral uppercase tracking-wide">{label}</span>
        {metrics && <span className="text-[10px] text-slate-500">{metrics.window_hours}h window</span>}
      </div>
      {loading ? (
        <div className="text-neutral text-sm animate-pulse">Loading…</div>
      ) : metrics ? (
        <div className="flex items-center gap-3">
          <div>
            <div className="text-[9px] text-slate-500 uppercase">Sentiment</div>
            <div className={clsx('font-mono text-lg', (metrics.sentiment ?? 0) >= 0.2 ? 'text-emerald-400' : (metrics.sentiment ?? 0) <= -0.2 ? 'text-red-400' : 'text-neutral')}>
              {metrics.sentiment != null ? metrics.sentiment.toFixed(2) : '—'}
            </div>
          </div>
          <div>
            <div className="text-[9px] text-slate-500 uppercase">Density</div>
            <div className="font-mono text-lg text-accent">{metrics.density ?? '—'}</div>
          </div>
          <div className="text-[11px] font-mono">
            <div className="text-emerald-400">▲ {metrics.bull ?? 0} bull</div>
            <div className="text-red-400">▼ {metrics.bear ?? 0} bear</div>
          </div>
        </div>
      ) : (
        <div className="text-slate-500 text-xs py-1">No {label} mentions in the last 72h.</div>
      )}
    </div>
  )
}
