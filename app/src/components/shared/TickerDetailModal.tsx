'use client'
import { useEffect, useState } from 'react'
import { CandlestickChart } from '@/pages/CandlestickChart'

export function TickerDetailModal({ ticker, onClose }: { ticker: string; onClose: () => void }) {
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [showSentiment, setShowSentiment] = useState(true)
  const [showDensity, setShowDensity] = useState(true)
  const [showPrediction, setShowPrediction] = useState(true)
  const [range, setRange] = useState('1d')
  const [interval, setInterval] = useState('1m')

  useEffect(() => {
    if (!ticker) return
    setLoading(true)
    fetch(`/api/charts/${ticker}?range=${range}&interval=${interval}&window_minutes=30&bucket_minutes=1`)
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false) })
      .catch(() => setLoading(false))
  }, [ticker, range, interval])

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-surface border border-border rounded-lg p-4 max-w-4xl w-full max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl font-bold text-white">{ticker} — Chart</h2>
          <button onClick={onClose} className="text-neutral hover:text-white text-2xl leading-none">✕</button>
        </div>

        {/* Chart controls */}
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          <select value={range} onChange={e => setRange(e.target.value)} className="bg-bg border border-border text-xs text-neutral rounded px-2 py-1">
            <option value="1d">1 Day</option>
            <option value="2h">2 Hours</option>
            <option value="1h">1 Hour</option>
            <option value="5d">5 Days</option>
            <option value="1mo">1 Month</option>
            <option value="3mo">3 Months</option>
          </select>
          <select value={interval} onChange={e => setInterval(e.target.value)} className="bg-bg border border-border text-xs text-neutral rounded px-2 py-1">
            <option value="1m">1m</option>
            <option value="5m">5m</option>
            <option value="15m">15m</option>
            <option value="1h">1h</option>
          </select>
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input type="checkbox" checked={showSentiment} onChange={e => setShowSentiment(e.target.checked)} className="accent-green-500" />
            <span className="text-xs text-neutral">Sentiment</span>
          </label>
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input type="checkbox" checked={showDensity} onChange={e => setShowDensity(e.target.checked)} className="accent-orange-500" />
            <span className="text-xs text-neutral">Density</span>
          </label>
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input type="checkbox" checked={showPrediction} onChange={e => setShowPrediction(e.target.checked)} className="accent-amber-500" />
            <span className="text-xs text-neutral">Prediction</span>
          </label>
        </div>

        {/* Chart */}
        <div className="bg-bg border border-border rounded-lg overflow-hidden" style={{ height: 400 }}>
          {loading ? (
            <div className="h-full flex items-center justify-center text-neutral text-sm">Loading chart...</div>
          ) : data?.candles?.length ? (
            <CandlestickChart
              candles={data.candles}
              bollinger={data.bollinger}
              predicted={data.predicted}
              newsEvents={data.news_events}
              density={data.social_density || []}
              sentiment={data.sentiment || []}
              showSentiment={showSentiment}
              showDensity={showDensity}
              showPrediction={showPrediction}
              chartStyle="candles"
            />
          ) : (
            <div className="h-full flex items-center justify-center text-neutral text-sm">No chart data available</div>
          )}
        </div>

        {/* Quick stats */}
        {data && (
          <div className="grid grid-cols-4 gap-2 mt-3">
            <div className="bg-bg border border-border rounded px-2 py-1">
              <div className="text-[10px] text-neutral uppercase">Price</div>
              <div className="text-sm text-white font-mono">${data.candles?.[data.candles.length - 1]?.close?.toFixed(2) || '--'}</div>
            </div>
            <div className="bg-bg border border-border rounded px-2 py-1">
              <div className="text-[10px] text-neutral uppercase">Change</div>
              <div className="text-sm font-mono">{(data.change_pct >= 0 ? '+' : '') + (data.change_pct?.toFixed(2) || '--') + '%'}</div>
            </div>
            <div className="bg-bg border border-border rounded px-2 py-1">
              <div className="text-[10px] text-neutral uppercase">Volume</div>
              <div className="text-sm text-white font-mono">{data.candles?.reduce((sum: number, c: any) => sum + (c.volume || 0), 0).toLocaleString() || '--'}</div>
            </div>
            <div className="bg-bg border border-border rounded px-2 py-1">
              <div className="text-[10px] text-neutral uppercase">Social</div>
              <div className="text-sm text-white font-mono">{data.social_density?.length || 0} pts</div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
