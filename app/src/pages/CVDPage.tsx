import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Chart from 'chart.js/auto'
import zoomPlugin from 'chartjs-plugin-zoom'
import { clsx } from 'clsx'
import { useSearchParams } from 'react-router-dom'
import { useTickerDatalistOptions } from '@/lib/useTickerUniverse'

Chart.register(zoomPlugin)

type Method = 'best' | 'bvc' | 'wick'

interface Candle {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

interface CvdRow {
  time: number
  volume: number
  delta_best: number
  delta_bvc: number
  delta_wick: number
  cvd_best: number
  cvd_bvc: number
  cvd_wick: number
  quality: 'measured' | 'estimated_bvc'
  measured_trades: number
  is_auction: boolean
  close?: number
  normalized_cvd_pct: number
  flow_imbalance_pct: number
  window_price_return_pct: number
  method_agreement: number
  reliability: number
  session_phase: string
  signal: CvdSignal
  signal_confidence: number
  signal_reason: string
  entry_confirmation: boolean
  exit_warning: boolean
}

type CvdSignal = 'neutral' | 'observe_only' | 'opening_noise_guard' | 'low_confidence'
  | 'buying_confirmation' | 'selling_confirmation' | 'bullish_divergence' | 'bearish_divergence'

interface CvdEvent {
  time: number
  signal: CvdSignal
  signal_direction: number
  signal_confidence: number
  signal_reason: string
  flow_imbalance_pct: number
  window_price_return_pct: number
  normalized_cvd_pct: number
  method_agreement: number
  reliability: number
  session_phase: string
  quality: string
  close?: number
}

interface CvdBubble {
  time: number
  z: number
  delta: number
  side: 'buy' | 'sell'
  quality: string
}

interface CvdPayload {
  ticker: string
  date?: string
  error?: string
  provenance?: 'measured' | 'mixed' | 'estimated'
  coverage?: number
  measured_minutes?: number
  candles: Candle[]
  rows: CvdRow[]
  bubbles?: CvdBubble[]
  events?: CvdEvent[]
  analysis?: {
    latest_signal: CvdSignal
    latest_reason: string
    latest_confidence: number
    normalized_cvd_pct: number
    flow_imbalance_pct: number
    method_agreement: number
    reliability: number
    session_phase?: string
    research_only: boolean
  }
  signal_policy?: { window_minutes?: number; status?: string }
  measured_source?: { configured?: boolean; status?: 'disabled' | 'empty' | 'ready' | 'error'; error?: string | null }
}

const methodMeta: Record<Method, { label: string; color: string; field: keyof CvdRow; delta: keyof CvdRow }> = {
  best: { label: 'Best available', color: '#22d3ee', field: 'cvd_best', delta: 'delta_best' },
  bvc: { label: 'BVC estimate', color: '#a78bfa', field: 'cvd_bvc', delta: 'delta_bvc' },
  wick: { label: 'Wick estimate', color: '#f59e0b', field: 'cvd_wick', delta: 'delta_wick' },
}

function formatEt(epoch: number) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC', hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(new Date(epoch * 1000))
}

function compactNumber(value: number) {
  const sign = value > 0 ? '+' : ''
  const abs = Math.abs(value)
  if (abs >= 1_000_000) return `${sign}${(value / 1_000_000).toFixed(2)}M`
  if (abs >= 1_000) return `${sign}${(value / 1_000).toFixed(1)}K`
  return `${sign}${value.toFixed(0)}`
}

function signedPercent(value: number, digits = 1) {
  if (!Number.isFinite(value)) return '--'
  return `${value > 0 ? '+' : ''}${value.toFixed(digits)}%`
}

const signalMeta: Record<CvdSignal, { label: string; tone: string }> = {
  neutral: { label: 'No CVD alignment', tone: 'border-slate-600 text-slate-300' },
  observe_only: { label: 'Extended-hours observation', tone: 'border-slate-600 text-slate-300' },
  opening_noise_guard: { label: 'Opening guard active', tone: 'border-amber-500/50 text-amber-300' },
  low_confidence: { label: 'Low estimator agreement', tone: 'border-amber-500/50 text-amber-300' },
  buying_confirmation: { label: 'Buying pressure alignment', tone: 'border-emerald-500/50 text-emerald-300' },
  selling_confirmation: { label: 'Selling pressure alignment', tone: 'border-red-500/50 text-red-300' },
  bullish_divergence: { label: 'Bullish divergence', tone: 'border-sky-500/50 text-sky-300' },
  bearish_divergence: { label: 'Bearish divergence', tone: 'border-orange-500/50 text-orange-300' },
}

function zoomOptions() {
  return {
    pan: { enabled: true, mode: 'x' as const, threshold: 4 },
    zoom: {
      wheel: { enabled: true, speed: 0.1 },
      pinch: { enabled: true },
      mode: 'x' as const,
    },
    limits: { x: { min: 'original' as const, max: 'original' as const, minRange: 15 * 60 } },
  }
}

function axisTimeLabel(value: string | number) {
  return formatEt(Number(value))
}

function useCvdCharts(
  priceCanvas: React.RefObject<HTMLCanvasElement>,
  cvdCanvas: React.RefObject<HTMLCanvasElement>,
  payload: CvdPayload | null,
  methods: Set<Method>,
) {
  const priceChart = useRef<Chart | null>(null)
  const cvdChart = useRef<Chart | null>(null)

  useEffect(() => {
    priceChart.current?.destroy()
    cvdChart.current?.destroy()
    priceChart.current = null
    cvdChart.current = null
    if (!payload?.candles?.length || !payload.rows?.length || !priceCanvas.current || !cvdCanvas.current) return

    const compact = window.innerWidth < 640
    const closeByTime = new Map(payload.candles.map(row => [row.time, row.close]))
    const pricePoints = payload.candles.map(row => ({ x: row.time, y: row.close }))
    const bubbles = (payload.bubbles || [])
      .filter(row => closeByTime.has(row.time))
      .map(row => ({ x: row.time, y: closeByTime.get(row.time), z: row.z, side: row.side, quality: row.quality }))
    const signalPoints = (payload.events || [])
      .filter(row => closeByTime.has(row.time))
      .map(row => ({
        x: row.time,
        y: closeByTime.get(row.time),
        signal: row.signal,
        confidence: row.signal_confidence,
        reason: row.signal_reason,
      }))

    priceChart.current = new Chart(priceCanvas.current, {
      type: 'line',
      data: {
        datasets: [
          {
            label: `${payload.ticker} close`, data: pricePoints,
            borderColor: '#38bdf8', borderWidth: 1.8, pointRadius: 0, tension: 0.12,
          },
          {
            type: 'bubble', label: 'Pressure outlier', data: bubbles as any,
            backgroundColor: (ctx: any) => ctx.raw?.side === 'buy' ? 'rgba(16,185,129,.78)' : 'rgba(239,68,68,.78)',
            borderColor: (ctx: any) => ctx.raw?.quality === 'measured' ? '#f8fafc' : 'rgba(226,232,240,.35)',
            borderWidth: 1,
            radius: (ctx: any) => Math.min(10, 3 + Math.abs(Number(ctx.raw?.z || 0)) * 1.7),
          } as any,
          {
            type: 'line', label: 'CVD research signal', data: signalPoints as any,
            showLine: false, pointStyle: 'triangle', pointRadius: 7, pointHoverRadius: 9,
            pointRotation: (ctx: any) => String(ctx.raw?.signal || '').includes('bearish') || String(ctx.raw?.signal || '').includes('selling') ? 180 : 0,
            pointBackgroundColor: (ctx: any) => String(ctx.raw?.signal || '').includes('bearish') || String(ctx.raw?.signal || '').includes('selling') ? '#fb7185' : '#34d399',
            pointBorderColor: '#f8fafc', pointBorderWidth: 1,
          } as any,
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        parsing: false, interaction: { mode: 'nearest', intersect: false },
        plugins: {
          legend: { labels: { color: '#cbd5e1', boxWidth: 12 } },
          tooltip: {
            callbacks: {
              title: items => items[0] ? formatEt(Number((items[0].raw as any).x)) : '',
              afterBody: items => {
                const raw = items[0]?.raw as any
                return raw?.reason ? [`${signalMeta[raw.signal as CvdSignal]?.label || raw.signal}`, raw.reason] : []
              },
            },
          },
          zoom: zoomOptions(),
        },
        scales: {
          x: { type: 'linear', grid: { color: 'rgba(51,65,85,.45)' }, ticks: { color: '#cbd5e1', callback: axisTimeLabel, maxRotation: 0, maxTicksLimit: compact ? 5 : 12 } },
          y: { position: 'right', grid: { color: 'rgba(51,65,85,.45)' }, ticks: { color: '#7dd3fc' } },
        },
      },
    })

    const selected = Array.from(methods)
    const lineDatasets = selected.map(method => {
      const meta = methodMeta[method]
      return {
        type: 'line' as const,
        label: compact ? (method === 'best' ? 'Best' : method.toUpperCase()) : meta.label,
        data: payload.rows.map(row => ({ x: row.time, y: Number(row[meta.field]) })),
        borderColor: meta.color, backgroundColor: meta.color,
        borderWidth: method === 'best' ? 2.2 : 1.4, pointRadius: 0, tension: 0.1, yAxisID: 'y',
      }
    })
    const primary = methods.has('best') ? 'best' : selected[0] || 'best'
    const deltaField = methodMeta[primary].delta
    const deltaDataset = {
      type: 'bar' as const, label: compact ? 'Delta' : `${methodMeta[primary].label} delta`,
      data: payload.rows.map(row => ({ x: row.time, y: Number(row[deltaField]) })),
      backgroundColor: payload.rows.map(row => Number(row[deltaField]) >= 0 ? 'rgba(16,185,129,.34)' : 'rgba(239,68,68,.34)'),
      borderWidth: 0, yAxisID: 'delta', barPercentage: 1, categoryPercentage: 1,
    }
    const normalizedDataset = {
      type: 'line' as const, label: compact ? 'Normalized %' : 'Normalized CVD (% of session volume)',
      data: payload.rows.map(row => ({ x: row.time, y: Number(row.normalized_cvd_pct) })),
      borderColor: '#fbbf24', backgroundColor: '#fbbf24', borderDash: [5, 4],
      borderWidth: 1.5, pointRadius: 0, tension: 0.1, yAxisID: 'normalized',
    }

    cvdChart.current = new Chart(cvdCanvas.current, {
      type: 'line',
      data: { datasets: [...lineDatasets, normalizedDataset, deltaDataset] as any },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        parsing: false, interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { labels: { color: '#cbd5e1', boxWidth: 12 } },
          tooltip: { callbacks: { title: items => items[0] ? formatEt(Number((items[0].raw as any).x)) : '' } },
          zoom: zoomOptions(),
        },
        scales: {
          x: { type: 'linear', grid: { color: 'rgba(51,65,85,.45)' }, ticks: { color: '#cbd5e1', callback: axisTimeLabel, maxRotation: 0, maxTicksLimit: compact ? 5 : 12 } },
          y: { position: 'left', grid: { color: 'rgba(51,65,85,.45)' }, ticks: { color: '#cbd5e1', callback: value => compactNumber(Number(value)) } },
          normalized: { position: 'right', min: -100, max: 100, grid: { drawOnChartArea: false }, ticks: { color: '#fbbf24', callback: value => `${value}%` } },
          delta: { position: 'right', grid: { drawOnChartArea: false }, ticks: { color: '#94a3b8', callback: value => compactNumber(Number(value)) } },
        },
      },
    })

    return () => {
      priceChart.current?.destroy()
      cvdChart.current?.destroy()
      priceChart.current = null
      cvdChart.current = null
    }
  }, [payload, methods, priceCanvas, cvdCanvas])

  return () => {
    priceChart.current?.resetZoom()
    cvdChart.current?.resetZoom()
  }
}

export function CVDPage() {
  const [params, setParams] = useSearchParams()
  const initialTicker = (params.get('t') || '').toUpperCase().trim()
  const initialWindow = [15, 30, 60].includes(Number(params.get('aw'))) ? Number(params.get('aw')) : 30
  const [input, setInput] = useState(initialTicker)
  const [ticker, setTicker] = useState(initialTicker)
  const [analysisWindow, setAnalysisWindow] = useState(initialWindow)
  const [payload, setPayload] = useState<CvdPayload | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [methods, setMethods] = useState<Set<Method>>(new Set(['best', 'bvc']))
  const tickerOptions = useTickerDatalistOptions(input)
  const priceCanvas = useRef<HTMLCanvasElement>(null)
  const cvdCanvas = useRef<HTMLCanvasElement>(null)
  const resetZoom = useCvdCharts(priceCanvas, cvdCanvas, payload, methods)

  useEffect(() => {
    if (ticker) return
    fetch('/api/ai/rankings?days=3&limit=1&window_minutes=1440&min_score=0')
      .then(response => response.json())
      .then(json => {
        const top = String(json?.rows?.[0]?.ticker || '').toUpperCase().trim()
        if (!top) return
        setInput(top); setTicker(top); setParams({ t: top, aw: String(analysisWindow) }, { replace: true })
      })
      .catch(() => {})
  }, [ticker, setParams, analysisWindow])

  useEffect(() => {
    if (!ticker) return
    let cancelled = false
    setLoading(true); setError('')
    fetch(`/api/sentchart/cvd/${encodeURIComponent(ticker)}?analysis_window=${analysisWindow}`)
      .then(async response => {
        const json = await response.json() as CvdPayload
        if (!response.ok || json.error) throw new Error(json.error || 'CVD service unavailable.')
        return json
      })
      .then(json => { if (!cancelled) setPayload(json) })
      .catch(err => { if (!cancelled) { setPayload(null); setError(String(err.message || err)) } })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [ticker, analysisWindow])

  const load = useCallback(() => {
    const next = input.toUpperCase().trim()
    if (!next) return
    setTicker(next); setParams({ t: next, aw: String(analysisWindow) }, { replace: true })
  }, [input, setParams, analysisWindow])

  const latest = payload?.rows?.[payload.rows.length - 1]
  const measuredPct = Math.round(Number(payload?.coverage || 0) * 100)
  const quality = payload?.provenance || 'estimated'
  const measuredSourceStatus = payload?.measured_source?.status
  const qualityLabel = measuredSourceStatus === 'error'
    ? 'Measured feed unavailable'
    : quality === 'estimated'
      ? (measuredSourceStatus === 'empty' ? 'Estimated · no ticks' : 'Estimated bars')
      : quality === 'mixed'
        ? `Mixed · ${measuredPct}%`
        : 'Measured ticks'
  const analysis = payload?.analysis
  const latestSignal = analysis?.latest_signal || latest?.signal || 'neutral'
  const currentSignal = signalMeta[latestSignal]
  const methodButtons = useMemo(() => (Object.keys(methodMeta) as Method[]), [])

  const toggleMethod = (method: Method) => {
    setMethods(current => {
      const next = new Set(current)
      if (next.has(method) && next.size > 1) next.delete(method)
      else next.add(method)
      return next
    })
  }

  return (
    <div className="flex h-full min-h-0 w-full max-w-[100vw] flex-col overflow-x-hidden overflow-y-auto p-3 sm:p-4">
      <div className="flex flex-wrap items-center gap-2 border-b border-border pb-3">
        <input
          value={input} onChange={event => setInput(event.target.value.toUpperCase())}
          onKeyDown={event => { if (event.key === 'Enter') load() }}
          list="cvd-ticker-options" placeholder="Ticker"
          className="h-10 w-36 rounded border border-border bg-bg px-3 font-mono text-sm text-neutral outline-none focus:border-accent"
        />
        <datalist id="cvd-ticker-options">
          {tickerOptions.map(row => <option key={row.ticker} value={row.ticker}>{row.company || row.ticker}</option>)}
        </datalist>
        <button onClick={load} className="h-10 rounded bg-sky-700 px-4 text-sm font-semibold text-white hover:bg-sky-800">Load CVD</button>
        <label className="flex h-9 items-center gap-2 rounded border border-border bg-bg px-2 text-[10px] font-semibold uppercase text-slate-400">
          Analysis
          <select
            value={analysisWindow}
            onChange={event => {
              const next = Number(event.target.value)
              setAnalysisWindow(next)
              if (ticker) setParams({ t: ticker, aw: String(next) }, { replace: true })
            }}
            className="bg-bg font-mono text-xs text-neutral outline-none"
          >
            <option value={15}>15m</option>
            <option value={30}>30m</option>
            <option value={60}>60m</option>
          </select>
        </label>
        <div className="order-last grid w-full max-w-full grid-cols-3 overflow-hidden rounded border border-border sm:order-none sm:ml-1 sm:flex sm:w-auto">
          {methodButtons.map(method => (
            <button
              key={method} onClick={() => toggleMethod(method)}
              className={clsx('h-9 min-w-0 whitespace-nowrap border-r border-border px-2 text-xs font-semibold last:border-r-0 sm:flex-none sm:px-3', methods.has(method) ? 'bg-surface text-neutral' : 'bg-bg text-slate-500')}
            >
              <span className="sm:hidden">{method === 'best' ? 'Best' : method.toUpperCase()}</span>
              <span className="hidden sm:inline">{methodMeta[method].label}</span>
            </button>
          ))}
        </div>
        <button onClick={resetZoom} className="h-9 rounded border border-border bg-bg px-3 text-xs font-semibold text-neutral hover:border-accent">Reset zoom</button>
      </div>

      <div className="grid grid-cols-2 gap-px border-b border-border bg-border md:grid-cols-6">
        <Metric label="Ticker" value={payload?.ticker || ticker || '--'} accent />
        <Metric label="Session" value={payload?.date || '--'} />
        <Metric label="Data quality" value={qualityLabel} quality={measuredSourceStatus === 'error' ? 'error' : quality} />
        <Metric label="Normalized CVD" value={latest ? signedPercent(latest.normalized_cvd_pct) : '--'} positive={Boolean(latest && latest.normalized_cvd_pct >= 0)} />
        <Metric label={`${analysisWindow}m flow`} value={latest ? signedPercent(latest.flow_imbalance_pct) : '--'} positive={Boolean(latest && latest.flow_imbalance_pct >= 0)} />
        <Metric label="Reliability" value={latest ? `${Math.round(latest.reliability * 100)}%` : '--'} />
      </div>

      {!loading && !error && payload && (
        <div className="grid gap-px border-b border-border bg-border md:grid-cols-[minmax(13rem,0.7fr)_minmax(20rem,2fr)_minmax(18rem,1fr)]">
          <div className="bg-bg px-3 py-2.5">
            <div className="mb-1 text-[10px] font-semibold uppercase text-slate-500">CVD research state</div>
            <span className={clsx('inline-flex rounded border px-2 py-1 text-xs font-semibold', currentSignal.tone)}>{currentSignal.label}</span>
          </div>
          <div className="bg-bg px-3 py-2.5">
            <div className="mb-1 text-[10px] font-semibold uppercase text-slate-500">Why</div>
            <div className="text-xs leading-5 text-slate-300">{analysis?.latest_reason || latest?.signal_reason || 'Waiting for CVD analysis.'}</div>
          </div>
          <div className="grid grid-cols-3 gap-px bg-border">
            <MiniMetric label="Agreement" value={latest ? `${Math.round(latest.method_agreement * 100)}%` : '--'} />
            <MiniMetric label="Confidence" value={latest ? `${Math.round(latest.signal_confidence * 100)}%` : '--'} />
            <MiniMetric label="Phase" value={(latest?.session_phase || '--').replace('_', ' ')} />
          </div>
        </div>
      )}

      {loading && <div className="flex min-h-[420px] items-center justify-center text-sm text-slate-400">Loading CVD session...</div>}
      {error && <div className="m-4 rounded border border-bear/40 bg-bear/10 p-4 text-sm text-red-200">{error}</div>}
      {!loading && !error && payload && (
        <div className="grid min-h-[720px] flex-1 grid-rows-2 gap-3 py-3">
          <section className="min-h-0 overflow-hidden rounded border border-border bg-surface">
            <div className="flex h-10 min-w-0 items-center justify-between gap-2 border-b border-border px-3">
              <h2 className="text-xs font-semibold uppercase text-neutral">Price + pressure events</h2>
              <span className="hidden truncate font-mono text-[11px] text-slate-400 sm:block">ET · scroll/pinch zoom · drag pan</span>
            </div>
            <div className="h-[calc(100%-2.5rem)] p-2"><canvas ref={priceCanvas} /></div>
          </section>
          <section className="min-h-0 overflow-hidden rounded border border-border bg-surface">
            <div className="flex h-10 min-w-0 items-center justify-between gap-2 border-b border-border px-3">
              <h2 className="text-xs font-semibold uppercase text-neutral">Cumulative volume delta</h2>
              <span className="hidden truncate font-mono text-[11px] text-slate-400 sm:block">{payload.measured_minutes || 0} measured minutes</span>
            </div>
            <div className="h-[calc(100%-2.5rem)] p-2"><canvas ref={cvdCanvas} /></div>
          </section>
        </div>
      )}
    </div>
  )
}

function Metric({ label, value, accent, quality, positive }: { label: string; value: string; accent?: boolean; quality?: string; positive?: boolean }) {
  return (
    <div className="min-w-0 bg-bg px-3 py-2">
      <div className="text-[10px] font-semibold uppercase text-slate-500">{label}</div>
      <div className={clsx(
        'truncate font-mono text-sm font-semibold text-neutral',
        accent && 'text-sky-400',
        quality === 'measured' && 'text-emerald-400',
        quality === 'mixed' && 'text-amber-300',
        quality === 'estimated' && 'text-slate-300',
        quality === 'error' && 'text-red-400',
        positive === true && 'text-emerald-400',
        positive === false && 'text-red-400',
      )}>{value}</div>
    </div>
  )
}

function MiniMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 bg-bg px-2 py-2.5 text-center">
      <div className="text-[9px] font-semibold uppercase text-slate-500">{label}</div>
      <div className="mt-1 truncate font-mono text-[11px] font-semibold capitalize text-neutral">{value}</div>
    </div>
  )
}
