import { useState, useCallback } from 'react'
import { CandlestickChart } from './CandlestickChart'

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
  const [showSentiment, setShowSentiment] = useState(true)
  const [showDensity, setShowDensity] = useState(true)

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
        <div className="bg-surface border border-border rounded-lg p-4">
          {/* Toggle controls like StockTwits */}
          <div className="flex items-center gap-2 mb-4">
            <button
              onClick={() => setShowSentiment(!showSentiment)}
              className={`px-3 py-1.5 text-xs font-medium rounded-full border transition-colors ${
                showSentiment
                  ? 'bg-purple-500/20 border-purple-500/50 text-purple-300'
                  : 'border-border text-neutral hover:text-white'
              }`}
            >
              Sentiment {(data as any).sentiment?.length || 0}
            </button>
            <button
              onClick={() => setShowDensity(!showDensity)}
              className={`px-3 py-1.5 text-xs font-medium rounded-full border transition-colors ${
                showDensity
                  ? 'bg-orange-500/20 border-orange-500/50 text-orange-300'
                  : 'border-border text-neutral hover:text-white'
              }`}
            >
              Message Volume {(data as any).density?.length || 0}
            </button>
            <div className="flex-1" />
            <span className="text-xs text-neutral">
              {activeTicker} • {range} • {interval}
            </span>
          </div>
          
          <CandlestickChart 
            candles={data.candles} 
            bollinger={data.bollinger}
            sentiment={(data as any).sentiment}
            density={(data as any).density}
            showSentiment={showSentiment}
            showDensity={showDensity}
          />
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

