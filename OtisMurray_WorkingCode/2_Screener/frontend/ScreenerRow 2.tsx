'use client'
import { useState } from 'react'
import { clsx } from 'clsx'
import type { ScreenerRow as SR } from '@/lib/types'
import { TickerDetailModal } from '@/components/shared/TickerDetailModal'

interface Props {
  row: SR
  columns: Array<{ key: string; label: string }>
}

function fmtCompact(n: number | undefined | null): string {
  if (n == null) return '—'
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`
  return n.toLocaleString()
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

export function ScreenerRow({ row, columns }: Props) {
  const [showDetail, setShowDetail] = useState(false)

  const renderCell = (key: string) => {
    switch (key) {
      case 'ticker':
        return (
          <button onClick={() => setShowDetail(true)} className="font-mono font-bold text-accent hover:text-sky-300 transition-colors">
            {row.ticker}
          </button>
        )
      case 'price':
        return <span className="font-mono">{row.price != null ? `$${row.price.toFixed(2)}` : '—'}</span>
      case 'change_pct':
        return (
          <span className={clsx('font-mono', (row.change_pct ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400')}>
            {row.change_pct != null ? `${row.change_pct >= 0 ? '+' : ''}${row.change_pct.toFixed(2)}%` : '—'}
          </span>
        )
      case 'volume':
        return <span className="font-mono text-neutral">{fmtCompact(row.volume)}</span>
      case 'avg_volume':
        return <span className="font-mono text-neutral">{fmtCompact((row as any).avg_volume)}</span>
      case 'market_cap':
        return <span className="font-mono text-neutral">{fmtCompact((row as any).market_cap)}</span>
      case 'sector':
        return <span className="text-neutral truncate max-w-[100px]">{row.sector ?? '—'}</span>
      case 'industry':
        return <span className="text-neutral truncate max-w-[100px]">{row.industry ?? '—'}</span>
      case 'avg_sentiment':
        return (
          <div className="flex items-center gap-1.5">
            <span className={clsx('font-mono', row.avg_sentiment >= 0.2 ? 'text-emerald-400' : row.avg_sentiment <= -0.2 ? 'text-red-400' : 'text-neutral')}>
              {row.avg_sentiment.toFixed(2)}
            </span>
            {sentBar(row.bullish_count, row.bearish_count, row.neutral_count)}
          </div>
        )
      case 'social_sentiment':
        return (
          <span className={clsx('font-mono', row.social_sentiment >= 0.2 ? 'text-emerald-400' : row.social_sentiment <= -0.2 ? 'text-red-400' : 'text-neutral')}>
            {row.social_sentiment.toFixed(2)}
          </span>
        )
      case 'structured_sentiment':
        return (
          <span className={clsx('font-mono', row.structured_sentiment >= 0.2 ? 'text-emerald-400' : row.structured_sentiment <= -0.2 ? 'text-red-400' : 'text-neutral')}>
            {row.structured_sentiment.toFixed(2)}
          </span>
        )
      case 'message_count':
        return <span className="font-mono text-neutral">{row.message_count}</span>
      case 'news_article_count':
        return <span className="font-mono text-neutral">{row.news_article_count ?? 0}</span>
      case 'bullish_count':
        return <span className="font-mono text-emerald-400">{row.bullish_count}</span>
      case 'bearish_count':
        return <span className="font-mono text-red-400">{row.bearish_count}</span>
      case 'sources':
        return (
          <div className="flex gap-0.5 flex-wrap">
            {(row.sources ?? []).slice(0, 3).map(s => (
              <span key={s} className="text-[9px] bg-slate-700 text-neutral px-1 py-0.5 rounded capitalize">{s}</span>
            ))}
          </div>
        )
      default:
        return <span className="text-neutral">—</span>
    }
  }

  return (
    <>
      <tr className="hover:bg-card-hover transition-colors">
        {columns.map(col => (
          <td key={col.key} className="px-2 py-2 whitespace-nowrap">{renderCell(col.key)}</td>
        ))}
      </tr>
      {showDetail && <TickerDetailModal ticker={row.ticker} onClose={() => setShowDetail(false)} />}
    </>
  )
}
