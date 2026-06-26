'use client'
import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import { clsx } from 'clsx'
import { CandlestickChart } from './CandlestickChart'
import { RSIChart } from './RSIChart'
import { MACDChart } from './MACDChart'
import { ResearchChart, type ResearchMode } from './ResearchChart'
import { TickerEnrichPanels, type EnrichData } from './TickerEnrichPanels'
import { resampleCandles, bollingerFromCandles, rsiFromCandles, macdFromCandles, overlaySeries, type SocialSeries } from '@/lib/chartAgg'

// Price-chart bar timeframes. The backend serves ONLY 1-minute extended-hours
// intraday bars (one session) — no daily/weekly — so the options stop at 1h and
// are all client-side resamples of the same fetched 1-min data.
const TIMEFRAMES: Array<{ min: number; label: string }> = [
  { min: 1, label: '1m' }, { min: 5, label: '5m' }, { min: 15, label: '15m' },
  { min: 30, label: '30m' }, { min: 60, label: '1h' },
]

interface ChartData {
  date?: string
  n?: number
  error?: string
  candles: Array<{ time: number; open: number; high: number; low: number; close: number; volume?: number }>
  bollinger?: { upper: Array<{ time: number; value: number }>; lower: Array<{ time: number; value: number }> }
  rsi?: Array<{ time: number; value: number }>
  macd?: { macd: Array<{ time: number; value: number }>; signal: Array<{ time: number; value: number }>; histogram: Array<{ time: number; value: number }> }
}

// Two jobs on one page, one ticker input:
//   • candles — native lightweight-charts OHLC + RSI/MACD/Bollinger from /api/charts
//   • pd|sent|ds — the high schoolers' research views, embedded Chart.js (ResearchChart)
type View = 'candles' | ResearchMode

const VIEWS: Array<{ key: View; label: string }> = [
  { key: 'candles', label: 'Candlestick + Indicators' },
  { key: 'pd',      label: 'Price + Density' },
  { key: 'sent',    label: 'Sentiment Score' },
  { key: 'ds',      label: 'Density vs Sentiment' },
]

// The data is 1-min EXTENDED-HOURS intraday only (no daily/weekly history, no
// fundamentals), so the controls are scoped to the intraday windows it supports.
type Win = 'full' | '2h' | '1h'
const WINDOWS: Array<{ key: Win; label: string }> = [
  { key: 'full', label: 'Full Day' },
  { key: '2h',   label: 'Last 2h' },
  { key: '1h',   label: 'Last 1h' },
]

export function ChartsPage() {
  // Ticker can arrive via ?t= (the Charts Grid links here for the clicked ticker).
  const [sp, setSp] = useSearchParams()
  const urlTicker = (sp.get('t') || '').toUpperCase().trim()
  const [input, setInput] = useState(urlTicker || 'AAPL')
  const [ticker, setTicker] = useState<string | null>(urlTicker || null)
  const [view, setView] = useState<View>('candles')
  const [win, setWin] = useState<Win>('full')
  const [data, setData] = useState<ChartData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [enrich, setEnrich] = useState<EnrichData | null>(null)

  // Price-chart bar timeframe (client-side resample) + density/sentiment overlays.
  // All three recompute from already-fetched data — no server round-trip.
  const [tf, setTf] = useState(1)
  const [showDensity, setShowDensity] = useState(false)
  const [showSentiment, setShowSentiment] = useState(false)
  const [social, setSocial] = useState<SocialSeries | null>(null)
  const [socialMsg, setSocialMsg] = useState('')
  const socialCache = useRef<Record<string, SocialSeries>>({})

  const load = useCallback(() => {
    const t = input.trim().toUpperCase()
    if (t) { setTicker(t); setSp({ t }, { replace: true }) }
  }, [input, setSp])

  // Follow ?t= changes (e.g. a grid cell clicked while this page is already open).
  useEffect(() => {
    const t = (sp.get('t') || '').toUpperCase().trim()
    if (t && t !== ticker) { setInput(t); setTicker(t) }
  }, [sp])  // eslint-disable-line react-hooks/exhaustive-deps

  // Per-ticker enrichments (news alert + 3-day news + social/gossip). DB reads.
  useEffect(() => {
    if (!ticker) { setEnrich(null); return }
    let cancelled = false
    fetch(`/api/ticker/${ticker}/enrich`)
      .then(r => r.json())
      .then(d => { if (!cancelled) setEnrich(d) })
      .catch(() => { if (!cancelled) setEnrich(null) })
    return () => { cancelled = true }
  }, [ticker])

  // Candlestick view fetches its own OHLC+indicators; research views are driven
  // by <ResearchChart> off the same ticker/window.
  useEffect(() => {
    if (!ticker || view !== 'candles') return
    let cancelled = false
    setLoading(true); setError(null)
    fetch(`/api/charts/${ticker}?window=${win}`)
      .then(r => r.json())
      .then((json: ChartData) => {
        if (cancelled) return
        if (json.error) { setError(json.error); setData(null) }
        else setData(json)
      })
      .catch(() => { if (!cancelled) setError('Failed to load chart data.') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [ticker, view, win])

  // Lazily fetch the social density/sentiment series — only once an overlay is
  // enabled on the candles view, and cached per (ticker, date) so timeframe
  // changes and toggles never re-fetch. Polls through the server's "walking"
  // StockTwits backfill the same way ResearchChart does.
  const wantOverlay = view === 'candles' && (showDensity || showSentiment)
  const chartDate = data?.date
  useEffect(() => {
    if (!wantOverlay || !ticker || !chartDate) return
    const key = `${ticker}|${chartDate}`
    if (socialCache.current[key]) { setSocial(socialCache.current[key]); setSocialMsg(''); return }
    let cancelled = false
    let timer: number | null = null
    setSocial(null); setSocialMsg('Loading social data…')
    const poll = async () => {
      try {
        const s = await fetch(`/api/chart/social?${new URLSearchParams({ ticker, date: chartDate })}`).then(r => r.json())
        if (cancelled) return
        if (s.error) { setSocialMsg('Social: ' + s.error); return }
        if (s.status === 'walking') { setSocialMsg(`Loading social history, ${s.count || 0} messages…`); timer = window.setTimeout(poll, 1500); return }
        if (!s.messages) { setSocialMsg('No social data for this day.'); return }
        const series: SocialSeries = { labels: s.labels, density: s.density, sent_labels: s.sent_labels, scores_smooth: s.scores_smooth }
        socialCache.current[key] = series
        setSocial(series); setSocialMsg(`Social: ${s.source} · ${s.messages} msgs`)
      } catch { if (!cancelled) setSocialMsg('Social data: error') }
    }
    poll()
    return () => { cancelled = true; if (timer) clearTimeout(timer) }
  }, [wantOverlay, ticker, chartDate])

  // Resample candles + (re)compute Bollinger + build overlays from already-fetched
  // data. Pure client-side: re-runs on timeframe / toggle / data change only.
  const priceView = useMemo(() => {
    const raw = (data?.candles ?? []) as any[]
    const candles = resampleCandles(raw as any, tf)
    // Default 1m keeps the server's Bollinger exactly; coarser timeframes recompute
    // it on the resampled closes so the band stays aligned to the bars.
    const bollinger = tf === 1 ? (data?.bollinger as any) : bollingerFromCandles(candles, 20, 2)
    // RSI/MACD recompute on the resampled closes at coarser timeframes so they
    // sit on the same time buckets as the candles (server values kept at 1m).
    const rsi = tf === 1 ? (data?.rsi as any) : rsiFromCandles(candles, 14)
    const macd = tf === 1 ? (data?.macd as any) : macdFromCandles(candles, 12, 26, 9)
    const ov = overlaySeries(raw as any, social, tf, 15)
    return {
      candles, bollinger, rsi, macd,
      density: showDensity ? ov.density : undefined,
      sentiment: showSentiment ? ov.sentiment : undefined,
      count: candles.length,
    }
  }, [data, tf, social, showDensity, showSentiment])

  return (
    <div>
      {/* Toolbar */}
      <div className="flex items-center gap-3 mb-2 flex-wrap">
        <input
          value={input}
          onChange={e => setInput(e.target.value.toUpperCase())}
          onKeyDown={e => e.key === 'Enter' && load()}
          placeholder="Ticker (e.g. AAPL)"
          className="w-[140px] bg-bg border border-border text-sm text-white rounded px-3 py-2 font-mono focus:outline-none focus:border-accent placeholder:text-slate-600"
        />
        <button
          onClick={load}
          disabled={!input.trim()}
          className="px-4 py-2 bg-accent text-white text-sm font-medium rounded hover:bg-sky-400 disabled:opacity-50 transition-colors"
        >
          {loading ? 'Loading…' : 'Load Chart'}
        </button>

        {/* Window selector (intraday only) */}
        <div className="flex items-stretch rounded overflow-hidden border border-border">
          {WINDOWS.map(w => (
            <button key={w.key} onClick={() => setWin(w.key)}
              className={`px-3 py-1.5 text-xs transition-colors ${win === w.key ? 'bg-accent text-white' : 'bg-surface text-neutral hover:text-white'}`}>
              {w.label}
            </button>
          ))}
        </div>

        {ticker && <span className="text-accent font-mono font-bold text-lg ml-1">{ticker}</span>}
        {/* Structured-news alert — fires only when FeedFlash has recent news for the ticker */}
        {enrich?.news_alert && (
          <span
            title={`${enrich.news_alert_count} structured news item(s) in the last 3 days`}
            className="flex items-center gap-1 text-[11px] font-semibold text-red-400 bg-red-500/10 border border-red-500/40 rounded px-2 py-0.5 animate-pulse"
          >
            ▲ NEWS {enrich.news_alert_count}
          </span>
        )}
        {data?.date && view === 'candles' && (
          <span className="text-xs text-neutral">{data.date} · {data.n} bars</span>
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
        <span className="ml-auto text-[10px] text-neutral pr-1">1-min intraday · extended hours 04:00–20:00 ET</span>
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
            ) : data ? (
              <div className="space-y-3">
                {/* Price-chart controls: client-side timeframe resample + overlays */}
                <div className="flex items-center gap-3 flex-wrap text-xs">
                  <div className="flex items-center gap-1">
                    <span className="text-neutral mr-1">Timeframe</span>
                    <div className="flex items-stretch rounded overflow-hidden border border-border">
                      {TIMEFRAMES.map(t => (
                        <button key={t.min} onClick={() => setTf(t.min)}
                          className={clsx('px-2.5 py-1 transition-colors',
                            tf === t.min ? 'bg-accent text-white' : 'bg-surface text-neutral hover:text-white')}>
                          {t.label}
                        </button>
                      ))}
                    </div>
                    <span className="text-neutral ml-1 tabular-nums">{priceView.count} bars</span>
                  </div>
                  <label className="flex items-center gap-1.5 cursor-pointer select-none">
                    <input type="checkbox" checked={showDensity} onChange={e => setShowDensity(e.target.checked)}
                      className="accent-orange-500 cursor-pointer" />
                    <span style={{ color: '#FF9800' }}>Density</span>
                  </label>
                  <label className="flex items-center gap-1.5 cursor-pointer select-none">
                    <input type="checkbox" checked={showSentiment} onChange={e => setShowSentiment(e.target.checked)}
                      className="accent-green-500 cursor-pointer" />
                    <span style={{ color: '#4CAF50' }}>Sentiment</span>
                  </label>
                  {(showDensity || showSentiment) && socialMsg && (
                    <span className="text-neutral">{socialMsg}</span>
                  )}
                  <span className="ml-auto text-[10px] text-neutral">1-min intraday only · resampled client-side</span>
                </div>
                <ChartCard title="Candlestick + Bollinger Bands (20,2)" height={300}>
                  <CandlestickChart candles={priceView.candles as any} bollinger={priceView.bollinger as any}
                    densityOverlay={priceView.density} sentimentOverlay={priceView.sentiment} />
                </ChartCard>
                <ChartCard title="RSI (14)" height={130}>
                  <RSIChart data={(priceView.rsi ?? []) as any} />
                </ChartCard>
                <ChartCard title="MACD (12, 26, 9)" height={150}>
                  <MACDChart data={priceView.macd as any} />
                </ChartCard>
              </div>
            ) : (
              <div className="text-neutral text-sm animate-pulse p-4">Loading chart…</div>
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
