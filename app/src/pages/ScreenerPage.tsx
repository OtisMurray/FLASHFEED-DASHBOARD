'use client'
import useSWR from 'swr'
import { useState, useMemo, useEffect, useCallback } from 'react'
import { ScreenerTable } from './ScreenerTable'
import { ScreenerFilterPanel } from './ScreenerFilterPanel'
import { SignalBar } from './SignalBar'
import { IntradayChart } from './IntradayChart'
import { MirrorPage } from './MirrorPage'
import type { Article, ScreenerRow } from '@/lib/types'

const fetcher = (url: string) => fetch(url).then(r => r.json())

export type ViewMode = 'overview' | 'performance' | 'technical' | 'sentiment' | 'top_movers' | 'predicted_increases' | 'high_conviction_next_day' | 'news_catalysts'
type WorkspaceTab = 'screener' | 'mirror'
type FilterTab = 'descriptive' | 'technical' | 'performance' | 'sentiment' | 'all'

const WORKSPACE_TABS: Array<{ id: WorkspaceTab; label: string; description: string }> = [
  { id: 'screener', label: 'Screener', description: 'ranked market universe' },
  { id: 'mirror', label: 'Mirror', description: 'chart/news cards' },
]

const VIEW_MODES: ViewMode[] = ['overview', 'top_movers', 'predicted_increases', 'high_conviction_next_day', 'news_catalysts', 'performance', 'technical', 'sentiment']
const VIEW_LABELS: Record<ViewMode, string> = {
  overview: 'Overview',
  performance: 'Performance',
  technical: 'Technical',
  sentiment: 'Sentiment',
  top_movers: 'Top Movers',
  predicted_increases: 'Developing Opportunities',
  high_conviction_next_day: 'High Conviction',
  news_catalysts: 'News/Catalysts',
}
const PRESETS = [
  { key: 'top_gainers', label: 'Top Gainers' },
  { key: 'top_losers', label: 'Top Losers' },
  { key: 'unusual_volume', label: 'Unusual Volume' },
  { key: 'bullish_news', label: 'Bullish News' },
  { key: 'bearish_news', label: 'Bearish News' },
  { key: 'oversold', label: 'Oversold' },
  { key: 'overbought', label: 'Overbought' },
]
const SOCIAL_WINDOW_MIN = 5
const SOCIAL_WINDOW_MAX = 360
const SOCIAL_WINDOW_STEP = 5

function resolvedSocialWindowMinutes(value: string) {
  if (value === 'adaptive') return SOCIAL_WINDOW_MAX
  const minutes = Number(value)
  return Number.isFinite(minutes)
    ? Math.max(SOCIAL_WINDOW_MIN, Math.min(SOCIAL_WINDOW_MAX, Math.round(minutes)))
    : SOCIAL_WINDOW_MAX
}

function socialWindowLabel(minutes: number) {
  if (!Number.isFinite(minutes)) return '--'
  if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60}h`
  return `${minutes}m`
}

function compact(n: number | null | undefined) {
  if (n == null || Number.isNaN(n)) return '--'
  if (Math.abs(n) >= 1e12) return `${(n / 1e12).toFixed(1)}T`
  if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1)}K`
  return n.toLocaleString()
}

function quoteIsCurrent(row: any) {
  const freshness = String(row?.quote_freshness || '').toLowerCase()
  const age = Number(row?.quote_age_seconds)
  if (freshness === 'very_stale' || freshness === 'missing') return false
  return !Number.isFinite(age) || age <= 45 * 60
}

export function ScreenerPage() {
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>('screener')
  const [socialWindow, setSocialWindow] = useState('adaptive')
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [showFilters, setShowFilters] = useState(false)
  const [filterTab, setFilterTab] = useState<FilterTab>('all')
  const [viewMode, setViewMode] = useState<ViewMode>('overview')
  const [signal, setSignal] = useState('')
  const [orderBy, setOrderBy] = useState('ticker')
  const [orderDir, setOrderDir] = useState<'asc' | 'desc'>('asc')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)
  const pageSize = 50
  const socialWindowMinutes = resolvedSocialWindowMinutes(socialWindow)
  const socialWindowDisplay = socialWindow === 'adaptive'
    ? `Adaptive (${socialWindowLabel(socialWindowMinutes)})`
    : socialWindowLabel(socialWindowMinutes)

  // Clickable column sorting: toggle asc/desc, reset on new column
  const handleSort = useCallback((key: string) => {
    setOrderBy(prev => {
      if (prev !== key) return key
      return key
    })
    setOrderDir(prev => {
      if (orderBy !== key) {
        // Default: desc for numeric columns (bigger = more important)
        const numericDesc = ['predicted_return', 'prediction_confidence', 'final_prediction_score', 'payoff_model_probability',
          'change_pct', 'volume', 'market_cap', 'momentum_score', 'ai_score',
          'correlation_score', 'structured_sentiment', 'filing_sentiment',
          'social_message_sentiment', 'price']
        return numericDesc.includes(key) ? 'desc' : 'asc'
      }
      // Same column: toggle
      return prev === 'asc' ? 'desc' : 'asc'
    })
    setPage(0)
  }, [orderBy])

  // Auto-switch to top_movers view when top_gainers or top_losers signal is active
  useEffect(() => {
    if (signal === 'top_gainers' || signal === 'top_losers') {
      setViewMode('top_movers')
    }
  }, [signal])

  // Reset sort defaults when switching to prediction/high-conviction views so
  // previous top-gainer / mover sorts don't leak into "Predicted Up Tomorrow".
  useEffect(() => {
    if (viewMode === 'predicted_increases') {
      setOrderBy('payoff_model_probability')
      setOrderDir('desc')
    } else if (viewMode === 'high_conviction_next_day') {
      setOrderBy('payoff_model_probability')
      setOrderDir('desc')
    }
  }, [viewMode])

  useEffect(() => { setPage(0) }, [filters, signal, orderBy, orderDir, search, viewMode, socialWindow])

  // Load the same filtered universe the backend sees; filters remain composable.
  function defaultViewLimit(view: ViewMode) {
    if (view === 'high_conviction_next_day') return '100'
    if (view === 'predicted_increases') return '100'
    if (view === 'top_movers') return '300'
    if (view === 'news_catalysts') return '300'
    if (view === 'performance' || view === 'technical' || view === 'sentiment') return '1000'
    return '5000'
  }

  const screenerParams = useMemo(() => {
    const params = new URLSearchParams({
      limit: defaultViewLimit(viewMode),
      days: '3',
      compact: '1',
      view: viewMode === 'overview' ? 'all' : viewMode,
      orderBy,
      orderDir,
      enrich: '1',
    })
    if (viewMode === 'predicted_increases' || viewMode === 'high_conviction_next_day') {
      params.set('horizon', '1d')
      params.set('min_predicted_return', '0')
      params.set('actionable', 'false')
      params.set('include_decision_candidates', 'true')
      params.set('includeFallback', 'true')
      if (viewMode === 'predicted_increases') {
        params.set('min_decision_score', '40')
        params.set('require_catalyst_alignment', 'false')
        params.set('includeDevelopingCandidates', 'true')
      }
      if (viewMode === 'high_conviction_next_day') {
        params.set('require_catalyst_alignment', 'true')
        params.set('includeFallback', 'false')
        params.set('minFinalScore', '78')
        params.set('minConfidence', '0.45')
        params.set('minPredictedReturn', '1.50')
        params.set('requireTrue1d', 'true')
        params.set('requireCatalyst', 'true')
      }
    }
    if (socialWindow !== 'adaptive') params.set('window_minutes', socialWindow)
    if (signal) params.set('signal', signal)
    if (search.trim()) params.set('search', search.trim())
    Object.entries(filters).forEach(([key, value]) => {
      if (value) params.set(key, value)
    })
    return params
  }, [filters, orderBy, orderDir, search, signal, socialWindow, viewMode])

  const screenerKey = `/api/screener?${screenerParams.toString()}`
  const { data, isLoading, isValidating, mutate } = useSWR(screenerKey, fetcher, {
    refreshInterval: 60_000,
    dedupingInterval: 60_000,
    keepPreviousData: true,
    revalidateOnFocus: false,
  })
  const { data: newsData } = useSWR(
    '/api/articles/recent-lite?mover_only=1&article_kind=structured&recent_days=3&limit=24',
    fetcher,
    {
      refreshInterval: 60_000,
      dedupingInterval: 30_000,
      keepPreviousData: true,
      revalidateOnFocus: false,
    },
  )

  const tickers: ScreenerRow[] = Array.isArray(data) ? data : data?.tickers ?? data?.rows ?? []
  const fallbackPredictionRows: ScreenerRow[] = Array.isArray(data?.fallbackRows) ? data.fallbackRows : []
  const predictionViewActive = viewMode === 'predicted_increases' || viewMode === 'high_conviction_next_day'
  const predictionStillResolving = predictionViewActive && (isLoading || (isValidating && tickers.length === 0))

  const filtered = useMemo(() => {
    let rows = [...tickers].filter(t => (
      t.price != null &&
      t.change_pct != null &&
      ['NASDAQ', 'NYSE', 'AMEX'].includes(String((t as any).exchange || '').toUpperCase()) &&
      !String(t.ticker || '').includes('.')
    ))

    // Search and filters are applied by /api/screener. Keep a light client-side
    // safety pass for legacy responses only; exact short ticker searches must not
    // broaden to company/title matches.
    if (search && !(data?.filters_applied?.search === search.trim())) {
      const q = search.trim().toLowerCase()
      const exactTicker = /^[a-z][a-z0-9.-]{0,5}$/i.test(q) ? q.toUpperCase() : ''
      rows = rows.filter(t => exactTicker ? t.ticker.toUpperCase() === exactTicker : (t.ticker.toLowerCase().includes(q) || (t.company ?? '').toLowerCase().includes(q)))
    }

    // Filters
    if (filters.sector) rows = rows.filter(t => t.sector === filters.sector)
    if (filters.exchange) rows = rows.filter(t => (t as any).exchange === filters.exchange)
    if (filters.index) rows = rows.filter(t => (t as any).index === filters.index)
    if (filters.country) rows = rows.filter(t => (t as any).country === filters.country)
    if (filters.industry) rows = rows.filter(t => t.industry === filters.industry)
    if (filters.market_cap) {
      const mc = filters.market_cap
      rows = rows.filter(t => {
        const cap = (t as any).market_cap ?? 0
        if (mc === 'micro') return cap < 300e6
        if (mc === 'small') return cap >= 300e6 && cap < 2e9
        if (mc === 'mid') return cap >= 2e9 && cap < 10e9
        if (mc === 'large') return cap >= 10e9 && cap < 200e9
        if (mc === 'mega') return cap >= 200e9
        return true
      })
    }
    if (filters.price_change) {
      const pc = filters.price_change
      rows = rows.filter(t => {
        const change = t.change_pct
        if (change == null) return false
        if (pc === 'up') return change > 0
        if (pc === 'down') return change < 0
        if (pc === 'up2') return change >= 2
        if (pc === 'up5') return change >= 5
        if (pc === 'up10') return change >= 10
        if (pc === 'down2') return change <= -2
        if (pc === 'down5') return change <= -5
        return true
      })
    }
    if (filters.avg_volume) {
      const av = parseInt(filters.avg_volume)
      rows = rows.filter(t => t.volume != null && t.volume >= av)
    }
    if (filters.rel_volume) {
      rows = rows.filter(t => {
        const rv = (t as any).rel_volume ?? 0
        if (filters.rel_volume === 'over1') return rv >= 1
        if (filters.rel_volume === 'over1_5') return rv >= 1.5
        if (filters.rel_volume === 'over2') return rv >= 2
        if (filters.rel_volume === 'over3') return rv >= 3
        return true
      })
    }
    if (filters.price_range) {
      const pr = filters.price_range
      rows = rows.filter(t => {
        const p = t.price
        if (p == null) return false
        if (pr === 'under1') return p < 1
        if (pr === 'under5') return p < 5
        if (pr === 'under10') return p < 10
        if (pr === 'under20') return p < 20
        if (pr === 'over5') return p >= 5
        if (pr === 'over10') return p >= 10
        if (pr === 'over20') return p >= 20
        if (pr === 'over50') return p >= 50
        if (pr === 'over100') return p >= 100
        return true
      })
    }
    if (filters.social_sentiment) {
      const ss = filters.social_sentiment
      rows = rows.filter(t => {
        const value = t.social_sentiment ?? 0
        if (ss === 'bullish') return value >= 0.2
        if (ss === 'bearish') return value <= -0.2
        if (ss === 'neutral') return value > -0.2 && value < 0.2
        return true
      })
    }
    if (filters.stocktwits_sentiment) {
      const ss = filters.stocktwits_sentiment
      rows = rows.filter(t => {
        const value = t.stocktwits_message_sentiment ?? 0
        if (ss === 'bullish') return value >= 0.2
        if (ss === 'bearish') return value <= -0.2
        if (ss === 'neutral') return value > -0.2 && value < 0.2
        return true
      })
    }
    if (filters.stocktwits_density) {
      rows = rows.filter(t => {
        const value = t.stocktwits_message_density ?? 0
        if (filters.stocktwits_density === 'over0_05') return value >= 0.05
        if (filters.stocktwits_density === 'over0_1') return value >= 0.1
        if (filters.stocktwits_density === 'over0_5') return value >= 0.5
        if (filters.stocktwits_density === 'over1') return value >= 1
        return true
      })
    }
    if (filters.news_sentiment) {
      const ns = filters.news_sentiment
      rows = rows.filter(t => {
        const value = t.structured_sentiment ?? 0
        if (ns === 'bullish') return value >= 0.2
        if (ns === 'bearish') return value <= -0.2
        if (ns === 'neutral') return value > -0.2 && value < 0.2
        return true
      })
    }
    if (filters.min_posts) {
      const mp = parseInt(filters.min_posts)
      rows = rows.filter(t => (t.message_count ?? 0) >= mp)
    }

    if (filters.pe_ratio) rows = rows.filter(t => {
      const pe = (t as any).pe_ratio ?? 0
      if (filters.pe_ratio === 'positive') return pe > 0
      if (filters.pe_ratio === 'low') return pe > 0 && pe < 15
      if (filters.pe_ratio === 'medium') return pe >= 15 && pe <= 25
      if (filters.pe_ratio === 'high') return pe > 25
      if (filters.pe_ratio === 'negative') return pe < 0
      return true
    })
    if (filters.forward_pe) rows = rows.filter(t => {
      const value = (t as any).forward_pe ?? 0
      if (filters.forward_pe === 'under10') return value < 10
      if (filters.forward_pe === 'under15') return value < 15
      if (filters.forward_pe === 'under25') return value < 25
      if (filters.forward_pe === 'over25') return value > 25
      return true
    })
    if (filters.peg) rows = rows.filter(t => {
      const value = (t as any).peg ?? 0
      if (filters.peg === 'under1') return value < 1
      if (filters.peg === 'under2') return value < 2
      if (filters.peg === 'over2') return value > 2
      return true
    })
    if (filters.dividend_yield) rows = rows.filter(t => {
      const value = (t as any).dividend_yield ?? 0
      if (filters.dividend_yield === 'positive') return value > 0
      if (filters.dividend_yield === 'over2') return value >= 2
      if (filters.dividend_yield === 'over4') return value >= 4
      return true
    })
    if (filters.analyst) rows = rows.filter(t => String((t as any).analyst || '') === filters.analyst)
    if (filters.rsi) rows = rows.filter(t => {
      const value = (t as any).rsi ?? 50
      if (filters.rsi === 'oversold') return value < 30
      if (filters.rsi === 'overbought') return value > 70
      if (filters.rsi === 'neutral') return value >= 30 && value <= 70
      return true
    })
    if (filters.sma20) rows = rows.filter(t => filters.sma20 === 'above' ? ((t as any).sma20 ?? 0) > 0 : ((t as any).sma20 ?? 0) < 0)
    for (const key of ['perf_week', 'perf_month', 'perf_year'] as const) {
      if (!filters[key]) continue
      rows = rows.filter(t => {
        const value = (t as any)[key] ?? 0
        if (filters[key] === 'up') return value > 0
        if (filters[key] === 'down') return value < 0
        if (filters[key] === 'up5') return value >= 5
        if (filters[key] === 'down5') return value <= -5
        if (filters[key] === 'up10') return value >= 10
        if (filters[key] === 'down10') return value <= -10
        if (filters[key] === 'up25') return value >= 25
        if (filters[key] === 'down25') return value <= -25
        return true
      })
    }
    if (filters.inst_own) rows = rows.filter(t => {
      const value = (t as any).inst_own ?? 0
      if (filters.inst_own === 'over50') return value >= 50
      if (filters.inst_own === 'over80') return value >= 80
      if (filters.inst_own === 'under30') return value < 30
      return true
    })
    if (filters.insider_own) rows = rows.filter(t => {
      const value = (t as any).insider_own ?? 0
      if (filters.insider_own === 'over5') return value >= 5
      if (filters.insider_own === 'over10') return value >= 10
      if (filters.insider_own === 'under1') return value < 1
      return true
    })
    if (filters.float_short) rows = rows.filter(t => {
      const value = (t as any).float_short ?? 0
      if (filters.float_short === 'over5') return value >= 5
      if (filters.float_short === 'over10') return value >= 10
      if (filters.float_short === 'over20') return value >= 20
      return true
    })

    // Signal
    if (signal === 'social_bullish') rows = rows.filter(t => (t.social_message_sentiment ?? t.social_sentiment ?? 0) >= 0.3)
    if (signal === 'social_bearish') rows = rows.filter(t => (t.social_message_sentiment ?? t.social_sentiment ?? 0) <= -0.3)
    if (signal === 'unusual_volume') rows = rows.filter(t => quoteIsCurrent(t) && (t.volume ?? 0) > ((t as any).avg_volume ?? 1) * 2)
    if (signal === 'top_gainers') rows = rows.filter(t => quoteIsCurrent(t) && (t.change_pct ?? 0) > 0)
    if (signal === 'top_losers') rows = rows.filter(t => quoteIsCurrent(t) && (t.change_pct ?? 0) < 0)
    if (signal === 'bullish_news') rows = rows.filter(t => (t.structured_sentiment ?? 0) >= 0.2)
    if (signal === 'bearish_news') rows = rows.filter(t => (t.structured_sentiment ?? 0) <= -0.2)
    if (signal === 'oversold') rows = rows.filter(t => ((t as any).rsi ?? 50) < 30)
    if (signal === 'overbought') rows = rows.filter(t => ((t as any).rsi ?? 50) > 70)

    // Sort
    rows.sort((a, b) => {
      const av = (a as any)[orderBy] ?? 0
      const bv = (b as any)[orderBy] ?? 0
      if (typeof av === 'string') return orderDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av)
      return orderDir === 'desc' ? bv - av : av - bv
    })

    return rows
  }, [tickers, filters, signal, orderBy, orderDir, search, data])

  const totalPages = Math.ceil(filtered.length / pageSize)
  const paged = filtered.slice(page * pageSize, (page + 1) * pageSize)
  const pricedCount = filtered.filter(t => t.price != null).length
  const gainers = filtered.filter(t => (t.change_pct ?? 0) > 0).length
  const losers = filtered.filter(t => (t.change_pct ?? 0) < 0).length
  const unchanged = filtered.filter(t => (t.change_pct ?? 0) === 0).length
  const activeSocialRows = filtered.filter(t => Number(t.message_count ?? t.stocktwits_message_count ?? 0) > 0)
  const activeSocialCount = activeSocialRows.length
  const totalSocialMessages = filtered.reduce((sum, row) => sum + Number(row.message_count ?? row.stocktwits_message_count ?? 0), 0)
  const avgPostsPerActive = activeSocialCount ? totalSocialMessages / activeSocialCount : 0
  const avgSocialDensity = filtered.length
    ? filtered.reduce((sum, row) => {
      const windowMinutes = Math.max(1, Number((row as any).rolling_window_minutes ?? (socialWindow === 'adaptive' ? 30 : socialWindow) ?? 30))
      return sum + Number(row.message_count ?? row.stocktwits_message_count ?? 0) / windowMinutes
    }, 0) / filtered.length
    : 0
  const topMovers = [...filtered]
    .filter(row => quoteIsCurrent(row) && Number(row.change_pct || 0) > 0)
    .sort((a, b) => Number(b.change_pct || 0) - Number(a.change_pct || 0))
    .slice(0, 4)
  const professorTop5 = viewMode === 'high_conviction_next_day'
    ? [...filtered].filter(r => Boolean((r as any).professor_sendable)).slice(0, 5)
    : []
  const predictionDiagnostics = predictionViewActive
    ? {
      backend_count: data?.diagnostics?.backend_count ?? data?.count ?? 0,
      frontend_received_count: tickers.length,
      frontend_visible_count: filtered.length,
      rawPredictionRows: data?.prediction_debug?.rawPredictionRows ?? data?.diagnostics?.rawPredictionRows ?? 0,
      storedPredictionRows: data?.prediction_debug?.storedPredictionRows ?? data?.diagnostics?.storedPredictionRows ?? 0,
      liveSignalRows: data?.prediction_debug?.liveSignalRows ?? data?.diagnostics?.liveSignalRows ?? 0,
      strictRows: data?.prediction_debug?.strictRows ?? data?.diagnostics?.strictRows ?? 0,
      candidatePoolRows: data?.prediction_debug?.candidatePoolRows ?? data?.diagnostics?.candidatePoolRows ?? 0,
      candidatePoolMin: data?.prediction_debug?.candidatePoolMin ?? data?.diagnostics?.candidatePoolMin ?? 0,
      developingCandidateMinScore: data?.prediction_debug?.developingCandidateMinScore ?? data?.diagnostics?.developingCandidateMinScore ?? null,
      includeDevelopingCandidates: data?.prediction_debug?.includeDevelopingCandidates ?? data?.diagnostics?.includeDevelopingCandidates ?? null,
      topBestCandidateRows: data?.prediction_debug?.bestAvailableCandidateRows ?? data?.diagnostics?.bestAvailableCandidateRows ?? data?.prediction_debug?.topBestCandidateRows ?? data?.diagnostics?.topBestCandidateRows ?? 0,
      fallbackRows: data?.prediction_debug?.fallbackRows ?? data?.diagnostics?.fallbackRows ?? fallbackPredictionRows.length,
      finalRows: data?.prediction_debug?.finalRows ?? data?.diagnostics?.finalRows ?? filtered.length,
      latestPredictionAt: data?.prediction_debug?.latestPredictionAt ?? data?.diagnostics?.latestPredictionAt ?? null,
      predictionDate: data?.prediction_debug?.predictionDate ?? data?.diagnostics?.predictionDate ?? null,
      targetDate: data?.prediction_debug?.targetDate ?? data?.diagnostics?.targetDate ?? null,
      missingFieldCounts: data?.prediction_debug?.missingFieldCounts ?? data?.diagnostics?.missingFieldCounts ?? {},
      removedByFilterCounts: data?.prediction_debug?.removedByFilterCounts ?? data?.diagnostics?.removedByFilterCounts ?? {},
      predictionRiskFlagCounts: data?.prediction_debug?.predictionRiskFlagCounts ?? data?.diagnostics?.predictionRiskFlagCounts ?? {},
      predictionReadinessCounts: data?.prediction_debug?.predictionReadinessCounts ?? data?.diagnostics?.predictionReadinessCounts ?? {},
      catalystReactionCounts: data?.prediction_debug?.catalystReactionCounts ?? data?.diagnostics?.catalystReactionCounts ?? {},
      catalystQualityCounts: data?.prediction_debug?.catalystQualityCounts ?? data?.diagnostics?.catalystQualityCounts ?? {},
      pendingOpenConfirmationCounts: data?.prediction_debug?.pendingOpenConfirmationCounts ?? data?.diagnostics?.pendingOpenConfirmationCounts ?? {},
      firstReactionStateCounts: data?.prediction_debug?.firstReactionStateCounts ?? data?.diagnostics?.firstReactionStateCounts ?? {},
      postmortemReport: data?.prediction_postmortem ?? data?.prediction_debug?.postmortemReport ?? data?.diagnostics?.postmortemReport ?? null,
      nextSessionModel: data?.next_session_model ?? null,
      warnings: data?.prediction_debug?.warnings ?? data?.diagnostics?.warnings ?? [],
      active_filters: {
        ...filters,
        signal: signal || null,
        search: search.trim() || null,
        orderBy,
        orderDir,
      },
      model_mode: data?.prediction_debug?.modelMode || data?.diagnostics?.model_mode || (data?.next_session_model?.live_enabled ? 'stored_daily_prediction' : 'no_stored_next_day_prediction'),
      calibrator_mode: data?.prediction_debug?.calibratorMode || data?.diagnostics?.calibrator_mode || 'calibrator_shadow_fallback',
      fallback_params_used: data?.diagnostics?.fallback_params_used || {
        actionable: false,
        include_decision_candidates: true,
        includeFallback: true,
        min_decision_score: 40,
      },
      cache_status: data?.prediction_debug?.predictionCacheMode || data?.diagnostics?.cache_status || null,
      screener_snapshot_at: data?.diagnostics?.screener_snapshot_at || null,
    }
    : null
  const moverNews: Article[] = newsData?.articles ?? []
  const predictionSourceMode = String(predictionDiagnostics?.model_mode || '')
  const showingLiveSignals = predictionSourceMode.includes('live_prediction_signal')
  const postmortemRecommendations = ((predictionDiagnostics as any)?.postmortemReport?.recommendations || []) as Array<{ rule?: string; reason?: string; action?: string }>
  const checkerSummary = ((predictionDiagnostics as any)?.postmortemReport?.summary?.raw_rows || (predictionDiagnostics as any)?.postmortemReport?.summary?.all || {}) as Record<string, any>
  const nextSessionModel = (predictionDiagnostics as any)?.nextSessionModel || {}
  const riskCounts = ((predictionDiagnostics as any)?.predictionRiskFlagCounts || {}) as Record<string, number>
  const readinessCounts = ((predictionDiagnostics as any)?.predictionReadinessCounts || {}) as Record<string, number>
  const reactionCounts = ((predictionDiagnostics as any)?.catalystReactionCounts || {}) as Record<string, number>
  const qualityCounts = ((predictionDiagnostics as any)?.catalystQualityCounts || {}) as Record<string, number>
  const pendingCounts = ((predictionDiagnostics as any)?.pendingOpenConfirmationCounts || {}) as Record<string, number>
  const firstReactionCounts = ((predictionDiagnostics as any)?.firstReactionStateCounts || {}) as Record<string, number>
  const heatmap = useMemo(() => {
    const groups = new Map<string, { sector: string; count: number; avgChange: number; avgSentiment: number; totalMsgs: number; stocktwitsMsgs: number; activeSocial: number; totalDensity: number; stocktwitsDensity: number }>()
    for (const row of filtered) {
      const sector = row.sector || 'Unclassified'
      const current = groups.get(sector) || { sector, count: 0, avgChange: 0, avgSentiment: 0, totalMsgs: 0, stocktwitsMsgs: 0, activeSocial: 0, totalDensity: 0, stocktwitsDensity: 0 }
      const totalMessages = Number(row.message_count ?? row.stocktwits_message_count ?? 0)
      const stocktwitsMessages = Number(row.stocktwits_message_count ?? 0)
      const windowMinutes = Math.max(1, Number((row as any).rolling_window_minutes ?? (socialWindow === 'adaptive' ? 30 : socialWindow) ?? 30))
      const totalDensity = totalMessages / windowMinutes
      current.count += 1
      current.avgChange += Number(row.change_pct || 0)
      current.avgSentiment += Number(row.avg_sentiment || 0)
      current.totalMsgs += totalMessages
      current.stocktwitsMsgs += stocktwitsMessages
      current.totalDensity += totalDensity
      current.stocktwitsDensity += Number(row.stocktwits_message_density ?? 0)
      if (totalMessages > 0) current.activeSocial += 1
      groups.set(sector, current)
    }
    return Array.from(groups.values())
      .map(row => ({
        ...row,
        avgChange: row.count ? row.avgChange / row.count : 0,
        avgSentiment: row.count ? row.avgSentiment / row.count : 0,
        avgMsgsPerActive: row.activeSocial ? row.totalMsgs / row.activeSocial : 0,
        avgDensity: row.count ? row.totalDensity / row.count : 0,
        stocktwitsDensity: row.count ? row.stocktwitsDensity / row.count : 0,
      }))
      .sort((a, b) => (b.activeSocial - a.activeSocial) || (b.avgDensity - a.avgDensity) || (Math.abs(b.avgChange) - Math.abs(a.avgChange)))
      .slice(0, 12)
  }, [filtered, socialWindow])

  const setFilter = (k: string, v: string) => {
    setPage(0)
    if (v) setFilters(f => ({ ...f, [k]: v }))
    else setFilters(f => { const n = { ...f }; delete n[k]; return n })
  }

  const resetFilters = () => { setFilters({}); setSignal(''); setSearch(''); setPage(0) }

  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-3">
        <h1 className="text-white font-semibold text-lg">Market Screener</h1>
        {workspaceTab !== 'mirror' && (
          <div className="flex min-w-[360px] items-center gap-2">
            <span className="text-[10px] text-neutral uppercase">Social Window</span>
            <button
              type="button"
              onClick={() => setSocialWindow('adaptive')}
              className={`rounded border px-2 py-1 text-xs transition-colors ${
                socialWindow === 'adaptive'
                  ? 'border-accent/60 bg-accent/10 text-sky-200'
                  : 'border-border text-neutral hover:border-accent hover:text-white'
              }`}
            >
              Adaptive
            </button>
            <input
              type="range"
              min={SOCIAL_WINDOW_MIN}
              max={SOCIAL_WINDOW_MAX}
              step={SOCIAL_WINDOW_STEP}
              value={socialWindowMinutes}
              onChange={event => setSocialWindow(event.currentTarget.value)}
              className="w-48 accent-orange-500 cursor-pointer"
              aria-label="Screener social rolling window in minutes"
            />
            <span className="w-24 font-mono text-xs text-slate-200">{socialWindowDisplay}</span>
            <span className="text-neutral text-sm">{filtered.length} NASDAQ/NYSE/AMEX tickers</span>
          </div>
        )}
      </div>

      <div className="mb-3 flex gap-1 overflow-x-auto border-b border-border">
        {WORKSPACE_TABS.map(tab => (
          <button
            key={tab.id}
            onClick={() => setWorkspaceTab(tab.id)}
            className={`min-w-fit border-b-2 px-3 py-2 text-left transition-colors ${
              workspaceTab === tab.id
                ? 'border-accent text-white'
                : 'border-transparent text-neutral hover:border-slate-600 hover:text-white'
            }`}
          >
            <div className="text-xs font-semibold">{tab.label}</div>
            <div className="text-[10px] text-neutral">{tab.description}</div>
          </button>
        ))}
      </div>

      {workspaceTab === 'mirror' ? (
        <MirrorPage
          embedded
          socialWindow={socialWindow}
          onSocialWindowChange={setSocialWindow}
        />
      ) : (
      <>
      <div className="mb-3 flex items-center gap-1 overflow-x-auto border-b border-border">
        {VIEW_MODES.map(mode => (
          <button
            key={mode}
            onClick={() => setViewMode(mode)}
            className={`min-w-fit border-b-2 px-3 py-2 text-xs transition-colors ${
              viewMode === mode
                ? 'border-accent text-white'
                : 'border-transparent text-neutral hover:text-white'
            }`}
          >
            {VIEW_LABELS[mode]}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mb-3">
        <ScreenerMetric label="Universe" value={compact(filtered.length)} />
        <ScreenerMetric label="Priced" value={compact(pricedCount)} tone="text-sky-300" />
        <ScreenerMetric label="Breadth G/L/F" value={`${gainers}/${losers}/${unchanged}`} tone={losers ? 'text-emerald-300' : 'text-yellow-300'} />
        <ScreenerMetric label="Active Social" value={`${compact(activeSocialCount)}/${compact(filtered.length)}`} tone="text-indigo-300" />
        <ScreenerMetric label="Avg Posts" value={`${compact(avgPostsPerActive)} active`} tone="text-violet-300" subvalue={`${avgSocialDensity.toFixed(2)}/m avg density`} />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1.25fr)_minmax(360px,0.9fr)] gap-3 mb-3">
        <section className="bg-surface border border-border rounded-lg overflow-hidden">
          <div className="px-3 py-2 border-b border-border flex items-center justify-between">
            <span className="text-xs uppercase text-neutral font-medium">Sector Heatmap</span>
            <span className="text-[10px] text-neutral">filtered universe</span>
          </div>
          <div className="p-2 grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
            {heatmap.map(tile => (
              <div
                key={tile.sector}
                className={`rounded border px-2 py-2 min-h-[70px] ${
                  tile.avgChange >= 0
                    ? 'bg-emerald-500/10 border-emerald-500/25'
                    : 'bg-red-500/10 border-red-500/25'
                }`}
              >
                <div className="text-xs text-white truncate">{tile.sector}</div>
                <div className={`font-mono text-lg ${tile.avgChange >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  {tile.avgChange >= 0 ? '+' : ''}{tile.avgChange.toFixed(1)}%
                </div>
                <div className="text-[10px] text-neutral">{tile.activeSocial}/{tile.count} active social</div>
                <div className="text-[10px] text-neutral">{compact(tile.avgMsgsPerActive)} avg posts · {tile.avgDensity.toFixed(2)}/m</div>
              </div>
            ))}
          </div>
        </section>

        {viewMode === 'high_conviction_next_day' && (
          <section className="bg-surface border border-border rounded-lg overflow-hidden">
            <div className="px-3 py-2 border-b border-border flex items-center justify-between">
              <span className="text-xs uppercase text-neutral font-medium">Professor Top 5</span>
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-neutral">Sendable picks</span>
                <button
                  className="text-[10px] bg-accent px-2 py-1 rounded text-black font-semibold"
                  onClick={() => {
                    try {
                      const list = professorTop5.map(r => r.ticker).join(', ')
                      navigator.clipboard.writeText(list)
                    } catch (e) {}
                  }}
                >Copy</button>
              </div>
            </div>
            <div className="p-3">
              {professorTop5.length ? professorTop5.map(r => (
                <div key={r.ticker} className="flex items-center justify-between mb-2">
                  <div>
                    <div className="font-mono text-accent font-semibold">{r.ticker}</div>
                    <div className="text-[11px] text-neutral">{r.company ?? r.sector}</div>
                  </div>
                  <div className="text-right">
                    <div className="font-mono text-emerald-400">{r.predicted_return != null ? `${r.predicted_return > 0 ? '+' : ''}${Number(r.predicted_return).toFixed(2)}%` : '—'}</div>
                    <div className="text-[11px] text-neutral">Score: {Number(r.final_prediction_score ?? 0).toFixed(0)}</div>
                  </div>
                </div>
              )) : (
                <div className="text-sm text-neutral">No professor-sendable picks available. A fallback list may exist.</div>
              )}
            </div>
          </section>
        )}

        <section className="bg-surface border border-border rounded-lg overflow-hidden">
          <div className="px-3 py-2 border-b border-border flex items-center justify-between">
            <span className="text-xs uppercase text-neutral font-medium">Mover News</span>
            <span className="text-[10px] text-neutral">{moverNews.length} latest</span>
          </div>
          <div className="divide-y divide-slate-700/30 max-h-[230px] overflow-y-auto">
            {moverNews.length ? moverNews.map(article => (
              <a key={article.id || article.article_id || article.url} href={article.url || '#'} target="_blank" rel="noreferrer" className="block px-3 py-2 hover:bg-bg/50">
                <div className="flex items-center gap-2 text-[10px] mb-1">
                  <span className="font-mono text-accent">{article.matched_mover_tickers?.join(',') || article.ticker || '--'}</span>
                  <span className="text-neutral truncate">{article.source}</span>
                </div>
                <div className="text-xs text-slate-200 line-clamp-2">{article.title}</div>
              </a>
            )) : (
              <div className="px-3 py-8 text-sm text-neutral text-center">No mover-matched news in the current window.</div>
            )}
          </div>
        </section>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3 mb-3">
        {topMovers.map(row => (
          <div key={row.ticker} className="bg-surface border border-border rounded-lg overflow-hidden">
            <div className="px-3 py-2 border-b border-border flex items-center justify-between">
              <div>
                <div className="font-mono text-accent font-semibold">{row.ticker}</div>
                <div className="text-[10px] text-neutral truncate max-w-[150px]">{row.company || row.sector}</div>
              </div>
              <div className="text-right">
                <div className="font-mono text-emerald-400">+{Number(row.change_pct || 0).toFixed(1)}%</div>
                <div className="text-[10px] text-neutral">{row.rolling_window_minutes ?? '--'}m window</div>
              </div>
            </div>
            <div className="h-[130px]">
              <IntradayChart ticker={row.ticker} />
            </div>
          </div>
        ))}
      </div>

      <div className="flex gap-1.5 overflow-x-auto pb-2 mb-2">
        {PRESETS.map(preset => (
          <button
            key={preset.key}
            onClick={() => {
              setSignal(signal === preset.key ? '' : preset.key)
              setOrderBy(preset.key === 'top_losers' ? 'change_pct' : preset.key === 'unusual_volume' ? 'rel_volume' : 'change_pct')
              setOrderDir(preset.key === 'top_losers' ? 'asc' : 'desc')
            }}
            className={`px-2.5 py-1 text-xs rounded border whitespace-nowrap ${signal === preset.key ? 'bg-accent/15 border-accent/50 text-accent' : 'bg-surface border-border text-neutral hover:text-white'}`}
          >
            {preset.label}
          </button>
        ))}
      </div>

      {/* Signal bar */}
      <SignalBar
        signal={signal} setSignal={setSignal}
        orderBy={orderBy} setOrderBy={setOrderBy}
        orderDir={orderDir} setOrderDir={setOrderDir}
        search={search} setSearch={setSearch}
        onRefresh={() => mutate()}
      />

      {/* Filter toggle + active pills */}
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        <button
          onClick={() => setShowFilters(s => !s)}
          className={`text-xs px-3 py-1.5 rounded border transition-colors ${
            showFilters ? 'bg-accent/10 border-accent/40 text-accent' : 'border-border text-neutral hover:text-white hover:border-accent'
          }`}
        >
          {showFilters ? '▾ Filters' : '▸ Filters'}
        </button>
        {Object.entries(filters).map(([k, v]) => (
          <span key={k} className="flex items-center gap-1 text-[11px] bg-accent/10 border border-accent/30 text-accent px-2 py-0.5 rounded">
            {k}: {v}
            <button onClick={() => setFilter(k, '')} className="hover:text-white ml-0.5">&times;</button>
          </span>
        ))}
        {Object.keys(filters).length > 0 && (
          <button onClick={resetFilters} className="text-[11px] text-red-400 hover:text-red-300">Clear All</button>
        )}
      </div>

      {/* Filter panel */}
      {showFilters && (
        <ScreenerFilterPanel
          filters={filters}
          setFilter={setFilter}
          activeTab={filterTab}
          setActiveTab={setFilterTab}
        />
      )}

      {predictionViewActive && (
        <div className="mb-2 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div>
              <div className="text-xs font-semibold text-white">
                {viewMode === 'high_conviction_next_day'
                  ? (showingLiveSignals ? 'Live High-Conviction Watch' : 'Strict High-Conviction Discovery')
                  : 'Developing Opportunity Discovery'}
              </div>
              <div className="text-[11px] text-neutral">
                {filtered.length
                  ? `${filtered.length} ranked ${viewMode === 'high_conviction_next_day' ? 'high-conviction' : 'opportunity'} row${filtered.length === 1 ? '' : 's'}`
                  : viewMode === 'high_conviction_next_day'
                    ? 'No real high-conviction predictions found under current thresholds.'
                    : 'No developing opportunities found under current evidence thresholds.'}
              </div>
            </div>
            <span className={showingLiveSignals ? 'rounded border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 text-[10px] text-sky-200' : 'rounded border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-200'}>
              {viewMode === 'high_conviction_next_day' ? (showingLiveSignals ? 'Live Watch' : 'Strict Gate') : 'Continuous Discovery'}
            </span>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.7fr)] gap-2 rounded border border-border bg-surface/60 px-3 py-2">
            <div className="flex flex-wrap items-center gap-2 text-[11px]">
              <span className="font-semibold text-slate-200">Learning gate</span>
              <span className="rounded border border-emerald-500/25 bg-emerald-500/10 px-2 py-0.5 text-emerald-200">
                {nextSessionModel?.target || 'payoff_capture'} {nextSessionModel?.selected_threshold != null ? `>= ${Number(nextSessionModel.selected_threshold).toFixed(2)}` : 'threshold pending'}
              </span>
              <span className="rounded border border-slate-600 bg-bg/60 px-2 py-0.5 text-slate-300">
                {nextSessionModel?.samples ?? 0} labels
              </span>
              <span className="rounded border border-slate-600 bg-bg/60 px-2 py-0.5 text-slate-300">
                checked: {checkerSummary.labeled ?? 0}
              </span>
              <span className="rounded border border-emerald-500/25 bg-emerald-500/10 px-2 py-0.5 text-emerald-200">
                payoff win: {checkerSummary.payoff_capture_win_rate != null ? `${Math.round(Number(checkerSummary.payoff_capture_win_rate) * 100)}%` : '—'}
              </span>
              <span className="rounded border border-slate-600 bg-bg/60 px-2 py-0.5 text-slate-300">
                avg payoff: {checkerSummary.avg_payoff_capture_return_pct != null ? `${Number(checkerSummary.avg_payoff_capture_return_pct).toFixed(2)}%` : '—'}
              </span>
              <span className="rounded border border-slate-600 bg-bg/60 px-2 py-0.5 text-slate-300">
                strict: {(predictionDiagnostics as any)?.strictRows ?? 0}
              </span>
              <span className="rounded border border-slate-600 bg-bg/60 px-2 py-0.5 text-slate-300">
                developing: {(predictionDiagnostics as any)?.candidatePoolRows ?? 0}
              </span>
              <span className="rounded border border-slate-600 bg-bg/60 px-2 py-0.5 text-slate-300">
                min score: {(predictionDiagnostics as any)?.developingCandidateMinScore ?? '—'}
              </span>
              <span className="rounded border border-slate-600 bg-bg/60 px-2 py-0.5 text-slate-300">
                best fallback: {(predictionDiagnostics as any)?.topBestCandidateRows ?? 0}
              </span>
              <span className="rounded border border-slate-600 bg-bg/60 px-2 py-0.5 text-slate-300">
                no fresh cross: {riskCounts.NO_FRESH_DENSITY_ENTRY_CROSS ?? 0}
              </span>
              <span className="rounded border border-slate-600 bg-bg/60 px-2 py-0.5 text-slate-300">
                no confirmed trigger: {riskCounts.NO_FRESH_CONFIRMED_TRIGGER ?? 0}
              </span>
              <span className="rounded border border-slate-600 bg-bg/60 px-2 py-0.5 text-slate-300">
                low social: {riskCounts.LOW_OR_MISSING_SOCIAL_CONFIRMATION ?? 0}
              </span>
              <span className="rounded border border-slate-600 bg-bg/60 px-2 py-0.5 text-slate-300">
                below payoff: {riskCounts.BELOW_PAYOFF_MODEL_THRESHOLD ?? 0}
              </span>
              <span className="rounded border border-sky-500/25 bg-sky-500/10 px-2 py-0.5 text-sky-200">
                trade ready: {(readinessCounts.trade_ready_prediction ?? 0) + (readinessCounts.high_conviction_prediction ?? 0)}
              </span>
              <span className="rounded border border-yellow-500/25 bg-yellow-500/10 px-2 py-0.5 text-yellow-200">
                waiting density: {readinessCounts.waiting_for_density_cross ?? 0}
              </span>
              <span className="rounded border border-slate-600 bg-bg/60 px-2 py-0.5 text-slate-300">
                fresh catalyst: {readinessCounts.fresh_catalyst_candidate ?? 0}
              </span>
              <span className="rounded border border-sky-500/25 bg-sky-500/10 px-2 py-0.5 text-sky-200">
                pending open: {readinessCounts.fresh_catalyst_pending_open ?? 0}
              </span>
              <span className="rounded border border-emerald-500/25 bg-emerald-500/10 px-2 py-0.5 text-emerald-200">
                strong cat: {qualityCounts.strong ?? 0}
              </span>
              <span className="rounded border border-sky-500/25 bg-sky-500/10 px-2 py-0.5 text-sky-200">
                pending confirmed: {pendingCounts.confirmed ?? 0}
              </span>
              <span className="rounded border border-yellow-500/25 bg-yellow-500/10 px-2 py-0.5 text-yellow-200">
                needs confirm: {pendingCounts.needs_confirmation ?? 0}
              </span>
              <span className="rounded border border-slate-600 bg-bg/60 px-2 py-0.5 text-slate-300">
                unaffected: {reactionCounts.unaffected ?? 0}
              </span>
              <span className="rounded border border-slate-600 bg-bg/60 px-2 py-0.5 text-slate-300">
                first pending: {firstReactionCounts.pending_market_open ?? 0}
              </span>
              <span className="rounded border border-red-500/25 bg-red-500/10 px-2 py-0.5 text-red-200">
                priced/faded: {reactionCounts['priced/faded'] ?? 0}
              </span>
            </div>
            <div className="text-[11px] text-neutral">
              {postmortemRecommendations.length
                ? postmortemRecommendations.slice(0, 2).map(item => item.action || item.reason || item.rule).join(' | ')
                : 'No postmortem recommendation is active yet.'}
            </div>
          </div>
        </div>
      )}

      {/* Table */}
      <ScreenerTable
        rows={paged}
        isLoading={isLoading || predictionStillResolving}
        viewMode={viewMode}
        sortBy={orderBy}
        sortDir={orderDir}
        onSort={handleSort}
        emptyDiagnostics={predictionDiagnostics}
      />

      {predictionViewActive && fallbackPredictionRows.length > 0 && (
        <section className="mt-4 rounded-lg border border-yellow-500/25 bg-yellow-500/5">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-yellow-500/20 px-3 py-2">
            <div>
              <div className="text-xs font-semibold text-yellow-100">Separate Watch Candidates</div>
              <div className="text-[11px] text-yellow-100/75">
                Rows below are useful monitoring candidates, but they did not meet the current evidence floor for the main discovery list.
              </div>
            </div>
            <div className="flex flex-wrap gap-1 text-[10px]">
              <span className="rounded border border-yellow-500/40 bg-yellow-500/10 px-2 py-0.5 text-yellow-100">Watch Candidate</span>
              <span className="rounded border border-slate-600 bg-slate-900/60 px-2 py-0.5 text-slate-300">{fallbackPredictionRows.length} rows</span>
            </div>
          </div>
          <div className="p-2">
            <ScreenerTable
              rows={fallbackPredictionRows.slice(0, viewMode === 'high_conviction_next_day' ? 25 : 50)}
              isLoading={false}
              viewMode="predicted_increases"
              sortBy={orderBy}
              sortDir={orderDir}
              onSort={handleSort}
              emptyDiagnostics={predictionDiagnostics}
            />
          </div>
        </section>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-3">
          <span className="text-xs text-neutral">
            {page * pageSize + 1}–{Math.min((page + 1) * pageSize, filtered.length)} of {filtered.length}
          </span>
          <div className="flex gap-1">
            <button disabled={page === 0} onClick={() => setPage(p => p - 1)}
              className="px-2 py-1 text-xs bg-surface border border-border rounded text-neutral disabled:opacity-40 hover:text-white">Prev</button>
            {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
              let pn: number
              if (totalPages <= 5) pn = i
              else if (page < 3) pn = i
              else if (page >= totalPages - 3) pn = totalPages - 5 + i
              else pn = page - 2 + i
              return (
                <button key={pn} onClick={() => setPage(pn)}
                  className={`w-6 h-6 text-xs rounded ${page === pn ? 'bg-accent text-white' : 'bg-surface border border-border text-neutral hover:text-white'}`}>
                  {pn + 1}
                </button>
              )
            })}
            <button disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)}
              className="px-2 py-1 text-xs bg-surface border border-border rounded text-neutral disabled:opacity-40 hover:text-white">Next</button>
          </div>
        </div>
      )}
      </>
      )}
    </div>
  )
}

function ScreenerMetric({ label, value, tone = 'text-white', subvalue }: { label: string; value: string; tone?: string; subvalue?: string }) {
  return (
    <div className="bg-surface border border-border rounded-lg px-3 py-2 min-w-0">
      <div className={`font-mono text-lg font-semibold truncate ${tone}`}>{value}</div>
      <div className="text-[10px] uppercase text-neutral mt-0.5">{label}</div>
      {subvalue && <div className="text-[10px] text-slate-500 mt-0.5">{subvalue}</div>}
    </div>
  )
}
