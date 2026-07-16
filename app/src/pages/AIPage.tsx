'use client'
import { useMemo, useState } from 'react'
import useSWR from 'swr'
import { clsx } from 'clsx'

const fetcher = (url: string) => fetch(url).then(r => r.json())

type AiRankingRow = {
  rank: number
  ticker: string
  company?: string
  price?: number | null
  change_pct?: number
  rel_volume?: number
  volume?: number
  ai_rank_score: number
  direction: 'bullish' | 'bearish' | 'watch'
  confidence?: number
  trade_watch_score?: number
  model_ready?: boolean
  prediction_signal?: {
    direction?: string
    probability_up?: number
    predicted_return_5m?: number
    confidence?: number
    model?: string
  } | null
  evidence: {
    news_score?: number
    news_articles?: number
    scored_news_articles?: number
    bullish_news?: number
    bearish_news?: number
    social_posts?: number
    social_sentiment?: number
    structured_articles?: number
    public_articles?: number
    evidence_score?: number
    agreement?: number
    quote_age_minutes?: number | null
    latest_signal_status?: string | null
  }
  reasons?: string[]
  risks?: string[]
}

type AiRankingResponse = {
  ok?: boolean
  error?: string
  generated_at?: string
  model?: {
    name?: string
    status?: string
    samples?: number
    min_samples?: number
    metrics?: Record<string, number> | null
    fallback?: string
  }
  summary?: {
    rows?: number
    scored_articles?: number
    article_window_days?: number
    social_window_minutes?: number
    bullish?: number
    bearish?: number
    watch?: number
    model_status?: string
    model_samples?: number
  }
  rows?: AiRankingRow[]
  methodology?: Record<string, string>
}

type AiTickerDetail = {
  ok?: boolean
  error?: string
  ticker?: string
  score?: {
    ai_rank_score?: number
    direction?: string
    trade_watch_score?: number
    news_score?: number
    evidence_score?: number
    social_density_score?: number
    prediction_score?: number
    quote_freshness?: number
  }
  mover?: {
    company?: string
    price?: number | null
    change_pct?: number
    rel_volume?: number
    quote_age_minutes?: number | null
    reasons?: string[]
    risks?: string[]
  } | null
  evidence?: {
    approved_article_count?: number
    scored_news_articles?: number
    bullish_news?: number
    bearish_news?: number
    structured_articles?: number
    public_articles?: number
    social_posts?: number
    social_sentiment?: number
  }
  prediction?: {
    active_signal?: AiRankingRow['prediction_signal']
    model?: {
      status?: string
      samples?: number
      metrics?: Record<string, number | null>
      updated_at?: string
    } | null
    signals?: Array<{
      signal_id?: string
      time?: string
      decision?: string
      rank?: number
      label_status?: string
      trade_watch_score?: number | null
      model_signal?: AiRankingRow['prediction_signal']
      baseline_signal?: AiRankingRow['prediction_signal']
      labels?: Record<string, any>
    }>
    summary?: {
      total?: number
      labeled?: number
      complete?: number
      accuracy_5m?: number | null
    }
  }
  articles?: Array<{
    title: string
    source: string
    sentiment: string
    sentiment_score?: number
    event_type?: string
    reason?: string
    url?: string
    time?: string
  }>
  social_posts?: Array<{
    platform: string
    author?: string
    text: string
    sentiment?: number
    url?: string
    time?: string
  }>
  checks?: Array<{ label: string; status: 'pass' | 'warn' | 'info' | string; detail: string }>
}

const DAY_OPTIONS = [1, 3, 5, 7]
const LIMIT_OPTIONS = [25, 50, 75, 100]
const SOCIAL_WINDOWS = [
  { label: '1h', value: 60 },
  { label: '4h', value: 240 },
  { label: '24h', value: 1440 },
  { label: '3d', value: 4320 },
]

function compact(value: unknown): string {
  const n = Number(value || 0)
  if (!Number.isFinite(n)) return '--'
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (Math.abs(n) >= 10_000) return `${Math.round(n / 1_000)}k`
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}

function pct(value?: number | null, digits = 1): string {
  const n = Number(value)
  if (!Number.isFinite(n)) return '--'
  return `${n >= 0 ? '+' : ''}${n.toFixed(digits)}%`
}

function money(value?: number | null): string {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return '--'
  return n >= 100 ? `$${n.toFixed(1)}` : `$${n.toFixed(2)}`
}

function scoreTone(score: number) {
  if (score >= 70) return 'text-emerald-300'
  if (score <= 38) return 'text-red-300'
  return 'text-sky-300'
}

function directionTone(direction?: string) {
  if (direction === 'bullish' || direction === 'up') return 'text-emerald-300 border-emerald-500/30 bg-emerald-500/10'
  if (direction === 'bearish' || direction === 'down') return 'text-red-300 border-red-500/30 bg-red-500/10'
  return 'text-sky-200 border-sky-500/30 bg-sky-500/10'
}

function ageLabel(minutes?: number | null): string {
  const n = Number(minutes)
  if (!Number.isFinite(n)) return '--'
  if (n < 60) return `${Math.round(n)}m`
  if (n < 1440) return `${Math.round(n / 60)}h`
  return `${Math.round(n / 1440)}d`
}

export function AIPage() {
  const [days, setDays] = useState(3)
  const [limit, setLimit] = useState(50)
  const [socialWindow, setSocialWindow] = useState(1440)
  const [minScore, setMinScore] = useState(0)
  const [direction, setDirection] = useState<'all' | 'bullish' | 'watch' | 'bearish'>('all')
  const [selectedTicker, setSelectedTicker] = useState('')

  const params = new URLSearchParams({
    days: String(days),
    limit: String(limit),
    window_minutes: String(socialWindow),
    min_score: String(minScore),
  })
  const { data, isLoading, mutate } = useSWR<AiRankingResponse>(`/api/ai/rankings?${params}`, fetcher, {
    refreshInterval: 60_000,
  })

  const rows = useMemo(() => {
    const source = data?.rows ?? []
    return direction === 'all' ? source : source.filter(row => row.direction === direction)
  }, [data?.rows, direction])
  const top = rows[0]
  const detailTicker = selectedTicker || top?.ticker || ''
  const { data: detail, isLoading: detailLoading } = useSWR<AiTickerDetail>(
    detailTicker ? `/api/ai/ticker/${detailTicker}?days=${days}&window_minutes=${socialWindow}` : null,
    fetcher,
    { refreshInterval: 60_000 }
  )
  const generated = data?.generated_at ? new Date(data.generated_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '--'
  const modelStatus = data?.model?.status || 'baseline'
  const modelSamples = Number(data?.model?.samples || 0)
  const modelMin = Number(data?.model?.min_samples || 20)
  const metrics = data?.model?.metrics || {}
  const actionableSamples = Number(metrics.actionable_samples || 0)
  const baselineActionableSamples = Number(metrics.baseline_actionable_samples || 0)
  const baselineAccuracy = Number(metrics.baseline_directional_accuracy_5m)
  const modelAccuracy = Number(metrics.directional_accuracy_5m)
  const modelBeatsBaseline = Number.isFinite(modelAccuracy) && (!Number.isFinite(baselineAccuracy) || modelAccuracy >= baselineAccuracy)
  const validationSamples = actionableSamples > 0 ? actionableSamples : baselineActionableSamples
  const validationLabel = validationSamples > 0
    ? `${compact(validationSamples)} samples${Number.isFinite(modelAccuracy) ? ` · ${Math.round(modelAccuracy * 100)}% model` : ''}${Number.isFinite(baselineAccuracy) ? ` · ${Math.round(baselineAccuracy * 100)}% base` : ''}`
    : 'pending'
  const modelTrustLabel = modelStatus === 'trained'
    ? actionableSamples > 0 ? modelBeatsBaseline ? 'validated' : 'shadow' : baselineActionableSamples > 0 ? 'baseline checked' : 'pending'
    : 'baseline'
  const modelTone = modelTrustLabel === 'validated'
    ? 'text-emerald-300'
    : modelTrustLabel === 'baseline checked'
      ? 'text-sky-300'
      : modelTrustLabel === 'shadow'
        ? 'text-yellow-300'
      : 'text-yellow-300'

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <h1 className="text-white font-semibold text-xl">AI Rankings</h1>
          <p className="text-sm text-neutral mt-1">
            Server-side blended ranking from momentum, news sentiment, social density, quote freshness, and prediction labels.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2">
          <Segment label="Days" value={days} options={DAY_OPTIONS} onChange={setDays} />
          <Segment label="Rows" value={limit} options={LIMIT_OPTIONS} onChange={setLimit} />
          <div className="flex items-center gap-1">
            <span className="text-[10px] uppercase text-neutral">Social</span>
            <div className="flex overflow-hidden rounded border border-border">
              {SOCIAL_WINDOWS.map(item => (
                <button
                  key={item.value}
                  onClick={() => setSocialWindow(item.value)}
                  className={clsx('px-2 py-1 text-xs transition-colors', socialWindow === item.value ? 'bg-accent text-white' : 'bg-bg text-neutral hover:text-white')}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
          <label className="flex items-center gap-2 text-[10px] uppercase text-neutral">
            Min
            <input
              type="number"
              min={0}
              max={100}
              value={minScore}
              onChange={event => setMinScore(Math.max(0, Math.min(100, Number(event.target.value || 0))))}
              className="w-16 rounded border border-border bg-bg px-2 py-1 text-xs text-white"
            />
          </label>
          <button
            onClick={() => mutate()}
            className="rounded border border-border bg-bg px-3 py-1.5 text-xs text-neutral transition-colors hover:border-accent hover:text-white"
          >
            Refresh
          </button>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
        <Metric label="AI Rows" value={compact(data?.summary?.rows ?? rows.length)} />
        <Metric label="Scored News" value={compact(data?.summary?.scored_articles)} tone="text-sky-300" />
        <Metric label="Bullish" value={compact(data?.summary?.bullish)} tone="text-emerald-300" />
        <Metric label="Bearish" value={compact(data?.summary?.bearish)} tone="text-red-300" />
        <Metric label="Model" value={modelTrustLabel} tone={modelTone} />
      </div>

      {data?.ok === false || data?.error ? (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-100">
          AI rankings failed: {data?.error || 'unknown error'}
        </div>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.45fr)_minmax(330px,0.7fr)]">
        <section className="min-w-0 rounded-lg border border-border bg-surface overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
            <div>
              <h2 className="text-sm font-semibold text-white">Ranked Signals</h2>
              <p className="text-[11px] text-neutral">Generated {generated} · {days}d news · {SOCIAL_WINDOWS.find(x => x.value === socialWindow)?.label ?? socialWindow} social</p>
            </div>
            <div className="flex overflow-hidden rounded border border-border">
              {(['all', 'bullish', 'watch', 'bearish'] as const).map(item => (
                <button
                  key={item}
                  onClick={() => setDirection(item)}
                  className={clsx('px-2.5 py-1 text-xs capitalize transition-colors', direction === item ? 'bg-accent text-white' : 'bg-bg text-neutral hover:text-white')}
                >
                  {item}
                </button>
              ))}
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[980px] text-left text-xs">
              <thead className="bg-bg/60 text-[10px] uppercase text-neutral">
                <tr>
                  <th className="px-3 py-2">Rank</th>
                  <th className="px-3 py-2">Ticker</th>
                  <th className="px-3 py-2">AI Score</th>
                  <th className="px-3 py-2">Move</th>
                  <th className="px-3 py-2">Rel Vol</th>
                  <th className="px-3 py-2">News</th>
                  <th className="px-3 py-2">Social</th>
                  <th className="px-3 py-2">Prediction</th>
                  <th className="px-3 py-2">Evidence</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700/40">
                {isLoading ? (
                  <tr><td colSpan={9} className="px-3 py-8 text-center text-neutral">Loading AI rankings...</td></tr>
                ) : rows.length ? rows.map(row => (
                  <AiRow
                    key={`${row.rank}-${row.ticker}`}
                    row={row}
                    selected={detailTicker === row.ticker}
                    onSelect={() => setSelectedTicker(row.ticker)}
                  />
                )) : (
                  <tr><td colSpan={9} className="px-3 py-8 text-center text-neutral">No AI rows match the current filters.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <aside className="space-y-4 min-w-0">
          <TickerAuditPanel detail={detail} loading={detailLoading} ticker={detailTicker} />

          <section className="rounded-lg border border-border bg-surface p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-white">Top Signal</h2>
                <p className="text-[11px] text-neutral">Highest blended AI score in the current window.</p>
              </div>
              {top && <span className={clsx('rounded border px-2 py-1 text-[11px] capitalize', directionTone(top.direction))}>{top.direction}</span>}
            </div>
            {top ? (
              <div className="mt-4">
                <div className="flex items-end justify-between gap-3">
                  <div>
                    <div className="font-mono text-2xl font-bold text-accent">{top.ticker}</div>
                    <div className="mt-1 truncate text-xs text-neutral">{top.company || 'No company name'}</div>
                  </div>
                  <div className={clsx('font-mono text-3xl font-bold', scoreTone(top.ai_rank_score))}>{top.ai_rank_score.toFixed(1)}</div>
                </div>
                <div className="mt-4 grid grid-cols-2 gap-2">
                  <Mini label="Price" value={money(top.price)} />
                  <Mini label="Move" value={pct(top.change_pct)} tone={(top.change_pct ?? 0) >= 0 ? 'text-emerald-300' : 'text-red-300'} />
                  <Mini label="News" value={compact(top.evidence.news_articles)} />
                  <Mini label="Social" value={compact(top.evidence.social_posts)} />
                </div>
                <EvidenceBars row={top} />
              </div>
            ) : (
              <div className="mt-4 text-sm text-neutral">Waiting for ranked rows.</div>
            )}
          </section>

          <section className="rounded-lg border border-border bg-surface p-4">
            <h2 className="text-sm font-semibold text-white">Reliability</h2>
            <div className="mt-3 space-y-2 text-xs">
              <ReliabilityLine label="Read path" value="Mongo + cached API" ok />
              <ReliabilityLine label="Provider dependency" value="none required" ok />
              <ReliabilityLine label="Fallback model" value={data?.model?.fallback || 'baseline'} ok />
              <ReliabilityLine label="Trained samples" value={compact(modelSamples)} ok={modelStatus === 'trained'} />
              <ReliabilityLine label="Validation" value={validationLabel} ok={validationSamples > 0} />
            </div>
          </section>

          <section className="rounded-lg border border-border bg-surface p-4">
            <h2 className="text-sm font-semibold text-white">Method</h2>
            <div className="mt-3 space-y-2 text-xs text-neutral">
              {Object.entries(data?.methodology ?? {}).map(([key, value]) => (
                <div key={key}>
                  <span className="text-slate-300 capitalize">{key.replace(/_/g, ' ')}:</span> {value}
                </div>
              ))}
            </div>
          </section>
        </aside>
      </div>
    </div>
  )
}

function Segment({ label, value, options, onChange }: {
  label: string
  value: number
  options: number[]
  onChange: (value: number) => void
}) {
  return (
    <div className="flex items-center gap-1">
      <span className="text-[10px] uppercase text-neutral">{label}</span>
      <div className="flex overflow-hidden rounded border border-border">
        {options.map(item => (
          <button
            key={item}
            onClick={() => onChange(item)}
            className={clsx('px-2 py-1 text-xs transition-colors', value === item ? 'bg-accent text-white' : 'bg-bg text-neutral hover:text-white')}
          >
            {item}
          </button>
        ))}
      </div>
    </div>
  )
}

function Metric({ label, value, tone = 'text-white' }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <div className={clsx('font-mono text-2xl font-semibold', tone)}>{value}</div>
      <div className="mt-2 text-[10px] font-semibold uppercase tracking-wide text-neutral">{label}</div>
    </div>
  )
}

function AiRow({ row, selected, onSelect }: { row: AiRankingRow; selected?: boolean; onSelect: () => void }) {
  const prediction = row.prediction_signal
  return (
    <tr className={clsx('cursor-pointer hover:bg-bg/40', selected && 'bg-sky-500/10')} onClick={onSelect}>
      <td className="px-3 py-3 font-mono text-neutral">{row.rank}</td>
      <td className="px-3 py-3">
        <div className="flex items-center gap-2">
          <span className="font-mono text-base font-bold text-accent">{row.ticker}</span>
          <span className={clsx('rounded border px-1.5 py-0.5 text-[10px] capitalize', directionTone(row.direction))}>{row.direction}</span>
        </div>
        <div className="mt-0.5 max-w-[220px] truncate text-[11px] text-neutral">{row.company || '--'}</div>
      </td>
      <td className="px-3 py-3">
        <div className={clsx('font-mono text-lg font-bold', scoreTone(row.ai_rank_score))}>{row.ai_rank_score.toFixed(1)}</div>
        <div className="mt-1 h-1.5 w-24 overflow-hidden rounded-full bg-slate-700">
          <div className={clsx('h-full rounded-full', row.ai_rank_score >= 70 ? 'bg-emerald-500' : row.ai_rank_score <= 38 ? 'bg-red-500' : 'bg-sky-500')} style={{ width: `${Math.min(100, Math.max(0, row.ai_rank_score))}%` }} />
        </div>
      </td>
      <td className={clsx('px-3 py-3 font-mono', (row.change_pct ?? 0) >= 0 ? 'text-emerald-300' : 'text-red-300')}>{pct(row.change_pct)}</td>
      <td className="px-3 py-3 font-mono text-slate-200">{Number(row.rel_volume || 0).toFixed(1)}x</td>
      <td className="px-3 py-3">
        <div className="font-mono text-slate-200">{compact(row.evidence.news_articles)}</div>
        <div className="text-[11px] text-neutral">{compact(row.evidence.bullish_news)} bull · {compact(row.evidence.bearish_news)} bear</div>
      </td>
      <td className="px-3 py-3">
        <div className="font-mono text-slate-200">{compact(row.evidence.social_posts)}</div>
        <div className={clsx('text-[11px] font-mono', Number(row.evidence.social_sentiment || 0) >= 0 ? 'text-emerald-300' : 'text-red-300')}>
          {Number(row.evidence.social_sentiment || 0).toFixed(2)}
        </div>
      </td>
      <td className="px-3 py-3">
        <div className={clsx('font-mono capitalize', directionTone(prediction?.direction).split(' ')[0])}>{prediction?.direction || 'watch'}</div>
        <div className="text-[11px] text-neutral">
          {prediction?.probability_up != null ? `${Math.round(prediction.probability_up * 100)}% up` : row.model_ready ? 'model' : 'baseline'}
        </div>
      </td>
      <td className="px-3 py-3">
        <div className="flex max-w-[240px] flex-wrap gap-1">
          {(row.reasons || []).slice(0, 3).map(reason => (
            <span key={reason} className="rounded border border-border bg-bg px-1.5 py-0.5 text-[10px] text-slate-200">{reason}</span>
          ))}
          {row.evidence.quote_age_minutes != null && (
            <span className="rounded border border-border bg-bg px-1.5 py-0.5 text-[10px] text-neutral">quote {ageLabel(row.evidence.quote_age_minutes)}</span>
          )}
        </div>
      </td>
    </tr>
  )
}

function TickerAuditPanel({ detail, loading, ticker }: { detail?: AiTickerDetail; loading?: boolean; ticker: string }) {
  const checks = detail?.checks ?? []
  const articles = detail?.articles ?? []
  const posts = detail?.social_posts ?? []
  const signals = detail?.prediction?.signals ?? []
  const active = detail?.prediction?.active_signal
  const predictionMetrics = detail?.prediction?.model?.metrics || {}
  const modelActionable = Number(predictionMetrics.actionable_samples || 0)
  const baselineActionable = Number(predictionMetrics.baseline_actionable_samples || 0)
  const baselineAccuracy = Number(predictionMetrics.baseline_directional_accuracy_5m)
  const modelAccuracy = Number(predictionMetrics.directional_accuracy_5m)
  const validationSamples = modelActionable > 0 ? modelActionable : baselineActionable
  const validationCopy = validationSamples > 0
    ? `${compact(validationSamples)} validation samples${Number.isFinite(modelAccuracy) ? ` · ${Math.round(modelAccuracy * 100)}% model` : ''}${Number.isFinite(baselineAccuracy) ? ` · ${Math.round(baselineAccuracy * 100)}% baseline` : ''}`
    : 'Validation pending'

  return (
    <section className="rounded-lg border border-border bg-surface overflow-hidden">
      <div className="border-b border-border px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-white">Why This Rank?</h2>
            <p className="text-[11px] text-neutral truncate">{ticker ? `${ticker} evidence audit` : 'Select a row to inspect the evidence chain.'}</p>
          </div>
          {detail?.score && (
            <span className={clsx('rounded border px-2 py-1 text-[11px] capitalize', directionTone(detail.score.direction))}>
              {detail.score.direction}
            </span>
          )}
        </div>
      </div>

      {loading ? (
        <div className="p-4 text-sm text-neutral">Loading ticker audit...</div>
      ) : detail?.error ? (
        <div className="p-4 text-sm text-red-200">{detail.error}</div>
      ) : detail ? (
        <div className="max-h-[760px] overflow-y-auto">
          <div className="grid grid-cols-2 gap-2 p-4">
            <Mini label="AI Score" value={compact(detail.score?.ai_rank_score)} tone={scoreTone(Number(detail.score?.ai_rank_score || 0))} />
            <Mini label="Trade Watch" value={compact((detail.score?.trade_watch_score || 0) * 100)} />
            <Mini label="News" value={compact(detail.evidence?.approved_article_count)} />
            <Mini label="Social" value={compact(detail.evidence?.social_posts)} />
          </div>

          <div className="border-t border-border p-4">
            <h3 className="text-xs font-semibold uppercase text-neutral">Calculation Checks</h3>
            <div className="mt-2 space-y-2">
              {checks.map(check => (
                <div key={check.label} className="rounded border border-border bg-bg/50 p-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-slate-200">{check.label}</span>
                    <span className={clsx('rounded px-1.5 py-0.5 text-[10px] uppercase',
                      check.status === 'pass' ? 'bg-emerald-500/15 text-emerald-300' :
                      check.status === 'warn' ? 'bg-yellow-500/15 text-yellow-300' :
                      'bg-sky-500/15 text-sky-300'
                    )}>{check.status}</span>
                  </div>
                  <div className="mt-1 text-[11px] text-neutral">{check.detail}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="border-t border-border p-4">
            <h3 className="text-xs font-semibold uppercase text-neutral">Prediction</h3>
            <div className="mt-2 rounded border border-border bg-bg/50 p-2 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="text-slate-200 capitalize">{active?.direction || 'watch'}</span>
                <span className="font-mono text-neutral">
                  {active?.probability_up != null ? `${Math.round(active.probability_up * 100)}% up` : 'baseline/model'}
                </span>
              </div>
              <div className="mt-1 text-[11px] text-neutral">
                {detail.prediction?.summary?.complete ?? 0} complete labels · {detail.prediction?.summary?.accuracy_5m == null ? '5m accuracy pending' : `${Math.round((detail.prediction.summary.accuracy_5m || 0) * 100)}% 5m accuracy`}
              </div>
              <div className="mt-1 text-[11px] text-neutral">
                {validationCopy}
              </div>
            </div>
            <div className="mt-2 space-y-1">
              {signals.slice(0, 4).map(signal => (
                <div key={signal.signal_id || `${signal.time}-${signal.rank}`} className="flex items-center justify-between gap-2 text-[11px]">
                  <span className="text-neutral">{signal.time || '--'} · {signal.decision || 'signal'}</span>
                  <span className={clsx('font-mono', signal.label_status === 'complete' ? 'text-emerald-300' : signal.label_status === 'pending' ? 'text-yellow-300' : 'text-sky-300')}>
                    {signal.label_status || 'pending'}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <EvidenceList
            title="News Evidence"
            empty="No approved ticker-matched headlines in this window."
            rows={articles.slice(0, 8).map(article => ({
              key: article.url || article.title,
              left: article.source || 'News',
              main: article.title,
              right: article.sentiment_score == null ? article.sentiment : `${article.sentiment_score >= 0 ? '+' : ''}${article.sentiment_score.toFixed(2)}`,
              meta: [article.time, article.event_type, article.reason].filter(Boolean).join(' · '),
              url: article.url,
              tone: Number(article.sentiment_score || 0),
            }))}
          />

          <EvidenceList
            title="Social Evidence"
            empty="No social posts in this selected window."
            rows={posts.slice(0, 8).map(post => ({
              key: post.url || `${post.platform}-${post.author}-${post.text}`,
              left: post.platform || 'Social',
              main: post.text,
              right: post.sentiment == null ? '--' : `${post.sentiment >= 0 ? '+' : ''}${post.sentiment.toFixed(2)}`,
              meta: [post.time, post.author ? `@${post.author}` : ''].filter(Boolean).join(' · '),
              url: post.url,
              tone: Number(post.sentiment || 0),
            }))}
          />
        </div>
      ) : (
        <div className="p-4 text-sm text-neutral">Select a ranked ticker to inspect evidence.</div>
      )}
    </section>
  )
}

function EvidenceList({ title, empty, rows }: {
  title: string
  empty: string
  rows: Array<{ key: string; left: string; main: string; right: string; meta?: string; url?: string; tone?: number }>
}) {
  return (
    <div className="border-t border-border p-4">
      <h3 className="text-xs font-semibold uppercase text-neutral">{title}</h3>
      <div className="mt-2 space-y-2">
        {rows.length ? rows.map(row => (
          <a
            key={row.key}
            href={row.url || undefined}
            target={row.url ? '_blank' : undefined}
            rel="noreferrer"
            className="block rounded border border-border bg-bg/50 p-2 transition-colors hover:border-accent/60"
          >
            <div className="flex items-center justify-between gap-2 text-[11px]">
              <span className="truncate text-neutral">{row.left}</span>
              <span className={clsx('font-mono', Number(row.tone || 0) >= 0 ? 'text-emerald-300' : 'text-red-300')}>{row.right}</span>
            </div>
            <div className="mt-1 line-clamp-2 text-xs text-slate-200">{row.main}</div>
            {row.meta && <div className="mt-1 truncate text-[11px] text-neutral">{row.meta}</div>}
          </a>
        )) : (
          <div className="rounded border border-border bg-bg/50 p-2 text-xs text-neutral">{empty}</div>
        )}
      </div>
    </div>
  )
}

function EvidenceBars({ row }: { row: AiRankingRow }) {
  const values = [
    { label: 'Trade', value: row.trade_watch_score ?? 0 },
    { label: 'Evidence', value: row.evidence.evidence_score ?? 0 },
    { label: 'Agreement', value: row.evidence.agreement ?? 0 },
    { label: 'Social', value: Math.min(1, Math.log1p(row.evidence.social_posts || 0) / Math.log1p(80)) },
  ]
  return (
    <div className="mt-4 space-y-2">
      {values.map(item => (
        <div key={item.label}>
          <div className="mb-1 flex items-center justify-between text-[11px]">
            <span className="text-neutral">{item.label}</span>
            <span className="font-mono text-slate-200">{Math.round(item.value * 100)}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-slate-700">
            <div className="h-full rounded-full bg-accent" style={{ width: `${Math.min(100, Math.max(0, item.value * 100))}%` }} />
          </div>
        </div>
      ))}
    </div>
  )
}

function Mini({ label, value, tone = 'text-white' }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded border border-border bg-bg/50 p-2">
      <div className={clsx('font-mono text-sm font-semibold', tone)}>{value}</div>
      <div className="mt-1 text-[10px] uppercase text-neutral">{label}</div>
    </div>
  )
}

function ReliabilityLine({ label, value, ok }: { label: string; value: string; ok?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded border border-border bg-bg/50 px-2 py-1.5">
      <span className="text-neutral">{label}</span>
      <span className={clsx('font-mono', ok ? 'text-emerald-300' : 'text-yellow-300')}>{value}</span>
    </div>
  )
}
