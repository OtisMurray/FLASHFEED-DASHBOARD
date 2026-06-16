'use client'
import { useState, useCallback, useEffect } from 'react'
import { CandlestickChart } from './CandlestickChart'
import { RSIChart } from './RSIChart'
import { MACDChart } from './MACDChart'
import { SentimentChart } from './SentimentChart'

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
  source_status?: { price?: string; price_source?: string; price_detail?: string; social?: string; news?: string; predictions?: string }
}

const RANGES = ['1d', '5d', '1mo', '3mo', '6mo', '1y'] as const
const INTERVALS = ['1m', '5m', '15m', '1h', '1d', '1wk'] as const
const RANGE_LABELS: Record<string, string> = { '1d': '1 Day', '5d': '5 Days', '1mo': '1 Month', '3mo': '3 Months', '6mo': '6 Months', '1y': '1 Year' }
const INT_LABELS: Record<string, string> = { '1m': '1 Minute', '5m': '5 Minute', '15m': '15 Minute', '1h': 'Hourly', '1d': 'Daily', '1wk': 'Weekly' }

export function ChartsPage() {
  const [ticker, setTicker] = useState('AAPL')
  const [range, setRange] = useState<string>('1d')
  const [interval, setInterval] = useState<string>('1m')
  const [data, setData] = useState<ChartData | null>(null)
  const [loading, setLoading] = useState(false)
  const [activeTicker, setActiveTicker] = useState<string | null>(null)
  const [autoLoaded, setAutoLoaded] = useState(false)

  const loadChart = useCallback(async () => {
    if (!ticker.trim()) return
    setLoading(true)
    try {
      const res = await fetch(`/api/charts/${ticker.trim().toUpperCase()}?range=${range}&interval=${interval}`)
      const json = await res.json()
      setData(json)
      setActiveTicker(ticker.trim().toUpperCase())
    } finally {
      setLoading(false)
    }
  }, [ticker, range, interval])

  useEffect(() => {
    if (!autoLoaded && !data && !loading) {
      setAutoLoaded(true)
      loadChart()
    }
  }, [autoLoaded, data, loading, loadChart])

  return (
    <div>
      {/* Toolbar */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <input
          value={ticker}
          onChange={e => setTicker(e.target.value.toUpperCase())}
          onKeyDown={e => e.key === 'Enter' && loadChart()}
          placeholder="Ticker (e.g. AAPL)"
          className="w-[140px] bg-bg border border-border text-sm text-white rounded px-3 py-2 font-mono focus:outline-none focus:border-accent placeholder:text-slate-600"
        />
        <select value={range} onChange={e => setRange(e.target.value)}
          className="bg-bg border border-border text-sm text-neutral rounded px-2 py-2 focus:outline-none focus:border-accent">
          {RANGES.map(r => <option key={r} value={r}>{RANGE_LABELS[r]}</option>)}
        </select>
        <select value={interval} onChange={e => setInterval(e.target.value)}
          className="bg-bg border border-border text-sm text-neutral rounded px-2 py-2 focus:outline-none focus:border-accent">
          {INTERVALS.map(i => <option key={i} value={i}>{INT_LABELS[i]}</option>)}
        </select>
        <button
          onClick={loadChart}
          disabled={loading || !ticker.trim()}
          className="px-4 py-2 bg-accent text-white text-sm font-medium rounded hover:bg-sky-400 disabled:opacity-50 transition-colors"
        >
          {loading ? 'Loading...' : 'Load Chart'}
        </button>
        {activeTicker && (
          <span className="text-accent font-mono font-bold text-lg ml-2">{activeTicker}</span>
        )}
      </div>

      {/* Charts */}
      {data ? (
        <div className="space-y-3">
          <div className="grid grid-cols-2 md:grid-cols-6 gap-2">
            <Status label="Price" value={data.source_status?.price ?? 'unknown'} />
            <Status label="Source" value={data.source_status?.price_source ?? 'pending'} />
            <Status label="Social" value={data.source_status?.social ?? 'pending'} />
            <Status label="News Markers" value={String(data.news_events?.length ?? 0)} />
            <Status label="Predictions" value={String(data.prediction_events?.length ?? 0)} />
            <Status label="Bars" value={String(data.candles?.length ?? 0)} />
          </div>
          <ChartCard title={`${INT_LABELS[interval] ?? interval} Price + Bollinger Bands`} height={300}>
            {data.candles?.length
              ? <CandlestickChart
                  candles={data.candles as any}
                  bollinger={data.bollinger as any}
                  predicted={data.predicted as any}
                  newsEvents={data.news_events as any}
                  density={data.social_density as any}
                  sentiment={data.sentiment as any}
                />
              : <EmptyChart message={data.source_status?.price_detail || 'No price bars returned for this interval.'} />}
          </ChartCard>
          <ChartCard title="Rolling Message Density" height={120}>
            <SentimentChart data={(data.social_density ?? []).map(row => ({ time: row.time as any, value: row.scaled ?? row.value }))} />
          </ChartCard>
          <ChartCard title="Rolling Message Sentiment" height={120}>
            <SentimentChart data={data.sentiment ?? []} />
          </ChartCard>
          <PredictionEvents events={data.prediction_events ?? []} />
          <ChartCard title="RSI (14)" height={120}>
            <RSIChart data={data.rsi ?? []} />
          </ChartCard>
          <ChartCard title="MACD (12,26,9)" height={120}>
            <MACDChart data={data.macd} />
          </ChartCard>
        </div>
      ) : (
        <div className="text-center py-20 text-neutral">
          <div className="text-sm">Loading the default candle chart...</div>
        </div>
      )}
    </div>
  )
}

function eventTime(value: string | number) {
  const sec = typeof value === 'number' ? value : Math.floor(Date.parse(value) / 1000)
  if (!Number.isFinite(sec) || sec <= 0) return '--'
  return new Date(sec * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
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
