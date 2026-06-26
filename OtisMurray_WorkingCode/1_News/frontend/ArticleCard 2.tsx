import type { Article } from '@/lib/types'
import { SentimentBadge } from './SentimentBadge'
import { clsx } from 'clsx'

function formatTime(ts: number | null): string {
  if (!ts) return ''
  const d = new Date(ts * 1000)
  const now = Date.now()
  const diff = now - d.getTime()
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`
  return d.toLocaleDateString()
}

interface Props { article: Article }

export function ArticleCard({ article: a }: Props) {
  const barColor = a.sentiment === 'bullish' ? 'bg-bull' : a.sentiment === 'bearish' ? 'bg-bear' : 'bg-neutral'

  return (
    <a
      href={a.url}
      target="_blank"
      rel="noopener noreferrer"
      className="block bg-surface border border-slate-700/50 rounded-lg overflow-hidden hover:bg-card-hover transition-colors"
    >
      <div className="flex">
        <div className={clsx('w-[3px] flex-shrink-0', barColor)} />
        <div className="flex-1 px-3 py-3">
          <div className="flex items-center justify-between gap-2 mb-1.5">
            <div className="flex items-center gap-1.5">
              <span className="text-xs bg-slate-700 text-neutral px-2 py-0.5 rounded">{a.source}</span>
              {a.category && (
                <span className="text-xs bg-slate-700/50 text-neutral px-2 py-0.5 rounded">{a.category}</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <span className="meta">{formatTime(a.publish_date ?? a.fetched_date)}</span>
              {a.sentiment && <SentimentBadge sentiment={a.sentiment} />}
            </div>
          </div>
          <p className="headline line-clamp-2 mb-1">{a.title}</p>
          {a.content && (
            <p className="meta line-clamp-2">{a.content.slice(0, 200)}</p>
          )}
          {(a.ticker || a.company) && (
            <div className="flex items-center gap-2 mt-1.5">
              {a.ticker && (
                <span className="text-xs font-mono font-bold text-accent bg-accent/10 px-2 py-0.5 rounded">{a.ticker}</span>
              )}
              {a.company && <span className="meta">{a.company}</span>}
            </div>
          )}
        </div>
      </div>
    </a>
  )
}
