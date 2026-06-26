import { useEffect, useState, useCallback } from 'react'

interface ScoreRow {
  ticker: string
  score: number
  direction: 'up' | 'down' | 'flat'
  confidence: number
  article_count: number
  bullish: number
  bearish: number
}
interface Overview {
  article_count: number
  avg_sentiment: number
  mood: string
  summary: string
  top_bullish: { ticker: string; score: number; article_count: number }[]
  top_bearish: { ticker: string; score: number; article_count: number }[]
  days: number
}

export function AIPage() {
  const [days, setDays] = useState(3)
  const [scores, setScores] = useState<ScoreRow[]>([])
  const [overview, setOverview] = useState<Overview | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const [s, o] = await Promise.all([
        fetch(`/api/ai/scores?days=${days}&limit=30`).then(r => r.json()),
        fetch(`/api/ai/overview?days=${days}`).then(r => r.json()),
      ])
      setScores(Array.isArray(s?.scores) ? s.scores : [])
      setOverview(o && !o.error ? o : null)
    } catch (e: any) {
      setError(e?.message || 'Failed to load AI analysis')
    } finally {
      setLoading(false)
    }
  }, [days])

  useEffect(() => {
    load()
    const id = window.setInterval(load, 60000)
    return () => window.clearInterval(id)
  }, [load])

  const moodTone = overview?.mood === 'risk-on' ? 'text-emerald-400'
    : overview?.mood === 'risk-off' ? 'text-red-400' : 'text-yellow-300'

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-white font-semibold text-2xl">AI Signal</h1>
          <p className="text-sm text-neutral mt-1">
            Directional scores derived from the last few days of news sentiment. Research only — not investment advice.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-neutral uppercase tracking-wide">Window</span>
          <select
            value={days}
            onChange={e => setDays(Number(e.target.value))}
            className="bg-bg border border-border text-sm text-neutral rounded px-2 py-2 focus:outline-none focus:border-accent"
          >
            <option value={3}>Last 3 days</option>
            <option value={7}>Last 7 days</option>
            <option value={14}>Last 14 days</option>
          </select>
        </div>
      </div>

      {error && <div className="border border-red-500/40 bg-red-500/10 text-red-300 rounded-lg p-3 text-sm">{error}</div>}

      <section className="bg-surface border border-border rounded-lg p-4">
        <div className="flex items-center justify-between gap-3 mb-2">
          <h2 className="text-white font-medium">AI Market Overview</h2>
          {overview && <span className={`text-sm font-semibold uppercase ${moodTone}`}>{overview.mood}</span>}
        </div>
        <p className="text-sm text-neutral leading-relaxed">
          {overview?.summary || (loading ? 'Analyzing recent news…' : 'No recent news to analyze yet. Click Run Now to fetch the latest.')}
        </p>
        {overview && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3">
            <Stat label="Articles analyzed" value={String(overview.article_count)} />
            <Stat label="Avg sentiment" value={overview.avg_sentiment.toFixed(2)}
              tone={overview.avg_sentiment > 0 ? 'text-emerald-400' : overview.avg_sentiment < 0 ? 'text-red-400' : 'text-white'} />
            <Stat label="Top bullish" value={overview.top_bullish?.[0]?.ticker || '--'} tone="text-emerald-400" />
            <Stat label="Top bearish" value={overview.top_bearish?.[0]?.ticker || '--'} tone="text-red-400" />
          </div>
        )}
      </section>

      <section className="bg-surface border border-border rounded-lg p-4">
        <div className="flex items-center justify-between gap-3 mb-3">
          <h2 className="text-white font-medium">Stock Scores</h2>
          <span className="text-xs text-neutral">{scores.length} scored · larger |score| = stronger signal</span>
        </div>
        {scores.length === 0 ? (
          <p className="text-sm text-neutral">{loading ? 'Scoring tickers…' : 'No scored tickers yet.'}</p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {scores.map(s => <ScoreCard key={s.ticker} s={s} />)}
          </div>
        )}
      </section>
    </div>
  )
}

function ScoreCard({ s }: { s: ScoreRow }) {
  const up = s.direction === 'up', down = s.direction === 'down'
  const tone = up ? 'text-emerald-400' : down ? 'text-red-400' : 'text-neutral'
  const bar = up ? 'bg-emerald-500' : down ? 'bg-red-500' : 'bg-slate-500'
  const arrow = up ? '▲' : down ? '▼' : '■'
  return (
    <div className="bg-bg border border-border rounded-lg p-3">
      <div className="flex items-center justify-between">
        <span className="font-mono font-bold text-accent text-lg">{s.ticker}</span>
        <span className={`font-mono font-bold text-xl ${tone}`}>{arrow} {s.score > 0 ? '+' : ''}{s.score}</span>
      </div>
      <div className="mt-2">
        <div className="flex items-center justify-between text-[11px] text-neutral mb-1">
          <span>Confidence</span><span>{Math.round(s.confidence * 100)}%</span>
        </div>
        <div className="h-1.5 bg-border rounded-full overflow-hidden">
          <div className={`h-full ${bar}`} style={{ width: `${Math.round(s.confidence * 100)}%` }} />
        </div>
      </div>
      <div className="flex items-center justify-between text-xs text-neutral mt-2">
        <span>{s.article_count} articles</span>
        <span><span className="text-emerald-400">{s.bullish}↑</span> · <span className="text-red-400">{s.bearish}↓</span></span>
      </div>
    </div>
  )
}

function Stat({ label, value, tone = 'text-white' }: { label: string; value: string; tone?: string }) {
  return (
    <div className="bg-bg border border-border rounded-lg px-3 py-2">
      <div className="text-[11px] text-neutral uppercase tracking-wide">{label}</div>
      <div className={`text-lg font-semibold ${tone}`}>{value}</div>
    </div>
  )
}
