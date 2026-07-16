'use client'
import useSWR from 'swr'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { clsx } from 'clsx'
import { CandlestickChart } from './CandlestickChart'
import { DecisionMapPanel } from './DecisionMapPanel'
import type { ScreenerRow } from '@/lib/types'

const fetcher = (url: string) => fetch(url, { cache: 'no-store' }).then(r => r.json())
const INITIAL_VISIBLE_COUNT = 25
const VISIBLE_BATCH_COUNT = 25
const DEFAULT_SIGNAL = 'top_gainers'
const MIRROR_DATA_VERSION = 'chart_quote_consistency_v2'

const LATEST_NEWS = [
  { value: '0', label: 'Any' },
  { value: '1', label: 'Today' },
  { value: '3', label: '3 Days' },
  { value: '7', label: 'This Week' },
  { value: '30', label: 'This Month' },
]

const SIGNALS = [
  { value: 'top_gainers', label: 'Top Gainers' },
  { value: 'top_losers', label: 'Top Losers' },
  { value: 'most_active', label: 'Most Active' },
  { value: 'unusual_volume', label: 'Unusual Volume' },
  { value: 'most_volatile', label: 'Most Volatile' },
]

function num(value: unknown): number | null {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function compact(value: unknown): string {
  const n = num(value)
  if (n == null || n === 0) return '--'
  const a = Math.abs(n)
  if (a >= 1e12) return `${(n / 1e12).toFixed(2)}T`
  if (a >= 1e9) return `${(n / 1e9).toFixed(2)}B`
  if (a >= 1e6) return `${(n / 1e6).toFixed(2)}M`
  if (a >= 1e3) return `${(n / 1e3).toFixed(1)}K`
  return n.toLocaleString()
}

function pct(value: unknown, signed = true): string {
  const n = num(value)
  if (n == null) return '--'
  return `${signed && n > 0 ? '+' : ''}${n.toFixed(2)}%`
}

function money(value: unknown): string {
  const n = num(value)
  if (n == null || n <= 0) return '--'
  return `$${n.toFixed(n < 10 ? 3 : 2)}`
}

function fixed(value: unknown, digits = 2): string {
  const n = num(value)
  return n == null ? '--' : n.toFixed(digits)
}

function whenLabel(value?: number | string | null): string {
  if (value == null || value === '') return ''
  const raw = typeof value === 'string' && Number.isNaN(Number(value)) ? Date.parse(value) / 1000 : Number(value)
  if (!Number.isFinite(raw) || raw <= 0) return ''
  const sec = raw > 1_000_000_000_000 ? Math.floor(raw / 1000) : raw
  return new Date(sec * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function ageLabel(value?: number | string | null): string {
  if (value == null || value === '') return '--'
  const raw = typeof value === 'string' && Number.isNaN(Number(value)) ? Date.parse(value) / 1000 : Number(value)
  if (!Number.isFinite(raw) || raw <= 0) return '--'
  const sec = raw > 1_000_000_000_000 ? Math.floor(raw / 1000) : raw
  const age = Math.max(0, Math.floor(Date.now() / 1000) - sec)
  if (age < 60) return 'now'
  if (age < 3600) return `${Math.floor(age / 60)}m`
  if (age < 86_400) return `${Math.floor(age / 3600)}h`
  return `${Math.floor(age / 86_400)}d`
}

function secondsFromTimestamp(value?: number | string | null): number | null {
  if (value == null || value === '') return null
  const raw = typeof value === 'string' && Number.isNaN(Number(value)) ? Date.parse(value) / 1000 : Number(value)
  if (!Number.isFinite(raw) || raw <= 0) return null
  const sec = raw > 1_000_000_000_000 ? Math.floor(raw / 1000) : Math.floor(raw)
  return sec > 0 ? sec : null
}

function companySignalTokens(company?: string | null): string[] {
  return String(company || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter(token => token.length >= 4)
    .filter(token => ![
      'inc', 'corp', 'corporation', 'company', 'limited', 'ltd', 'holdings', 'holding',
      'group', 'plc', 'class', 'common', 'stock', 'american', 'technologies', 'technology',
      'therapeutics', 'pharmaceuticals', 'biopharma', 'systems', 'international',
      'ordinary', 'shares', 'share', 'depositary', 'adr',
    ].includes(token))
    .slice(0, 5)
}

function articleMatchesTickerOrCompany(row: ScreenerRow, article: any): boolean {
  const text = [
    article?.title,
    article?.headline,
    article?.summary,
    article?.bodyText,
    article?.content,
    article?.company,
    article?.url,
  ].filter(Boolean).join(' ').toLowerCase()
  if (!text.trim()) return false
  const ticker = String(row.ticker || '').toLowerCase()
  const companyMatched = companySignalTokens(row.company).some(token => text.includes(token))
  if (companyMatched) return true
  if (!ticker) return false

  // Prefer explicit article text/cashtags over backend ticker fields alone.
  // Some symbols collide across exchanges, so a stored ticker match without
  // visible ticker/company evidence can attach the wrong company's news.
  if (new RegExp(`\\$${ticker}\\b`, 'i').test(text)) return true
  return new RegExp(`(^|[^a-z0-9])${ticker}([^a-z0-9]|$)`, 'i').test(text)
}

function chartQuoteFromCandles(candles: any[]) {
  if (!Array.isArray(candles) || candles.length < 2) return null
  const last = candles[candles.length - 1]
  const previous = candles[candles.length - 2]
  const price = num(last?.close)
  const previousClose = num(previous?.close)
  if (price == null || previousClose == null || previousClose <= 0) return null
  const changePct = ((price - previousClose) / previousClose) * 100
  return {
    price,
    previousClose,
    changePct,
    volume: num(last?.volume),
    timestamp: secondsFromTimestamp(last?.time),
  }
}

function uniqueRows(rows: ScreenerRow[]): ScreenerRow[] {
  const seen = new Set<string>()
  const out: ScreenerRow[] = []
  for (const row of rows) {
    const ticker = String(row?.ticker || '').toUpperCase()
    if (!ticker || seen.has(ticker)) continue
    seen.add(ticker)
    out.push({ ...row, ticker })
  }
  return out
}

function rowList(payload: any): ScreenerRow[] {
  const rows = payload?.tickers ?? payload?.rows ?? payload?.data ?? (Array.isArray(payload) ? payload : [])
  return uniqueRows(Array.isArray(rows) ? rows : [])
}

export function ChartsGridPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [signal, setSignal] = useState(searchParams.get('signal') || DEFAULT_SIGNAL)
  const [recentDays, setRecentDays] = useState(searchParams.get('recent_days') || '0')
  const [keyword, setKeyword] = useState(searchParams.get('keyword') || '')
  const [search, setSearch] = useState(searchParams.get('search') || '')
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_COUNT)
  const [refreshNonce, setRefreshNonce] = useState(() => Date.now())
  const loadMoreRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const next = new URLSearchParams(searchParams)
    signal === DEFAULT_SIGNAL ? next.delete('signal') : next.set('signal', signal)
    recentDays === '0' ? next.delete('recent_days') : next.set('recent_days', recentDays)
    keyword.trim() ? next.set('keyword', keyword.trim()) : next.delete('keyword')
    search.trim() ? next.set('search', search.trim().toUpperCase()) : next.delete('search')
    setSearchParams(next, { replace: true })
    setVisibleCount(INITIAL_VISIBLE_COUNT)
    // Keep the URL shareable without making searchParams a dependency loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signal, recentDays, keyword, search, setSearchParams])

  const screenerUrl = useMemo(() => {
    const params = new URLSearchParams({
      mirror: '1',
      compact: '1',
      limit: '5000',
      signal,
      orderBy: 'change_pct',
      orderDir: signal === 'top_losers' ? 'asc' : 'desc',
      _v: MIRROR_DATA_VERSION,
      _r: String(refreshNonce),
    })
    if (search.trim()) params.set('search', search.trim().toUpperCase())
    return `/api/screener?${params.toString()}`
  }, [signal, search, refreshNonce])

  const { data, error, isLoading, mutate } = useSWR(screenerUrl, fetcher, { revalidateOnFocus: false })
  const rows = useMemo(() => rowList(data), [data])
  const keywordClean = keyword.trim().toLowerCase()
  const visibleRows = rows.slice(0, Math.min(visibleCount, rows.length))
  const hasMoreRows = visibleRows.length < rows.length
  const lastUpdated = new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })

  const refresh = () => {
    setRefreshNonce(n => n + 1)
    mutate()
  }

  const showMoreRows = () => {
    setVisibleCount(count => Math.min(rows.length, count + VISIBLE_BATCH_COUNT))
  }

  useEffect(() => {
    const el = loadMoreRef.current
    if (!el || !hasMoreRows) return
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) showMoreRows()
    }, { rootMargin: '900px' })
    observer.observe(el)
    return () => observer.disconnect()
  }, [hasMoreRows, rows.length, visibleRows.length])

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-white">Mirror</h1>
          <p className="mt-0.5 text-xs text-neutral">Finviz-style stock mirror: one ticker card at a time, chart first, latest source news underneath.</p>
        </div>
        <div className="flex items-center gap-2 text-xs text-neutral">
          <span>{visibleRows.length.toLocaleString()} shown of {rows.length.toLocaleString()} stocks</span>
          <span>updated {lastUpdated}</span>
          <span className={clsx('rounded border px-2 py-1', error ? 'border-red-500/40 text-red-300' : isLoading ? 'border-amber-500/40 text-amber-300' : 'border-emerald-500/40 text-emerald-300')}>
            {error ? 'partial' : isLoading ? 'loading' : 'live'}
          </span>
        </div>
      </div>

      <section className="rounded-lg border border-border bg-[#111317] px-3 py-2">
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-neutral">
            Signal
            <select value={signal} onChange={event => setSignal(event.target.value)} className="rounded border border-border bg-bg px-2 py-1.5 text-sm text-white focus:border-accent focus:outline-none">
              {SIGNALS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-xs text-neutral">
            Latest News
            <select value={recentDays} onChange={event => setRecentDays(event.target.value)} className="rounded border border-border bg-bg px-2 py-1.5 text-sm text-white focus:border-accent focus:outline-none">
              {LATEST_NEWS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-xs text-neutral">
            News Keywords
            <input value={keyword} onChange={event => setKeyword(event.target.value)} placeholder="headline filter" className="w-[180px] rounded border border-border bg-bg px-2 py-1.5 text-sm text-white placeholder:text-slate-600 focus:border-accent focus:outline-none" />
          </label>
          <label className="flex items-center gap-1.5 text-xs text-neutral">
            Stock
            <input value={search} onChange={event => setSearch(event.target.value.toUpperCase())} placeholder="ticker" className="w-[120px] rounded border border-border bg-bg px-2 py-1.5 font-mono text-sm text-white placeholder:text-slate-600 focus:border-accent focus:outline-none" />
          </label>
          <button onClick={refresh} className="rounded border border-border px-3 py-1.5 text-xs text-neutral hover:border-accent hover:text-white">
            Refresh
          </button>
          <span className="ml-auto text-xs text-neutral">Scroll loads more stocks</span>
        </div>
      </section>

      {error && <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">Mirror data could not refresh.</div>}

      {visibleRows.length ? (
        <div className="space-y-4">
          {visibleRows.map(row => (
            <MirrorCard key={row.ticker} row={row} signal={signal} recentDays={recentDays} keyword={keywordClean} refreshNonce={refreshNonce} />
          ))}
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-surface py-16 text-center text-sm text-neutral">
          {isLoading ? 'Loading stocks...' : 'No stocks match the current Mirror filters.'}
        </div>
      )}

      {visibleRows.length > 0 && (
        <div className="flex items-center justify-center gap-3 py-2 text-xs">
          <div ref={loadMoreRef} className="h-8 w-px" />
          {hasMoreRows ? (
            <button onClick={showMoreRows} className="rounded border border-border px-3 py-1.5 text-neutral hover:border-accent hover:text-white">
              Load more stocks
            </button>
          ) : (
            <span className="text-neutral">End of current screener universe</span>
          )}
        </div>
      )}
    </div>
  )
}

function MirrorCard({ row, signal, recentDays, keyword, refreshNonce }: {
  row: ScreenerRow
  signal: string
  recentDays: string
  keyword: string
  refreshNonce: number
}) {
  const ticker = String(row.ticker || '').toUpperCase()
  const cardRef = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)
  const [show3d, setShow3d] = useState(false)

  useEffect(() => {
    const el = cardRef.current
    if (!el || visible) return
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        setVisible(true)
        observer.disconnect()
      }
    }, { rootMargin: '360px' })
    observer.observe(el)
    return () => observer.disconnect()
  }, [visible])

  const chartUrl = ticker && visible ? `/api/charts/${encodeURIComponent(ticker)}?tf=1d&_r=${refreshNonce}` : null
  const quoteUrl = ticker ? `/api/market-quote/${encodeURIComponent(ticker)}?_r=${refreshNonce}` : null
  const articleDays = recentDays && recentDays !== '0' ? recentDays : '30'
  const articleUrl = ticker && visible ? `/api/articles?ticker=${encodeURIComponent(ticker)}&limit=12&recent_days=${articleDays}&facets=0&_r=${refreshNonce}` : null
  const { data: chart, error: chartError, isLoading: chartLoading } = useSWR(chartUrl, fetcher, { revalidateOnFocus: false })
  const { data: quoteData } = useSWR(quoteUrl, fetcher, { revalidateOnFocus: false, dedupingInterval: 0 })
  const { data: articleData } = useSWR(articleUrl, fetcher, { revalidateOnFocus: false })

  const candles = Array.isArray(chart?.candles) ? chart.candles : []
  const chartQuote = useMemo(() => {
    if (quoteData?.ok && quoteData.price != null) {
      return {
        price: num(quoteData.price),
        previousClose: num(quoteData.previousClose),
        changePct: num(quoteData.change_pct),
        volume: num(quoteData.volume),
        timestamp: secondsFromTimestamp(quoteData.quote_time),
      }
    }
    return chartQuoteFromCandles(candles)
  }, [candles, quoteData])
  const screenerQuoteSec = secondsFromTimestamp(row.quote_updated_at)
  const screenerAgeSeconds = screenerQuoteSec ? Math.max(0, Math.floor(Date.now() / 1000) - screenerQuoteSec) : null
  const staleScreener = screenerAgeSeconds == null || screenerAgeSeconds > 45 * 60
  const displayPrice = chartQuote?.price ?? (staleScreener ? null : num(row.price))
  const displayChange = chartQuote?.changePct ?? (staleScreener ? null : num(row.change_pct))
  const displayVolume = chartQuote?.volume ?? (staleScreener ? null : num(row.volume))
  const chartMoveDisagrees = chartQuote && row.change_pct != null && (
    Math.sign(Number(chartQuote.changePct || 0)) !== Math.sign(Number(row.change_pct || 0)) ||
    Math.abs(Number(chartQuote.changePct || 0) - Number(row.change_pct || 0)) >= 5
  )
  const quoteSourceLabel = chartQuote
    ? `Chart close${chartQuote.timestamp ? ` ${whenLabel(chartQuote.timestamp)}` : ''}`
    : staleScreener ? 'Loading chart quote' : row.quote_source || 'Screener row'
  const rawArticles = useMemo(() => {
    const source = Array.isArray(articleData?.articles) ? articleData.articles : []
    const tickerSpecific = source.filter((article: any) => articleMatchesTickerOrCompany(row, article))
    if (!keyword) return tickerSpecific
    return tickerSpecific.filter((article: any) => String(article.title || article.headline || '').toLowerCase().includes(keyword))
  }, [articleData, keyword, row])
  const rawArticleCount = Array.isArray(articleData?.articles) ? articleData.articles.length : 0
  const rejectedAmbiguousArticles = Math.max(0, rawArticleCount - rawArticles.length)
  const articles = rawArticles

  const change = displayChange
  const up = Number(change || 0) >= 0
  const latestSignalMismatch =
    chartQuote && signal === 'top_gainers' && Number(displayChange || 0) <= 0 ? true :
    chartQuote && signal === 'top_losers' && Number(displayChange || 0) >= 0 ? true :
    false
  const fields: Array<[string, string]> = [
    ['Current Price', money(displayPrice)],
    ['Current Move', pct(displayChange)],
    ['Current Volume', compact(displayVolume)],
    ['Quote Source', quoteSourceLabel],
    ['Screener Age', ageLabel(row.quote_updated_at)],
    ['Market Cap', compact(row.market_cap)],
    ['P/E', fixed((row as any).pe_ratio)],
    ['Forward P/E', fixed((row as any).forward_pe)],
    ['PEG', fixed((row as any).peg)],
    ['P/S', fixed((row as any).ps_ratio)],
    ['P/B', fixed((row as any).pb_ratio)],
    ['Dividend', pct((row as any).dividend_yield, false)],
    ['EPS next Y', pct((row as any).eps_growth_next_y)],
    ['EPS this Y', pct((row as any).eps_growth_this_y)],
    ['Sales Q/Q', pct((row as any).sales_growth)],
    ['Insider Own', pct((row as any).insider_own, false)],
    ['Inst Own', pct((row as any).inst_own, false)],
    ['Short Float', pct((row as any).float_short, false)],
    ['ROE', pct((row as any).roe)],
    ['Beta', fixed((row as any).beta)],
    ['Avg Volume', compact(row.avg_volume)],
    ['Rel Volume', row.rel_volume != null ? `${Number(row.rel_volume).toFixed(2)}x` : '--'],
    ['RSI', row.rsi != null ? Number(row.rsi).toFixed(1) : '--'],
    ['Target Price', money((row as any).target_price)],
  ]

  if (latestSignalMismatch) return null

  return (
    <article ref={cardRef} className="overflow-hidden rounded-lg border border-border bg-surface">
      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1.55fr)_minmax(320px,0.85fr)]">
        <div className="border-b border-border xl:border-b-0 xl:border-r">
          <div className="border-b border-border bg-[#1d2635] px-4 py-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-baseline gap-2">
                  <Link to={`/charts?t=${encodeURIComponent(ticker)}`} className="font-mono text-2xl font-bold text-accent hover:text-sky-300">{ticker}</Link>
                  <span className={clsx('font-mono text-sm font-semibold', change == null ? 'text-amber-200' : up ? 'text-emerald-400' : 'text-red-400')}>{change == null ? 'chart quote pending' : pct(change)}</span>
                  <span className="text-sm font-medium text-slate-200">{row.company || ticker}</span>
                </div>
                <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-neutral">
                  <span className="font-mono text-slate-200">{money(displayPrice)}</span>
                  <span>Vol {compact(displayVolume)}</span>
                  <span>{row.exchange || '--'}</span>
                  <span>{row.country || 'USA'}</span>
                  <span>{row.sector || 'Sector unavailable'}</span>
                  {staleScreener && <span className="text-amber-200">{chartQuote ? 'chart quote used' : 'waiting for chart quote'} · screener {ageLabel(row.quote_updated_at)}</span>}
                </div>
                {chartMoveDisagrees && (
                  <div className="mt-2 rounded border border-amber-400/30 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-100">
                    Stale screener move {pct(row.change_pct)} replaced with chart move {pct(displayChange)} for this card.
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => setShow3d(open => !open)} className="rounded border border-sky-500/40 bg-sky-500/10 px-3 py-1.5 text-xs font-medium text-sky-100 hover:border-sky-300">
                  {show3d ? 'Hide 3D' : 'Show 3D'}
                </button>
                <Link to={`/charts?t=${encodeURIComponent(ticker)}`} className="rounded border border-border px-3 py-1.5 text-xs text-neutral hover:border-accent hover:text-white">
                  Chart
                </Link>
              </div>
            </div>
          </div>

          <div className="relative bg-bg" style={{ height: 340 }}>
            {!visible || chartLoading ? (
              <div className="flex h-full items-center justify-center text-xs text-neutral animate-pulse">Loading chart...</div>
            ) : chartError || chart?.error ? (
              <div className="flex h-full items-center justify-center text-xs text-red-300">Chart unavailable</div>
            ) : candles.length ? (
              <CandlestickChart
                candles={candles as any}
                bollinger={chart?.bollinger as any}
                chartStyle="candles"
                showBollinger
                showMarkers={false}
                minHeight={0}
              />
            ) : (
              <div className="flex h-full items-center justify-center text-xs text-neutral">No candle data</div>
            )}
          </div>
        </div>

        <div className="p-4">
          <div className="text-sm font-semibold text-white">{row.company || ticker}</div>
          <div className="mt-1 text-[11px] text-neutral">{[row.sector, row.industry].filter(Boolean).join(' - ') || 'Fundamentals from current screener row'}</div>
          <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
            {fields.map(([label, value]) => (
              <div key={label} className="flex justify-between gap-2 border-b border-border/35 py-1">
                <span className="text-neutral">{label}</span>
                <span className="truncate font-mono text-slate-200">{value}</span>
              </div>
            ))}
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2 text-center text-[11px]">
            <MetricBadge label="News" value={compact(articles.length)} />
            <MetricBadge label="Messages" value={compact(row.message_count)} />
            <MetricBadge label="Sentiment" value={row.avg_sentiment != null ? Number(row.avg_sentiment).toFixed(2) : '--'} />
          </div>
        </div>
      </div>

      <section className="border-t border-border bg-[#1b2432]">
        <div className="flex items-center justify-between border-b border-border px-4 py-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-200">Latest News Sources</h2>
          <span className="text-[11px] text-neutral">{articles.length ? `${articles.length} ticker-specific` : 'No ticker-specific article rows'}</span>
        </div>
        <div className="divide-y divide-border">
          {articles.length ? articles.map((article: any, index: number) => (
            <a
              key={article.id || article.article_id || article.url || `${ticker}-${index}`}
              href={article.url || '#'}
              target="_blank"
              rel="noreferrer"
              className="grid gap-2 px-4 py-2 text-xs hover:bg-sky-500/5 md:grid-cols-[118px_180px_1fr_96px]"
            >
              <span className="font-mono text-neutral">{whenLabel(article.publish_date || article.detected_at || article.fetched_date) || '--'}</span>
              <span className="truncate text-sky-200">{article.source || 'Unknown source'}</span>
              <span className="min-w-0 truncate text-slate-100">{article.title || article.headline || 'Untitled article'}</span>
              <span className="text-right capitalize text-neutral">{article.sentiment || article.article_kind || '--'}</span>
            </a>
          )) : (
            <div className="px-4 py-6 text-center text-xs text-neutral">
              No ticker-specific news found for {ticker} in the selected news window.
              {rejectedAmbiguousArticles > 0 && (
                <span className="ml-1 text-amber-200">{rejectedAmbiguousArticles} ambiguous source row{rejectedAmbiguousArticles === 1 ? '' : 's'} rejected.</span>
              )}
            </div>
          )}
        </div>
      </section>

      <section className="border-t border-border bg-bg/30">
        <div className="flex items-center justify-between px-4 py-2">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-200">3D Decision Journey</div>
            <div className="text-[11px] text-neutral">Single-ticker Decision Map path for {ticker}; loaded on demand so the Mirror stays fast.</div>
          </div>
          <button onClick={() => setShow3d(open => !open)} className="rounded border border-border px-3 py-1 text-xs text-neutral hover:border-accent hover:text-white">
            {show3d ? 'Collapse' : 'Load 3D'}
          </button>
        </div>
        {show3d && (
          <div className="border-t border-border p-3">
            <DecisionMapPanel key={`mirror-decision-map-${ticker}`} focusTicker={ticker} single embedded />
          </div>
        )}
      </section>
    </article>
  )
}

function MetricBadge({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-border bg-bg/60 px-2 py-2">
      <div className="text-[10px] uppercase text-neutral">{label}</div>
      <div className="mt-1 font-mono text-slate-100">{value}</div>
    </div>
  )
}
