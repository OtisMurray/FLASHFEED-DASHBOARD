'use client'
import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import { clsx } from 'clsx'
import { CandlestickChart, type StrategyMarker } from './CandlestickChart'
import { RSIChart } from './RSIChart'
import { MACDChart } from './MACDChart'
import { ResearchChart, type ResearchMode } from './ResearchChart'
import { ChartsGridPage } from './ChartsGridPage'
import { TickerEnrichPanels, type EnrichData } from './TickerEnrichPanels'
import { overlaySeries, type SocialSeries } from '@/lib/chartAgg'

// Full multi-timeframe selector. Each timeframe is fetched from the backend
// (/api/charts/:ticker?tf=) which returns candles + Bollinger + RSI + MACD already
// computed for that timeframe — the server picks the right history and resamples
// the odd buckets (3m/10m/2h/5h/12h/2d). Crosshair/hover is built into the charts.
const TIMEFRAMES: Array<{ key: string; label: string; min: number }> = [
  { key: '1m', label: '1m', min: 1 },
  { key: '3m', label: '3m', min: 3 },
  { key: '5m', label: '5m', min: 5 },
  { key: '10m', label: '10m', min: 10 },
  { key: '15m', label: '15m', min: 15 },
  { key: '30m', label: '30m', min: 30 },
  { key: '1h', label: '1h', min: 60 },
  { key: '2h', label: '2h', min: 120 },
  { key: '5h', label: '5h', min: 300 },
  { key: '12h', label: '12h', min: 720 },
  { key: '1d', label: '1D', min: 1440 },
  { key: '2d', label: '2D', min: 2880 },
  { key: '1w', label: '1W', min: 10080 },
]
// Density/sentiment overlays are per-minute single-session social, so they only
// make sense on the single-day intraday timeframes.
const OVERLAY_TFS = new Set(TIMEFRAMES.filter(t => t.min <= 60).map(t => t.key))
const tfMinutes = (k: string) => TIMEFRAMES.find(t => t.key === k)?.min ?? 5
const eventWindowMinutesForTf = (k: string) => {
  const min = tfMinutes(k)
  if (min <= 1) return 1440
  if (min <= 5) return 5 * 1440
  return 10080
}

interface ChartData {
  date?: string
  n?: number
  tf?: string
  error?: string
  candles: Array<{ time: number; open: number; high: number; low: number; close: number; volume?: number }>
  bollinger?: { upper: Array<{ time: number; value: number }>; lower: Array<{ time: number; value: number }> }
  rsi?: Array<{ time: number; value: number }>
  macd?: { macd: Array<{ time: number; value: number }>; signal: Array<{ time: number; value: number }>; histogram: Array<{ time: number; value: number }> }
  predicted?: Array<{ time: number; value: number }>
  news_events?: Array<{ time: number; position?: string; color?: string; shape?: string; text?: string; title?: string; source?: string; event_type?: string }>
  structured_news_events?: Array<{ time: number; title?: string; source?: string; text?: string }>
  prediction_events?: Array<{ time: number; title?: string; text?: string; entry_price?: number; label_5m?: { return_pct?: number; direction_correct?: boolean } | null }>
  strategy_markers?: StrategyMarker[]
  strategy_signal_stats?: { trades?: number; setups?: number; corr_defined?: number; messages?: number; threshold?: number; stop_pct?: number; proxy_based?: boolean; note?: string } | null
  watcher_series?: WatcherSeries | null
  source_status?: {
    price?: string
    price_source?: string
    price_detail?: string
    social?: string
    news?: string
    predictions?: string
    watchers?: string
    markers?: string
    quote_disagrees_with_candles?: boolean
  }
}

interface WatcherSeries {
  status?: string
  source?: string
  current_count?: number | null
  snapshot_count?: number
  times?: number[]
  watchers?: number[]
  note?: string
}

// Candlestick + indicators (multi-timeframe) OR the research views (intraday).
type View = 'candles' | ResearchMode
const VIEWS: Array<{ key: View; label: string }> = [
  { key: 'candles', label: 'Candlestick + Indicators' },
  { key: 'pd',      label: 'Price + Density' },
  { key: 'sent',    label: 'Sentiment Score' },
  { key: 'ds',      label: 'Density vs Sentiment' },
]

// Research views are 1-min intraday only, so they keep the intraday window control.
type Win = 'full' | '2h' | '1h'
const WINDOWS: Array<{ key: Win; label: string }> = [
  { key: 'full', label: 'Full Day' },
  { key: '2h',   label: 'Last 2h' },
  { key: '1h',   label: 'Last 1h' },
]

const OVERLAY_ROLLING_WINDOWS = [
  { value: 5, label: '5m' },
  { value: 15, label: '15m' },
  { value: 30, label: '30m' },
  { value: 60, label: '1h' },
  { value: 120, label: '2h' },
  { value: 180, label: '3h' },
  { value: 240, label: '4h' },
  { value: 360, label: '6h' },
]

export function ChartsPage() {
  const [sp, setSp] = useSearchParams()
  const urlTicker = (sp.get('t') || '').toUpperCase().trim()
  const chartTab = sp.get('chartTab') === 'grid' ? 'grid' : 'single'
  const [input, setInput] = useState(urlTicker)
  const [ticker, setTicker] = useState<string | null>(urlTicker || null)
  const [view, setView] = useState<View>('candles')
  const [tf, setTf] = useState('5m')
  const [win, setWin] = useState<Win>('full')
  const [data, setData] = useState<ChartData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [enrich, setEnrich] = useState<EnrichData | null>(null)

  const [showDensity, setShowDensity] = useState(false)
  const [showSentiment, setShowSentiment] = useState(false)
  const [showWatchers, setShowWatchers] = useState(false)
  const [showStrategy, setShowStrategy] = useState(true)
  const [overlayRollingMinutes, setOverlayRollingMinutes] = useState(15)
  const [social, setSocial] = useState<SocialSeries | null>(null)
  const [socialMsg, setSocialMsg] = useState('')
  const [watchers, setWatchers] = useState<WatcherSeries | null>(null)
  const [watcherMsg, setWatcherMsg] = useState('')
  const socialCache = useRef<Record<string, SocialSeries>>({})
  const watcherCache = useRef<Record<string, WatcherSeries>>({})
  const loadedTopAiTickerRef = useRef(false)
  const overlayOk = OVERLAY_TFS.has(tf)

  const setChartTab = useCallback((next: 'single' | 'grid') => {
    const nextParams = new URLSearchParams(sp)
    if (next === 'grid') nextParams.set('chartTab', 'grid')
    else nextParams.delete('chartTab')
    setSp(nextParams, { replace: true })
  }, [sp, setSp])

  const load = useCallback(() => {
    const t = input.trim().toUpperCase()
    if (t) { setTicker(t); setSp({ t }, { replace: true }) }
  }, [input, setSp])

  useEffect(() => {
    const t = (sp.get('t') || '').toUpperCase().trim()
    if (t && t !== ticker) { setInput(t); setTicker(t) }
  }, [sp])  // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (ticker || urlTicker || loadedTopAiTickerRef.current) return
    loadedTopAiTickerRef.current = true
    let cancelled = false
    fetch('/api/ai/rankings?days=3&limit=1&window_minutes=1440&min_score=0')
      .then(r => r.json())
      .then(json => {
        if (cancelled) return
        const topTicker = String(json?.rows?.[0]?.ticker || '').toUpperCase().trim()
        if (!topTicker) return
        setInput(topTicker)
        setTicker(topTicker)
        const nextParams = new URLSearchParams(sp)
        nextParams.set('t', topTicker)
        setSp(nextParams, { replace: true })
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [ticker, urlTicker, sp, setSp])

  // Per-ticker enrichments (news alert + 3-day news + social/gossip). DB reads.
  useEffect(() => {
    if (!ticker || chartTab !== 'single') { setEnrich(null); return }
    let cancelled = false
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), 15000)
    setEnrich(null)
    fetch(`/api/ticker/${ticker}/enrich`, { signal: controller.signal })
      .then(async r => {
        if (!r.ok) throw new Error(`enrich ${r.status}`)
        return r.json()
      })
      .then(d => { if (!cancelled) setEnrich(d?.ticker ? d : emptyEnrich(ticker)) })
      .catch(() => { if (!cancelled) setEnrich(emptyEnrich(ticker, 'News/social enrichment endpoint unavailable.')) })
      .finally(() => window.clearTimeout(timeout))
    return () => { cancelled = true; controller.abort(); window.clearTimeout(timeout) }
  }, [ticker, chartTab])

  // Candlestick view fetches OHLC + indicators for the chosen timeframe from the
  // backend (the server resamples + computes Bollinger/RSI/MACD per timeframe).
  useEffect(() => {
    if (!ticker || chartTab !== 'single' || view !== 'candles') return
    let cancelled = false
    setLoading(true); setError(null)
    fetch(`/api/charts/${ticker}?tf=${tf}&events=1&window_minutes=${eventWindowMinutesForTf(tf)}&bucket_minutes=1`)
      .then(r => r.json())
      .then((json: ChartData) => {
        if (cancelled) return
        if (json.error) { setError(json.error); setData(null) }
        else setData(json)
      })
      .catch(() => { if (!cancelled) setError('Failed to load chart data.') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [ticker, view, tf, chartTab])

  // Social overlay (density/sentiment) — only on single-day intraday timeframes.
  const wantOverlay = view === 'candles' && overlayOk && (showDensity || showSentiment)
  const wantWatcherOverlay = view === 'candles' && overlayOk && showWatchers
  const chartDate = data?.date
  const candleStart = Number(data?.candles?.[0]?.time || 0)
  const candleEnd = Number(data?.candles?.[data?.candles?.length ? data.candles.length - 1 : 0]?.time || 0)
  const overlayWindowMinutes = useMemo(() => {
    const candles = data?.candles || []
    if (candles.length < 2) return 1440
    const first = Number(candles[0]?.time || 0)
    const last = Number(candles[candles.length - 1]?.time || 0)
    const span = Math.ceil(Math.max(0, last - first) / 60) + 120
    return Math.max(1440, Math.min(10080, span))
  }, [data])
  useEffect(() => {
    if (!wantOverlay || !ticker || !chartDate) { return }
    const key = `${ticker}|${chartDate}|${candleStart}|${candleEnd}|${overlayWindowMinutes}`
    if (socialCache.current[key]) { setSocial(socialCache.current[key]); setSocialMsg(''); return }
    let cancelled = false
    let timer: number | null = null
    setSocial(null); setSocialMsg('Loading social data…')
    const poll = async () => {
      try {
        const qs = new URLSearchParams({
          ticker,
          date: chartDate,
          window_minutes: String(overlayWindowMinutes),
          bucket_minutes: '1',
        })
        if (candleStart && candleEnd) {
          qs.set('start_sec', String(candleStart))
          qs.set('end_sec', String(candleEnd))
        }
        const s = await fetch(`/api/chart/social?${qs}`).then(r => r.json())
        if (cancelled) return
        if (s.error) { setSocialMsg('Social: ' + s.error); return }
        if (s.status === 'walking') { setSocialMsg(`Loading social history, ${s.count || 0} messages…`); timer = window.setTimeout(poll, 1500); return }
        let payload = s
        let fallbackWindow = ''
        if (!s.messages) {
          for (const minutes of [4320, 10080]) {
            const fallbackQs = new URLSearchParams({
              ticker,
              date: chartDate,
              window_minutes: String(minutes),
              bucket_minutes: '1',
            })
            const fallback = await fetch(`/api/chart/social?${fallbackQs}`).then(r => r.json())
            if (cancelled) return
            if (fallback?.messages) {
              payload = fallback
              fallbackWindow = minutes === 4320 ? '72h stored fallback' : '7d stored fallback'
              break
            }
          }
        }
        if (!payload.messages) {
          const emptySeries: SocialSeries = {
            labels: [],
            density: [],
            times: [],
            sent_labels: [],
            scores_smooth: [],
            sent_times: [],
          }
          socialCache.current[key] = emptySeries
          setSocial(emptySeries)
          setSocialMsg('No social data for this chart window.')
          return
        }
        const series: SocialSeries = {
          labels: payload.labels || [],
          density: payload.density || [],
          density_per_minute: payload.density_per_minute || [],
          times: payload.times || [],
          sent_labels: payload.sent_labels || payload.labels || [],
          scores_smooth: payload.scores_smooth || [],
          sent_times: payload.sent_times || payload.times || [],
        }
        socialCache.current[key] = series
        const socialCount = Number(payload.social_messages || 0)
        const articleCount = Number(payload.article_messages || 0)
        const suffix = fallbackWindow ? ` · ${fallbackWindow}` : ''
        setSocial(series); setSocialMsg(`Evidence: ${payload.source} · ${payload.messages} rows (${articleCount} news, ${socialCount} social)${suffix}`)
      } catch { if (!cancelled) setSocialMsg('Social data: error') }
    }
    poll()
    return () => { cancelled = true; if (timer) clearTimeout(timer) }
  }, [wantOverlay, ticker, chartDate, candleStart, candleEnd, overlayWindowMinutes])

  useEffect(() => {
    if (!wantWatcherOverlay || !ticker || !chartDate) { return }
    const key = `${ticker}|watchers|${chartDate}|${candleStart}|${candleEnd}|${overlayWindowMinutes}`
    if (watcherCache.current[key]) { setWatchers(watcherCache.current[key]); setWatcherMsg(''); return }
    let cancelled = false
    setWatchers(null); setWatcherMsg('Loading watcher history...')
    const qs = new URLSearchParams({
      ticker,
      window_minutes: String(overlayWindowMinutes),
    })
    if (candleStart && candleEnd) {
      qs.set('start_sec', String(candleStart))
      qs.set('end_sec', String(candleEnd))
    }
    fetch(`/api/chart/watchers?${qs}`)
      .then(r => r.json())
      .then((json: WatcherSeries & { error?: string }) => {
        if (cancelled) return
        if (json.error) { setWatcherMsg('Watchers: ' + json.error); return }
        watcherCache.current[key] = json
        setWatchers(json)
        const count = Number(json.current_count)
        const current = Number.isFinite(count) ? `${count.toLocaleString()} watchers` : 'watcher count unavailable'
        const snapshots = Number(json.snapshot_count || 0)
        setWatcherMsg(snapshots > 1 ? `Watchers: ${current} · ${snapshots} snapshots` : `Watchers: ${current} · collecting real history`)
      })
      .catch(() => { if (!cancelled) setWatcherMsg('Watchers: error') })
    return () => { cancelled = true }
  }, [wantWatcherOverlay, ticker, chartDate, candleStart, candleEnd, overlayWindowMinutes])

  // Build optional overlays from the fetched candles + social (single-day tfs only).
  const overlays = useMemo(() => {
    if (!overlayOk || !data?.candles?.length) return { density: undefined, sentiment: undefined, watchers: undefined }
    const ov = overlaySeries(data.candles as any, social, tfMinutes(tf), overlayRollingMinutes)
    const watcherSource = watchers || data?.watcher_series
    const watcherOverlay = (watcherSource?.times || []).map((time, i) => ({
      time,
      value: Number((watcherSource?.watchers || [])[i]),
    })).filter(point => Number.isFinite(point.time) && Number.isFinite(point.value))
    return {
      density: showDensity ? ov.density : undefined,
      sentiment: showSentiment ? ov.sentiment : undefined,
      watchers: showWatchers ? watcherOverlay : undefined,
    }
  }, [data, social, watchers, showDensity, showSentiment, showWatchers, tf, overlayOk, overlayRollingMinutes])

  const candleCount = data?.candles?.length ?? 0

  return (
    <div>
      <ChartSectionTabs active={chartTab} onChange={setChartTab} />
      {chartTab === 'grid' ? (
        <ChartsGridPage />
      ) : (
        <>
      {/* Toolbar */}
      <div className="flex items-center gap-3 mb-2 flex-wrap">
        <input
          value={input}
          onChange={e => setInput(e.target.value.toUpperCase())}
          onKeyDown={e => e.key === 'Enter' && load()}
          placeholder="Ticker (e.g. AAPL)"
          className="w-[140px] bg-bg border border-border text-sm text-white rounded px-3 py-2 font-mono focus:outline-none focus:border-accent placeholder:text-slate-600"
        />
        <button onClick={load} disabled={!input.trim()}
          className="px-4 py-2 bg-accent text-white text-sm font-medium rounded hover:bg-sky-400 disabled:opacity-50 transition-colors">
          {loading ? 'Loading…' : 'Load Chart'}
        </button>

        {/* Research-only intraday window selector */}
        {view !== 'candles' && (
          <div className="flex items-stretch rounded overflow-hidden border border-border">
            {WINDOWS.map(w => (
              <button key={w.key} onClick={() => setWin(w.key)}
                className={`px-3 py-1.5 text-xs transition-colors ${win === w.key ? 'bg-accent text-white' : 'bg-surface text-neutral hover:text-white'}`}>
                {w.label}
              </button>
            ))}
          </div>
        )}

        {ticker && <span className="text-accent font-mono font-bold text-lg ml-1">{ticker}</span>}
        {enrich?.news_alert && (
          <span title={`${enrich.news_alert_count} structured news item(s) in the last 3 days`}
            className="flex items-center gap-1 text-[11px] font-semibold text-red-400 bg-red-500/10 border border-red-500/40 rounded px-2 py-0.5 animate-pulse">
            ▲ NEWS {enrich.news_alert_count}
          </span>
        )}
        {data?.date && view === 'candles' && (
          <span className="text-xs text-neutral">{data.date} · {candleCount} bars · {tf}</span>
        )}
      </div>

      {/* View selector */}
      <div className="flex items-center gap-1 mb-3 border-b border-border flex-wrap">
        {VIEWS.map(v => (
          <button key={v.key} onClick={() => setView(v.key)}
            className={`px-3 py-1.5 text-xs transition-colors border-b-2 -mb-px ${
              view === v.key ? 'text-white border-accent' : 'text-neutral border-transparent hover:text-white'
            }`}>
            {v.label}
          </button>
        ))}
        <span className="ml-auto text-[10px] text-neutral pr-1">
          {view === 'candles' ? 'hover for crosshair · 1m → 1W timeframes' : '1-min intraday · extended hours 04:00–20:00 ET'}
        </span>
      </div>

      {!ticker ? (
        <div className="text-center py-20 text-neutral">
          <div className="text-4xl mb-3">📊</div>
          <div className="text-sm">Enter a ticker symbol and click Load Chart.</div>
        </div>
      ) : (
        <>
          {view === 'candles' ? (
            error ? (
              <div className="bg-surface border border-border rounded-lg p-8 text-center text-neutral">
                <div className="text-sm">{error}</div>
              </div>
            ) : (
              <div className="space-y-3">
                {/* Full timeframe selector + (single-day) overlays */}
                <div className="flex items-center gap-3 flex-wrap text-xs">
                  <div className="flex items-center gap-1">
                    <span className="text-neutral mr-1">Timeframe</span>
                    <div className="flex items-stretch rounded overflow-hidden border border-border flex-wrap">
                      {TIMEFRAMES.map(t => (
                        <button key={t.key} onClick={() => setTf(t.key)}
                          className={clsx('px-2.5 py-1 transition-colors border-r border-border last:border-r-0',
                            tf === t.key ? 'bg-accent text-white' : 'bg-surface text-neutral hover:text-white')}>
                          {t.label}
                        </button>
                      ))}
                    </div>
                    <span className="text-neutral ml-1 tabular-nums">{candleCount} bars</span>
                  </div>
                  {overlayOk && (
                    <>
                      <label className="flex items-center gap-1.5 text-neutral">
                        Rolling Window
                        <select
                          value={overlayRollingMinutes}
                          onChange={event => setOverlayRollingMinutes(Number(event.target.value))}
                          className="rounded border border-border bg-bg px-2 py-1 text-xs text-white focus:border-accent focus:outline-none"
                        >
                          {OVERLAY_ROLLING_WINDOWS.map(option => (
                            <option key={option.value} value={option.value}>{option.label}</option>
                          ))}
                        </select>
                      </label>
                      <label className="flex items-center gap-1.5 cursor-pointer select-none">
                        <input type="checkbox" checked={showDensity} onChange={e => setShowDensity(e.target.checked)} className="accent-orange-500 cursor-pointer" />
                        <span style={{ color: '#FF9800' }}>Density</span>
                      </label>
                      <label className="flex items-center gap-1.5 cursor-pointer select-none">
                        <input type="checkbox" checked={showSentiment} onChange={e => setShowSentiment(e.target.checked)} className="accent-green-500 cursor-pointer" />
                        <span style={{ color: '#4CAF50' }}>Sentiment</span>
                      </label>
                      <label className="flex items-center gap-1.5 cursor-pointer select-none">
                        <input type="checkbox" checked={showWatchers} onChange={e => setShowWatchers(e.target.checked)} className="accent-blue-400 cursor-pointer" />
                        <span className="text-blue-300">Watchers</span>
                      </label>
                      {(showDensity || showSentiment) && socialMsg && <span className="text-neutral">{socialMsg}</span>}
                      {showWatchers && watcherMsg && <span className="text-neutral">{watcherMsg}</span>}
                    </>
                  )}
                  <label className="flex items-center gap-1.5 cursor-pointer select-none">
                    <input type="checkbox" checked={showStrategy} onChange={e => setShowStrategy(e.target.checked)} className="accent-sky-500 cursor-pointer" />
                    <span className="text-accent">Entry setups ▲▼</span>
                  </label>
                  <span className="ml-auto text-[10px] text-neutral">
                    {overlayOk ? 'density + sentiment overlays available for intraday timeframes up to 1h' : 'overlays are disabled for 2h / daily / weekly views'}
                  </span>
                </div>

                {loading && !data ? (
                  <div className="text-neutral text-sm animate-pulse p-4">Loading chart…</div>
                ) : (
                  <>
                    <ChartDiagnostics data={data} />
                    <ChartCard title={`Candlestick + Bollinger Bands (20,2) · ${tf}`} height={320}>
                      {candleCount
                        ? <CandlestickChart candles={data!.candles as any} bollinger={data!.bollinger as any}
                            predicted={data!.predicted as any}
                            newsEvents={data!.news_events as any}
                            strategyMarkers={showStrategy ? data!.strategy_markers as any : []}
                            densityOverlay={overlays.density} sentimentOverlay={overlays.sentiment}
                            watcherOverlay={overlays.watchers}
                            showWatchers={showWatchers}
                            showPrediction showMarkers chartStyle="candles" />
                        : <div className="h-full flex items-center justify-center text-xs text-neutral">No price bars for this timeframe.</div>}
                    </ChartCard>
                    <PredictionEvents events={data?.prediction_events ?? []} />
                    <ChartCard title={`RSI (14) · ${tf}`} height={130}>
                      <RSIChart data={(data?.rsi ?? []) as any} />
                    </ChartCard>
                    <ChartCard title={`MACD (12, 26, 9) · ${tf}`} height={150}>
                      <MACDChart data={data?.macd as any} />
                    </ChartCard>
                  </>
                )}
              </div>
            )
          ) : (
            <div className="bg-surface border border-border rounded-lg overflow-hidden" style={{ height: 460 }}>
              <ResearchChart ticker={ticker} mode={view} window={win} />
            </div>
          )}

          {/* Per-ticker enrichments below the chart: 3-day news + social/gossip */}
          <TickerEnrichPanels ticker={ticker} enrich={enrich} />
        </>
      )}
        </>
      )}
    </div>
  )
}

function ChartSectionTabs({ active, onChange }: { active: 'single' | 'grid'; onChange: (next: 'single' | 'grid') => void }) {
  return (
    <div className="flex items-center gap-1 mb-3 border-b border-border">
      <button
        onClick={() => onChange('single')}
        className={clsx('px-3 py-1.5 text-xs transition-colors border-b-2 -mb-px',
          active === 'single' ? 'text-white border-accent' : 'text-neutral border-transparent hover:text-white')}
      >
        Single Chart
      </button>
      <button
        onClick={() => onChange('grid')}
        className={clsx('px-3 py-1.5 text-xs transition-colors border-b-2 -mb-px',
          active === 'grid' ? 'text-white border-accent' : 'text-neutral border-transparent hover:text-white')}
      >
        Charts Grid
      </button>
    </div>
  )
}

function emptyEnrich(ticker: string, note = 'No FeedFlash news loaded for this ticker yet.'): EnrichData {
  return {
    ticker,
    news_alert: false,
    news_alert_count: 0,
    news: { days: 3, articles: [], ai: null, sources: [], source_filter_active: false, note },
    social: {
      stocktwits: null,
      bluesky: { configured: true, metrics: null },
      reddit: { configured: true, metrics: null },
      grok: { configured: true, metrics: null },
      rumor: null,
      future_sources: [],
    },
  }
}

function eventTime(value: string | number) {
  const sec = typeof value === 'number' ? value : Math.floor(Date.parse(value) / 1000)
  if (!Number.isFinite(sec) || sec <= 0) return '--'
  return new Date(sec * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function ChartDiagnostics({ data }: { data: ChartData | null }) {
  if (!data) return null
  const status = data.source_status || {}
  const warn = Boolean(status.quote_disagrees_with_candles || status.price_detail)
  const newsValue = status.news === 'no_matched_news' ? '0 news' : (status.news || `${data.structured_news_events?.length ?? 0} news`)
  const setupCount = data.strategy_signal_stats?.setups ?? data.strategy_signal_stats?.trades ?? 0
  const watcherValue = status.watchers || (data.watcher_series?.current_count != null ? `${Number(data.watcher_series.current_count).toLocaleString()} watchers` : 'not captured')
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 md:grid-cols-7 gap-2">
        <Status label="Price" value={status.price || 'ok'} />
        <Status label="Source" value={status.price_source || data.tf || 'market'} />
        <Status label="Social" value={status.social === 'no_social_posts' ? '0 posts' : (status.social || 'pending')} />
        <Status label="News" value={newsValue} />
        <Status label="Signals" value={status.predictions === 'no_prediction_signals' ? '0 signals' : (status.predictions || String(data.prediction_events?.length ?? 0))} />
        <Status label="Entry Setups" value={`${setupCount} setups`} />
        <Status label="Watchers" value={watcherValue} />
      </div>
      {warn && (
        <div className="rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">
          {status.price_detail || 'Chart candles and screener quote disagree; use the screener quote for current-session change.'}
        </div>
      )}
    </div>
  )
}

function PredictionEvents({ events }: { events: NonNullable<ChartData['prediction_events']> }) {
  if (!events.length) return null
  return (
    <div className="bg-surface border border-border rounded-lg overflow-hidden">
      <div className="px-3 py-2 border-b border-border">
        <span className="text-xs text-neutral font-medium uppercase">Recent Prediction Signals</span>
      </div>
      <div className="divide-y divide-border/60">
        {events.slice(-5).map((event, index) => {
          const actual = event.label_5m?.return_pct
          const correct = event.label_5m?.direction_correct
          return (
            <div key={`${event.time}-${index}`} className="grid grid-cols-[82px_1fr_92px] gap-2 px-3 py-2 text-xs items-center">
              <span className="font-mono text-neutral">{eventTime(event.time)}</span>
              <span className="text-slate-200 truncate">{event.title || event.text || 'Prediction signal'}</span>
              <span className={correct === true ? 'text-emerald-400 font-mono text-right' : correct === false ? 'text-orange-400 font-mono text-right' : 'text-neutral font-mono text-right'}>
                {actual == null ? 'pending' : `${actual > 0 ? '+' : ''}${Number(actual).toFixed(2)}%`}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function Status({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-surface border border-border rounded-lg px-3 py-2 min-w-0">
      <div className="font-mono text-sm text-white truncate">{value}</div>
      <div className="text-[10px] uppercase text-neutral mt-0.5">{label}</div>
    </div>
  )
}

function ChartCard({ title, height, children }: { title: string; height: number; children: React.ReactNode }) {
  return (
    <div className="bg-surface border border-border rounded-lg overflow-hidden">
      <div className="px-3 py-2 border-b border-border">
        <span className="text-xs text-neutral font-medium uppercase tracking-wide">{title}</span>
      </div>
      <div style={{ height }}>{children}</div>
    </div>
  )
}
