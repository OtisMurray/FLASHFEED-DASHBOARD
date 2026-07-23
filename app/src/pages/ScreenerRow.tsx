'use client'
import { useState, useEffect, useRef } from 'react'
import { clsx } from 'clsx'
import type { ScreenerRow as SR } from '@/lib/types'
import { TickerDetailModal } from '@/components/shared/TickerDetailModal'
import { CandlestickChart } from './CandlestickChart'

interface Props {
  row: SR
  columns: Array<{ key: string; label: string }>
}

interface HoverChartData {
  candles: Array<{ time: string | number; open: number; high: number; low: number; close: number; volume?: number }>
  social_density?: Array<{ time: string | number; value: number; scaled?: number; count?: number }>
  sentiment?: Array<{ time: string | number; value: number }>
}

function fmtCompact(n: number | undefined | null): string {
  if (n == null) return '—'
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`
  return n.toLocaleString()
}

function fmtNumber(n: number | undefined | null, digits = 2): string {
  if (n == null || Number.isNaN(n)) return '—'
  return Number(n).toFixed(digits)
}

function fmtPct(n: number | undefined | null, signed = false): string {
  if (n == null || Number.isNaN(n)) return '—'
  const sign = signed && n > 0 ? '+' : ''
  return `${sign}${Number(n).toFixed(1)}%`
}

function pctTone(n: number | undefined | null) {
  const value = Number(n ?? 0)
  return value > 0 ? 'text-emerald-400' : value < 0 ? 'text-red-400' : 'text-neutral'
}

function scoreTone(n: number | undefined | null) {
  const value = Number(n ?? 0)
  if (value >= 70) return 'text-emerald-400'
  if (value >= 50) return 'text-yellow-300'
  if (value > 0) return 'text-orange-400'
  return 'text-neutral'
}

function sentBar(bullish: number, bearish: number, neutral: number) {
  const total = bullish + bearish + neutral
  if (total === 0) return null
  const bp = (bullish / total) * 100
  const np = (neutral / total) * 100
  return (
    <div className="flex h-1.5 rounded-full overflow-hidden w-16">
      <div className="bg-emerald-500" style={{ width: `${bp}%` }} />
      <div className="bg-slate-500" style={{ width: `${np}%` }} />
      <div className="bg-red-500" style={{ width: `${100 - bp - np}%` }} />
    </div>
  )
}

function titleCaseWords(value: string): string {
  return value
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, c => c.toUpperCase())
}

function catalystLabel(row: SR): string {
  const raw = [
    (row as any).main_catalyst?.event_type,
    (row as any).main_catalyst?.type,
    (row as any).structured_catalyst_type,
    (row as any).catalyst_quality?.class,
    (row as any).main_catalyst?.title,
    (row as any).catalyst_summary,
  ].filter(Boolean).join(' ').toLowerCase()

  if (/fda|pdufa|approval|clearance|510\(k\)|regulatory/.test(raw)) return /rejection|crl|reject|denied/.test(raw) ? 'FDA Rejection' : 'FDA Approval'
  if (/clinical|trial|phase\s*(1|2|3)|endpoint|study|data/.test(raw)) return /fail|miss|negative|halt/.test(raw) ? 'Trial Miss' : 'Clinical Data'
  if (/merger|acquisition|buyout|takeover|acquires|acquired|all-stock/.test(raw)) return 'Merger'
  if (/contract|award|order|purchase agreement|customer|defence|defense|government/.test(raw)) return 'Contract'
  if (/partnership|collaboration|strategic alliance|agreement/.test(raw)) return 'Partnership'
  if (/earnings|revenue|eps|guidance|results|quarter/.test(raw)) return /cut|miss|down/.test(raw) ? 'Earnings Miss' : 'Earnings'
  if (/offering|dilution|atm|warrant|convertible|registered direct/.test(raw)) return 'Offering'
  if (/sec|edgar|8-k|10-q|10-k|6-k|filing/.test(raw)) return 'SEC Filing'
  if (/analyst|upgrade|downgrade|price target/.test(raw)) return /downgrade|cut|lower/.test(raw) ? 'Analyst Cut' : 'Analyst Upgrade'
  if (/stock_move_up|soars|surges|jumps|rallies|gains/.test(raw)) return 'Momentum News'

  const qualityClass = String((row as any).catalyst_quality?.class || '')
  if (qualityClass) return titleCaseWords(qualityClass).replace('Commercial Contract Or Launch', 'Contract')
  return 'News'
}

function catalystTimeLabel(row: SR): string {
  const sec = Number(
    (row as any).main_catalyst?.event_sec ??
    (row as any).catalyst_reaction_summary?.event_sec ??
    (row as any).prediction_debug?.catalyst_reaction_summary?.event_sec ??
    0
  )
  if (!Number.isFinite(sec) || sec <= 0) return 'time unknown'
  return new Date(sec * 1000).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function catalystReactionMark(row: SR): { symbol: string; label: string; tone: string } {
  const reaction = (row as any).catalyst_reaction_summary || (row as any).prediction_readiness?.reaction || {}
  const debugReaction = (row as any).prediction_debug?.catalyst_reaction || {}
  const latest = Number(reaction.latest_return_pct ?? debugReaction.postCatalystLatestReturnPct)
  const runup = Number(reaction.runup_pct ?? debugReaction.postCatalystRunupPct)
  const giveback = Number(reaction.giveback_from_high_pct ?? debugReaction.postCatalystGivebackPct)
  const state = String(reaction.first_reaction_state || reaction.state || debugReaction.reactionState || '').toLowerCase()
  const pending = Boolean(reaction.pending_market_reaction || state.includes('pending'))
  const fading = Boolean(debugReaction.postCatalystFading || reaction.exhaustion_risk || state.includes('fading') || state.includes('exhausted')) ||
    (Number.isFinite(giveback) && giveback >= 35 && Number.isFinite(runup) && runup >= 3)

  if (pending || reaction.market_had_chance_to_react === false) {
    return { symbol: '→', label: 'pending reaction', tone: 'text-sky-300' }
  }
  if (fading || (Number.isFinite(latest) && latest < -0.5)) {
    return { symbol: '↓', label: 'fading', tone: 'text-red-300' }
  }
  if ((Number.isFinite(latest) && latest >= 1) || (Number.isFinite(runup) && runup >= 2)) {
    return { symbol: '↑', label: 'confirming', tone: 'text-emerald-300' }
  }
  return { symbol: '→', label: 'neutral', tone: 'text-neutral' }
}

function sourceList(row: SR): string {
  return [
    (row as any).main_catalyst?.source,
    ...(((row as any).sources || []) as string[]),
  ].filter(Boolean).slice(0, 3).join(', ')
}

export function ScreenerRow({ row, columns }: Props) {
  const [showDetail, setShowDetail] = useState(false)
  const [showHoverChart, setShowHoverChart] = useState(false)
  const [hoverData, setHoverData] = useState<HoverChartData | null>(null)
  const [hoverLoading, setHoverLoading] = useState(false)
  const hoverTimeoutRef = useRef<number | null>(null)
  const rowRef = useRef<HTMLTableRowElement>(null)

  const renderCell = (key: string) => {
    switch (key) {
      case 'ticker':
        return (
          <div className="flex items-center gap-2">
            <button onClick={() => setShowDetail(true)} className="font-mono font-bold text-accent hover:text-sky-300 transition-colors">
              {row.ticker}
            </button>
            {(row.high_conviction_fallback || row.prediction_status === 'fallback_candidate') && (
              <span className="text-[9px] uppercase tracking-wide text-yellow-300 bg-yellow-900/20 rounded px-1 py-0.5">
                fallback
              </span>
            )}
            {(row as any).discovery_tier === 'unpriced_or_pending_reaction_catalyst' && (
              <span className="text-[9px] uppercase tracking-wide text-sky-200 bg-sky-900/30 rounded px-1 py-0.5">
                pending
              </span>
            )}
          </div>
        )
      case 'company':
        return <span className="text-slate-300 truncate block max-w-[150px]">{row.company || row.industry || '—'}</span>
      case 'exchange':
      case 'country':
      case 'index':
      case 'market_cap_bucket':
      case 'earnings_date':
        return <span className="text-neutral whitespace-nowrap">{(row as any)[key] ?? '—'}</span>
      case 'session':
        return <span className="text-[10px] uppercase text-neutral whitespace-nowrap">{(row as any).session || (row.prediction as any)?.predictionSession || '—'}</span>
      case 'price':
        return <span className="font-mono">{row.price != null ? `$${row.price.toFixed(2)}` : '—'}</span>
      case 'change_pct':
        return (
          <span className={clsx('font-mono', (row.change_pct ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400')}>
            {row.change_pct != null ? `${row.change_pct >= 0 ? '+' : ''}${row.change_pct.toFixed(2)}%` : '—'}
          </span>
        )
      case 'prediction_direction':
      case 'fallback_prediction_direction':
        if (key === 'fallback_prediction_direction') {
          if ((row as any).isFallback || (row as any).is_fallback || row.prediction_status === 'fallback_candidate') {
            return <span className="text-[10px] text-yellow-300">Watch candidate</span>
          }
          const dir = String((row as any).fallback_prediction_direction || row.prediction_direction || 'watch').toLowerCase()
          return (
            <span className={clsx('font-mono uppercase', dir === 'up' ? 'text-emerald-400' : dir === 'down' ? 'text-red-400' : 'text-yellow-300')}>
              {dir}
            </span>
          )
        }
        if ((row as any).decision_candidate) {
          return (
            <div className="flex flex-col leading-tight">
              <span className="font-mono uppercase text-emerald-400">candidate</span>
              <span className="text-[9px] text-neutral">Decision Map</span>
            </div>
          )
        }
        if (!row.prediction) {
          if (row.prediction_status === 'fallback_candidate') {
            return <span className="text-yellow-300 text-[10px]">Watch candidate</span>
          }
          return <span className="text-yellow-300 text-[10px]">No prediction</span>
        }
        return (
          <span className={clsx('font-mono uppercase', row.prediction_direction === 'up' ? 'text-emerald-400' : row.prediction_direction === 'down' ? 'text-red-400' : 'text-neutral')}>
            {row.prediction_direction || 'watch'}
          </span>
        )
      case 'predicted_return':
      case 'final_predicted_percent':
        if (key === 'final_predicted_percent') {
          const finalPredicted = (row as any).final_predicted_percent ?? row.predicted_return
          if ((row as any).isFallback || (row as any).is_fallback || row.prediction_status === 'fallback_candidate') {
            const watchScore = (row as any).watchScore ?? (row as any).watch_score ?? (row as any).final_prediction_score
            const sourceLabel = (row as any).prediction_source_label || 'Watch Candidate'
            return (
              <div className="leading-tight">
                <span className="text-[10px] text-yellow-300">No stored prediction</span>
                <div className="text-[9px] text-neutral">{watchScore == null ? sourceLabel : `${sourceLabel} ${Number(watchScore).toFixed(0)}`}</div>
              </div>
            )
          }
          return (
            <span className={clsx('font-mono font-semibold', Number(finalPredicted ?? 0) >= 5 ? 'text-emerald-300' : Number(finalPredicted ?? 0) > 0 ? 'text-emerald-400' : 'text-neutral')}>
              {finalPredicted == null ? '—' : `${Number(finalPredicted) > 0 ? '+' : ''}${Number(finalPredicted).toFixed(2)}%`}
            </span>
          )
        }
        if ((row as any).decision_candidate) {
          return (
            <span
              className="font-mono text-sky-300"
              title="No trained 1d predicted return is stored; this row is ranked by screener-first Decision Map score."
            >
              score
            </span>
          )
        }
        if (!row.prediction) return <span className="text-neutral">—</span>
        const predictedReturnValue = row.predicted_return
        const confidenceValue = Number(row.prediction_confidence ?? row.prediction?.confidence ?? 0)
        const intervalRange = Number.isFinite(Number(predictedReturnValue)) && Number.isFinite(confidenceValue)
          ? Math.max(0.5, Math.abs(Number(predictedReturnValue)) * (1 - confidenceValue) * 0.8 + 0.5)
          : null
        const intervalLow = intervalRange != null ? Number(predictedReturnValue) - intervalRange : null
        const intervalHigh = intervalRange != null ? Number(predictedReturnValue) + intervalRange : null
        const intervalTitle = intervalLow != null && intervalHigh != null
          ? `Predicted avg ${Number(predictedReturnValue).toFixed(2)}%; range ${intervalLow.toFixed(2)}% to ${intervalHigh.toFixed(2)}% (${Math.round(confidenceValue * 100)}% confidence)`
          : undefined
        return (
          <span
            title={intervalTitle}
            className={clsx('font-mono', Number(predictedReturnValue || 0) > 0 ? 'text-emerald-400' : Number(predictedReturnValue || 0) < 0 ? 'text-red-400' : 'text-neutral')}
          >
            {predictedReturnValue == null ? '—' : `${predictedReturnValue > 0 ? '+' : ''}${Number(predictedReturnValue).toFixed(2)}%`}
          </span>
        )
      case 'prediction_confidence':
        if ((row as any).decision_candidate) return <span className="text-[10px] text-neutral">candidate</span>
        if ((row as any).isFallback || (row as any).is_fallback || row.prediction_status === 'fallback_candidate') return <span className="text-[10px] text-yellow-300">Watch only</span>
        const confidenceStack = (row as any).confidence_stack || (row as any).prediction_scorecard?.confidence_stack
        const confidenceBars = Array.isArray(confidenceStack?.bars) ? confidenceStack.bars : []
        const visibleBars = confidenceBars
          .filter((bar: any) => ['market', 'catalyst', 'people', 'density', 'float', 'penalty'].includes(String(bar?.key || '')))
          .slice(0, 6)
        const rawConfidence = Number(confidenceStack?.confidence ?? row.prediction_confidence ?? row.prediction?.confidence)
        const displayConfidence = Number.isFinite(rawConfidence)
          ? rawConfidence > 1 ? rawConfidence : rawConfidence * 100
          : null
        const confidenceTitle = confidenceBars.length
          ? confidenceBars.map((bar: any) => `${bar.label || bar.key}: ${Math.round(Number(bar.score || 0))}/100 - ${bar.reason || ''}`).join('\n')
          : undefined
        const confidenceTone = displayConfidence == null
          ? 'text-neutral'
          : displayConfidence >= 70
            ? 'text-emerald-400'
            : displayConfidence >= 55
              ? 'text-sky-300'
              : displayConfidence >= 40
                ? 'text-yellow-300'
                : 'text-orange-300'
        return (
          <div className="min-w-[86px] leading-tight" title={confidenceTitle}>
            <div className={clsx('font-mono', confidenceTone)}>{displayConfidence == null ? '—' : `${Math.round(displayConfidence)}%`}</div>
            {visibleBars.length > 0 && (
              <div className="mt-1 space-y-0.5">
                {visibleBars.map((bar: any) => {
                  const score = Math.max(0, Math.min(100, Number(bar.score || 0)))
                  const isPenalty = bar.key === 'penalty'
                  const fillClass = isPenalty
                    ? score >= 45 ? 'bg-red-400' : score >= 20 ? 'bg-orange-400' : 'bg-emerald-500'
                    : score >= 75 ? 'bg-emerald-400' : score >= 55 ? 'bg-sky-400' : score >= 35 ? 'bg-yellow-300' : 'bg-slate-600'
                  return (
                    <div key={bar.key} className="flex items-center gap-1">
                      <span className="w-5 text-[8px] uppercase text-neutral">{String(bar.label || bar.key).slice(0, 3)}</span>
                      <span className="h-1 w-12 overflow-hidden rounded-full bg-slate-800">
                        <span className={clsx('block h-full rounded-full', fillClass)} style={{ width: `${Math.max(4, score)}%` }} />
                      </span>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )
      case 'payoff_model_probability':
        const payoffProb = (row as any).payoff_model_probability
        const payoffThreshold = (row as any).payoff_model_threshold
        if (payoffProb == null) return <span className="text-neutral">—</span>
        const payoffPasses = (row as any).payoff_model_passes
        const payoffTone = payoffPasses === true ? 'text-emerald-400' : payoffPasses === false ? 'text-red-400' : 'text-yellow-300'
        return (
          <div className="leading-tight" title={`Payoff model probability ${Number(payoffProb).toFixed(3)}${payoffThreshold != null ? `; threshold ${Number(payoffThreshold).toFixed(3)}` : ''}`}>
            <span className={`font-mono ${payoffTone}`}>{Math.round(Number(payoffProb) * 100)}%</span>
            {payoffThreshold != null && <div className="text-[9px] text-neutral">min {Math.round(Number(payoffThreshold) * 100)}%</div>}
          </div>
        )
      case 'fallback_confidence':
        const fallbackConfidence = (row as any).fallback_confidence
        return (
          <span className={clsx('font-mono', Number(fallbackConfidence ?? 0) >= 0.6 ? 'text-emerald-400' : Number(fallbackConfidence ?? 0) >= 0.35 ? 'text-yellow-300' : 'text-neutral')}>
            {fallbackConfidence == null ? '—' : `${Math.round(Number(fallbackConfidence) * 100)}%`}
          </span>
        )
      case 'prediction_source_label':
        const sourceTone = String((row as any).prediction_source_tone || 'muted')
        return (
          <span
            className={clsx(
              'inline-flex whitespace-nowrap rounded border px-1.5 py-0.5 text-[10px]',
              sourceTone === 'strong' || sourceTone === 'success'
                ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
                : sourceTone === 'moderate' || sourceTone === 'info'
                  ? 'border-sky-500/40 bg-sky-500/10 text-sky-200'
                  : sourceTone === 'caution' || sourceTone === 'warning'
                    ? 'border-yellow-500/40 bg-yellow-500/10 text-yellow-200'
                    : 'border-slate-500/40 bg-slate-500/10 text-slate-300'
            )}
            title={(row as any).prediction_source_code || undefined}
          >
            {(row as any).prediction_source_label || ((row as any).isFallback || (row as any).is_fallback ? 'Watch Candidate' : 'Real Prediction')}
          </span>
        )
      case 'discovery_tier_label':
        const tierTone = String((row as any).discovery_tier_tone || 'muted')
        const tierLabel = String((row as any).discovery_tier_label || (row as any).discovery_tier || '—').replace(/_/g, ' ')
        return (
          <span
            className={clsx(
              'inline-flex whitespace-nowrap rounded border px-1.5 py-0.5 text-[10px]',
              tierTone === 'success'
                ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
                : tierTone === 'info'
                  ? 'border-sky-500/40 bg-sky-500/10 text-sky-200'
                  : tierTone === 'warning'
                    ? 'border-yellow-500/40 bg-yellow-500/10 text-yellow-200'
                    : 'border-slate-500/40 bg-slate-500/10 text-slate-300'
            )}
            title={(row as any).discovery_reason || undefined}
          >
            {tierLabel}
          </span>
        )
      case 'prediction_readiness_level':
        const readiness = (row as any).prediction_readiness || {}
        const readinessLevel = String((row as any).prediction_readiness_level || readiness.level || 'watch_candidate')
        const readinessLabel = String((row as any).prediction_readiness_label || readiness.label || readinessLevel.replace(/_/g, ' '))
        const readinessTone = String((row as any).prediction_readiness_tone || readiness.tone || 'neutral')
        const waitingFor = (((row as any).prediction_waiting_for || readiness.waiting_for || []) as string[]).filter(Boolean)
        return (
          <div className="max-w-[150px]" title={waitingFor.length ? `waiting for: ${waitingFor.join(', ')}` : readinessLevel}>
            <span
              className={clsx(
                'text-[9px] uppercase tracking-wide border rounded px-1.5 py-0.5 whitespace-nowrap',
                readinessTone === 'success'
                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                  : readinessTone === 'info'
                    ? 'border-sky-500/40 bg-sky-500/10 text-sky-300'
                    : readinessTone === 'warning'
                      ? 'border-yellow-500/40 bg-yellow-500/10 text-yellow-200'
                      : readinessTone === 'danger'
                        ? 'border-red-500/40 bg-red-500/10 text-red-300'
                        : 'border-slate-500/40 bg-slate-500/10 text-slate-300'
              )}
            >
              {readinessLabel}
            </span>
            {waitingFor.length > 0 && (
              <div className="text-[9px] text-neutral truncate mt-0.5">
                needs {waitingFor.slice(0, 2).map(item => item.replace(/_/g, ' ')).join(', ')}
              </div>
            )}
          </div>
        )
      case 'catalyst_reaction_summary':
        const reaction = (row as any).catalyst_reaction_summary || (row as any).prediction_readiness?.reaction || {}
        if (!Object.keys(reaction).length) return <span className="text-neutral">—</span>
        const reactionTone = String(reaction.tone || 'neutral')
        const reactionTitle = [
          `state: ${reaction.state ?? '—'}`,
          `label: ${reaction.label ?? '—'}`,
          `reason: ${reaction.reaction_reason ?? '—'}`,
          `rejection: ${reaction.rejection ?? '—'}`,
          `market had chance to react: ${reaction.market_had_chance_to_react == null ? '—' : reaction.market_had_chance_to_react ? 'yes' : 'no'}`,
          `actionable spillover: ${reaction.actionable_spillover == null ? '—' : reaction.actionable_spillover ? 'yes' : 'no'}`,
          `exhaustion risk: ${reaction.exhaustion_risk == null ? '—' : reaction.exhaustion_risk ? 'yes' : 'no'}`,
          `post-catalyst bars: ${reaction.post_catalyst_bar_count ?? '—'}`,
          `runup: ${fmtPct(reaction.runup_pct, true)}`,
          `latest return: ${fmtPct(reaction.latest_return_pct, true)}`,
          `giveback from high: ${fmtPct(reaction.giveback_from_high_pct)}`,
          `post-catalyst volume: ${fmtCompact(reaction.post_catalyst_volume)}`,
          `post-catalyst dollar volume: ${fmtCompact(reaction.post_catalyst_dollar_volume)}`,
          `minutes since catalyst: ${reaction.minutes_since_catalyst ?? '—'}`,
          `market session: ${reaction.market_session ?? '—'}`,
          `source: ${reaction.source ?? '—'}`,
        ].join('\n')
        return (
          <div className="max-w-[160px]" title={reactionTitle}>
            <div
              className={clsx(
                'text-[10px] font-semibold uppercase',
                reactionTone === 'success'
                  ? 'text-emerald-300'
                  : reactionTone === 'warning'
                    ? 'text-yellow-300'
                    : reactionTone === 'danger'
                      ? 'text-red-300'
                      : 'text-neutral'
              )}
            >
              {String(reaction.label || 'reaction').replace(/_/g, ' ')}
            </div>
            <div className="font-mono text-[10px] text-slate-300 whitespace-nowrap">
              H {fmtPct(reaction.runup_pct, true)} · now {fmtPct(reaction.latest_return_pct, true)} · gb {fmtPct(reaction.giveback_from_high_pct)}
            </div>
          </div>
        )
      case 'catalyst_quality_score':
        const catalystQuality = (row as any).catalyst_quality || {}
        const qualityScore = (row as any).catalyst_quality_score ?? catalystQuality.score
        const qualityTier = String((row as any).catalyst_quality_tier || catalystQuality.tier || 'unknown')
        if (qualityScore == null) return <span className="text-neutral">—</span>
        return (
          <div className="leading-tight max-w-[120px]" title={(catalystQuality.reasons || []).join('\n') || undefined}>
            <span className={clsx('font-mono', scoreTone(Number(qualityScore)))}>{Number(qualityScore).toFixed(0)}</span>
            <div className={clsx(
              'text-[9px] uppercase',
              qualityTier === 'strong' ? 'text-emerald-300' : qualityTier === 'moderate' ? 'text-sky-300' : qualityTier === 'weak' ? 'text-yellow-300' : qualityTier === 'reject' ? 'text-red-300' : 'text-neutral'
            )}>
              {qualityTier}
            </div>
          </div>
        )
      case 'prediction_decision_reason':
        const decisionReason = String((row as any).prediction_decision_reason || (row as any).reason_included_detail || '')
        if (!decisionReason) return <span className="text-neutral">—</span>
        return <span className="block max-w-[340px] truncate text-slate-300" title={decisionReason}>{decisionReason}</span>
      case 'prediction_blocked_reasons':
        const blockedReasons = (((row as any).prediction_blocked_reasons || []) as string[]).filter(Boolean)
        if (!blockedReasons.length) return <span className="text-emerald-300 text-[10px]">clear</span>
        return (
          <div className="flex flex-wrap gap-0.5 max-w-[220px]" title={blockedReasons.join('\n')}>
            {blockedReasons.slice(0, 2).map(reason => (
              <span key={reason} className="text-[9px] bg-red-900/40 text-red-300 px-1 py-0.5 rounded">
                {reason.replace(/_/g, ' ').toLowerCase()}
              </span>
            ))}
            {blockedReasons.length > 2 && <span className="text-[9px] text-neutral">+{blockedReasons.length - 2}</span>}
          </div>
        )
      case 'prediction_horizon_requested':
        return (
          <div className="flex flex-col leading-tight">
            <span className="font-mono text-neutral">{row.prediction?.requested_horizon || row.prediction_horizon_requested || '—'}</span>
            {(row as any).decision_candidate && <span className="text-[9px] text-sky-300">candidate</span>}
            {row.prediction?.is_next_day_proxy && <span className="text-[9px] text-yellow-300">proxy</span>}
          </div>
        )
      case 'catalyst_brief': {
        const catalyst = (row as any).main_catalyst
        const reaction = (row as any).catalyst_reaction_summary || (row as any).prediction_readiness?.reaction || {}
        const quality = (row as any).catalyst_quality || {}
        const mark = catalystReactionMark(row)
        const label = catalystLabel(row)
        const title = [
          `Catalyst: ${label}`,
          `Time: ${catalystTimeLabel(row)}`,
          `Reaction: ${mark.label}`,
          `Event type: ${catalyst?.event_type || (row as any).structured_catalyst_type || '—'}`,
          `Quality: ${quality.tier || '—'} ${quality.score == null ? '' : `${Number(quality.score).toFixed(1)}/100`}`.trim(),
          `Session: ${reaction.market_session || catalyst?.market_session || '—'}`,
          `Source: ${sourceList(row) || '—'}`,
          `Headline: ${catalyst?.title || (row as any).catalyst_summary || '—'}`,
          `Reason: ${reaction.reaction_reason || '—'}`,
        ].join('\n')
        if (!catalyst && (row as any).broad_roundup_catalyst_suppressed) {
          return (
            <div className="max-w-[220px]" title="A broad market-movers roundup was found, but no ticker-specific catalyst was available for this row.">
              <div className="text-[10px] font-semibold uppercase text-yellow-200">No ticker-specific catalyst</div>
              <div className="text-[10px] text-neutral">roundup suppressed</div>
            </div>
          )
        }
        if (!catalyst && !(row as any).catalyst_summary && !(row as any).structured_catalyst_type) {
          return <span className="text-neutral">—</span>
        }
        return (
          <div className="max-w-[280px]" title={title}>
            <div className="flex items-center gap-1.5">
              <span className={clsx('font-mono text-sm font-bold', mark.tone)}>{mark.symbol}</span>
              <span className="text-[10px] font-semibold uppercase text-sky-200">{label}</span>
              {quality.score != null && <span className="font-mono text-[9px] text-neutral">{Number(quality.score).toFixed(0)}</span>}
            </div>
            <div className="text-[10px] text-neutral">{catalystTimeLabel(row)} · {mark.label}</div>
            <div className="truncate text-[10px] text-slate-300">{catalyst?.title || (row as any).catalyst_summary || '—'}</div>
          </div>
        )
      }
      case 'main_catalyst':
        if (!row.main_catalyst) return <span className="text-neutral">—</span>
        return (
          <div className="max-w-[240px]">
            <div className={clsx('text-[10px] uppercase font-semibold', row.main_catalyst.isSecFiling ? 'text-yellow-300' : 'text-sky-300')}>
              {row.main_catalyst.type || row.main_catalyst.source || 'news'}
            </div>
            <div className="text-slate-300 truncate">{row.main_catalyst.title || row.main_catalyst.source || 'Catalyst'}</div>
            {row.main_catalyst.isSecFiling && (
              <div className="text-[9px] text-neutral">{row.main_catalyst.filingContentStatus || 'filing'}</div>
            )}
          </div>
        )
      case 'volume':
        return <span className="font-mono text-neutral">{fmtCompact(row.volume)}</span>
      case 'avg_volume':
        return <span className="font-mono text-neutral">{fmtCompact((row as any).avg_volume)}</span>
      case 'rel_volume':
        return <span className="font-mono text-neutral">{fmtNumber((row as any).rel_volume, 2)}x</span>
      case 'market_cap':
        return <span className="font-mono text-neutral">{fmtCompact((row as any).market_cap)}</span>
      case 'sector':
        return <span className="text-neutral truncate max-w-[100px]">{row.sector ?? '—'}</span>
      case 'industry':
        return <span className="text-neutral truncate max-w-[100px]">{row.industry ?? '—'}</span>
      case 'avg_sentiment':
        const avgSentiment = row.avg_sentiment ?? 0
        return (
          <div className="flex items-center gap-1.5">
            <span className={clsx('font-mono', avgSentiment >= 0.2 ? 'text-emerald-400' : avgSentiment <= -0.2 ? 'text-red-400' : 'text-neutral')}>
              {avgSentiment.toFixed(2)}
            </span>
            {sentBar(row.bullish_count ?? 0, row.bearish_count ?? 0, row.neutral_count ?? 0)}
          </div>
        )
      case 'social_sentiment':
        const socialSentiment = row.social_sentiment ?? 0
        return (
          <span className={clsx('font-mono', socialSentiment >= 0.2 ? 'text-emerald-400' : socialSentiment <= -0.2 ? 'text-red-400' : 'text-neutral')}>
            {socialSentiment.toFixed(2)}
          </span>
        )
      case 'social_message_sentiment':
        const allSocialSentiment = row.social_message_sentiment ?? row.social_sentiment ?? 0
        return (
          <span className={clsx('font-mono', allSocialSentiment >= 0.2 ? 'text-emerald-400' : allSocialSentiment <= -0.2 ? 'text-red-400' : 'text-neutral')}>
            {allSocialSentiment.toFixed(2)}
          </span>
        )
      case 'social_message_density':
        return <span className="font-mono text-neutral">{(row.social_message_density ?? 0).toFixed(3)}/m</span>
      case 'stocktwits_message_sentiment':
        const stocktwitsSentiment = row.stocktwits_message_sentiment ?? 0
        return (
          <span className={clsx('font-mono', stocktwitsSentiment >= 0.2 ? 'text-emerald-400' : stocktwitsSentiment <= -0.2 ? 'text-red-400' : 'text-neutral')}>
            {stocktwitsSentiment.toFixed(2)}
          </span>
        )
      case 'stocktwits_message_density':
        return <span className="font-mono text-neutral">{(row.stocktwits_message_density ?? 0).toFixed(3)}/m</span>
      case 'message_density_trend':
        const trend = String((row as any).message_density_trend || (row as any).prediction_debug?.message_density_trend || 'none')
        const densityScore = Number((row as any).message_density_score ?? (row as any).prediction_debug?.message_density_score ?? 0)
        const rising = Boolean((row as any).message_density_rising ?? (row as any).prediction_debug?.message_density_rising)
        const supported = Boolean((row as any).message_density_supported ?? (row as any).prediction_debug?.message_density_supported)
        return (
          <div title={`5m: ${(row as any).message_density_5m ?? '—'}/m\n15m: ${(row as any).message_density_15m ?? '—'}/m\n30m: ${(row as any).message_density_30m ?? '—'}/m\n60m: ${(row as any).message_density_60m ?? '—'}/m\nactive 15m: ${(row as any).message_density_active_15m ?? '—'}/m\nactive 60m: ${(row as any).message_density_active_60m ?? '—'}/m\nsession count: ${(row as any).message_density_session_count ?? '—'}\nsession density: ${(row as any).message_density_session_density ?? '—'}/m\nlast event age: ${(row as any).message_density_last_event_age_minutes ?? '—'}m\nchange: ${(row as any).message_density_change_pct ?? '—'}%`}>
            <span className={clsx('font-mono text-[10px]', rising ? 'text-sky-300' : supported ? 'text-emerald-300' : trend === 'falling' ? 'text-red-300' : 'text-neutral')}>
              {trend.replace(/_/g, ' ')}
            </span>
            <div className="text-[9px] text-neutral">{densityScore.toFixed(0)}/100</div>
          </div>
        )
      case 'setup_summary': {
        const trend = String((row as any).message_density_trend || (row as any).prediction_debug?.message_density_trend || 'none')
        const densityScore = Number((row as any).message_density_score ?? (row as any).prediction_debug?.message_density_score ?? 0)
        const squeezeScore = Number((row as any).short_squeeze_score ?? (row as any).prediction_debug?.short_squeeze_score ?? 0)
        const newsScore = Number((row as any).news_score ?? (row as any).newsScore ?? (row as any).catalystScore ?? 0)
        const socialScore = Number((row as any).social_score ?? (row as any).socialScore ?? 0)
        const momentumScore = Number((row as any).momentum_score ?? (row as any).momentumScore ?? 0)
        const corrVal = (row as any).correlation_score
        const title = [
          `News/catalyst score: ${Number.isFinite(newsScore) ? newsScore.toFixed(1) : '—'}`,
          `Social score: ${Number.isFinite(socialScore) ? socialScore.toFixed(1) : '—'}`,
          `Momentum score: ${Number.isFinite(momentumScore) ? momentumScore.toFixed(1) : '—'}`,
          `Message density trend: ${trend}`,
          `Message density score: ${Number.isFinite(densityScore) ? densityScore.toFixed(1) : '—'}`,
          `Squeeze score: ${Number.isFinite(squeezeScore) ? squeezeScore.toFixed(1) : '—'}`,
          `Correlation: ${corrVal == null ? 'missing' : Number(corrVal).toFixed(3)}`,
          `SEC used: ${(row as any).sec_filing_contributed ? 'yes' : 'no'}`,
        ].join('\n')
        return (
          <div className="leading-tight" title={title}>
            <div className="flex items-center gap-2 font-mono text-[10px]">
              <span className={scoreTone(newsScore)}>N {Number.isFinite(newsScore) ? newsScore.toFixed(0) : '—'}</span>
              <span className={scoreTone(socialScore)}>S {Number.isFinite(socialScore) ? socialScore.toFixed(0) : '—'}</span>
              <span className={scoreTone(momentumScore)}>M {Number.isFinite(momentumScore) ? momentumScore.toFixed(0) : '—'}</span>
            </div>
            <div className="text-[9px] text-neutral">
              {trend.replace(/_/g, ' ')} · sqz {squeezeScore.toFixed(0)} · corr {corrVal == null ? '—' : Number(corrVal).toFixed(2)}
            </div>
          </div>
        )
      }
      case 'short_squeeze_score':
        const squeezeScore = Number((row as any).short_squeeze_score ?? (row as any).prediction_debug?.short_squeeze_score ?? 0)
        const squeezeSignal = String((row as any).squeeze_signal || (row as any).prediction_debug?.squeeze_signal || '')
        return (
          <div title={(row as any).short_squeeze_reason || String((row as any).prediction_debug?.short_squeeze_reason || '')}>
            <span className={clsx('font-mono font-semibold', squeezeScore >= 62 ? 'text-sky-300' : squeezeScore >= 42 ? 'text-yellow-300' : 'text-neutral')}>
              {squeezeScore.toFixed(0)}
            </span>
            <div className="text-[9px] text-neutral truncate max-w-[90px]">{squeezeSignal.replace(/_/g, ' ') || '—'}</div>
          </div>
        )
      case 'stocktwits_message_count':
        return <span className="font-mono text-neutral">{row.stocktwits_message_count ?? 0}</span>
      case 'structured_sentiment':
        const structuredSentiment = row.structured_sentiment ?? 0
        return (
          <span className={clsx('font-mono', structuredSentiment >= 0.2 ? 'text-emerald-400' : structuredSentiment <= -0.2 ? 'text-red-400' : 'text-neutral')}>
            {structuredSentiment.toFixed(2)}
          </span>
        )
      case 'filing_sentiment':
        const filingSentiment = row.filing_sentiment ?? 0
        return (
          <span className={clsx('font-mono', filingSentiment >= 0.2 ? 'text-emerald-400' : filingSentiment <= -0.2 ? 'text-red-400' : 'text-neutral')}>
            {filingSentiment.toFixed(2)}
          </span>
        )
      case 'filing_article_count':
        return <span className="font-mono text-neutral">{row.filing_article_count ?? 0}</span>
      case 'filing_used_count':
        return <span className={clsx('font-mono', Number(row.filing_used_count || 0) > 0 ? 'text-emerald-400' : 'text-neutral')}>{row.filing_used_count ?? 0}</span>
      case 'sec_filing_contributed':
        return <span className={clsx('text-[10px] font-semibold', row.sec_filing_contributed ? 'text-emerald-400' : 'text-neutral')}>{row.sec_filing_contributed ? 'YES' : 'NO'}</span>
      case 'message_count':
        return <span className="font-mono text-neutral">{row.message_count ?? 0}</span>
      case 'rolling_window_minutes':
        return <span className="font-mono text-neutral">{(row as any).rolling_window_minutes ?? '—'}m</span>
      case 'news_article_count':
        return <span className="font-mono text-neutral">{row.news_article_count ?? 0}</span>
      case 'bullish_count':
        return <span className="font-mono text-emerald-400">{row.bullish_count ?? 0}</span>
      case 'bearish_count':
        return <span className="font-mono text-red-400">{row.bearish_count ?? 0}</span>
      case 'pe_ratio':
      case 'forward_pe':
      case 'peg':
      case 'ps_ratio':
      case 'pb_ratio':
      case 'debt_equity':
      case 'beta':
      case 'atr':
        return <span className="font-mono text-neutral">{fmtNumber((row as any)[key], key === 'pe_ratio' || key === 'forward_pe' ? 1 : 2)}</span>
      case 'target_price':
        return <span className="font-mono text-neutral">{(row as any).target_price != null ? `$${Number((row as any).target_price).toFixed(2)}` : '—'}</span>
      case 'dividend_yield':
      case 'eps_growth_this_y':
      case 'eps_growth_next_y':
      case 'sales_growth':
      case 'gross_margin':
      case 'operating_margin':
      case 'roe':
      case 'inst_own':
      case 'insider_own':
      case 'float_short':
      case 'perf_week':
      case 'perf_month':
      case 'perf_quarter':
      case 'perf_half':
      case 'perf_year':
      case 'perf_ytd':
      case 'sma20':
      case 'sma50':
      case 'sma200':
      case 'gap':
        return <span className={`font-mono ${pctTone((row as any)[key])}`}>{fmtPct((row as any)[key], ['perf_week','perf_month','perf_quarter','perf_half','perf_year','perf_ytd','sma20','sma50','sma200','gap','eps_growth_this_y','eps_growth_next_y','sales_growth'].includes(key))}</span>
      case 'rsi':
        const rsi = Number((row as any).rsi ?? 0)
        return <span className={clsx('font-mono', rsi >= 70 ? 'text-red-400' : rsi <= 30 ? 'text-emerald-400' : 'text-neutral')}>{fmtNumber(rsi, 1)}</span>
      case 'analyst':
        return <span className={clsx('font-mono', row.analyst === 'Buy' || row.analyst === 'Strong Buy' ? 'text-emerald-400' : row.analyst === 'Sell' ? 'text-red-400' : 'text-neutral')}>{row.analyst ?? '—'}</span>
      case 'sources':
        return (
          <div className="flex gap-0.5 flex-wrap">
            {(row.sources ?? []).slice(0, 3).map(s => (
              <span key={s} className="text-[9px] bg-slate-700 text-neutral px-1 py-0.5 rounded capitalize">{s}</span>
            ))}
          </div>
        )
      case 'final_prediction_score':
      case 'evidence_score':
        const da = (row as any).dashboard_assessment
        const fps = key === 'evidence_score'
          ? ((row as any).evidence_score ?? da?.finalScore ?? (row as any).final_prediction_score)
          : (da?.finalScore ?? (row as any).final_prediction_score)
        if ((row as any).isFallback || (row as any).is_fallback || row.prediction_status === 'fallback_candidate') {
          const watchScore = (row as any).watchScore ?? (row as any).watch_score ?? fps
          const sourceLabel = (row as any).prediction_source_label || 'watch score'
          return (
            <div className="leading-tight">
              <span className="font-mono text-yellow-300">{watchScore == null ? '—' : Number(watchScore).toFixed(0)}</span>
              <div className="text-[9px] text-neutral">{sourceLabel}</div>
            </div>
          )
        }
        if (fps == null) return <span className="text-neutral">No score</span>
        const fpsTone = fps >= 70 ? 'text-emerald-400' : fps >= 50 ? 'text-yellow-300' : fps >= 30 ? 'text-orange-400' : 'text-red-400'
        return <span className={`font-mono font-semibold ${fpsTone}`}>{fps.toFixed(0)}</span>
      case 'model_mode':
        const mode = String((row as any).model_mode || '—')
        return (
          <span className={clsx('text-[10px] font-semibold whitespace-nowrap', mode.includes('shadow') ? 'text-sky-300' : 'text-emerald-400')}>
            {mode.replace(/_/g, ' ')}
          </span>
        )
      case 'high_conviction_fallback':
        return (row as any).high_conviction_fallback
          ? <span className="text-[9px] uppercase tracking-wide text-emerald-300 bg-emerald-900/25 rounded px-1 py-0.5">high fallback</span>
          : <span className="text-neutral">—</span>
      case 'reason_included':
        return <span className="text-slate-300 block max-w-[280px] truncate" title={(row as any).reason_included || ''}>{(row as any).reason_included || '—'}</span>
      case 'catalyst_summary':
        return <span className="text-slate-300 block max-w-[260px] truncate" title={(row as any).catalyst_summary || ''}>{(row as any).catalyst_summary || '—'}</span>
      case 'prediction_debug':
        const debug = (row as any).prediction_debug || {}
        if (!Object.keys(debug).length) return <span className="text-neutral">—</span>
        const debugTitle = [
          `final predicted percent: ${debug.final_predicted_percent ?? '—'}`,
          `confidence: ${debug.confidence ?? '—'}`,
          `market cap bucket: ${debug.market_cap_bucket ?? '—'}`,
          `catalyst score: ${debug.catalyst_score ?? '—'}`,
          `freshness score: ${debug.freshness_score ?? '—'}`,
          `structured news score: ${debug.structured_news_score ?? '—'}`,
          `structured news available: ${debug.structured_news_available ?? '—'}`,
          `best structured headline: ${debug.best_structured_catalyst_headline ?? '—'}`,
          `best structured source: ${debug.best_structured_catalyst_source ?? '—'}`,
          `structured catalyst age minutes: ${debug.best_structured_catalyst_age_minutes ?? '—'}`,
          `structured catalyst type: ${debug.structured_catalyst_type ?? '—'}`,
          `structured catalyst sentiment: ${debug.structured_catalyst_sentiment ?? '—'}`,
          `structured catalyst confidence: ${debug.structured_catalyst_confidence ?? '—'}`,
          `unstructured/social score: ${debug.unstructured_social_score ?? '—'}`,
          `message density 5m: ${debug.message_density_5m ?? '—'}`,
          `message density 15m: ${debug.message_density_15m ?? '—'}`,
          `message density 30m: ${debug.message_density_30m ?? '—'}`,
          `message density 60m: ${debug.message_density_60m ?? '—'}`,
          `message density prev: ${debug.message_density_prev_window ?? '—'}`,
          `message density change pct: ${debug.message_density_change_pct ?? '—'}`,
          `message density trend: ${debug.message_density_trend ?? '—'}`,
          `message density rising: ${debug.message_density_rising ?? '—'}`,
          `message density supported: ${debug.message_density_supported ?? '—'}`,
          `message density score: ${debug.message_density_score ?? '—'}`,
          `message density live score: ${debug.message_density_live_score ?? '—'}`,
          `message density carry score: ${debug.message_density_carry_score ?? '—'}`,
          `message density session count: ${debug.message_density_session_count ?? '—'}`,
          `message density last event age min: ${debug.message_density_last_event_age_minutes ?? '—'}`,
          `short squeeze score: ${debug.short_squeeze_score ?? '—'}`,
          `short squeeze available: ${debug.short_squeeze_available ?? '—'}`,
          `short squeeze reason: ${debug.short_squeeze_reason ?? '—'}`,
          `float/short interest available: ${debug.float_or_short_interest_available ?? '—'}`,
          `squeeze proxy used: ${debug.squeeze_proxy_used ?? '—'}`,
          `sentiment score: ${debug.sentiment_score ?? '—'}`,
          `momentum score: ${debug.momentum_score ?? '—'}`,
          `volume score: ${debug.volume_score ?? '—'}`,
          `correlation/independence score: ${debug.correlation_independence_score ?? '—'}`,
          `priced-in penalty: ${debug.priced_in_penalty ?? '—'}`,
          `unrealized catalyst score: ${debug.unrealized_catalyst_score ?? '—'}`,
          `AI score: ${debug.ai_score ?? '—'}`,
          `AI available: ${debug.ai_available ?? '—'}`,
          `AI raw score: ${debug.ai_raw_score ?? '—'}`,
          `AI article count: ${debug.ai_article_count ?? '—'}`,
          `source credibility score: ${debug.source_credibility_score ?? '—'}`,
          `correlation available: ${debug.correlation_available ?? '—'}`,
          `raw correlation score: ${debug.raw_correlation_score ?? '—'}`,
          `correlation source: ${debug.correlation_source ?? '—'}`,
          `correlation samples: ${debug.correlation_samples ?? '—'}`,
          `decision-map quadrant: ${debug.decision_map_quadrant ?? '—'}`,
          `raw priced-in penalty: ${debug.raw_priced_in_penalty ?? '—'}`,
          `catalyst published at: ${debug.catalyst_published_at ?? '—'}`,
          `quote updated at: ${debug.quote_updated_at ?? '—'}`,
          `readiness level: ${debug.prediction_readiness?.level ?? (row as any).prediction_readiness_level ?? '—'}`,
          `readiness waiting for: ${(debug.prediction_readiness?.waiting_for || (row as any).prediction_waiting_for || []).join(', ') || 'none'}`,
          `catalyst quality: ${debug.catalyst_quality?.tier ?? (row as any).catalyst_quality_tier ?? '—'} ${debug.catalyst_quality?.score ?? (row as any).catalyst_quality_score ?? '—'}/100`,
          `catalyst class: ${debug.catalyst_quality?.class ?? (row as any).catalyst_quality?.class ?? '—'}`,
          `pending open confirmed: ${debug.pending_open_confirmation?.passes ?? (row as any).pending_open_confirmation?.passes ?? '—'}`,
          `pending open support: ${(debug.pending_open_confirmation?.support_reasons || (row as any).pending_open_confirmation?.support_reasons || []).join(', ') || 'none'}`,
          `catalyst reaction label: ${debug.catalyst_reaction_summary?.label ?? (row as any).catalyst_reaction_summary?.label ?? '—'}`,
          `first reaction state: ${debug.catalyst_reaction_summary?.first_reaction_state ?? (row as any).catalyst_reaction_summary?.first_reaction_state ?? '—'}`,
          `post-catalyst runup pct: ${debug.catalyst_reaction_summary?.runup_pct ?? (row as any).catalyst_reaction_summary?.runup_pct ?? '—'}`,
          `post-catalyst latest return pct: ${debug.catalyst_reaction_summary?.latest_return_pct ?? (row as any).catalyst_reaction_summary?.latest_return_pct ?? '—'}`,
          `post-catalyst giveback pct: ${debug.catalyst_reaction_summary?.giveback_from_high_pct ?? (row as any).catalyst_reaction_summary?.giveback_from_high_pct ?? '—'}`,
          `catalyst reaction hours: ${debug.catalyst_reaction_hours ?? '—'}`,
          `market had regular reaction: ${debug.market_had_regular_reaction ?? '—'}`,
          `catalyst timing bucket: ${debug.catalyst_timing_bucket ?? '—'}`,
          `priced-in reason: ${debug.priced_in_reason ?? '—'}`,
          `decision reason: ${debug.prediction_decision_reason ?? (row as any).prediction_decision_reason ?? '—'}`,
          `risk flags: ${(debug.risk_flags || []).join(', ') || 'none'}`,
          `explanation: ${debug.final_explanation || '—'}`,
        ].join('\n')
        return (
          <div className="max-w-[220px]" title={debugTitle}>
            <div className="font-mono text-[10px] text-sky-300">
              {debug.decision_map_quadrant || '—'} · {debug.catalyst_score ?? '—'} cat · {debug.short_squeeze_score ?? '—'} squeeze · {debug.message_density_trend ?? 'no trend'}
            </div>
            <div className="text-[10px] text-slate-300 truncate">{debug.final_explanation || '—'}</div>
          </div>
        )
      case 'signal_quality':
        const da2 = (row as any).dashboard_assessment
        const sq = da2?.signalQuality ?? (row as any).signal_quality
        if (!sq) return <span className="text-neutral">—</span>
        const sqScore = (row as any).signal_quality_score ?? (row as any).prediction_scorecard?.signal_quality_score
        const sqTone = sq === 'strong' || sq === 'high_quality' ? 'text-emerald-400' : sq === 'moderate' || sq === 'medium_quality' ? 'text-yellow-300' : sq === 'weak' || sq === 'low_quality' ? 'text-orange-400' : sq === 'proxy_only' ? 'text-yellow-300' : sq === 'decision_map_candidate' ? 'text-sky-300' : 'text-red-300'
        return (
          <div className="leading-tight" title={`Signal quality score: ${sqScore ?? '—'}/100`}>
            <span className={`text-[10px] font-semibold ${sqTone}`}>
              {String(sq).replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase())}
            </span>
            {sqScore != null && <div className="font-mono text-[9px] text-neutral">{Number(sqScore).toFixed(0)}/100</div>}
          </div>
        )
      case 'expected_move_range':
        const scRange = (row as any).prediction_scorecard || {}
        const low = (row as any).expected_move_low_pct ?? scRange.expected_move_low_pct
        const high = (row as any).expected_move_high_pct ?? scRange.expected_move_high_pct
        const mid = scRange.expected_move_pct ?? (row as any).predicted_return ?? (row as any).predictedReturnPct
        if (low == null || high == null) return <span className="text-neutral">—</span>
        return (
          <div className="leading-tight" title={`Expected move range: ${Number(low).toFixed(2)}% to ${Number(high).toFixed(2)}%; midpoint ${mid == null ? '—' : `${Number(mid).toFixed(2)}%`}`}>
            <span className="font-mono text-emerald-300">{Number(low).toFixed(1)}%</span>
            <span className="font-mono text-neutral">–</span>
            <span className="font-mono text-emerald-300">{Number(high).toFixed(1)}%</span>
          </div>
        )
      case 'timing_quality':
      case 'liquidity_risk':
      case 'reversal_risk':
      case 'evidence_completeness':
        const scorecard = (row as any).prediction_scorecard || {}
        const scoreKey = `${key}_score`
        const label = String((row as any)[key] ?? scorecard[key] ?? 'unknown')
        const value = (row as any)[scoreKey] ?? scorecard[scoreKey]
        const isRisk = key === 'liquidity_risk' || key === 'reversal_risk'
        const tone = isRisk
          ? label === 'critical' || label === 'high' ? 'text-red-300' : label === 'moderate' ? 'text-yellow-300' : label === 'low' ? 'text-emerald-300' : 'text-neutral'
          : label === 'strong' ? 'text-emerald-300' : label === 'moderate' ? 'text-yellow-300' : label === 'weak' ? 'text-orange-300' : label === 'poor' ? 'text-red-300' : 'text-neutral'
        const details = [
          `${key.replace(/_/g, ' ')}: ${label}`,
          `score: ${value ?? '—'}/100`,
          ...(key === 'timing_quality' ? [`reaction: ${(row as any).catalyst_reaction_summary?.label ?? '—'}`] : []),
          ...(key === 'evidence_completeness' ? [`inputs: ${Object.entries(scorecard.inputs_present || {}).filter(([, present]) => present).map(([name]) => name).join(', ') || '—'}`] : []),
        ].join('\n')
        return (
          <div className="leading-tight" title={details}>
            <span className={`text-[10px] font-semibold ${tone}`}>{label.replace(/_/g, ' ')}</span>
            {value != null && <div className="font-mono text-[9px] text-neutral">{Number(value).toFixed(0)}/100</div>}
          </div>
        )
      case 'high_conviction_rank':
        const rank = (row as any).high_conviction_rank
        return <span className="font-mono text-accent">{rank != null ? `#${rank}` : '—'}</span>
      case 'risk_flags':
        const flags = ((row as any).risk_flags || []) as string[]
        if (!flags.length) return <span className="text-neutral">—</span>
        return (
          <div className="flex flex-wrap gap-0.5">
            {flags.slice(0, 2).map((f: string) => (
              <span key={f} className="text-[9px] bg-red-900/40 text-red-300 px-1 py-0.5 rounded">{f.replace(/_/g, ' ')}</span>
            ))}
            {flags.length > 2 && <span className="text-[9px] text-neutral">+{flags.length - 2}</span>}
          </div>
        )
      case 'risk_summary': {
        const flags = ((row as any).risk_flags || []) as string[]
        const blocked = (((row as any).prediction_blocked_reasons || []) as string[]).filter(Boolean)
        const liq = String((row as any).liquidity_risk || (row as any).prediction_scorecard?.liquidity_risk || 'unknown')
        const rev = String((row as any).reversal_risk || (row as any).prediction_scorecard?.reversal_risk || 'unknown')
        const title = [
          `Liquidity risk: ${liq}`,
          `Reversal risk: ${rev}`,
          `Blocked: ${blocked.join(', ') || 'none'}`,
          `Risk flags: ${flags.join(', ') || 'none'}`,
          `Decision reason: ${(row as any).prediction_decision_reason || (row as any).reason_included_detail || '—'}`,
        ].join('\n')
        const danger = flags.length || blocked.length || liq === 'high' || liq === 'critical' || rev === 'high' || rev === 'critical'
        return (
          <div className="max-w-[160px]" title={title}>
            <span className={clsx('text-[10px] font-semibold', danger ? 'text-yellow-300' : 'text-emerald-300')}>
              {danger ? `${flags.length + blocked.length || 1} caution` : 'clear'}
            </span>
            <div className="text-[9px] text-neutral">liq {liq} · rev {rev}</div>
          </div>
        )
      }
      case 'momentum_score':
        const msVal = (row as any).momentum_score
        if (msVal == null) return <span className="text-neutral">missing</span>
        return <span className={`font-mono ${scoreTone(Number(msVal))}`} title={`Momentum confirmation score: ${Number(msVal).toFixed(1)}/100`}>{typeof msVal === 'number' ? msVal.toFixed(1) : msVal}</span>
      case 'news_score':
        const newsVal = (row as any).news_score ?? (row as any).newsScore ?? (row as any).catalystScore ?? (row as any).catalyst_score
        if (newsVal == null) return <span className="text-neutral">missing</span>
        return <span className={`font-mono ${scoreTone(Number(newsVal))}`} title={`News/catalyst evidence score: ${Number(newsVal).toFixed(1)}/100 · articles: ${(row as any).news_article_count ?? 0}`}>{typeof newsVal === 'number' ? newsVal.toFixed(1) : newsVal}</span>
      case 'social_score':
        const socialVal = (row as any).social_score ?? (row as any).socialScore
        if (socialVal == null) return <span className="text-neutral">missing</span>
        return <span className={`font-mono ${scoreTone(Number(socialVal))}`} title={`Social evidence score: ${Number(socialVal).toFixed(1)}/100 · posts: ${(row as any).message_count ?? 0}`}>{typeof socialVal === 'number' ? socialVal.toFixed(1) : socialVal}</span>
      case 'ai_score':
        const aiVal = (row as any).ai_score
        if (aiVal == null) return <span className="text-neutral">—</span>
        return <span className={`font-mono ${scoreTone(Number(aiVal))}`} title={`AI/news evidence score: ${Number(aiVal).toFixed(1)}/100`}>{typeof aiVal === 'number' ? aiVal.toFixed(1) : aiVal}</span>
      case 'correlation_score':
        const corrVal = (row as any).correlation_score
        if (corrVal == null) {
          const status = (row as any).correlation_context?.status || (row as any).threshold_setup_status || 'missing'
          return <span className="text-neutral" title={`Correlation unavailable: ${String(status).replace(/_/g, ' ')}`}>{status === 'missing_price_density_correlation_history' ? 'pending' : 'missing'}</span>
        }
        return <span className={`font-mono ${Number(corrVal) >= 0 ? 'text-emerald-400' : 'text-red-400'}`} title={`Correlation / validation history: ${Number(corrVal).toFixed(3)}`}>{typeof corrVal === 'number' ? corrVal.toFixed(2) : corrVal}</span>
      default:
        return <span className="text-neutral">—</span>
    }
  }

  const loadHoverChart = async () => {
    if (hoverData) return // Already loaded
    setHoverLoading(true)
    try {
      const res = await fetch(`/api/charts/${row.ticker}?range=1d&interval=5m&window_minutes=30&bucket_minutes=5`)
      const json = await res.json()
      if (json?.candles?.length) {
        setHoverData({
          candles: json.candles,
          social_density: json.social_density || [],
          sentiment: json.sentiment || [],
        })
      }
    } catch (e) {
      // Silently fail hover chart
    } finally {
      setHoverLoading(false)
    }
  }

  const handleMouseEnter = () => {
    hoverTimeoutRef.current = window.setTimeout(() => {
      setShowHoverChart(true)
      loadHoverChart()
    }, 500) // Show after 500ms hover
  }

  const handleMouseLeave = () => {
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current)
      hoverTimeoutRef.current = null
    }
    setShowHoverChart(false)
  }

  useEffect(() => {
    return () => {
      if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current)
    }
  }, [])

  return (
    <>
      <tr
        ref={rowRef}
        className="hover:bg-card-hover transition-colors relative"
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        {columns.map(col => (
          <td key={col.key} className="px-2 py-2 whitespace-nowrap">{renderCell(col.key)}</td>
        ))}
      </tr>

      {/* Hover chart preview */}
      {showHoverChart && rowRef.current && (
        <div className="fixed z-50 bg-surface border border-border rounded-lg shadow-xl p-3" style={{
          left: `${rowRef.current.getBoundingClientRect().right + 10}px`,
          top: `${rowRef.current.getBoundingClientRect().top}px`,
          width: '400px',
          maxHeight: '300px',
        }}>
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-mono font-bold text-accent">{row.ticker}</span>
            <span className="text-[10px] text-neutral">1D · 5m</span>
          </div>
          {hoverLoading ? (
            <div className="h-[200px] flex items-center justify-center text-neutral text-xs">Loading...</div>
          ) : hoverData?.candles?.length ? (
            <div className="h-[200px]">
              <CandlestickChart
                candles={hoverData.candles}
                density={hoverData.social_density || []}
                sentiment={hoverData.sentiment || []}
                showSentiment={true}
                showDensity={true}
                showMarkers={false}
                chartStyle="candles"
              />
            </div>
          ) : (
            <div className="h-[200px] flex items-center justify-center text-neutral text-xs">No data</div>
          )}
        </div>
      )}

      {showDetail && <TickerDetailModal ticker={row.ticker} onClose={() => setShowDetail(false)} />}
    </>
  )
}
