'use client'
import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import { clsx } from 'clsx'
import { CandlestickChart } from './CandlestickChart'
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

interface ChartData {
  date?: string
  n?: number
  tf?: string
  error?: string
  candles: Array<{ time: number; open: number; high: number; low: number; close: number; volume?: number }>
  bollinger?: { upper: Array<{ time: number; value: number }>; lower: Array<{ time: number; value: number }> }
  rsi?: Array<{ time: number; value: number }>
  macd?: { macd: Array<{ time: number; value: number }>; signal: Array<{ time: number; value: number }>; histogram: Array<{ time: number; value: number }> }
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

export function ChartsPage() {
  const [sp, setSp] = useSearchParams()
  const urlTicker = (sp.get('t') || '').toUpperCase().trim()
  const chartTab = sp.get('chartTab') === 'grid' ? 'grid' : 'single'
  const [input, setInput] = useState(urlTicker || 'AAPL')
  const [ticker, setTicker] = useState<string | null>(urlTicker || 'AAPL')
  const [view, setView] = useState<View>('candles')
  const [tf, setTf] = useState('5m')
  const [win, setWin] = useState<Win>('full')
  const [data, setData] = useState<ChartData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [enrich, setEnrich] = useState<EnrichData | null>(null)

  const [showDensity, setShowDensity] = useState(false)
  const [showSentiment, setShowSentiment] = useState(false)
  const [social, setSocial] = useState<SocialSeries | null>(null)
  const [socialMsg, setSocialMsg] = useState('')
  const socialCache = useRef<Record<string, SocialSeries>>({})
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
    fetch(`/api/charts/${ticker}?tf=${tf}`)
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
  const chartDate = data?.date
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
    const key = `${ticker}|${chartDate}|${overlayWindowMinutes}`
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
        const s = await fetch(`/api/chart/social?${qs}`).then(r => r.json())
        if (cancelled) return
        if (s.error) { setSocialMsg('Social: ' + s.error); return }
        if (s.status === 'walking') { setSocialMsg(`Loading social history, ${s.count || 0} messages…`); timer = window.setTimeout(poll, 1500); return }
        if (!s.messages) { setSocialMsg('No social data for this chart window.'); return }
        const series: SocialSeries = {
          labels: s.labels || [],
          density: s.density || [],
          times: s.times || [],
          sent_labels: s.sent_labels || s.labels || [],
          scores_smooth: s.scores_smooth || [],
          sent_times: s.sent_times || s.times || [],
        }
        socialCache.current[key] = series
        setSocial(series); setSocialMsg(`Social: ${s.source} · ${s.messages} msgs`)
      } catch { if (!cancelled) setSocialMsg('Social data: error') }
    }
    poll()
    return () => { cancelled = true; if (timer) clearTimeout(timer) }
  }, [wantOverlay, ticker, chartDate, overlayWindowMinutes])

  // Build optional overlays from the fetched candles + social (single-day tfs only).
  const overlays = useMemo(() => {
    if (!overlayOk || !data?.candles?.length) return { density: undefined, sentiment: undefined }
    const ov = overlaySeries(data.candles as any, social, tfMinutes(tf), 15)
    return { density: showDensity ? ov.density : undefined, sentiment: showSentiment ? ov.sentiment : undefined }
  }, [data, social, showDensity, showSentiment, tf, overlayOk])

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
                      <label className="flex items-center gap-1.5 cursor-pointer select-none">
                        <input type="checkbox" checked={showDensity} onChange={e => setShowDensity(e.target.checked)} className="accent-orange-500 cursor-pointer" />
                        <span style={{ color: '#FF9800' }}>Density</span>
                      </label>
                      <label className="flex items-center gap-1.5 cursor-pointer select-none">
                        <input type="checkbox" checked={showSentiment} onChange={e => setShowSentiment(e.target.checked)} className="accent-green-500 cursor-pointer" />
                        <span style={{ color: '#4CAF50' }}>Sentiment</span>
                      </label>
                      {(showDensity || showSentiment) && socialMsg && <span className="text-neutral">{socialMsg}</span>}
                    </>
                  )}
                  <span className="ml-auto text-[10px] text-neutral">
                    {overlayOk ? 'density + sentiment overlays available for intraday timeframes up to 1h' : 'overlays are disabled for 2h / daily / weekly views'}
                  </span>
                </div>

                {loading && !data ? (
                  <div className="text-neutral text-sm animate-pulse p-4">Loading chart…</div>
                ) : (
                  <>
                    <ChartCard title={`Candlestick + Bollinger Bands (20,2) · ${tf}`} height={320}>
                      {candleCount
                        ? <CandlestickChart candles={data!.candles as any} bollinger={data!.bollinger as any}
                            densityOverlay={overlays.density} sentimentOverlay={overlays.sentiment} />
                        : <div className="h-full flex items-center justify-center text-xs text-neutral">No price bars for this timeframe.</div>}
                    </ChartCard>
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
      bluesky: { configured: false, metrics: null },
      reddit: { configured: false, metrics: null },
      rumor: null,
      future_sources: ['X'],
    },
  }
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
