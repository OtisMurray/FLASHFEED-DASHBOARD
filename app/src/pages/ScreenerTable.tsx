'use client'
import { ScreenerRow } from './ScreenerRow'
import type { ScreenerRow as SR } from '@/lib/types'
import type { ViewMode } from './ScreenerPage'

interface Props {
  rows: SR[]
  isLoading: boolean
  viewMode: ViewMode
  sortBy?: string
  sortDir?: 'asc' | 'desc'
  onSort?: (key: string) => void
  emptyDiagnostics?: Record<string, unknown> | null
}

const COLUMNS: Record<ViewMode, Array<{ key: string; label: string }>> = {
  predicted_increases: [
    { key: 'ticker', label: 'TICKER' },
    { key: 'company', label: 'COMPANY' },
    { key: 'session', label: 'SESSION' },
    { key: 'price', label: 'PRICE' },
    { key: 'change_pct', label: 'CHG%' },
    { key: 'rel_volume', label: 'REL VOL' },
    { key: 'final_predicted_percent', label: 'PRED %' },
    { key: 'expected_move_range', label: 'RANGE' },
    { key: 'payoff_model_probability', label: 'PAYOFF' },
    { key: 'final_prediction_score', label: 'SCORE' },
    { key: 'catalyst_brief', label: 'CATALYST' },
    { key: 'setup_summary', label: 'SETUP' },
    { key: 'signal_quality', label: 'QUALITY' },
    { key: 'prediction_readiness_level', label: 'READY' },
    { key: 'risk_summary', label: 'RISK' },
  ],
  high_conviction_next_day: [
    { key: 'high_conviction_rank', label: 'RANK' },
    { key: 'ticker', label: 'TICKER' },
    { key: 'company', label: 'COMPANY' },
    { key: 'price', label: 'PRICE' },
    { key: 'change_pct', label: 'CHG%' },
    { key: 'prediction_direction', label: 'PRED' },
    { key: 'predicted_return', label: 'PRED RET' },
    { key: 'expected_move_range', label: 'RANGE' },
    { key: 'prediction_confidence', label: 'CONF' },
    { key: 'payoff_model_probability', label: 'PAYOFF' },
    { key: 'final_prediction_score', label: 'SCORE' },
    { key: 'catalyst_brief', label: 'CATALYST' },
    { key: 'setup_summary', label: 'SETUP' },
    { key: 'signal_quality', label: 'QUALITY' },
    { key: 'prediction_readiness_level', label: 'READY' },
    { key: 'risk_summary', label: 'RISK' },
  ],
  news_catalysts: [
    { key: 'ticker', label: 'TICKER' },
    { key: 'company', label: 'COMPANY' },
    { key: 'price', label: 'PRICE' },
    { key: 'change_pct', label: 'CHG%' },
    { key: 'main_catalyst', label: 'CATALYST' },
    { key: 'news_article_count', label: 'ARTICLES' },
    { key: 'structured_sentiment', label: 'NEWS SENT' },
    { key: 'filing_article_count', label: 'FILINGS' },
    { key: 'filing_used_count', label: 'FILINGS USED' },
    { key: 'sources', label: 'SOURCES' },
  ],
  top_movers: [
    { key: 'ticker', label: 'TICKER' },
    { key: 'company', label: 'COMPANY' },
    { key: 'price', label: 'PRICE' },
    { key: 'change_pct', label: 'CHG%' },
    { key: 'volume', label: 'VOLUME' },
    { key: 'rel_volume', label: 'REL VOL' },
    { key: 'market_cap', label: 'MKT CAP' },
    { key: 'sector', label: 'SECTOR' },
    { key: 'social_message_sentiment', label: 'SOC SENT' },
    { key: 'social_message_density', label: 'SOC DENS' },
    { key: 'rolling_window_minutes', label: 'WIN' },
  ],
  overview: [
    { key: 'ticker', label: 'TICKER' },
    { key: 'company', label: 'COMPANY' },
    { key: 'exchange', label: 'EXCH' },
    { key: 'price', label: 'PRICE' },
    { key: 'change_pct', label: 'CHG%' },
    { key: 'volume', label: 'VOLUME' },
    { key: 'rel_volume', label: 'REL VOL' },
    { key: 'market_cap', label: 'MKT CAP' },
    { key: 'sector', label: 'SECTOR' },
    { key: 'structured_sentiment', label: 'NEWS SENT' },
    { key: 'social_message_sentiment', label: 'SOC SENT' },
    { key: 'social_message_density', label: 'SOC DENS' },
    { key: 'stocktwits_message_sentiment', label: 'ST SENT' },
    { key: 'stocktwits_message_count', label: 'ST MSGS' },
    { key: 'rolling_window_minutes', label: 'WIN' },
  ],
  performance: [
    { key: 'ticker', label: 'TICKER' },
    { key: 'change_pct', label: 'CHG%' },
    { key: 'perf_week', label: 'WEEK' },
    { key: 'perf_month', label: 'MONTH' },
    { key: 'perf_quarter', label: 'QUARTER' },
    { key: 'perf_half', label: 'HALF' },
    { key: 'perf_year', label: 'YEAR' },
    { key: 'perf_ytd', label: 'YTD' },
  ],
  technical: [
    { key: 'ticker', label: 'TICKER' },
    { key: 'price', label: 'PRICE' },
    { key: 'change_pct', label: 'CHG%' },
    { key: 'volume', label: 'VOLUME' },
    { key: 'avg_volume', label: 'AVG VOL' },
    { key: 'rel_volume', label: 'REL VOL' },
    { key: 'rsi', label: 'RSI' },
    { key: 'sma20', label: 'SMA20' },
    { key: 'sma50', label: 'SMA50' },
    { key: 'sma200', label: 'SMA200' },
    { key: 'atr', label: 'ATR' },
    { key: 'gap', label: 'GAP' },
  ],
  sentiment: [
    { key: 'ticker', label: 'TICKER' },
    { key: 'social_message_sentiment', label: 'SOC SENT' },
    { key: 'social_message_density', label: 'SOC DENS' },
    { key: 'stocktwits_message_sentiment', label: 'ST SENT' },
    { key: 'stocktwits_message_density', label: 'ST DENS' },
    { key: 'stocktwits_message_count', label: 'ST MSGS' },
    { key: 'social_sentiment', label: 'ALL SOCIAL' },
    { key: 'message_count', label: 'ALL POSTS' },
    { key: 'rolling_window_minutes', label: 'WINDOW' },
    { key: 'structured_sentiment', label: 'NEWS' },
    { key: 'news_article_count', label: 'ARTICLES' },
    { key: 'sources', label: 'SOURCES' },
    { key: 'bullish_count', label: 'BULL' },
    { key: 'bearish_count', label: 'BEAR' },
  ],
}

function ScreenerTableSkeleton({ columns }: { columns: Array<{ key: string; label: string }> }) {
  const widths = ['w-14', 'w-28', 'w-20', 'w-16', 'w-20', 'w-24', 'w-16', 'w-32']
  return (
    <div className="bg-surface border border-border rounded-lg overflow-hidden animate-pulse">
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="border-b border-border bg-bg/50">
            <tr>
              {columns.map(col => (
                <th
                  key={col.key}
                  className="px-2 py-2 text-left text-[10px] uppercase tracking-wide font-medium whitespace-nowrap text-neutral"
                >
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700/30">
            {Array.from({ length: 12 }).map((_, rowIdx) => (
              <tr key={rowIdx}>
                {columns.map((col, colIdx) => (
                  <td key={col.key} className="px-2 py-4">
                    <div className={`h-3 rounded bg-slate-700/60 ${widths[colIdx % widths.length]}`} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export function ScreenerTable({ rows, isLoading, viewMode, sortBy, sortDir, onSort, emptyDiagnostics }: Props) {
  const columns = COLUMNS[viewMode]

  if (isLoading) return <ScreenerTableSkeleton columns={columns} />
  if (rows.length === 0) return (
    <div className="text-center py-12 text-neutral">
      <div className="text-sm">No tickers match current filters</div>
      {emptyDiagnostics && (
        <div className="mt-3 mx-auto max-w-3xl text-left text-[11px] bg-bg border border-border rounded p-3">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <div>backend_count: {String((emptyDiagnostics as any).backend_count ?? 0)}</div>
            <div>frontend_received_count: {String((emptyDiagnostics as any).frontend_received_count ?? 0)}</div>
            <div>frontend_visible_count: {String((emptyDiagnostics as any).frontend_visible_count ?? 0)}</div>
            <div>model_mode: {String((emptyDiagnostics as any).model_mode ?? 'unknown')}</div>
          </div>
          <div className="mt-2 break-all">fallback params: {JSON.stringify((emptyDiagnostics as any).fallback_params_used ?? {})}</div>
          <div className="mt-1 break-all">active filters: {JSON.stringify((emptyDiagnostics as any).active_filters ?? {})}</div>
          <div className="mt-1 break-all">cache_status: {String((emptyDiagnostics as any).cache_status ?? '—')} · screener_snapshot_at: {String((emptyDiagnostics as any).screener_snapshot_at ?? '—')}</div>
        </div>
      )}
    </div>
  )

  return (
    <div className="bg-surface border border-border rounded-lg overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="border-b border-border bg-bg/50">
            <tr>
              {columns.map(col => {
                const isActive = sortBy === col.key
                const arrow = isActive
                  ? sortDir === 'asc'
                    ? ' ↑'
                    : sortDir === 'desc'
                      ? ' ↓'
                      : ''
                  : ''
                return (
                  <th
                    key={col.key}
                    onClick={() => onSort?.(col.key)}
                    className={`px-2 py-2 text-left text-[10px] uppercase tracking-wide font-medium whitespace-nowrap select-none cursor-pointer hover:text-white transition-colors ${
                      isActive ? 'text-accent' : 'text-neutral'
                    }`}
                    title={isActive ? `Sorted ${sortDir === 'asc' ? 'ascending' : 'descending'}` : `Sort by ${col.label}`}
                  >
                    {col.label}{arrow}
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700/30">
            {rows.map(row => <ScreenerRow key={row.ticker} row={row} columns={columns} />)}
          </tbody>
        </table>
      </div>
    </div>
  )
}
