'use client'
import useSWR from 'swr'
import { useState } from 'react'
import { MomentumCard } from './MomentumCard'
import { TrendingBar } from './TrendingBar'
import { MarketBanner } from './MarketBanner'
import type { MomentumRow } from '@/lib/types'

const fetcher = (url: string) => fetch(url).then(r => r.json())

function ageLabel(seconds?: number | null): string {
  if (seconds == null || !Number.isFinite(Number(seconds))) return 'unknown age'
  const s = Math.max(0, Number(seconds))
  if (s < 3600) return `${Math.floor(s / 60)}m old`
  if (s < 86_400) return `${Math.floor(s / 3600)}h old`
  return `${Math.floor(s / 86_400)}d old`
}

export function MomentumPage() {
  const [minVol, setMinVol] = useState('0')
  const [minRelVol, setMinRelVol] = useState('0')
  const [topN, setTopN] = useState('30')
  const [maxPrice, setMaxPrice] = useState('')
  const [sentFilter, setSentFilter] = useState('')
  const [socialWindow, setSocialWindow] = useState('1440')
  const [session, setSession] = useState('regular')

  const params = new URLSearchParams({
    min_news: minVol,
    min_rel_vol: minRelVol,
    limit: topN,
    order: 'absolute_momentum',
    window_minutes: socialWindow,
    session,
    ...(maxPrice && { max_price: maxPrice }),
    ...(sentFilter && { sentiment: sentFilter }),
  })
  const momentumUrl = `/api/momentum?${params}`
  const [isRefreshing, setIsRefreshing] = useState(false)
  const { data, isLoading, mutate } = useSWR(momentumUrl, fetcher, { refreshInterval: 60_000 })
  const { data: trending, mutate: mutateTrending } = useSWR(`/api/momentum/trending?window_minutes=${socialWindow}`, fetcher, { refreshInterval: 60_000 })
  const { data: tradeWatch, mutate: mutateTradeWatch } = useSWR(`/api/trade-watch?limit=5&window_minutes=${socialWindow}`, fetcher, { refreshInterval: 60_000 })
  const { data: predictionSignals } = useSWR('/api/prediction/signals?limit=80', fetcher, { refreshInterval: 60_000 })
  const { data: marketStatus } = useSWR('/api/market/status', fetcher, { refreshInterval: 60_000 })
  const { data: alerts, mutate: mutateAlerts } = useSWR(`/api/alerts?scope=momentum&limit=8&window_minutes=${socialWindow}`, fetcher, { refreshInterval: 60_000 })
  const { data: snapshots, mutate: mutateSnapshots } = useSWR('/api/momentum/snapshots?limit=6', fetcher, { refreshInterval: 60_000 })
  const { data: sourceHealth } = useSWR('/api/sources/health', fetcher, { refreshInterval: 60_000 })
  const finvizStatus = data?.finviz_status
  const finvizBroken = finvizStatus && !['working', 'working_public'].includes(String(finvizStatus.status || '').toLowerCase())
  const finvizStale = finvizStatus?.quote_age_seconds != null && Number(finvizStatus.quote_age_seconds) > 30 * 60 && marketStatus?.open

  const tickers: MomentumRow[] = (data?.tickers ?? []).filter((row: MomentumRow) => {
    const ticker = String(row.ticker || '').toUpperCase()
    const exchange = String((row as any).exchange || '').toUpperCase()
    const source = `${(row as any).quote_source || ''} ${(row as any).source || ''} ${(row as any).discovery_source || ''}`.toLowerCase()
    const isFinviz = source.includes('finviz')

    return ticker &&
      !ticker.includes('.') &&
      !ticker.includes('-') &&
      (isFinviz || !exchange || ['NASDAQ', 'NYSE', 'AMEX'].includes(exchange))
  })
  const tradeWatchRows: MomentumRow[] = tradeWatch?.tickers ?? []

  const refreshMomentum = async () => {
    if (isRefreshing) return
    setIsRefreshing(true)
    try {
      const freshUrl = `${momentumUrl}&fresh=1&t=${Date.now()}`
      const rebuilt = await fetcher(freshUrl)
      await mutate(rebuilt, { revalidate: false })
      await Promise.all([
        mutateAlerts(),
        mutateSnapshots(),
        mutateTrending(),
        mutateTradeWatch(),
      ])
    } finally {
      setIsRefreshing(false)
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div>
          <h1 className="text-white font-semibold text-lg">Momentum</h1>
          <p className="text-xs text-neutral mt-0.5">Finviz top movers enriched with structured news, public news, and ticker-specific social.</p>
          <p className="text-[11px] text-slate-500 mt-0.5">{data?.session_note || 'Regular, premarket, and after-hours movers are analyzed separately.'}</p>
        </div>
        <span className="text-neutral text-sm">{tickers.length} tickers</span>
      </div>

      {/* Market status banner */}
      <MarketBanner status={marketStatus} />

      <MomentumLivePanel
        momentum={data}
        finvizStatus={finvizStatus}
        alerts={alerts}
        snapshots={snapshots}
        sourceHealth={sourceHealth}
        visibleTickerCount={tickers.length}
        onRefresh={refreshMomentum}
        isRefreshing={isRefreshing}
      />

      {(finvizBroken || finvizStale) && (
        <div className="mb-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
          <div className="font-semibold text-amber-200">Finviz Elite movers need attention</div>
          <div className="mt-0.5 text-amber-100/90">
            Showing the last stored Finviz movers ({ageLabel(finvizStatus?.quote_age_seconds)}).
            {finvizBroken ? ` Import status: ${finvizStatus?.status || 'unknown'}${finvizStatus?.detail ? ` - ${finvizStatus.detail}` : ''}.` : ''}
            {finvizStale ? ' Market is open and the mover list is older than 30 minutes.' : ''}
          </div>
        </div>
      )}

      {/* Filter toolbar */}
      <div className="flex items-center gap-2 mb-4 flex-wrap bg-surface border border-border rounded-lg px-3 py-2">
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-neutral uppercase">Session</span>
          <select value={session} onChange={e => setSession(e.target.value)}
            className="bg-bg border border-border text-xs text-neutral rounded px-1.5 py-1">
            <option value="regular">Regular</option>
            <option value="premarket">Premarket</option>
            <option value="postmarket">After-hours</option>
            <option value="auto">Auto strongest</option>
          </select>
        </div>
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-neutral uppercase">Min News</span>
          <select value={minVol} onChange={e => setMinVol(e.target.value)}
            className="bg-bg border border-border text-xs text-neutral rounded px-1.5 py-1">
            <option value="0">Any</option>
            <option value="1">1</option>
            <option value="3">3</option>
            <option value="5">5</option>
            <option value="10">10</option>
          </select>
        </div>
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-neutral uppercase">Rel Vol</span>
          <select value={minRelVol} onChange={e => setMinRelVol(e.target.value)}
            className="bg-bg border border-border text-xs text-neutral rounded px-1.5 py-1">
            <option value="0">Any</option>
            <option value="1">1x</option>
            <option value="2">2x</option>
            <option value="3">3x</option>
            <option value="5">5x</option>
            <option value="10">10x</option>
            <option value="20">20x</option>
          </select>
        </div>
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-neutral uppercase">Top</span>
          <select value={topN} onChange={e => setTopN(e.target.value)}
            className="bg-bg border border-border text-xs text-neutral rounded px-1.5 py-1">
            <option value="3">3</option>
            <option value="5">5</option>
            <option value="10">10</option>
            <option value="20">20</option>
            <option value="30">30</option>
            <option value="50">50</option>
          </select>
        </div>
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-neutral uppercase">Max $</span>
          <select value={maxPrice} onChange={e => setMaxPrice(e.target.value)}
            className="bg-bg border border-border text-xs text-neutral rounded px-1.5 py-1">
            <option value="">Any</option>
            <option value="5">Under $5</option>
            <option value="10">Under $10</option>
            <option value="20">Under $20</option>
          </select>
        </div>
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-neutral uppercase">Sent</span>
          <select value={sentFilter} onChange={e => setSentFilter(e.target.value)}
            className="bg-bg border border-border text-xs text-neutral rounded px-1.5 py-1">
            <option value="">All</option>
            <option value="bullish">Bullish</option>
            <option value="bearish">Bearish</option>
          </select>
        </div>
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-neutral uppercase">Social Window</span>
          <select value={socialWindow} onChange={e => setSocialWindow(e.target.value)}
            className="bg-bg border border-border text-xs text-neutral rounded px-1.5 py-1">
            <option value="5">5m</option>
            <option value="15">15m</option>
            <option value="30">30m</option>
            <option value="60">1h</option>
            <option value="120">2h</option>
            <option value="1440">24h</option>
          </select>
        </div>
        <div className="flex-1" />
        <button onClick={refreshMomentum} disabled={isRefreshing}
          className="px-2 py-1 text-xs bg-bg border border-border text-neutral rounded hover:text-white hover:border-accent transition-colors">
          {isRefreshing ? 'Refreshing...' : '↻ Refresh'}
        </button>
      </div>

      {/* Trending bar */}
      <TrendingBar tickers={trending?.tickers ?? []} />

      <TradeWatchPanel rows={tradeWatchRows} />

      <PredictionPerformancePanel data={predictionSignals} />

      {/* Momentum cards */}
      {isLoading ? (
        <div className="text-neutral text-sm animate-pulse p-4">Loading momentum data...</div>
      ) : tickers.length === 0 ? (
        <div className="text-center py-12 text-neutral">
          <div className="text-3xl mb-2">📈</div>
          <div className="text-sm">No Finviz top movers match current filters. Click Run Now / fetch first, then refresh.</div>
        </div>
      ) : (
        <div className="space-y-2">
          {tickers.map((t, i) => (
            <MomentumCard key={t.ticker} row={t} rank={i + 1} />
          ))}
        </div>
      )}
    </div>
  )
}

function MomentumLivePanel({ momentum, finvizStatus, alerts, snapshots, sourceHealth, visibleTickerCount, onRefresh, isRefreshing }: {
  momentum: any
  finvizStatus: any
  alerts: any
  snapshots: any
  sourceHealth: any
  visibleTickerCount: number
  onRefresh: () => void
  isRefreshing: boolean
}) {
  const alertRows = Array.isArray(alerts?.alerts) ? alerts.alerts : []
  const snapshotRows = Array.isArray(snapshots?.snapshots) ? snapshots.snapshots : []
  const sourceRows = Array.isArray(sourceHealth?.sources) ? sourceHealth.sources : []
  const finvizSource = sourceRows.find((row: any) => /finviz/i.test(String(row.source || row.name || '')))
  const socialSources = sourceRows.filter((row: any) => String(row.collection || '').toLowerCase() === 'socials')
  const latestSnapshot = snapshotRows[0]
  const monitor = momentum?.monitor || {}
  const quoteAge = monitor.quoteAgeSeconds ?? finvizStatus?.quote_age_seconds
  const status = monitor.status || finvizStatus?.status || finvizSource?.status || 'missing'
  const finvizRows = monitor.finvizRows ?? finvizStatus?.last_count ?? finvizSource?.count
  const liveSourceCount = monitor.liveSourceCount ?? sourceHealth?.working_count
  const cacheMode = momentum?.cacheHit ? 'Redis/RAM' : momentum?.cacheMode ? String(momentum.cacheMode).replaceAll('_', ' ') : 'Mongo'
  const freshness = monitor.label || (finvizRows ? 'Momentum data available' : 'No FinViz metadata yet')
  const lastFetch = monitor.lastFetchAt || finvizStatus?.last_fetch_at
  const noAlertText = alerts?.message || 'No active alerts under current thresholds.'
  const snapshotText = latestSnapshot
    ? ((latestSnapshot.top_tickers || latestSnapshot.tickers || []).slice(0, 8).join('  ') || 'Snapshot has no tickers')
    : (snapshots?.message || 'Snapshot not created yet')

  return (
    <section className="mb-4 border border-border rounded-lg bg-surface overflow-hidden">
      <div className="grid gap-px bg-border lg:grid-cols-[1.05fr_1.15fr_1fr]">
        <div className="bg-surface px-3 py-2">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-white text-sm font-semibold">Live Monitor</h2>
              <p className="text-[11px] text-neutral">Finviz Elite is the required Momentum source.</p>
            </div>
            <StatusPill status={status} />
          </div>
          <div className="grid grid-cols-3 gap-2 mt-3">
            <MiniMetric label="Finviz Rows" value={finvizRows == null ? 'No metadata' : String(finvizRows)} />
            <MiniMetric label="Visible" value={String(monitor.visibleTickerCount ?? visibleTickerCount)} />
            <MiniMetric label="Quote Age" value={ageLabel(quoteAge)} />
            <MiniMetric label="Sources" value={liveSourceCount == null ? 'Screener cache missing' : `${liveSourceCount} live`} />
            <MiniMetric label="Cache" value={cacheMode} />
            <MiniMetric label="Last Fetch" value={lastFetch ? ageLabel(secondsAgoFromIso(lastFetch)) : 'Fetch paused'} />
          </div>
          <div className="mt-2 flex items-center justify-between gap-2">
            <div className="text-[11px] text-neutral truncate">{freshness}</div>
            <button
              type="button"
              onClick={onRefresh}
              disabled={isRefreshing}
              className="shrink-0 rounded border border-border bg-bg px-2 py-0.5 text-[11px] text-neutral hover:text-white disabled:opacity-50"
            >
              {isRefreshing ? 'Refreshing' : 'Refresh'}
            </button>
          </div>
        </div>

        <div className="bg-surface px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h2 className="text-white text-sm font-semibold">Alerts</h2>
              <p className="text-[11px] text-neutral">Freshness, social density, high-watch, and squeeze checks.</p>
            </div>
            <span className="text-[11px] text-neutral font-mono">{alertRows.length}</span>
          </div>
          <div className="mt-2 space-y-1 max-h-[92px] overflow-y-auto">
            {alertRows.length ? alertRows.map((alert: any) => (
              <div key={alert.id} className="flex items-start gap-2 text-[11px]">
                <span className={`mt-1 h-1.5 w-1.5 rounded-full shrink-0 ${alertDot(alert.severity)}`} />
                <div className="min-w-0">
                  <div className="text-white truncate">{alert.ticker ? `${alert.ticker} · ` : ''}{alert.title}</div>
                  <div className="text-neutral truncate">{alert.detail}</div>
                </div>
              </div>
            )) : (
              <div className="text-[11px] text-neutral">{noAlertText}</div>
            )}
          </div>
        </div>

        <div className="bg-surface px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h2 className="text-white text-sm font-semibold">Snapshots</h2>
              <p className="text-[11px] text-neutral">Saved top-mover history for later labeling.</p>
            </div>
            <span className="text-[11px] text-neutral">{snapshots?.retention_days ?? 31}d</span>
          </div>
          <div className="mt-2 text-[11px]">
            <div className="flex items-center justify-between gap-2">
              <span className="text-neutral">Latest</span>
              <span className="text-white font-mono">{latestSnapshot ? ageLabel(secondsAgo(latestSnapshot.snapshot_sec)) : '--'}</span>
            </div>
            <div className="mt-1 text-accent font-mono truncate">
              {snapshotText}
            </div>
            <div className="mt-1 text-[10px] text-neutral truncate">
              {latestSnapshot ? `${latestSnapshot.rowCount ?? latestSnapshot.row_count ?? 0} rows · ${latestSnapshot.cacheMode || latestSnapshot.cache_mode || 'Mongo'} · ${latestSnapshot.tradingDate || latestSnapshot.trading_date || 'date unavailable'}` : 'Snapshot will be created from real Momentum rows when available.'}
            </div>
            <div className="mt-2 flex flex-wrap gap-1">
              {socialSources.slice(0, 3).map((row: any) => (
                <span key={row.source || row.name} className="rounded border border-border px-1.5 py-0.5 text-[10px] text-neutral">
                  {row.source || row.name}: {row.count ?? 0}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

function secondsAgo(sec?: number | string | null): number | null {
  const raw = Number(sec)
  if (!Number.isFinite(raw) || raw <= 0) return null
  return Math.max(0, Math.floor(Date.now() / 1000) - raw)
}

function secondsAgoFromIso(value?: string | null): number | null {
  if (!value) return null
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) return null
  return Math.max(0, Math.floor((Date.now() - ms) / 1000))
}

function StatusPill({ status }: { status: string }) {
  const s = String(status || 'unknown').toLowerCase()
  const cls = s.includes('working') || s.includes('healthy') ? 'border-emerald-500/50 text-emerald-300 bg-emerald-500/10'
    : s.includes('required') || s.includes('stale') || s.includes('partial') ? 'border-yellow-500/50 text-yellow-300 bg-yellow-500/10'
    : s.includes('missing') ? 'border-red-500/50 text-red-300 bg-red-500/10'
    : 'border-border text-neutral bg-bg'
  return <span className={`rounded-full border px-2 py-0.5 text-[11px] ${cls}`}>{status || 'missing'}</span>
}

function alertDot(severity?: string) {
  const s = String(severity || '').toLowerCase()
  if (s === 'critical') return 'bg-red-400'
  if (s === 'warning') return 'bg-yellow-300'
  if (s === 'watch') return 'bg-emerald-400'
  return 'bg-sky-300'
}

function PredictionPerformancePanel({ data }: { data: any }) {
  const summary = Array.isArray(data?.summary) ? data.summary : []
  const total = summary.reduce((sum: number, row: any) => sum + Number(row.count || 0), 0)
  if (!total) return null

  const complete = summary.find((row: any) => row.status === 'complete') || {}
  const partial = summary.find((row: any) => row.status === 'partially_labeled') || {}
  const pending = summary.find((row: any) => row.status === 'pending') || {}
  const accuracy = complete.directional_accuracy_5m ?? partial.directional_accuracy_5m
  const model = data?.model

  return (
    <section className="mb-4 border border-border rounded-lg bg-surface px-3 py-2">
      <div className="flex flex-wrap items-center gap-3">
        <div className="mr-auto">
          <h2 className="text-white text-sm font-semibold">Prediction Labels</h2>
          <p className="text-[11px] text-neutral">Trade Watch signals are being labeled against later quote moves.</p>
        </div>
        <MiniMetric label="Signals" value={String(total)} />
        <MiniMetric label="Pending" value={String(pending.count || 0)} />
        <MiniMetric label="Labeled" value={String(Number(complete.count || 0) + Number(partial.count || 0))} />
        <MiniMetric label="5m Acc." value={accuracy == null ? '--' : `${(Number(accuracy) * 100).toFixed(0)}%`} />
        <MiniMetric label="Avg 5m" value={complete.avg_return_5m == null ? '--' : `${Number(complete.avg_return_5m).toFixed(2)}%`} />
        <MiniMetric label="Model" value={model?.status === 'trained' ? 'trained' : `${model?.samples ?? 0}/20`} />
      </div>
    </section>
  )
}

function MiniMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-[76px] text-right">
      <div className="font-mono text-sm text-white">{value}</div>
      <div className="text-[9px] text-neutral uppercase">{label}</div>
    </div>
  )
}

function TradeWatchPanel({ rows }: { rows: MomentumRow[] }) {
  if (!rows.length) return null

  return (
    <section className="mb-4 border border-border rounded-lg bg-surface overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <div>
          <h2 className="text-white text-sm font-semibold">Trade Watch</h2>
          <p className="text-[11px] text-neutral">Ranked movers with price, news, and social support.</p>
        </div>
        <span className="text-[11px] text-neutral uppercase">Research only</span>
      </div>
      <div className="grid gap-px bg-border md:grid-cols-5">
        {rows.slice(0, 5).map(row => {
          const watch = row.trade_watch
          const change = Number(row.change_pct || 0)
          const sentiment = Number(row.sentiment || 0)
          const score = Number(watch?.confidence ?? (Number(watch?.trade_watch_score || 0) * 100))
          const decision = watch?.decision || 'Monitor'
          const evidence = Number(row.article_count || 0) + Number(row.message_count || 0)
          const primaryReasons = watch?.reasons?.slice(0, 2) ?? []
          const primaryRisks = watch?.risks?.slice(0, 1) ?? []
          const breakdown = watch?.score_breakdown

          return (
            <div key={row.ticker} className="bg-surface px-3 py-2 min-w-0">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-mono text-accent font-bold text-base leading-tight">{row.ticker}</div>
                  <div className="text-[10px] text-neutral truncate">{row.company || row.exchange || 'Listed equity'}</div>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-white font-mono text-sm">{score.toFixed(0)}</div>
                  <div className="text-[9px] text-neutral uppercase">score</div>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-2 mt-2 text-[11px]">
                <div>
                  <div className={change >= 0 ? 'text-emerald-400 font-mono' : 'text-red-400 font-mono'}>
                    {change >= 0 ? '+' : ''}{change.toFixed(2)}%
                  </div>
                  <div className="text-neutral uppercase text-[9px]">change</div>
                </div>
                <div>
                  <div className={sentiment >= 0 ? 'text-emerald-300 font-mono' : 'text-red-300 font-mono'}>
                    {sentiment >= 0 ? '+' : ''}{sentiment.toFixed(2)}
                  </div>
                  <div className="text-neutral uppercase text-[9px]">sent</div>
                </div>
                <div>
                  <div className="text-white font-mono">{evidence}</div>
                  <div className="text-neutral uppercase text-[9px]">evidence</div>
                </div>
              </div>
              <div className="mt-2 text-[11px] text-white font-medium truncate">{decision}</div>
              {breakdown && (
                <div className="mt-1 grid grid-cols-6 gap-1 text-[9px] text-neutral">
                  <BreakdownCell label="P" value={breakdown.price_action} />
                  <BreakdownCell label="V" value={breakdown.relative_volume} />
                  <BreakdownCell label="E" value={breakdown.evidence} />
                  <BreakdownCell label="A" value={breakdown.agreement} />
                  <BreakdownCell label="F" value={breakdown.freshness} />
                  <BreakdownCell label="-" value={breakdown.penalties} inverse />
                </div>
              )}
              <div className="mt-1 min-h-[32px] text-[10px] text-neutral leading-snug">
                {[...primaryReasons, ...primaryRisks].join(' | ') || 'waiting for confirmation'}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}

function BreakdownCell({ label, value, inverse = false }: { label: string; value?: number; inverse?: boolean }) {
  const n = Math.max(0, Math.min(1, Number(value || 0)))
  const tone = inverse
    ? n > 0 ? 'text-yellow-300' : 'text-neutral'
    : n >= 0.7 ? 'text-emerald-300' : n >= 0.35 ? 'text-sky-300' : 'text-neutral'
  return (
    <span title={`${label}: ${n.toFixed(2)}`} className={`font-mono ${tone}`}>
      {label}{Math.round(n * 10)}
    </span>
  )
}
