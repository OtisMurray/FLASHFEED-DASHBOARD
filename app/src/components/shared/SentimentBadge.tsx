import { clsx } from 'clsx'

interface Props { sentiment: 'bullish' | 'bearish' | 'neutral' }

export function SentimentBadge({ sentiment }: Props) {
  return (
    <span className={clsx(
      'rounded-full px-2.5 py-1 text-xs font-semibold border',
      sentiment === 'bullish' && 'bg-emerald-500/20 border-emerald-500 text-emerald-300',
      sentiment === 'bearish' && 'bg-red-500/20 border-red-500 text-red-300',
      sentiment === 'neutral' && 'bg-slate-500/20 border-slate-500 text-slate-300',
    )}>
      {sentiment.charAt(0).toUpperCase() + sentiment.slice(1)}
    </span>
  )
}
