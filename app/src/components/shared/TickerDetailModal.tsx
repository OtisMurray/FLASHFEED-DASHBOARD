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
  const [audit, setAudit] = useState<any>(null)
  const [auditLoading, setAuditLoading] = useState(false)
  const [auditError, setAuditError] = useState('')

  useEffect(() => {
    if (!ticker) return
    setAudit(null)
    setAuditError('')
    setLoading(true)
    fetch(`/api/charts/${ticker}?range=${range}&interval=${interval}&window_minutes=30&bucket_minutes=1`)
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false) })
      .catch(() => setLoading(false))
  }, [ticker, range, interval])

  async function loadEvidenceTrace() {
    setAuditLoading(true)
    setAuditError('')
    try {
      const response = await fetch(`/api/screener/audit/${encodeURIComponent(ticker)}?days=7`)
      const payload = await response.json()
      if (!response.ok || !payload?.ok) throw new Error(payload?.error || 'Evidence trace unavailable')
      setAudit(payload)
    } catch (error) {
      setAuditError(error instanceof Error ? error.message : 'Evidence trace unavailable')
    } finally {
      setAuditLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-surface border border-border rounded-lg p-4 max-w-4xl w-full max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-center mb-4 gap-3">
          <h2 className="text-xl font-bold text-white">{ticker} — Chart</h2>
          <div className="flex items-center gap-2">
            <button
              onClick={loadEvidenceTrace}
              disabled={auditLoading}
              className="rounded border border-sky-500/40 px-2 py-1 text-xs text-sky-200 hover:bg-sky-500/10 disabled:opacity-50"
            >
              {auditLoading ? 'Loading evidence...' : 'Evidence trace'}
            </button>
            <button onClick={onClose} className="text-neutral hover:text-white text-2xl leading-none">✕</button>
          </div>
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

        {auditError && <div className="mb-3 rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">{auditError}</div>}
        {audit?.trace && (
          <section className="mb-3 rounded border border-border bg-bg/60 p-3 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="font-semibold text-slate-100">Evidence trace</div>
              <div className="text-sky-200">{String(audit.selection_status || '').replaceAll('_', ' ')}</div>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-neutral md:grid-cols-4">
              <div>Catalyst: <span className="text-slate-200">{audit.trace.classification?.catalyst_label || 'None'}</span></div>
              <div>Reaction: <span className="text-slate-200">{audit.trace.catalyst?.reaction?.label || 'Unavailable'}</span></div>
              <div>Quality: <span className="text-slate-200">{audit.trace.catalyst?.quality?.score ?? '—'}/100</span></div>
              <div>Articles: <span className="text-slate-200">{audit.trace.articles?.length ?? 0}</span></div>
            </div>
            {audit.rejection_reasons?.length > 0 && (
              <div className="mt-2 text-red-200">Rejected or limited by: {audit.rejection_reasons.slice(0, 4).join(' · ')}</div>
            )}
            {audit.trace.catalyst?.main?.title && (
              <div className="mt-2 text-slate-300">{audit.trace.catalyst.main.title}</div>
            )}
            {audit.trace.articles?.length > 0 && (
              <div className="mt-2 max-h-32 space-y-1 overflow-y-auto border-t border-border pt-2">
                {audit.trace.articles.slice(0, 5).map((article: any, index: number) => (
                  <div key={`${article.id || article.url || 'article'}-${index}`} className="flex gap-2 text-neutral">
                    <span className="shrink-0 text-slate-500">{article.publication_timestamp ? new Date(article.publication_timestamp).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'time unknown'}</span>
                    <span className="truncate text-slate-300">{article.headline || 'Untitled article'}</span>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

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
