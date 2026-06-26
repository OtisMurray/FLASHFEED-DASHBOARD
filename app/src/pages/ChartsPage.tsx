'use client'
import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import { CandlestickChart } from './CandlestickChart'
import { RSIChart } from './RSIChart'
import { MACDChart } from './MACDChart'
import { SentimentChart } from './SentimentChart'
import { ResearchChart, type ResearchMode } from './ResearchChart'
import { TickerEnrichPanels, type EnricstshData } from './TickerEnrichPanels'
import { resampleCandles, bollingerFromCandles, rsiFromCandles, macdFromCandles, overlaySeries, type SocialSeries } from '../lib/chartAgg'
import { formatMarketTime } from '../lib/marketTime'

const PREDICTION_HORIZON_MINUTES = 5

interface ChartData {
  candles: Array<{ time: string | number; open: number; high: number; low: number; close: number; volume?: number }>
  bollinger?: { upper: Array<{ time: string | number; value: number }>; lower: Array<{ time: string | number; value: number }> }
  rsi?: Array<{ time: string | number; value: number }>
  macd?: { macd: Array<{ time: string | number; value: number }>; signal: Array<{ time: string | number; value: number }>; histogram: Array<{ time: string | number; value: number }> }
  predicted?: Array<{ time: string | number; value: number }>
  news_events?: Array<{ time: string | number; position?: string; color?: string; shape?: string; text?: string; title?: string; source?: string }>
  prediction_events?: Array<{ time: string | number; title?: string; text?: string; entry_price?: number; label_5m?: { return_pct?: number; direction_correct?: boolean } | null }>
  sentiment?: Array<{ time: string | number; value: number }>
  social_density?: Array<{ time: string | number; value: number; scaled?: number; count?: number; session?: string }>
  summary?: { social_message_count?: number; social_buckets?: number; news_sentiment_events?: number; sentiment_buckets?: number }
  source_status?: { price?: string; price_source?: string; price_detail?: string; social?: string; sentiment?: string; news?: string; predictions?: string | number }
}

const RANGES = ['1d', '5d', '1mo', '3mo', '6mo', '1y'] as const
const INTERVALS = ['1m', '5m', '15m', '1h', '1d', '1wk'] as const
const RANGE_LABELS: Record<string, string> = { '1d': '1 Day', '5d': '5 Days', '1mo': '1 Month', '3mo': '3 Months', '6mo': '6 Months', '1y': '1 Year' }
const INT_LABELS: Record<string, string> = { '1m': '1 Minute', '5m': '5 Minute', '15m': '15 Minute', '1h': 'Hourly', '1d': 'Daily', '1wk': 'Weekly' }

// Intraday timeframe options for the research/resample views
const INTRADAY_TFS: Array<{ min: number; label: string }> = [
  { min: 1, label: '1m' }, { min: 5, label: '5m' }, { min: 15, label: '15m' },
  { min: 30, label: '30m' }, { min: 60, label: '1h' },
]

type View = 'simple' | 'advanced' | 'candles' | ResearchMode

const VIEW_OPTIONS: Array<{ key: View; label: string }> = [
  { key: 'simple', label: 'Simple' },
  { key: 'advanced', label: 'Advanced' },
  { key: 'pd',     label: 'Price+Density' },
  { key: 'sent',   label: 'Sentiment' },
  { key: 'ds',     label: 'Density vs Sent' },
]

type Win = 'full' | '2h' | '1h'
const WINDOWS: Array<{ key: Win; label: string }> = [
  { key: 'full', label: 'Full Day' },
  { key: '2h',   label: 'Last 2h' },
  { key: '1h',   label: 'Last 1h' },
]

export function ChartsPage() {
  const [sp, setSp] = useSearchParams()
  const urlTicker = (sp.get('t') || '').toUpperCase().trim()
  const [input, setInput] = useState(urlTicker || 'AAPL')
  const [ticker, setTicker] = useState<string | null>(urlTicker || 'AAPL')
  const [range, setRange] = useState<string>('1d')
  const [interval, setInterval] = useState<string>('1m')
  const [rollingWindow, setRollingWindow] = useState(30)
  const [view, setView] = useState<View>('simple')
  const [win, setWin] = useState<Win>('full')
  const [showSentiment, setShowSentiment] = useState(true)
  const [showDensity, setShowDensity] = useState(true)
  const [showBollinger, setShowBollinger] = useState(false)
  const [showPrediction, setShowPrediction] = useState(false)
  const [data, setData] = useState<ChartData | null>(null)
  const [loading, setLoading] = useState(false)
  const [activeTicker, setActiveTicker] = useState<string | null>(null)
  const [autoLoaded, setAutoLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [enrich, setEnrich] = useState<EnrichData | null>(null)

  // Candlestick intraday state: client-side resample, social overlays
  const [tf, setTf] = useState(1)
  const [showDensityOverlay, setShowDensityOverlay] = useState(false)
  const [showSentimentOverlay, setShowSentimentOverlay] = useState(false)
  const [social, setSocial] = useState<SocialSeries | null>(null)
  const [socialMsg, setSocialMsg] = useState('')
  const socialCache = useRef<Record<string, SocialSeries>>({})

  // Track if we're in a research/intraday view
  const isResearch = view === 'pd' || view === 'sent' || view === 'ds'

  const loadChart = useCallback(async (windowOverride?: number) => {
    if (!ticker?.trim()) return
    const windowMinutes = Math.max(1, Math.min(120, Math.round(windowOverride ?? rollingWindow)))
    setLoading(true)
    setError(null)
    try {
      const bucketMinutes = interval === '1m' ? 1 : interval === '5m' ? 5 : interval === '15m' ? 15 : 60
      const res = await fetch(`/api/charts/${ticker.trim().toUpperCase()}?range=${range}&interval=${interval}&window_minutes=${windowMinutes}&bucket_minutes=${bucketMinutes}&prediction_horizon_minutes=${PREDICTION_HORIZON_MINUTES}`)
      const json = await res.json()
      if (!res.ok || json?.ok === false) throw new Error(json?.error || `Chart request failed (${res.status})`)
      setData(json)
      setActiveTicker(ticker.trim().toUpperCase())
    } catch (err: any) {
      setError(err?.message || 'Unable to load chart data')
    } finally {
      setLoading(false)
    }
  }, [ticker, range, interval, rollingWindow])

  // Auto-load on mount
  useEffect(() => {
    if (!autoLoaded && !data && !loading) {
      setAutoLoaded(true)
      loadChart()
    }
  }, [autoLoaded, data, loading, loadChart])

  // Per-ticker enrichments — non-blocking, loads in background after chart renders
  useEffect(() => {
    if (!ticker) { setEnrich(null); return }
    let cancelled = false
    // Use a small delay so the chart renders first on slow connections
    const timer = setTimeout(() => {
      fetch(`/api/ticker/${ticker}/enrich`)
        .then(r => r.json())
        .then(d => { if (!cancelled) setEnrich(d) })
        .catch(() => { if (!cancelled) setEnrich(null) })
    }, 100)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [ticker])

  // Social series for overlay on candlestick chart
  const wantOverlay = view === 'candles' && (showDensityOverlay || showSentimentOverlay)
  useEffect(() => {
    if (!wantOverlay || !ticker) return
    const key = `${ticker}|candles`
    if (socialCache.current[key]) { setSocial(socialCache.current[key]); setSocialMsg(''); return }
    let cancelled = false
    let timer: number | undefined
    setSocial(null); setSocialMsg('Loading social data…')
    
    const getToday = () => new Date().toISOString().slice(0, 10)
    const getYesterday = () => {
      const d = new Date()
      d.setDate(d.getDate() - 1)
      return d.toISOString().slice(0, 10)
    }

    const tryDate = async (date: string): Promise<any | null> => {
      const s = await fetch(`/api/chart/social?${new URLSearchParams({ ticker, date })}`).then(r => r.json())
      if (cancelled) return null
      if (s.error) return null
      if (s.status === 'walking') {
        setSocialMsg(`Loading social history, ${s.count || 0} messages…`)
        await new Promise(resolve => { timer = window.setTimeout(() => resolve(undefined), 1500) })
        if (cancelled) return null
        return tryDate(date)
      }
      if (!s.messages) return null
      return s
    }

    const pollForToday = async () => {
      const today = getToday()
      let s = await tryDate(today)
      if (!s && !cancelled) {
        setSocialMsg(`No data for ${today}, trying yesterday…`)
        s = await tryDate(getYesterday())
      }
      if (!s && !cancelled) {
        setSocialMsg('No social data available for recent days.')
        return
      }
      if (cancelled || !s) return
      const series: SocialSeries = { labels: s.labels, density: s.density, sent_labels: s.sent_labels, scores_smooth: s.scores_smooth }
      socialCache.current[key] = series
      setSocial(series); setSocialMsg(`Social: ${s.source} · ${s.messages} msgs`)
      
      // Poll for today's data every 30 seconds if we're showing yesterday
      const interval = setInterval(async () => {
        if (cancelled) { clearInterval(interval); return }
        const todayData = await tryDate(today)
        if (todayData && todayData.messages && !cancelled) {
          const todaySeries: SocialSeries = { labels: todayData.labels, density: todayData.density, sent_labels: todayData.sent_labels, scores_smooth: todayData.scores_smooth }
          socialCache.current[key] = todaySeries
          setSocial(todaySeries); setSocialMsg(`Social: ${todayData.source} · ${todayData.messages} msgs`)
          clearInterval(interval)
        }
      }, 30000)
      
      return () => clearInterval(interval)
    }

    pollForToday()
    
    return () => { 
      cancelled = true; 
      if (timer) clearTimeout(timer) 
    }
  }, [wantOverlay, ticker])

  // Client-side resample for candlestick view
  const priceView = useMemo(() => {
    if (!data?.candles) return null
    const raw = data.candles as any[]
    const candles = resampleCandles(raw as any, tf)
    const bollinger = tf === 1 ? (data?.bollinger as any) : bollingerFromCandles(candles, 20, 2)
    const rsi = tf === 1 ? (data?.rsi as any) : rsiFromCandles(candles, 14)
    const macd = tf === 1 ? (data?.macd as any) : macdFromCandles(candles, 12, 26, 9)
    const ov = overlaySeries(raw as any, social, tf, 15)
    return {
      candles, bollinger, rsi, macd,
      density: showDensityOverlay ? ov.density : undefined,
      sentiment: showSentimentOverlay ? ov.sentiment : undefined,
      count: candles.length,
    }
  }, [data, tf, social, showDensityOverlay, showSentimentOverlay])

  const handleLoad = useCallback(() => {
    const t = input.trim().toUpperCase()
    if (t) { setTicker(t); setSp({ t }, { replace: true }) }
  }, [input, setSp])

  return (
    <div>
      {/* Toolbar */}
      <div className="flex items-center gap-3 mb-2 flex-wrap">
        <input
          value={input}
          onChange={e => setInput(e.target.value.toUpperCase())}
          onKeyDown={e => e.key === 'Enter' && handleLoad()}
          placeholder="Ticker (e.g. AAPL)"
          className="w-[140px] bg-bg border border-border text-sm text-white rounded px-3 py-2 font-mono focus:outline-none focus:border-accent placeholder:text-slate-600"
        />
        {!isResearch && (
          <>
            <select value={range} onChange={e => setRange(e.target.value)}
              className="bg-bg border border-border text-sm text-neutral rounded px-2 py-2 focus:outline-none focus:border-accent">
              {RANGES.map(r => <option key={r} value={r}>{RANGE_LABELS[r]}</option>)}
            </select>
            <select value={interval} onChange={e => setInterval(e.target.value)}
              className="bg-bg border border-border text-sm text-neutral rounded px-2 py-2 focus:outline-none focus:border-accent">
              {INTERVALS.map(i => <option key={i} value={i}>{INT_LABELS[i]}</option>)}
            </select>
          </>
        )}
        <button
          onClick={handleLoad}
          disabled={loading || !input.trim()}
          className="px-4 py-2 bg-accent text-white text-sm font-medium rounded hover:bg-sky-400 disabled:opacity-50 transition-colors"
        >
          {loading ? 'Loading...' : view === 'simple' || view === 'advanced' ? 'Load Chart' : 'Set Ticker'}
        </button>
        {activeTicker && (
          <span className="text-accent font-mono font-bold text-lg ml-2">{activeTicker}</span>
        )}
      </div>

      {error && <div className="mb-4 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</div>}

      {/* View selector */}
      <div className="flex items-center gap-1 mb-3 border-b border-border flex-wrap">
        {VIEW_OPTIONS.map(v => (
          <button key={v.key} onClick={() => setView(v.key)}
            className={`px-3 py-1.5 text-xs transition-colors border-b-2 -mb-px ${
              view === v.key ? 'text-white border-accent' : 'text-neutral border-transparent hover:text-white'
            }`}>
            {v.label}
          </button>
        ))}
      </div>

      {/* Charts */}
      {isResearch && ticker ? (
        <div className="bg-surface border border-border rounded-lg overflow-hidden" style={{ height: 460 }}>
          <ResearchChart ticker={ticker} mode={view as ResearchMode} window={win} />
        </div>
      ) : data ? (
        <div className="space-y-3">
          {/* Controls bar for simple/advanced views */}
          {view !== 'candles' && (
            <div className="bg-surface border border-border rounded-lg px-3 py-3">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-2 flex-wrap">
                  <Toggle label={`Sentiment ${latestSentimentValue(data.sentiment)}`} active={showSentiment} onClick={() => setShowSentiment(v => !v)} tone="purple" />
                  <Toggle label={`Message Volume ${messageVolumeValue(data)}`} active={showDensity} onClick={() => setShowDensity(v => !v)} tone="orange" />
                  <Toggle label="Bollinger" active={showBollinger} onClick={() => setShowBollinger(v => !v)} tone="slate" />
                  <Toggle label="Prediction" active={showPrediction} onClick={() => setShowPrediction(v => !v)} tone="amber" />
                </div>
                <div className="flex items-center gap-2 min-w-[280px]">
                  <label className="text-xs uppercase text-neutral whitespace-nowrap">
                    Feature Window {rollingWindow >= 60 && rollingWindow % 60 === 0 ? `${rollingWindow / 60}h` : `${rollingWindow}m`}
                  </label>
                  <input
                    type="range" min={1} max={120} step={1} value={rollingWindow}
                    onChange={e => setRollingWindow(Number(e.target.value))}
                    onMouseUp={() => data && loadChart()}
                    onTouchEnd={() => data && loadChart()}
                    className="w-full accent-sky-400"
                  />
                  <button type="button" onClick={() => { setRollingWindow(60); loadChart(60) }} className="px-2 py-1 bg-bg border border-border text-xs text-neutral rounded">1h</button>
                  <button type="button" onClick={() => { setRollingWindow(120); loadChart(120) }} className="px-2 py-1 bg-bg border border-border text-xs text-neutral rounded">2h</button>
                </div>
              </div>
            </div>
          )}

          {/* Candlestick view with overlays */}
          {view === 'candles' ? (
            <>
              <div className="flex items-center gap-3 flex-wrap text-xs mb-2">
                <div className="flex items-center gap-1">
                  <span className="text-neutral mr-1">Timeframe</span>
                  <div className="flex items-stretch rounded overflow-hidden border border-border">
                    {INTRADAY_TFS.map(t => (
                      <button key={t.min} onClick={() => setTf(t.min)}
                        className={`px-2.5 py-1 transition-colors ${tf === t.min ? 'bg-accent text-white' : 'bg-surface text-neutral hover:text-white'}`}>
                        {t.label}
                      </button>
                    ))}
                  </div>
                  {priceView && <span className="text-neutral ml-1 tabular-nums">{priceView.count} bars</span>}
                </div>
                <label className="flex items-center gap-1.5 cursor-pointer select-none">
                  <input type="checkbox" checked={showDensityOverlay} onChange={e => setShowDensityOverlay(e.target.checked)} className="accent-orange-500 cursor-pointer" />
                  <span style={{ color: '#FF9800' }}>Density</span>
                </label>
                <label className="flex items-center gap-1.5 cursor-pointer select-none">
                  <input type="checkbox" checked={showSentimentOverlay} onChange={e => setShowSentimentOverlay(e.target.checked)} className="accent-green-500 cursor-pointer" />
                  <span style={{ color: '#4CAF50' }}>Sentiment</span>
                </label>
                {(showDensityOverlay || showSentimentOverlay) && socialMsg && (
                  <span className="text-neutral">{socialMsg}</span>
                )}
                <div className="flex items-stretch rounded overflow-hidden border border-border ml-auto">
                  {WINDOWS.map(w => (
                    <button key={w.key} onClick={() => setWin(w.key)}
                      className={`px-2.5 py-1 text-xs transition-colors ${win === w.key ? 'bg-accent text-white' : 'bg-surface text-neutral hover:text-white'}`}>
                      {w.label}
                    </button>
                  ))}
                </div>
              </div>
              <ChartCard title={`${activeTicker || ticker} — Candlestick + Indicators`} height={420}>
                {priceView?.candles?.length ? (
                  <CandlestickChart
                    candles={priceView.candles as any}
                    bollinger={priceView.bollinger as any}
                    density={priceView.density as any}
                    sentiment={priceView.sentiment as any}
                    showSentiment={showSentimentOverlay}
                    showDensity={showDensityOverlay}
                    showBollinger={true}
                    chartStyle="candles"
                  />
                ) : (
                  <EmptyChart message="No candle data available." />
                )}
              </ChartCard>
            </>
          ) : (
            <>
              <ChartCard title={`${activeTicker || ticker} ${RANGE_LABELS[range] ?? range}`} height={view === 'simple' ? 460 : 380}>
                {data.candles?.length
                  ? <CandlestickChart
                      candles={data.candles as any}
                      bollinger={data.bollinger as any}
                      predicted={data.predicted as any}
                      newsEvents={data.news_events as any}
                      density={(data.social_density || []) as any}
                      sentiment={(data.sentiment || []) as any}
                      showSentiment={showSentiment}
                      showDensity={showDensity}
                      showBollinger={showBollinger}
                      showPrediction={showPrediction}
                      chartStyle={view === 'advanced' ? 'candles' : 'line'}
                    />
                  : <EmptyChart message={data.source_status?.price_detail || 'No price bars returned for this interval.'} />}
              </ChartCard>
              {view === 'advanced' && (
                <>
                  <div className="grid grid-cols-2 md:grid-cols-6 gap-2">
                    <Status label="Price" value={data.source_status?.price ?? 'unknown'} />
                    <Status label="Source" value={data.source_status?.price_source ?? 'pending'} />
                    <Status label="Social" value={data.source_status?.social ?? 'pending'} />
                    <Status label="News Markers" value={String(data.news_events?.length ?? 0)} />
                    <Status label="Predictions" value={String(data.prediction_events?.length ?? 0)} />
                    <Status label="Bars" value={String(data.candles?.length ?? 0)} />
                  </div>
                  <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
                    <ChartCard title="Rolling Message Density" height={150}>
                      <SentimentChart data={(data.social_density ?? []).map(row => ({ time: row.time as any, value: row.scaled ?? row.value }))} />
                    </ChartCard>
                    <ChartCard title="Rolling Message Sentiment" height={150}>
                      <SentimentChart data={data.sentiment ?? []} />
                    </ChartCard>
                    <ChartCard title="RSI (14)" height={150}>
                      <RSIChart data={data.rsi ?? []} />
                    </ChartCard>
                    <ChartCard title="MACD (12,26,9)" height={150}>
                      <MACDChart data={data.macd} />
                    </ChartCard>
                  </div>
                  <PredictionEvents events={data.prediction_events ?? []} />
                </>
              )}
            </>
          )}

          {/* Ticker enrichment panels */}
          {ticker && <TickerEnrichPanels ticker={ticker} enrich={enrich} />}
        </div>
      ) : (
        <div className="text-center py-20 text-neutral">
          <div className="text-sm">Loading the default chart...</div>
        </div>
      )}
    </div>
  )
}

function latestSentimentValue(rows: any[] | undefined) {
  const row = rows?.[rows.length - 1]
  if (!row) return '—'
  return String(Math.round(Math.max(0, Math.min(100, (Number(row.value || 0) + 1) * 50))))
}

function messageVolumeValue(data: ChartData) {
  const summaryValue = Number(data.summary?.social_message_count)
  if (Number.isFinite(summaryValue) && summaryValue > 0) return String(Math.round(summaryValue))
  const total = (data.social_density ?? []).reduce((sum, row) => sum + Number(row.count ?? 0), 0)
  return total > 0 ? String(Math.round(total)) : '—'
}

function Toggle({ label, active, onClick, tone }: { label: string; active: boolean; onClick: () => void; tone: 'purple' | 'orange' | 'slate' | 'amber' }) {
  const activeClasses = {
    purple: 'border-violet-500 text-violet-300 bg-violet-500/10',
    orange: 'border-orange-500 text-orange-300 bg-orange-500/10',
    slate: 'border-slate-500 text-slate-200 bg-slate-500/10',
    amber: 'border-amber-500 text-amber-300 bg-amber-500/10',
  }[tone]
  return (
    <button type="button" onClick={onClick}
      className={active ? `px-3 py-1.5 rounded-full border text-sm font-medium ${activeClasses}` : 'px-3 py-1.5 rounded-full border border-border bg-bg text-sm text-neutral'}>
      {label}
    </button>
  )
}

function eventTime(value: string | number) {
  const sec = typeof value === 'number' ? value : Math.floor(Date.parse(value) / 1000)
  if (!Number.isFinite(sec) || sec <= 0) return '--'
  return formatMarketTime(sec * 1000)
}

function PredictionEvents({ events }: { events: NonNullable<ChartData['prediction_events']> }) {
  if (!events.length) return null
  return (
    <div className="bg-surface border border-border rounded-lg overflow-hidden">
      <div className="px-3 py-2 border-b border-border">
        <span className="text-xs text-neutral font-medium uppercase">Prediction Signals</span>
      </div>
      <div className="divide-y divide-border/60">
        {events.slice(-5).map((event, index) => {
          const actual = event.label_5m?.return_pct
          const correct = event.label_5m?.direction_correct
          return (
            <div key={`${event.time}-${index}`} className="grid grid-cols-[86px_1fr_100px] gap-2 px-3 py-2 text-xs items-center">
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

function EmptyChart({ message }: { message: string }) {
  return (
    <div className="h-full flex items-center justify-center px-4 text-center text-xs text-neutral">
      {message}
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