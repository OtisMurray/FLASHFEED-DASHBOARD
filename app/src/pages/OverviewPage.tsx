import useSWR from 'swr'
import { clsx } from 'clsx'
import type { Article, CorrelationEntry } from '@/lib/types'
import { getLanguageLabel, useTargetLanguage, useTranslatedText } from '@/lib/translation'
import { buildTrendingPhrases } from '../lib/trendingPhrases'

type SocialPreview = {
  platform?: string
  author?: string
  ticker?: string
  symbol?: string
  title?: string
  text?: string
  content?: string
  sentiment?: string | number | null
  sentiment_score?: number | null
  finance_keywords?: string[]
  keywords?: string[]
  gossip_keywords?: string[]
  fetched_at?: number
  timestamp?: number
  created_at?: number
}

type SentimentAuditRow = {
  id?: string
  ticker?: string
  title?: string
  source?: string
  sentiment?: string
  sentiment_score?: number
  event_type?: string
  reason?: string
}

const fetcher = (url: string) => fetch(url).then(r => r.json())

const livePanelSWR = {
  refreshInterval: 60_000,
  dedupingInterval: 60_000,
  keepPreviousData: true,
  revalidateOnFocus: false,
}

const slowerPanelSWR = {
  refreshInterval: 60_000,
  dedupingInterval: 45_000,
  keepPreviousData: true,
  revalidateOnFocus: false,
}

function asArray<T>(value: any, keys: string[] = []): T[] {
  if (Array.isArray(value)) return value
  for (const key of keys) {
    if (Array.isArray(value?.[key])) return value[key]
  }
  return []
}

function compact(n: number | null | undefined) {
  if (n == null || Number.isNaN(n)) return '--'
  if (Math.abs(n) >= 1e12) return `${(n / 1e12).toFixed(1)}T`
  if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1)}K`
  return n.toLocaleString()
}

function timeAgo(epoch?: number | string | null) {
  const raw = Number(epoch || 0)
  if (!raw) return ''
  const ms = raw > 1000000000000 ? raw : raw * 1000
  const diff = Math.max(0, Date.now() - ms)
  if (diff < 60_000) return 'now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function sentimentTone(value?: string | number | null) {
  const numeric = typeof value === 'number' ? value : null
  const text = String(value || '').toLowerCase()
  if ((numeric ?? 0) > 0.15 || text.includes('bull') || text.includes('positive')) return 'text-emerald-400'
  if ((numeric ?? 0) < -0.15 || text.includes('bear') || text.includes('negative')) return 'text-red-400'
  return 'text-slate-400'
}

function sentimentLabel(value?: string | number | null) {
  if (typeof value === 'number') return Math.abs(value) < 0.005 ? 'Neutral' : value > 0 ? `+${value.toFixed(2)}` : value.toFixed(2)
  const text = String(value || 'neutral')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function socialText(post: SocialPreview) {
  return post.text || post.title || post.content || 'No preview available'
}

export function OverviewPage() {
  const targetLanguage = useTargetLanguage()
  const { data: stats } = useSWR('/api/stats?days=3', fetcher, livePanelSWR)
  const { data: status } = useSWR('/api/status', fetcher, livePanelSWR)
  const { data: articlesData } = useSWR('/api/articles?limit=30&ticker_only=1&recent_days=3', fetcher, livePanelSWR)
  const { data: socialData } = useSWR('/api/social/rolling?window_minutes=1440&limit=80&ranked=1', fetcher, livePanelSWR)
  const { data: socialStats } = useSWR('/api/social/rolling/stats?window_minutes=1440', fetcher, livePanelSWR)
  const { data: correlationData } = useSWR('/api/correlation', fetcher, slowerPanelSWR)
  const { data: auditData } = useSWR('/api/sentiment/audit?limit=8&days=3', fetcher, slowerPanelSWR)

  const articles = asArray<Article>(articlesData, ['articles'])
  const socialPosts = asArray<SocialPreview>(socialData, ['rows', 'posts']).slice(0, 10)
  const correlations = asArray<CorrelationEntry>(correlationData, ['entries', 'results']).slice(0, 5)
  const tickerMentions: Array<{ ticker: string; count: number; bullish?: number; bearish?: number; neutral?: number }> = (stats?.ticker_mentions ?? [])
    .slice()
    .sort((a: any, b: any) => Number(b.count || 0) - Number(a.count || 0))
    .slice(0, 5)
  const auditRows = asArray<SentimentAuditRow>(auditData, ['rows']).slice(0, 6)
  const auditSummary = auditData?.summary

  const rawPhrases = Array.isArray((socialData as any)?.phrases) && (socialData as any).phrases.length
    ? (socialData as any).phrases
    : buildTrendingPhrases(socialPosts, 12)
  const phrases: Array<[string, number]> = rawPhrases
    .map((row: any) => Array.isArray(row)
      ? [String(row[0] || ''), Number(row[1] || 0)] as [string, number]
      : [String(row?.phrase || ''), Number(row?.count || 0)] as [string, number])
    .filter(([phrase]) => Boolean(phrase))


  const bullishArticles = stats?.sentiment?.bullish ?? 0
  const bearishArticles = stats?.sentiment?.bearish ?? 0
  const trackedMarkets = compact(stats?.tracked_market_ticker_count ?? stats?.tracked_ticker_count)
  const totalArticleCount = stats?.total ?? status?.database?.recent_articles ?? articlesData?.total ?? 0
  const socialTotal = socialStats?.total ?? socialData?.count ?? socialPosts.length
  const pearsonR = correlationData?.summary?.pearson_correlation ?? null

  return (
    <div className="overview-page space-y-4">
      <div>
        <div>
          <h1 className="text-white font-semibold text-2xl">Overview</h1>
          <p className="text-sm text-neutral mt-1">Last three days of ticker-matched news, social, and correlation signals in one workspace.</p>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
        <Metric label="Total Articles" value={compact(totalArticleCount)} />
        <Metric label="Tracked Stocks" value={trackedMarkets} tone="text-sky-300" />
        <Metric label="Bullish News" value={compact(bullishArticles)} tone="text-emerald-400" />
        <Metric label="Bearish News" value={compact(bearishArticles)} tone="text-red-400" />
        <Metric label="Social Signals" value={compact(socialTotal)} tone="text-indigo-300" />
        <Metric label="Correlation" value={pearsonR == null ? '--' : pearsonR.toFixed(2)} tone="text-yellow-300" />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1.45fr)_minmax(320px,0.9fr)_minmax(300px,0.8fr)] gap-4">
        <section className="min-w-0 bg-surface border border-border rounded-lg overflow-hidden">
          <SectionTitle title="Ticker-Matched News" meta={`${articles.length} latest 30 · 3d`} />
          <div className="divide-y divide-slate-700/30 max-h-[640px] overflow-y-auto">
            {articles.length ? articles.map(article => (
              <OverviewArticleRow key={article.id || article.article_id || article.url || article.title} article={article} targetLanguage={targetLanguage} />
            )) : (
              <div className="px-3 py-8 text-center text-neutral text-sm">No recent headlines. Run a fetch to fill this section.</div>
            )}
          </div>
        </section>

        <section className="min-w-0 bg-surface border border-border rounded-lg overflow-hidden">
          <SectionTitle title="Social Sentiment" meta={`${socialTotal} posts`} />
          <div className="divide-y divide-slate-700/30 max-h-[360px] overflow-y-auto">
            {socialPosts.length ? socialPosts.map((post, idx) => {
              const ticker = post.ticker || post.symbol
              return (
                <div key={`${post.platform}-${ticker}-${idx}`} className="px-3 py-3">
                  <div className="flex items-center gap-2 text-[11px] mb-1">
                    <span className="capitalize bg-bg border border-border rounded px-1.5 py-0.5 text-neutral">{post.platform || 'Social'}</span>
                    {ticker && <TickerChip ticker={ticker} />}
                    {post.author && <span className="text-neutral truncate">@{post.author}</span>}
                    <span className={clsx('ml-auto font-mono', sentimentTone(post.sentiment_score ?? post.sentiment))}>
                      {sentimentLabel(post.sentiment_score ?? post.sentiment)}
                    </span>
                  </div>
                  <div className="text-sm text-slate-200 line-clamp-3">{socialText(post)}</div>
                </div>
              )
            }) : (
              <div className="px-3 py-8 text-center text-neutral text-sm">No social posts in the current window.</div>
            )}
          </div>

          <SectionTitle title="Trending Phrases" meta={phrases.length ? '24h window' : 'waiting'} />
          <div className="p-3 flex flex-wrap gap-2">
            {phrases.length ? phrases.map(([phrase, count]) => (
              <span key={phrase} className="rounded-full border border-border bg-bg px-2.5 py-1 text-xs text-slate-200">
                {phrase} <span className="text-neutral">x{count}</span>
              </span>
            )) : (
              <span className="text-sm text-neutral">Phrases appear after social posts include keywords.</span>
            )}
          </div>
        </section>

        <section className="overview-side-rail min-w-0 bg-surface border border-border rounded-lg overflow-y-auto">
          <SectionTitle title="Correlation Signals" meta={`${correlations.length} rows`} />
          <div className="p-3 space-y-2 flex-none">
            {correlations.length ? correlations.map(entry => (
              <div key={entry.ticker} className="bg-bg/60 border border-border rounded p-2">
                <div className="flex items-center justify-between gap-2 mb-1">
                  <span className="font-mono font-bold text-accent text-xs">{entry.ticker}</span>
                  <span className={clsx('font-mono text-xs', Number(entry.correlation || 0) >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                    {Number(entry.correlation || 0) >= 0 ? '+' : ''}{Number(entry.correlation || 0).toFixed(3)}
                  </span>
                </div>
                <div className="h-1.5 rounded-full bg-slate-700 overflow-hidden">
                  <div
                    className={clsx('h-full rounded-full', Number(entry.correlation || 0) >= 0 ? 'bg-emerald-500' : 'bg-red-500')}
                    style={{ width: `${Math.min(100, Math.abs(Number(entry.correlation || 0)) * 100)}%` }}
                  />
                </div>
                <div className="text-[10px] text-neutral mt-1">{entry.sample_size ?? 0} samples</div>
              </div>
            )) : (
              <div className="text-sm text-neutral border border-border rounded p-3 bg-bg/40">Run alignment after fresh articles and quotes to populate this panel.</div>
            )}
          </div>

          <SectionTitle title="Ticker Tracker" meta={tickerMentions.length ? 'top 5 by mentions' : 'waiting'} />
          <div className="p-4 space-y-3 flex-none">
            {tickerMentions.length ? tickerMentions.map(row => {
              const bullish = row.bullish ?? 0
              const bearish = row.bearish ?? 0
              const total = Math.max(1, row.count || 0)
              return (
                <div key={row.ticker} className="bg-bg/60 border border-border rounded-lg p-3">
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <TickerChip ticker={row.ticker} />
                    <span className="text-xs text-neutral">{compact(row.count)} mentions</span>
                  </div>
                  <div className="flex h-2 rounded-full overflow-hidden bg-slate-700">
                    <div className="bg-emerald-500" style={{ width: `${(bullish / total) * 100}%` }} />
                    <div className="bg-red-500" style={{ width: `${(bearish / total) * 100}%` }} />
                  </div>
                  <div className="flex justify-between text-xs text-neutral mt-2">
                    <span className="text-emerald-400">{bullish} bullish</span>
                    <span className="text-red-400">{bearish} bearish</span>
                  </div>
                </div>
              )
            }) : (
              <div className="text-sm text-neutral border border-border rounded p-3 bg-bg/40">Ticker mentions appear after articles include ticker symbols.</div>
            )}
          </div>

          <SectionTitle
            title="Sentiment Audit"
            meta={auditSummary
              ? `${compact(auditSummary.actionable)} actionable · ${compact(auditSummary.ticker_matched)}/${compact(auditSummary.total)} tickered`
              : `${auditRows.length} sample rows`}
          />
          <div className="p-3 space-y-2 flex-none">
            {auditRows.length ? auditRows.map(row => (
              <div key={row.id || `${row.ticker}-${row.title}`} className="bg-bg/60 border border-border rounded p-2">
                <div className="flex items-center gap-2 mb-1">
                  {row.ticker && <TickerChip ticker={row.ticker.split(',')[0]} compact />}
                  <span className={clsx('font-mono text-xs ml-auto', sentimentTone(row.sentiment_score ?? row.sentiment))}>
                    {sentimentLabel(row.sentiment_score ?? row.sentiment)}
                  </span>
                </div>
                <div className="text-xs text-slate-200 line-clamp-2">{row.title || 'Untitled headline'}</div>
                <div className="text-[10px] text-neutral mt-1 truncate">
                  {(row.event_type || 'general_news').replaceAll('_', ' ')} · {row.reason || row.source || 'No event phrase matched'}
                </div>
              </div>
            )) : (
              <div className="text-sm text-neutral border border-border rounded p-3 bg-bg/40">Audit rows appear after recent ticker-matched articles are scored.</div>
            )}
          </div>

          <SectionTitle title="Data Health" meta="live" />
          <div className="p-3 grid grid-cols-2 gap-2 text-xs flex-none">
            <Health label="Sources" value={compact(stats?.sources?.length ?? 0)} />
            <Health label="Categories" value={compact(stats?.categories?.length ?? 0)} />
            <Health label="Database" value={status?.database?.connected === false ? 'Offline' : 'Online'} />
          </div>
        </section>
      </div>
    </div>
  )
}

function OverviewArticleRow({ article, targetLanguage }: { article: Article; targetLanguage: string }) {
  const { translated, source } = useTranslatedText(article.title, targetLanguage)

  return (
    <a href={article.url || '#'} target="_blank" rel="noreferrer" className="block px-3 py-2 hover:bg-bg/40">
      <div className="flex items-center gap-2 text-[11px] mb-1">
        <span className="font-mono text-neutral w-10">{timeAgo(article.publish_date)}</span>
        <span className="uppercase bg-bg border border-border rounded px-1.5 py-0.5 text-neutral max-w-[110px] truncate">{article.source}</span>
        {article.ticker && <TickerChip ticker={article.ticker} compact />}
        {article.sentiment && <span className={clsx('ml-auto', sentimentTone(article.sentiment))}>{sentimentLabel(article.sentiment)}</span>}
      </div>
      <div className="text-sm text-slate-200 line-clamp-2">{article.title}</div>
      {translated && translated !== article.title && (
        <div className="text-[11px] text-sky-300 line-clamp-2 mt-1">
          {getLanguageLabel(targetLanguage)}: {translated}
          {source === 'glossary' && <span className="text-neutral"> · glossary</span>}
        </div>
      )}
    </a>
  )
}

function Metric({ label, value, tone = 'text-white' }: { label: string; value: string; tone?: string }) {
  return (
    <div className="bg-surface border border-border rounded-lg px-3 py-3 min-w-0">
      <div className={clsx('text-2xl font-semibold font-mono truncate', tone)}>{value}</div>
      <div className="text-[10px] text-neutral uppercase tracking-wide mt-1">{label}</div>
    </div>
  )
}

function TickerChip({ ticker, compact = false }: { ticker: string; compact?: boolean }) {
  return (
    <span className={clsx(
      'inline-flex items-center rounded border border-sky-500/30 bg-sky-500/10 font-mono font-semibold text-sky-300',
      compact ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-0.5 text-xs'
    )}>
      {ticker}
    </span>
  )
}

function SectionTitle({ title, meta }: { title: string; meta?: string }) {
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2 border-b border-border bg-bg/30">
      <h2 className="text-sm font-semibold text-white">{title}</h2>
      {meta && <span className="text-[11px] text-neutral">{meta}</span>}
    </div>
  )
}

function Health({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-bg/60 border border-border rounded p-2 min-w-0">
      <div className="font-mono text-slate-200 truncate">{value}</div>
      <div className="text-[10px] text-neutral uppercase mt-1">{label}</div>
    </div>
  )
}
