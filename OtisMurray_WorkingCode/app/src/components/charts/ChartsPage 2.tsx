import { useState, useCallback } from 'react'
import { CandlestickChart } from './CandlestickChart'
import { RSIChart } from './RSIChart'
import { MACDChart } from './MACDChart'
import { SentimentChart } from './SentimentChart'

interface ChartData {
  candles: Array<{ time: string; open: number; high: number; low: number; close: number; volume?: number }>
  bollinger?: { upper: Array<{ time: string; value: number }>; lower: Array<{ time: string; value: number }> }
  rsi?: Array<{ time: string; value: number }>
  macd?: { macd: Array<{ time: string; value: number }>; signal: Array<{ time: string; value: number }>; histogram: Array<{ time: string; value: number }> }
  sentiment?: Array<{ time: string; value: number }>
}

const RANGES = ['1mo', '3mo', '6mo', '1y'] as const
const INTERVALS = ['1d', '1wk', '1h'] as const
const RANGE_LABELS: Record<string, string> = { '1mo': '1 Month', '3mo': '3 Months', '6mo': '6 Months', '1y': '1 Year' }
const INT_LABELS: Record<string, string> = { '1d': 'Daily', '1wk': 'Weekly', '1h': 'Hourly' }

export function ChartsPage() {
  const [ticker, setTicker] = useState('AAPL')
  const [range, setRange] = useState<string>('3mo')
  const [interval, setInterval] = useState<string>('1d')
  const [data, setData] = useState<ChartData | null>(null)
  const [loading, setLoading] = useState(false)
  const [activeTicker, setActiveTicker] = useState<string | null>(null)

  const loadChart = useCallback(async () => {
    if (!ticker.trim()) return
    setLoading(true)
    try {
      const res = await fetch(`/api/charts/${ticker.trim().toUpperCase()}?range=${range}&interval=${interval}`)
      const json = await res.json()
      if (json.candles) {
        setData(json)
        setActiveTicker(ticker.trim().toUpperCase())
      }
    } finally {
      setLoading(false)
    }
  }, [ticker, range, interval])

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
          <ChartCard title="Candlestick + Bollinger Bands (20,2)" height={280}>
            <CandlestickChart candles={data.candles} bollinger={data.bollinger} />
          </ChartCard>
          <ChartCard title="RSI (14)" height={130}>
            <RSIChart data={data.rsi ?? []} />
          </ChartCard>
          <ChartCard title="MACD (12,26,9)" height={130}>
            <MACDChart data={data.macd} />
          </ChartCard>
          <ChartCard title="News Sentiment" height={110}>
            <SentimentChart data={data.sentiment ?? []} />
          </ChartCard>
        </div>
      ) : (
        <div className="text-center py-20 text-neutral">
          <div className="text-4xl mb-3">📊</div>
          <div className="text-sm">Enter a ticker symbol and click Load Chart to view technical analysis</div>
        </div>
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
