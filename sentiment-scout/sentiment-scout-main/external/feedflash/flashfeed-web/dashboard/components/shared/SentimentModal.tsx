'use client'
import { useState, useEffect, useCallback } from 'react'
import { Modal } from './Modal'
import { clsx } from 'clsx'

interface Props {
  open: boolean
  onClose: () => void
}

type Tab = 'analyze_asset' | 'analyze_articles' | 'quick_analyze' | 'extract_tickers' | 'saved_reports'

const TABS: { id: Tab; label: string }[] = [
  { id: 'analyze_asset', label: 'Analyze Asset' },
  { id: 'analyze_articles', label: 'Analyze Articles' },
  { id: 'quick_analyze', label: 'Quick Analyze' },
  { id: 'extract_tickers', label: 'Extract Tickers' },
  { id: 'saved_reports', label: 'Saved Reports' },
]

export function SentimentModal({ open, onClose }: Props) {
  const [tab, setTab] = useState<Tab>('analyze_asset')
  const [serviceStatus, setServiceStatus] = useState<{ ok: boolean; port?: number } | null>(null)

  useEffect(() => {
    if (open) {
      fetch('/api/sentiment/status').then(r => r.json()).then(setServiceStatus).catch(() => setServiceStatus({ ok: false }))
    }
  }, [open])

  return (
    <Modal open={open} onClose={onClose} title="Sentiment Analysis" wide>
      {/* Service status */}
      <div className={`flex items-center gap-2 px-3 py-2 rounded-lg mb-3 text-xs ${
        serviceStatus?.ok ? 'bg-emerald-500/10 border border-emerald-500/30' : 'bg-red-500/10 border border-red-500/30'
      }`}>
        <span className={`w-2 h-2 rounded-full ${serviceStatus?.ok ? 'bg-emerald-500' : 'bg-red-500'}`} />
        <span className={serviceStatus?.ok ? 'text-emerald-400' : 'text-red-400'}>
          {serviceStatus?.ok ? `Service Running (port ${serviceStatus.port ?? 5001})` : 'Service Not Running'}
        </span>
        {!serviceStatus?.ok && (
          <span className="text-neutral ml-1">Start with: python sentiment_service.py</span>
        )}
      </div>

      {/* Tab bar */}
      <div className="flex gap-0.5 border-b border-border mb-3 overflow-x-auto">
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={clsx(
              'px-2.5 py-1.5 text-xs whitespace-nowrap transition-colors border-b-2 -mb-px',
              tab === t.id ? 'text-white border-accent' : 'text-neutral border-transparent hover:text-white'
            )}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {tab === 'analyze_asset' && <AnalyzeAssetTab />}
      {tab === 'analyze_articles' && <AnalyzeArticlesTab />}
      {tab === 'quick_analyze' && <QuickAnalyzeTab />}
      {tab === 'extract_tickers' && <ExtractTickersTab />}
      {tab === 'saved_reports' && <SavedReportsTab />}
    </Modal>
  )
}

function AnalyzeAssetTab() {
  const [ticker, setTicker] = useState('')
  const [maxArticles, setMaxArticles] = useState('50')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<any>(null)

  const run = async () => {
    if (!ticker.trim()) return
    setLoading(true); setResult(null)
    try {
      const res = await fetch('/api/sentiment/analyze-asset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticker: ticker.trim().toUpperCase(), max_articles: parseInt(maxArticles) })
      })
      setResult(await res.json())
    } finally { setLoading(false) }
  }

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <input value={ticker} onChange={e => setTicker(e.target.value.toUpperCase())}
          placeholder="Ticker (e.g. AAPL)"
          className="flex-1 bg-bg border border-border text-sm text-white rounded px-3 py-2 font-mono focus:outline-none focus:border-accent placeholder:text-slate-600"
          onKeyDown={e => e.key === 'Enter' && run()} />
        <input type="number" value={maxArticles} onChange={e => setMaxArticles(e.target.value)}
          className="w-20 bg-bg border border-border text-sm text-white rounded px-3 py-2 focus:outline-none focus:border-accent"
          placeholder="Max" />
        <button onClick={run} disabled={loading || !ticker.trim()}
          className="px-4 py-2 bg-accent text-white text-sm rounded hover:bg-sky-400 disabled:opacity-50 transition-colors">
          {loading ? 'Analyzing...' : 'Analyze'}
        </button>
      </div>
      {result && (
        <div className="bg-bg border border-border rounded-lg p-3">
          <div className="flex items-center gap-3 mb-2">
            <span className="font-mono font-bold text-accent text-lg">{result.ticker}</span>
            {result.sentiment && (
              <span className={clsx(
                'text-sm font-bold px-2 py-0.5 rounded',
                result.sentiment === 'bullish' ? 'bg-emerald-500/15 text-emerald-400' :
                result.sentiment === 'bearish' ? 'bg-red-500/15 text-red-400' :
                'bg-slate-500/15 text-neutral'
              )}>
                {result.sentiment.toUpperCase()}
              </span>
            )}
            {result.confidence != null && (
              <span className="text-xs text-neutral">Confidence: {(result.confidence * 100).toFixed(1)}%</span>
            )}
          </div>
          {result.breakdown && (
            <div className="grid grid-cols-3 gap-2 text-xs">
              <div className="bg-emerald-500/10 rounded p-2 text-center">
                <div className="text-emerald-400 font-bold">{result.breakdown.bullish ?? 0}</div>
                <div className="text-neutral">Bullish</div>
              </div>
              <div className="bg-slate-500/10 rounded p-2 text-center">
                <div className="text-neutral font-bold">{result.breakdown.neutral ?? 0}</div>
                <div className="text-neutral">Neutral</div>
              </div>
              <div className="bg-red-500/10 rounded p-2 text-center">
                <div className="text-red-400 font-bold">{result.breakdown.bearish ?? 0}</div>
                <div className="text-neutral">Bearish</div>
              </div>
            </div>
          )}
          {result.error && <div className="text-red-400 text-xs">{result.error}</div>}
        </div>
      )}
    </div>
  )
}

function AnalyzeArticlesTab() {
  const [batchSize, setBatchSize] = useState('50')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<any>(null)

  const run = async () => {
    setLoading(true); setResult(null)
    try {
      const res = await fetch('/api/sentiment/analyze-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batch_size: parseInt(batchSize) })
      })
      setResult(await res.json())
    } finally { setLoading(false) }
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-neutral">Run FinBERT ensemble on unanalyzed articles. This uses the ML sentiment service.</p>
      <div className="flex gap-2 items-center">
        <span className="text-xs text-neutral">Batch size:</span>
        <input type="number" value={batchSize} onChange={e => setBatchSize(e.target.value)}
          className="w-20 bg-bg border border-border text-sm text-white rounded px-2 py-1.5 focus:outline-none focus:border-accent" />
        <button onClick={run} disabled={loading}
          className="px-4 py-2 bg-accent text-white text-sm rounded hover:bg-sky-400 disabled:opacity-50 transition-colors">
          {loading ? 'Running FinBERT...' : 'Run Analysis'}
        </button>
      </div>
      {result && (
        <div className="bg-bg border border-border rounded-lg p-3 text-xs">
          {result.success ? (
            <div className="space-y-1">
              <div className="text-emerald-400">Analysis complete</div>
              <div className="text-neutral">Analyzed: {result.analyzed ?? 0} articles</div>
              {result.breakdown && (
                <div className="flex gap-3 mt-2">
                  <span className="text-emerald-400">Bullish: {result.breakdown.bullish}</span>
                  <span className="text-neutral">Neutral: {result.breakdown.neutral}</span>
                  <span className="text-red-400">Bearish: {result.breakdown.bearish}</span>
                </div>
              )}
            </div>
          ) : (
            <div className="text-red-400">{result.error ?? 'Analysis failed'}</div>
          )}
        </div>
      )}
    </div>
  )
}

function QuickAnalyzeTab() {
  const [batchSize, setBatchSize] = useState('100')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<any>(null)

  const run = async () => {
    setLoading(true); setResult(null)
    try {
      const res = await fetch('/api/sentiment/quick-analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batch_size: parseInt(batchSize) })
      })
      setResult(await res.json())
    } finally { setLoading(false) }
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-neutral">Rule-based sentiment using DS440 lexicon (64 bullish + 31 bearish financial phrases). Fast, no ML service required.</p>
      <div className="flex gap-2 items-center">
        <span className="text-xs text-neutral">Batch size:</span>
        <input type="number" value={batchSize} onChange={e => setBatchSize(e.target.value)}
          className="w-20 bg-bg border border-border text-sm text-white rounded px-2 py-1.5 focus:outline-none focus:border-accent" />
        <button onClick={run} disabled={loading}
          className="px-4 py-2 bg-accent text-white text-sm rounded hover:bg-sky-400 disabled:opacity-50 transition-colors">
          {loading ? 'Analyzing...' : 'Quick Analyze'}
        </button>
      </div>
      {result && (
        <div className="bg-bg border border-border rounded-lg p-3 text-xs">
          {result.success ? (
            <div className="space-y-1">
              <div className="text-emerald-400">Quick analysis complete</div>
              <div className="text-neutral">Processed: {result.processed ?? 0} articles</div>
              {result.breakdown && (
                <div className="flex gap-3 mt-2">
                  <span className="text-emerald-400">Bullish: {result.breakdown.bullish}</span>
                  <span className="text-neutral">Neutral: {result.breakdown.neutral}</span>
                  <span className="text-red-400">Bearish: {result.breakdown.bearish}</span>
                </div>
              )}
            </div>
          ) : (
            <div className="text-red-400">{result.error ?? 'Analysis failed'}</div>
          )}
        </div>
      )}
    </div>
  )
}

function ExtractTickersTab() {
  const [batchSize, setBatchSize] = useState('200')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<any>(null)

  const run = async () => {
    setLoading(true); setResult(null)
    try {
      const res = await fetch('/api/sentiment/extract-tickers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batch_size: parseInt(batchSize) })
      })
      setResult(await res.json())
    } finally { setLoading(false) }
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-neutral">Extract ticker symbols from article titles/content using three-tier regex engine. Validates against ~10k NYSE/NASDAQ symbols.</p>
      <div className="flex gap-2 items-center">
        <span className="text-xs text-neutral">Batch size:</span>
        <input type="number" value={batchSize} onChange={e => setBatchSize(e.target.value)}
          className="w-20 bg-bg border border-border text-sm text-white rounded px-2 py-1.5 focus:outline-none focus:border-accent" />
        <button onClick={run} disabled={loading}
          className="px-4 py-2 bg-accent text-white text-sm rounded hover:bg-sky-400 disabled:opacity-50 transition-colors">
          {loading ? 'Extracting...' : 'Extract Tickers'}
        </button>
      </div>
      {result && (
        <div className="bg-bg border border-border rounded-lg p-3 text-xs">
          {result.success ? (
            <div className="space-y-1">
              <div className="text-emerald-400">Extraction complete</div>
              <div className="text-neutral">Processed: {result.processed ?? 0} articles</div>
              <div className="text-neutral">Tickers found: {result.found ?? 0}</div>
              {result.tickers && result.tickers.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-2">
                  {result.tickers.slice(0, 30).map((t: string) => (
                    <span key={t} className="text-[10px] font-mono text-accent bg-accent/10 px-1.5 py-0.5 rounded">{t}</span>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="text-red-400">{result.error ?? 'Extraction failed'}</div>
          )}
        </div>
      )}
    </div>
  )
}

function SavedReportsTab() {
  const [filter, setFilter] = useState('')
  const [reports, setReports] = useState<any[]>([])
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = filter ? `?ticker=${filter.toUpperCase()}` : ''
      const res = await fetch(`/api/sentiment/reports${params}`)
      const data = await res.json()
      setReports(data.reports ?? [])
    } finally { setLoading(false) }
  }, [filter])

  useEffect(() => { load() }, [])

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <input value={filter} onChange={e => setFilter(e.target.value.toUpperCase())}
          placeholder="Filter by ticker..."
          className="flex-1 bg-bg border border-border text-sm text-white rounded px-3 py-2 font-mono focus:outline-none focus:border-accent placeholder:text-slate-600" />
        <button onClick={load} disabled={loading}
          className="px-3 py-2 bg-surface border border-border text-neutral text-sm rounded hover:text-white hover:border-accent transition-colors">
          {loading ? 'Loading...' : 'Refresh'}
        </button>
      </div>
      <div className="space-y-2 max-h-[300px] overflow-y-auto">
        {reports.length === 0 ? (
          <div className="text-xs text-neutral text-center py-4">No saved reports</div>
        ) : reports.map((r, i) => (
          <div key={i} className="bg-bg border border-border rounded-lg p-3">
            <div className="flex items-center gap-2 mb-1">
              <span className="font-mono font-bold text-accent text-sm">{r.ticker}</span>
              <span className={clsx(
                'text-xs px-1.5 py-0.5 rounded font-medium',
                r.sentiment === 'bullish' ? 'bg-emerald-500/15 text-emerald-400' :
                r.sentiment === 'bearish' ? 'bg-red-500/15 text-red-400' :
                'bg-slate-500/15 text-neutral'
              )}>
                {r.sentiment}
              </span>
              {r.confidence != null && <span className="text-[10px] text-neutral">{(r.confidence * 100).toFixed(0)}%</span>}
              <span className="text-[10px] text-neutral ml-auto">{new Date(r.created_at).toLocaleDateString()}</span>
            </div>
            {r.article_count != null && <div className="text-[10px] text-neutral">{r.article_count} articles analyzed</div>}
          </div>
        ))}
      </div>
    </div>
  )
}
