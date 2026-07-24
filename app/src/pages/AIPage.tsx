'use client'
import { useMemo, useState } from 'react'
import useSWR from 'swr'
import { clsx } from 'clsx'
import { CandlestickChart } from './CandlestickChart'

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
    predicted_return_intraday_trade?: number
    confidence?: number
    model?: string
    horizon?: string
    entry_ready?: boolean
    threshold_status?: string
    backtest_profit_factor?: number | null
    backtest_trades?: number | null
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
    price_density_correlation?: number | null
    density_setup_score?: number | null
    density_setup_status?: string | null
    validation_accuracy_5m?: number | null
    validation_samples?: number | null
    validation_avg_return_5m?: number | null
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
    validation_status?: string
    validation_edge?: number | null
    live_classifier_enabled?: boolean
    live_classifier_reason?: string
    threshold_rule_live_enabled?: boolean
    threshold_rule_live_reason?: string
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
    price_density_correlation?: number | null
    density_setup_score?: number | null
    density_setup_status?: string | null
    validation_edge?: number | null
    validation_accuracy_5m?: number | null
    validation_samples?: number | null
    validation_avg_return_5m?: number | null
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

type AiInlineChartData = {
  ok?: boolean
  error?: string
  ticker?: string
  tf?: string
  n?: number
  candles?: Array<{ time: number; open: number; high: number; low: number; close: number; volume?: number }>
  bollinger?: { upper: Array<{ time: number; value: number }>; lower: Array<{ time: number; value: number }> }
  predicted?: Array<{ time: number; value: number }>
  news_events?: Array<{ time: number; position?: string; color?: string; shape?: string; text?: string; title?: string; source?: string }>
  social_density?: Array<{ time: number; value: number; scaled?: number; count?: number; session?: string }>
  sentiment?: Array<{ time: number; value: number }>
  source_status?: {
    price?: string
    social?: string
    news?: string
    predictions?: string
  }
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

function modelShortName(model?: string): string {
  const raw = String(model || '').toLowerCase()
  if (raw.includes('threshold')) return 'threshold'
  if (raw.includes('linear')) return 'shadow ML'
  if (raw.includes('baseline')) return 'baseline'
  return model ? 'model' : 'baseline'
}

function humanStatus(status?: string | null): string {
  return String(status || '')
    .replace(/^entry_/, '')
    .replace(/_/g, ' ')
    .trim()
}

function predictionDisplay(signal?: AiRankingRow['prediction_signal'], model?: AiRankingResponse['model']) {
  const probability = Number(signal?.probability_up)
  const confidence = Number(signal?.confidence)
  const direction = String(signal?.direction || '').toLowerCase()
  const modelName = modelShortName(signal?.model)
  const liveEnabled = model?.live_classifier_enabled === true
  const thresholdLiveEnabled = model?.threshold_rule_live_enabled === true
  const validationStatus = String(model?.validation_status || '')
  const thresholdStatus = humanStatus(signal?.threshold_status)
  const entryReady = signal?.entry_ready === true
  const isNeutral = !Number.isFinite(probability) || Math.abs(probability - 0.5) < 0.035 || direction === 'watch'
  const predictedReturn = Number(signal?.predicted_return_5m ?? signal?.predicted_return_intraday_trade)
  const returnText = Number.isFinite(predictedReturn)
    ? `${predictedReturn >= 0 ? '+' : ''}${predictedReturn.toFixed(2)}%`
    : ''

  if (isNeutral) {
    const armed = thresholdLiveEnabled && !entryReady && thresholdStatus
    return {
      label: armed ? 'Setup pending' : liveEnabled ? 'No edge' : 'Edge pending',
      sub: armed
        ? thresholdStatus
        : modelName === 'baseline'
          ? 'baseline watch'
          : validationStatus.includes('shadow') ? 'shadow validation' : 'neutral model',
      meta: armed ? 'validated gate' : modelName === 'baseline' ? 'baseline' : 'neutral',
      tone: 'text-sky-200',
      barTone: 'bg-sky-500',
      width: armed ? 18 : 10,
    }
  }

  const up = probability > 0.5
  const edge = Math.abs(probability - 0.5)
  const label = entryReady && modelName === 'threshold' ? 'Validated edge' : up ? 'Upside edge' : 'Downside risk'
  const probText = `${Math.round(probability * 100)}% ${up ? 'up' : 'down'}`
  return {
    label,
    sub: [probText, returnText, modelName].filter(Boolean).join(' · '),
    meta: Number.isFinite(confidence) ? `conf ${(confidence * 100).toFixed(0)}%` : `edge ${(edge * 100).toFixed(0)}%`,
    tone: up ? 'text-emerald-300' : 'text-red-300',
    barTone: up ? 'bg-emerald-500' : 'bg-red-500',
    width: Math.max(10, Math.min(100, (Number.isFinite(confidence) ? confidence : edge) * 100)),
  }
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
  const [expandedTicker, setExpandedTicker] = useState('')
  const [auditTicker, setAuditTicker] = useState('')

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
  const { data: detail, isLoading: detailLoading } = useSWR<AiTickerDetail>(
    auditTicker ? `/api/ai/ticker/${auditTicker}?days=${days}&window_minutes=${socialWindow}` : null,
    fetcher,
    { refreshInterval: 60_000 }
  )
  const generated = data?.generated_at ? new Date(data.generated_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '--'
  const modelStatus = data?.model?.status || 'baseline'
  const metrics = data?.model?.metrics || {}
  const actionableSamples = Number(metrics.actionable_samples || 0)
  const baselineActionableSamples = Number(metrics.baseline_actionable_samples || 0)
  const baselineAccuracy = Number(metrics.baseline_directional_accuracy_5m)
  const modelAccuracy = Number(metrics.directional_accuracy_5m)
  const modelBeatsBaseline = Number.isFinite(modelAccuracy) && (!Number.isFinite(baselineAccuracy) || modelAccuracy >= baselineAccuracy)
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
                  <th className="px-3 py-2">Model Edge</th>
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
                    model={data?.model}
                    expanded={expandedTicker === row.ticker}
                    auditExpanded={auditTicker === row.ticker}
                    socialWindow={socialWindow}
                    auditDetail={auditTicker === row.ticker ? detail : undefined}
                    auditLoading={auditTicker === row.ticker ? detailLoading : false}
                    onToggleChart={() => {
                      setExpandedTicker(current => current === row.ticker ? '' : row.ticker)
                    }}
                    onToggleAudit={() => setAuditTicker(current => current === row.ticker ? '' : row.ticker)}
                  />
                )) : (
                  <tr><td colSpan={9} className="px-3 py-8 text-center text-neutral">No AI rows match the current filters.</td></tr>
                )}
              </tbody>
            </table>
          </div>
      </section>
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

function AiRow({
  row,
  model,
  expanded,
  auditExpanded,
  socialWindow,
  auditDetail,
  auditLoading,
  onToggleChart,
  onToggleAudit,
}: {
  row: AiRankingRow
  model?: AiRankingResponse['model']
  expanded?: boolean
  auditExpanded?: boolean
  socialWindow: number
  auditDetail?: AiTickerDetail
  auditLoading?: boolean
  onToggleChart: () => void
  onToggleAudit: () => void
}) {
  const prediction = row.prediction_signal
  const modelEdge = predictionDisplay(prediction, model)
  return (
    <>
      <tr className={clsx('hover:bg-bg/40', (expanded || auditExpanded) && 'bg-sky-500/10')}>
        <td className="px-3 py-3 font-mono text-neutral">{row.rank}</td>
        <td className="px-3 py-3">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={event => {
                event.stopPropagation()
                onToggleChart()
              }}
              className="rounded border border-transparent px-1 py-0.5 font-mono text-base font-bold text-accent transition-colors hover:border-sky-500/50 hover:bg-sky-500/10"
              aria-expanded={expanded}
              aria-label={`${expanded ? 'Hide' : 'Show'} ${row.ticker} chart`}
            >
              {row.ticker}
            </button>
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
          <div className={clsx('font-mono font-semibold', modelEdge.tone)}>{modelEdge.label}</div>
          <div className="mt-0.5 text-[11px] text-neutral">
            {modelEdge.sub}
          </div>
          <div className="mt-1 flex items-center gap-1.5">
            <div className="h-1 w-16 overflow-hidden rounded-full bg-slate-700">
              <div className={clsx('h-full rounded-full', modelEdge.barTone)} style={{ width: `${modelEdge.width}%` }} />
            </div>
            {modelEdge.meta && <span className="font-mono text-[10px] text-slate-400">{modelEdge.meta}</span>}
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
            <button
              type="button"
              onClick={event => {
                event.stopPropagation()
                onToggleAudit()
              }}
              className={clsx('rounded border px-1.5 py-0.5 text-[10px] transition-colors', auditExpanded ? 'border-sky-500/50 bg-sky-500/15 text-sky-200' : 'border-border bg-bg text-neutral hover:border-sky-500/50 hover:text-white')}
            >
              Audit
            </button>
          </div>
        </td>
      </tr>
      {expanded && (
        <tr className="bg-bg/30">
          <td colSpan={9} className="px-3 pb-4 pt-0">
            <AiInlineChart ticker={row.ticker} socialWindow={socialWindow} />
          </td>
        </tr>
      )}
      {auditExpanded && (
        <tr className="bg-bg/30">
          <td colSpan={9} className="px-3 pb-4 pt-0">
            <TickerAuditPanel detail={auditDetail} loading={auditLoading} ticker={row.ticker} dense />
          </td>
        </tr>
      )}
    </>
  )
}

function AiInlineChart({ ticker, socialWindow }: { ticker: string; socialWindow: number }) {
  const chartWindow = Math.max(1440, Math.min(10080, Number(socialWindow || 1440)))
  const { data, isLoading } = useSWR<AiInlineChartData>(
    ticker ? `/api/charts/${ticker}?tf=5m&events=1&window_minutes=${chartWindow}&bucket_minutes=5` : null,
    fetcher,
    { refreshInterval: 60_000 }
  )
  const candles = data?.candles || []
  const densityRows = data?.social_density || []
  const sentimentRows = data?.sentiment || []
  const latest = candles[candles.length - 1]
  const first = candles[0]
  const chartMove = latest && first ? ((Number(latest.close) - Number(first.close)) / Math.max(0.0001, Number(first.close))) * 100 : null
  const messageCount = densityRows.reduce((sum, point) => sum + Number(point.count || 0), 0)
  const avgSentiment = sentimentRows.length
    ? sentimentRows.reduce((sum, point) => sum + Number(point.value || 0), 0) / sentimentRows.length
    : 0

  return (
    <div className="mt-2 rounded-lg border border-sky-500/20 bg-slate-950/55 p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="font-mono text-sm font-semibold text-slate-100">{ticker} 5m chart</div>
          <div className="text-[11px] text-neutral">Price with Bollinger bands, message density, and validated sentiment overlays</div>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          <span className="rounded border border-border bg-bg px-2 py-1 text-neutral">{candles.length || 0} bars</span>
          <span className="rounded border border-orange-500/30 bg-orange-500/10 px-2 py-1 text-orange-200">{compact(messageCount)} msgs</span>
          <span className={clsx('rounded border px-2 py-1 font-mono', avgSentiment >= 0 ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' : 'border-red-500/30 bg-red-500/10 text-red-300')}>
            sent {avgSentiment >= 0 ? '+' : ''}{avgSentiment.toFixed(2)}
          </span>
          <span className={clsx('rounded border px-2 py-1 font-mono', Number(chartMove || 0) >= 0 ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' : 'border-red-500/30 bg-red-500/10 text-red-300')}>
            {pct(chartMove, 2)}
          </span>
        </div>
      </div>
      <div className="h-[340px] overflow-hidden rounded border border-border bg-bg">
        {isLoading ? (
          <div className="flex h-full items-center justify-center text-sm text-neutral">Loading chart...</div>
        ) : data?.error ? (
          <div className="flex h-full items-center justify-center text-sm text-red-200">{data.error}</div>
        ) : candles.length ? (
          <CandlestickChart
            candles={candles}
            bollinger={data?.bollinger}
            predicted={data?.predicted}
            newsEvents={data?.news_events || []}
            density={densityRows}
            sentiment={sentimentRows}
            showDensity
            showSentiment
            showBollinger
            showPrediction={false}
            showMarkers={false}
            chartStyle="candles"
            minHeight={320}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-neutral">No chart data available</div>
        )}
      </div>
    </div>
  )
}

function TickerAuditPanel({ detail, loading, ticker, dense = false }: { detail?: AiTickerDetail; loading?: boolean; ticker: string; dense?: boolean }) {
  const checks = detail?.checks ?? []
  const articles = detail?.articles ?? []
  const posts = detail?.social_posts ?? []
  const signals = detail?.prediction?.signals ?? []
  const active = detail?.prediction?.active_signal
  const activeDisplay = predictionDisplay(active, {
    status: detail?.prediction?.model?.status,
    samples: detail?.prediction?.model?.samples,
    metrics: detail?.prediction?.model?.metrics as Record<string, number> | null,
  })
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
    <section className={clsx('rounded-lg border border-border bg-surface overflow-hidden', compact && 'bg-slate-950/55')}>
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
        <div className={clsx('overflow-y-auto', dense ? 'max-h-[520px]' : 'max-h-[760px]')}>
          <div className={clsx('grid gap-2 p-4', dense ? 'grid-cols-2 md:grid-cols-4' : 'grid-cols-2')}>
            <Mini label="AI Score" value={compact(detail.score?.ai_rank_score)} tone={scoreTone(Number(detail.score?.ai_rank_score || 0))} />
            <Mini label="Trade Watch" value={compact((detail.score?.trade_watch_score || 0) * 100)} />
            <Mini label="News" value={compact(detail.evidence?.approved_article_count)} />
            <Mini label="Social" value={compact(detail.evidence?.social_posts)} />
            <Mini label="Density Setup" value={detail.score?.density_setup_score == null ? '--' : compact(detail.score.density_setup_score)} />
            <Mini label="Density Corr" value={detail.score?.price_density_correlation == null ? '--' : Number(detail.score.price_density_correlation).toFixed(2)} />
            <Mini label="Val Acc" value={detail.score?.validation_accuracy_5m == null ? '--' : `${Math.round(Number(detail.score.validation_accuracy_5m) * 100)}%`} />
            <Mini label="Val Return" value={detail.score?.validation_avg_return_5m == null ? '--' : pct(detail.score.validation_avg_return_5m, 2)} />
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
            <h3 className="text-xs font-semibold uppercase text-neutral">Model Edge</h3>
            <div className="mt-2 rounded border border-border bg-bg/50 p-2 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className={clsx('font-semibold', activeDisplay.tone)}>{activeDisplay.label}</span>
                <span className="font-mono text-neutral">{activeDisplay.sub}</span>
              </div>
              <div className="mt-2 flex items-center gap-2">
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-700">
                  <div className={clsx('h-full rounded-full', activeDisplay.barTone)} style={{ width: `${activeDisplay.width}%` }} />
                </div>
                {activeDisplay.meta && <span className="font-mono text-[10px] text-slate-400">{activeDisplay.meta}</span>}
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

function Mini({ label, value, tone = 'text-white' }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded border border-border bg-bg/50 p-2">
      <div className={clsx('font-mono text-sm font-semibold', tone)}>{value}</div>
      <div className="mt-1 text-[10px] uppercase text-neutral">{label}</div>
    </div>
  )
}
