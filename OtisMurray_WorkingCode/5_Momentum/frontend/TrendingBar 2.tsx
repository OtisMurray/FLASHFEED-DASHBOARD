import type { MomentumRow } from '@/lib/types'
import { clsx } from 'clsx'

interface Props { tickers: MomentumRow[] }

export function TrendingBar({ tickers }: Props) {
  if (tickers.length === 0) return null
  return (
    <div className="flex gap-2 overflow-x-auto mb-4 pb-2">
      {tickers.slice(0, 15).map(t => {
        const chg = t.change_pct ?? 0
        return (
          <div key={t.ticker} className="flex-shrink-0 bg-surface border border-border rounded px-3 py-1.5 text-xs">
            <div className="font-mono font-bold text-accent">{t.ticker}</div>
            <div className={clsx('font-mono', chg >= 0 ? 'text-emerald-400' : 'text-red-400')}>
              {chg >= 0 ? '+' : ''}{chg.toFixed(2)}%
            </div>
          </div>
        )
      })}
    </div>
  )
}
