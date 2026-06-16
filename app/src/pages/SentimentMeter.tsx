import type { ScreenerRow } from '@/lib/types'

export function SentimentMeter({ row }: { row: ScreenerRow }) {
  const total = (row.bullish_count ?? 0) + (row.bearish_count ?? 0) + (row.neutral_count ?? 0)
  if (total === 0) return <span className="text-neutral text-xs">—</span>
  const bullPct = ((row.bullish_count ?? 0) / total) * 100
  const bearPct = ((row.bearish_count ?? 0) / total) * 100
  const neutPct = 100 - bullPct - bearPct
  return (
    <div className="flex items-center gap-1.5">
      <div className="flex h-1.5 w-20 rounded-full overflow-hidden bg-slate-700">
        <div style={{ width: `${bullPct}%` }} className="bg-emerald-500" />
        <div style={{ width: `${neutPct}%` }} className="bg-slate-500" />
        <div style={{ width: `${bearPct}%` }} className="bg-red-500" />
      </div>
      <span className={`text-xs font-mono ${row.avg_sentiment >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
        {row.avg_sentiment >= 0 ? '+' : ''}{row.avg_sentiment.toFixed(2)}
      </span>
    </div>
  )
}
