'use client'
import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import { clsx } from 'clsx'
import { CandlestickChart } from './CandlestickChart'
import { RSIChart } from './RSIChart'
import { MACDChart } from './MACDChart'
import { ResearchChart, type ResearchMode } from './ResearchChart'
import { TickerEnrichPanels, type EnrichData } from './TickerEnrichPanels'
import { resampleCandles, bollingerFromCandles, rsiFromCandles, macdFromCandles, overlaySeries, bucketStart, ROLL_WINDOW_DEFAULT, type SocialSeries } from './chartAgg'
import type { StrategyMarker, NewsMarker } from './CandlestickChart'

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
//   • candles — native lightweight-charts OHLC + RSI/MACD/Bollinger from /api/sentchart/charts
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
  // Optional ?d=YYYY-MM-DD pins a historical session (phase-3 overlay demo:
  // aligns candles with the historical social snapshot). Absent = latest session.
  const urlDate = (sp.get('d') || '').trim()
  const [input, setInput] = useState(urlTicker || 'AAPL')
  const [ticker, setTicker] = useState<string | null>(urlTicker || null)
  const [view, setView] = useState<View>('candles')
  const [win, setWin] = useState<Win>('full')
  const [data, setData] = useState<ChartData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [enrich, setEnrich] = useState<EnrichData | null>(null)
  const [enrichLoaded, setEnrichLoaded] = useState(false)  // distinguishes "loading" from "no enrichment endpoint"

  // Price-chart bar timeframe (client-side resample) + density/sentiment overlays.
  // All three recompute from already-fetched data — no server round-trip.
  const [tf, setTf] = useState(1)
  const [showDensity, setShowDensity] = useState(false)
  const [showSentiment, setShowSentiment] = useState(false)
  const [social, setSocial] = useState<SocialSeries | null>(null)
  const [socialMsg, setSocialMsg] = useState('')
  const socialCache = useRef<Record<string, SocialSeries>>({})

  // Strategy indicator (entry/exit arrows) — a chart-only overlay like density/
  // sentiment. Fetched from /api/sentchart/signals once enabled, per ticker/window.
  const [showStrategy, setShowStrategy] = useState(false)
  // Trailing-stop % for the strategy exit. 30 is the professor's specified
  // default; tighter values (2/5/10) let the stop actually fire intraday.
  const [stopPct, setStopPct] = useState(30)
  const [signals, setSignals] = useState<StrategyMarker[] | null>(null)
  const [signalsMsg, setSignalsMsg] = useState('')

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
  // Note: this endpoint is optional — FlashFeed's backend may not implement it.
  // We check r.ok before parsing so a 404 degrades to a tidy empty state
  // (enrichLoaded=true, enrich=null) instead of a console error or stuck spinner.
  useEffect(() => {
    if (!ticker) { setEnrich(null); setEnrichLoaded(false); return }
    let cancelled = false
    setEnrich(null); setEnrichLoaded(false)
    fetch(`/api/ticker/${ticker}/enrich`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (!cancelled) { setEnrich(d); setEnrichLoaded(true) } })
      .catch(() => { if (!cancelled) { setEnrich(null); setEnrichLoaded(true) } })
    return () => { cancelled = true }
  }, [ticker])

  // Candlestick view fetches its own OHLC+indicators; research views are driven
  // by <ResearchChart> off the same ticker/window.
  useEffect(() => {
    if (!ticker || view !== 'candles') return
    let cancelled = false
    setLoading(true); setError(null)
    fetch(`/api/sentchart/charts/${ticker}?window=${win}${urlDate ? `&date=${urlDate}` : ''}`)
      .then(r => r.json())
      .then((json: ChartData) => {
        if (cancelled) return
        if (json.error) { setError(json.error); setData(null) }
        else setData(json)
      })
      .catch(() => { if (!cancelled) setError('Failed to load chart data.') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [ticker, view, win, urlDate])

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
        const s = await fetch(`/api/sentchart/chart/social?${new URLSearchParams({ ticker, date: chartDate })}`).then(r => r.json())
        if (cancelled) return
        if (s.error) { setSocialMsg('Social: ' + s.error); return }
        if (s.status === 'walking') { setSocialMsg(`Loading social history, ${s.count || 0} messages…`); timer = window.setTimeout(poll, 1500); return }
        if (!s.messages) { setSocialMsg('No social data for this day.'); return }
        const series: SocialSeries = { labels: s.labels, density: s.density, sent_labels: s.sent_labels, scores_smooth: s.scores_smooth, roll_window: s.roll_window }
        socialCache.current[key] = series
        setSocial(series); setSocialMsg(`Social: ${s.source} · ${s.messages} msgs`)
      } catch { if (!cancelled) setSocialMsg('Social data: error') }
    }
    poll()
    return () => { cancelled = true; if (timer) clearTimeout(timer) }
  }, [wantOverlay, ticker, chartDate])

  // Strategy entry/exit markers — fetched only once the indicator is toggled on,
  // for the candles view, per (ticker, window, date). The backend computes on the
  // full session and returns markers already filtered to the requested window.
  const wantStrategy = view === 'candles' && showStrategy
  useEffect(() => {
    if (!wantStrategy || !ticker) return
    let cancelled = false
    setSignals(null); setSignalsMsg('Loading strategy signals…')
    fetch(`/api/sentchart/signals/${ticker}?window=${win}&stop_pct=${stopPct}${urlDate ? `&date=${urlDate}` : ''}`)
      .then(r => r.json())
      .then((j: { markers?: StrategyMarker[]; trades?: number; error?: string; note?: string }) => {
        if (cancelled) return
        if (j.error) { setSignals(null); setSignalsMsg('Strategy: ' + j.error); return }
        const markers = j.markers ?? []
        setSignals(markers)
        setSignalsMsg(markers.length
          ? `Strategy: ${j.trades ?? 0} trade(s) · ${markers.length} markers`
          : (j.note || 'Strategy: no signals for this session'))
      })
      .catch(() => { if (!cancelled) setSignalsMsg('Strategy: error') })
    return () => { cancelled = true }
  }, [wantStrategy, ticker, win, urlDate, stopPct])

  // Snap marker times onto the active timeframe's bucket so the arrows stay
  // registered to the resampled candles (1m is a no-op). Off => undefined.
  const strategyMarkers = useMemo(() => {
    if (!showStrategy || !signals) return undefined
    return signals.map(m => ({ ...m, time: bucketStart(m.time, tf) }))
  }, [showStrategy, signals, tf])

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
    const ov = overlaySeries(raw as any, social, tf, social?.roll_window ?? ROLL_WINDOW_DEFAULT)
    return {
      candles, bollinger, rsi, macd,
      density: showDensity ? ov.density : undefined,
      sentiment: showSentiment ? ov.sentiment : undefined,
      count: candles.length,
    }
  }, [data, tf, social, showDensity, showSentiment])

  // News-on-candle markers — reuse the already-fetched enrich News feed. A dot
  // above the bar at each article's publish time, colored by sentiment, snapped
  // to the active timeframe grid. Only articles whose publish time falls within
  // the charted session are shown. NOTE: enrich News is a last-3-days window, so
  // these stay empty until fresh same-session news lands — expected, not a bug.
  const newsMarkers = useMemo<NewsMarker[] | undefined>(() => {
    const arts = enrich?.news?.articles
    const candles = priceView.candles as Array<{ time: number }>
    if (!arts?.length || !candles.length) return undefined
    const first = candles[0].time
    const last = candles[candles.length - 1].time
    const out: NewsMarker[] = []
    for (const a of arts) {
      const ts = a.published_at
      if (!ts || ts < first || ts > last) continue
      out.push({ time: bucketStart(ts, tf), sentiment: a.sentiment ?? null, headline: a.headline })
    }
    return out.length ? out : undefined
  }, [enrich, priceView, tf])

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
                  <label className="flex items-center gap-1.5 cursor-pointer select-none">
                    <input type="checkbox" checked={showStrategy} onChange={e => setShowStrategy(e.target.checked)}
                      className="accent-sky-500 cursor-pointer" />
                    <span className="text-accent">Strategy ▲▼</span>
                  </label>
                  {showStrategy && (
                    <label className="flex items-center gap-1 select-none">
                      <span className="text-neutral">Stop</span>
                      <select value={stopPct} onChange={e => setStopPct(Number(e.target.value))}
                        className="bg-surface border border-border rounded px-1 py-0.5 text-xs text-white cursor-pointer">
                        {[2, 5, 10, 30].map(p => (
                          <option key={p} value={p}>{p}%{p === 30 ? ' (spec)' : ''}</option>
                        ))}
                      </select>
                    </label>
                  )}
                  {(showDensity || showSentiment) && socialMsg && (
                    <span className="text-neutral">{socialMsg}</span>
                  )}
                  {showStrategy && signalsMsg && (
                    <span className="text-neutral">{signalsMsg}</span>
                  )}
                  <span className="ml-auto text-[10px] text-neutral">1-min intraday only · resampled client-side</span>
                </div>
                <ChartCard title="Candlestick + Bollinger Bands (20,2)" height={300}>
                  <CandlestickChart candles={priceView.candles as any} bollinger={priceView.bollinger as any}
                    densityOverlay={priceView.density} sentimentOverlay={priceView.sentiment}
                    strategyMarkers={strategyMarkers} newsMarkers={newsMarkers} />
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
              <ResearchChart ticker={ticker} mode={view} window={win} date={urlDate} />
            </div>
          )}

          {/* Per-ticker enrichments below the chart: 3-day news + social/gossip */}
          <TickerEnrichPanels ticker={ticker} enrich={enrich} loaded={enrichLoaded} />
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
