import { clsx } from 'clsx'

interface Props { sentiment: 'bullish' | 'bearish' | 'neutral' }

export function SentimentBadge({ sentiment }: Props) {
  return (
    <span className={clsx(
      'rounded-full px-2 py-0.5 text-xs border bg-transparent',
      sentiment === 'bullish' && 'border-emerald-500 text-emerald-400',
      sentiment === 'bearish' && 'border-red-500 text-red-400',
      sentiment === 'neutral' && 'border-slate-500 text-slate-400',
    )}>
      {sentiment}
    </span>
  )
}
