import type { SocialPost } from '@/lib/types'
import { clsx } from 'clsx'

function formatTime(ts: string): string {
  const d = new Date(ts)
  const diff = Date.now() - d.getTime()
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`
  return d.toLocaleDateString()
}

export function SocialCard({ post }: { post: SocialPost }) {
  const sentColor = post.sentiment == null ? '' : post.sentiment >= 0.2 ? 'bg-bull' : post.sentiment <= -0.2 ? 'bg-bear' : 'bg-neutral'
  return (
    <div className="bg-surface border border-slate-700/50 rounded-lg overflow-hidden hover:bg-card-hover transition-colors">
      <div className="flex">
        <div className={clsx('w-[3px] flex-shrink-0', sentColor || 'bg-slate-700')} />
        <div className="flex-1 px-3 py-3">
          <div className="flex items-center gap-2 mb-1.5">
            <span className="text-xs bg-slate-700 text-neutral px-2 py-0.5 rounded capitalize">{post.platform}</span>
            <span className="text-xs text-neutral">@{post.author}</span>
            {post.ticker && <span className="text-xs font-mono font-bold text-accent bg-accent/10 px-2 py-0.5 rounded">{post.ticker}</span>}
            <span className="ml-auto meta">{formatTime(post.created_at)}</span>
          </div>
          <p className="text-sm text-slate-200 leading-relaxed">{post.content}</p>
          {post.sentiment != null && (
            <div className="mt-1.5 text-xs text-neutral">
              sentiment: <span className={post.sentiment >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                {post.sentiment >= 0 ? '+' : ''}{post.sentiment.toFixed(2)}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
