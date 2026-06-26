'use client'
import { useEffect, useRef, useState } from 'react'
import Chart from 'chart.js/auto'
import { smoothSame } from '@/lib/chartAgg'

// ── Embedded Chart.js research views ─────────────────────────────────────────
// Faithful React port of the legacy dashboard's three research charts (the views
// the professor pushed on): Price+Density, Sentiment Score, and Density-vs-
// Sentiment. The smoothing/windowing math is NOT re-derived here — it stays in
// the Flask backend (_smooth_same, 5-min sliding sentiment); this component only
// plots the server-computed series from /api/chart + /api/chart/social, so it
// can't silently diverge from the research scripts.
//
// A single <canvas> is driven by Chart.js on a ref. The instance is destroyed
// before every rebuild and on unmount (the multi-instance lifecycle discipline
// from NOTES.md — never leave a live Chart.js on a reused canvas).

export type ResearchMode = 'pd' | 'sent' | 'ds'
type Win = 'full' | '2h' | '1h'

interface SocialData {
  labels: string[]; density: number[]; density_smooth: number[]
  sent_labels: string[]; scores: number[]; scores_smooth: number[]
  win_density: number[]; win_density_smooth: number[]
  messages: number; bullish: number; bearish: number
  source?: string; complete?: boolean; coverage_start?: string
  status?: string; count?: number; error?: string
}
interface PriceData { ticker: string; date: string; labels: string[]; prices: number[]; volumes: number[]; error?: string }

const fetchJSON = (url: string) => fetch(url).then(r => r.json())

const mapBy = (labels: string[], values: number[]) => {
  const m: Record<string, number> = {}
  labels.forEach((l, i) => { m[l] = values[i] })
  return m
}

// smoothSame (the backend _smooth_same port) lives in @/lib/chartAgg now, shared
// with the candlestick overlays so both views smooth density identically.
const atMap = (m: Record<string, number>) => (l: string): number | null => (l in m ? m[l] : null)

// Research x-axis: full session uses the social per-minute timeline; 2h/1h follow
// the price window so the zoom controls keep working (legacy _researchLabels).
function researchLabels(d: PriceData, social: SocialData, win: Win): string[] {
  if (win === 'full') return social.labels
  const lo = d.labels[0], hi = d.labels[d.labels.length - 1]
  return social.labels.filter(l => l >= lo && l <= hi)
}

// Red dashed at 09:30, purple dashed at 16:00 (research scripts' axvline cues).
const marketLinesPlugin = {
  id: 'marketLines',
  afterDatasetsDraw(chart: any) {
    const { ctx, chartArea, scales: { x } } = chart
    if (!chartArea) return
    const labels: string[] = chart.data.labels || []
    ;[['09:30', 'rgba(239,68,68,.75)'], ['16:00', 'rgba(139,92,246,.85)']].forEach(([t, col]) => {
      let i = labels.indexOf(t)
      if (i < 0) i = labels.findIndex(l => l >= t)
      if (i < 0 || labels[0] > t) return
      const px = x.getPixelForValue(i)
      ctx.save()
      ctx.strokeStyle = col; ctx.setLineDash([4, 3]); ctx.lineWidth = 1.2
      ctx.beginPath(); ctx.moveTo(px, chartArea.top); ctx.lineTo(px, chartArea.bottom); ctx.stroke()
      ctx.restore()
    })
  },
}

// Zero baseline for sentiment axes (the scripts' axhline(0)).
const zeroLinePlugin = {
  id: 'zeroLine',
  afterDatasetsDraw(chart: any, _a: any, opts: any) {
    if (!opts || !opts.scale) return
    const sc = chart.scales[opts.scale], area = chart.chartArea
    if (!sc || !area) return
    const y = sc.getPixelForValue(0)
    if (y < area.top || y > area.bottom) return
    const ctx = chart.ctx
    ctx.save()
    ctx.strokeStyle = 'rgba(200,200,200,.45)'; ctx.lineWidth = .8
    ctx.beginPath(); ctx.moveTo(area.left, y); ctx.lineTo(area.right, y); ctx.stroke()
    ctx.restore()
  },
}

// High/Low peak markers on the price series (Combined script's scatter+annotate).
const hiLoPlugin = {
  id: 'hiLo',
  afterDatasetsDraw(chart: any, _a: any, opts: any) {
    if (!opts || !opts.enabled) return
    const data: (number | null)[] = chart.data.datasets[0].data, labels: string[] = chart.data.labels
    let hi = -1, lo = -1
    data.forEach((v, i) => {
      if (v == null) return
      if (hi < 0 || v > (data[hi] as number)) hi = i
      if (lo < 0 || v < (data[lo] as number)) lo = i
    })
    if (hi < 0) return
    const meta = chart.getDatasetMeta(0), ctx = chart.ctx
    const draw = (i: number, col: string, txt: string, dy: number) => {
      const el = meta.data[i]; if (!el) return
      ctx.save()
      ctx.fillStyle = col
      ctx.beginPath(); ctx.arc(el.x, el.y, 4, 0, Math.PI * 2); ctx.fill()
      ctx.font = '9px monospace'; ctx.textAlign = 'left'
      const tx = Math.min(el.x + 8, chart.chartArea.right - 90)
      ctx.fillText(txt, tx, el.y + dy)
      ctx.fillText(labels[i], tx, el.y + dy + 10)
      ctx.restore()
    }
    draw(hi, '#2ea043', `High: $${(data[hi] as number).toFixed(2)}`, -14)
    draw(lo, '#e5534b', `Low: $${(data[lo] as number).toFixed(2)}`, 16)
  },
}

function buildConfig(mode: ResearchMode, d: PriceData, social: SocialData, win: Win, windowMin = 15): any {
  const labels = researchLabels(d, social, win)
  Chart.defaults.color = '#4e5567'
  const baseOpts = {
    responsive: true, maintainAspectRatio: false, animation: false as const,
    interaction: { mode: 'index' as const, intersect: false },
  }

  if (mode === 'pd') {
    const prices = labels.map(atMap(mapBy(d.labels, d.prices)))
    const dens   = labels.map(atMap(mapBy(social.labels, social.density)))
    // Rolling-window density is recomputed client-side over the raw per-minute
    // `social.density` for the slider's window (1..60 min); k=15 == server's
    // density_smooth. Price (above) is independent of the window and unchanged.
    const densSm = labels.map(atMap(mapBy(social.labels, smoothSame(social.density, windowMin))))
    const pVals = prices.filter((v): v is number => v != null)
    const pMin = Math.min(...pVals), pMax = Math.max(...pVals)
    const maxDen = Math.max(...social.density, 1)
    return {
      type: 'line',
      data: { labels, datasets: [
        { label: 'Close price', data: prices, yAxisID: 'y1', spanGaps: true,
          borderColor: '#2196F3', borderWidth: 1.4, tension: .1, pointRadius: 0,
          fill: { target: { value: pMin } }, backgroundColor: 'rgba(33,150,243,.08)' },
        { label: 'Messages/min', type: 'bar', data: dens, yAxisID: 'y2',
          backgroundColor: 'rgba(144,202,249,.5)', borderWidth: 0,
          barPercentage: 1, categoryPercentage: 1 },
        { label: `${windowMin}-min avg density`, data: densSm, yAxisID: 'y2', spanGaps: true,
          borderColor: '#FF9800', borderWidth: 2, tension: .1, pointRadius: 0 },
      ] },
      plugins: [marketLinesPlugin, hiLoPlugin],
      options: { ...baseOpts,
        plugins: { legend: { display: true, labels: { font: { size: 9 }, boxWidth: 12 } }, hiLo: { enabled: true } },
        scales: {
          x: { grid: { color: '#1e2330' }, ticks: { font: { size: 8 }, maxTicksLimit: 16 } },
          y1: { position: 'left', min: pMin * 0.97, max: pMax * 1.08,
                grid: { color: '#1e2330' }, ticks: { font: { size: 8 }, color: '#2196F3' },
                title: { display: true, text: 'Close Price ($)', color: '#2196F3', font: { size: 10 } } },
          y2: { position: 'right', beginAtZero: true, max: maxDen * 2.5,
                grid: { display: false }, ticks: { font: { size: 8 }, color: '#FF9800' },
                title: { display: true, text: 'Messages per minute', color: '#FF9800', font: { size: 10 } } },
        },
      },
    }
  }

  if (mode === 'sent') {
    const raw    = labels.map(atMap(mapBy(social.sent_labels, social.scores)))
    const smooth = labels.map(atMap(mapBy(social.sent_labels, social.scores_smooth)))
    return {
      type: 'line',
      data: { labels, datasets: [
        { label: 'Raw score', data: raw, yAxisID: 'ys', spanGaps: true,
          borderColor: 'rgba(160,160,160,.4)', borderWidth: .6, tension: 0, pointRadius: 0,
          fill: { target: 'origin', above: 'rgba(76,175,80,.2)', below: 'rgba(244,67,54,.2)' } },
        { label: '15-min smoothed score', data: smooth, yAxisID: 'ys', spanGaps: true,
          borderColor: '#4CAF50', borderWidth: 2, tension: .1, pointRadius: 0 },
      ] },
      plugins: [marketLinesPlugin, zeroLinePlugin],
      options: { ...baseOpts,
        plugins: { legend: { display: true, labels: { font: { size: 9 }, boxWidth: 12 } }, zeroLine: { scale: 'ys' } },
        scales: {
          x: { grid: { color: '#1e2330' }, ticks: { font: { size: 8 }, maxTicksLimit: 16 } },
          ys: { position: 'left', min: -1.1, max: 1.1,
                grid: { color: '#1e2330' }, ticks: { font: { size: 8 } },
                title: { display: true, text: 'Sentiment Score  (−1 = Bearish | +1 = Bullish)', font: { size: 10 } } },
        },
      },
    }
  }

  // mode === 'ds'
  const dens   = labels.map(atMap(mapBy(social.sent_labels, social.win_density)))
  const densSm = labels.map(atMap(mapBy(social.sent_labels, social.win_density_smooth)))
  const smooth = labels.map(atMap(mapBy(social.sent_labels, social.scores_smooth)))
  const maxDen = Math.max(...social.win_density, 1)
  return {
    type: 'line',
    data: { labels, datasets: [
      { label: 'Messages/window', type: 'bar', data: dens, yAxisID: 'y1',
        backgroundColor: 'rgba(33,150,243,.3)', borderWidth: 0, barPercentage: 1, categoryPercentage: 1 },
      { label: '15-min avg density', data: densSm, yAxisID: 'y1', spanGaps: true,
        borderColor: '#2196F3', borderWidth: 1.8, tension: .1, pointRadius: 0 },
      { label: 'Sentiment score (smoothed)', data: smooth, yAxisID: 'ys', spanGaps: true,
        borderColor: '#FF5722', borderWidth: 2, tension: .1, pointRadius: 0,
        fill: { target: 'origin', above: 'rgba(76,175,80,.12)', below: 'rgba(244,67,54,.12)' } },
    ] },
    plugins: [marketLinesPlugin, zeroLinePlugin],
    options: { ...baseOpts,
      plugins: { legend: { display: true, labels: { font: { size: 9 }, boxWidth: 12 } }, zeroLine: { scale: 'ys' } },
      scales: {
        x: { grid: { color: '#1e2330' }, ticks: { font: { size: 8 }, maxTicksLimit: 16 } },
        y1: { position: 'left', beginAtZero: true, max: maxDen * 2.2,
              grid: { color: '#1e2330' }, ticks: { font: { size: 8 }, color: '#2196F3' },
              title: { display: true, text: 'Messages per 5-min window', color: '#2196F3', font: { size: 10 } } },
        ys: { position: 'right', min: -1.5, max: 1.5,
              grid: { display: false }, ticks: { font: { size: 8 }, color: '#FF5722' },
              title: { display: true, text: 'Sentiment Score  (−1 to +1)', color: '#FF5722', font: { size: 10 } } },
      },
    },
  }
}

const TITLES: Record<ResearchMode, string> = {
  pd: 'Close Price vs Message Density',
  sent: 'Sentiment Score — (Bullish − Bearish) / Tagged · 5-min window, slides 1 min',
  ds: 'Message Density vs Sentiment Score',
}

// Rolling-window density slider bounds (Price+Density view only).
const WIN_MIN = 1, WIN_MAX = 60, WIN_DEFAULT = 15

export function ResearchChart({ ticker, mode, window: win }: { ticker: string; mode: ResearchMode; window: Win }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const chartRef = useRef<Chart | null>(null)
  const pollRef = useRef<number | null>(null)
  const [status, setStatus] = useState('')
  // The fetched data is held in state so a window change re-plots from it WITHOUT
  // re-fetching; `windowMin` drives the client-side rolling density (pd view).
  const [bundle, setBundle] = useState<{ d: PriceData; s: SocialData } | null>(null)
  const [windowMin, setWindowMin] = useState(WIN_DEFAULT)

  const destroyChart = () => { if (chartRef.current) { chartRef.current.destroy(); chartRef.current = null } }

  // Fetch + poll only. Re-runs when ticker / mode / price-window change — never
  // on the rolling-window slider, so dragging the slider hits no backend.
  useEffect(() => {
    let cancelled = false
    setStatus('Loading…'); setBundle(null)

    const run = async () => {
      const d: PriceData = await fetchJSON(`/api/chart?${new URLSearchParams({ ticker, window: win })}`)
      if (cancelled) return
      if (d.error) { setStatus(d.error); return }

      const poll = async () => {
        const s: SocialData = await fetchJSON(`/api/chart/social?${new URLSearchParams({ ticker: d.ticker, date: d.date })}`)
        if (cancelled) return
        if (s.error) { setStatus('Social data: ' + s.error); return }
        if (s.status === 'walking') {
          setStatus(`Loading social history, ${s.count || 0} messages…`)
          pollRef.current = window.setTimeout(poll, 1500) as unknown as number
          return
        }
        if (!s.messages) { setStatus('Not enough social data for this day.'); return }
        let txt = `Social: ${s.source} · ${s.messages} msgs (${s.bullish}B/${s.bearish}B tagged)`
        if (!s.complete && s.coverage_start) txt += ` · partial, from ${s.coverage_start}`
        setStatus(txt)
        setBundle({ d, s })
      }
      poll()
    }
    run().catch(() => { if (!cancelled) setStatus('Error loading chart data.') })

    return () => {
      cancelled = true
      if (pollRef.current) { clearTimeout(pollRef.current); pollRef.current = null }
    }
  }, [ticker, mode, win])

  // Build/rebuild from already-fetched data on new data OR a window change.
  // Lightly debounced (40ms) so a fast slider drag coalesces; animation is off,
  // so the redraw is effectively instant. No fetch, no page reload.
  useEffect(() => {
    if (!bundle) { destroyChart(); return }
    const t = window.setTimeout(() => {
      if (!canvasRef.current) return
      destroyChart()
      chartRef.current = new Chart(canvasRef.current, buildConfig(mode, bundle.d, bundle.s, win, windowMin))
    }, 40)
    return () => window.clearTimeout(t)
  }, [bundle, windowMin, mode, win])

  // Destroy the Chart.js instance on unmount (NOTES.md: never leave one on a reused canvas).
  useEffect(() => destroyChart, [])

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-2 border-b border-border flex items-center justify-between">
        <span className="text-xs text-neutral font-medium uppercase tracking-wide">{ticker} — {TITLES[mode]}</span>
        <span className="text-[11px] text-neutral">{status}</span>
      </div>
      {mode === 'pd' && (
        <div className="px-3 py-2 border-b border-border flex items-center gap-3">
          <label htmlFor="pd-window" className="text-[11px] text-neutral whitespace-nowrap">
            Rolling window: <span className="text-white font-medium tabular-nums">{windowMin} min</span>
          </label>
          <input
            id="pd-window" type="range" min={WIN_MIN} max={WIN_MAX} step={1} value={windowMin}
            onChange={e => setWindowMin(Number(e.target.value))}
            className="flex-1 accent-orange-500 cursor-pointer"
            aria-label="Density rolling window in minutes"
          />
        </div>
      )}
      <div className="flex-1 min-h-0 p-2">
        <canvas ref={canvasRef} />
      </div>
    </div>
  )
}
