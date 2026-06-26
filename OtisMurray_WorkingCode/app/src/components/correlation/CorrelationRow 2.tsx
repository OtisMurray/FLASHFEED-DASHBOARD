import type { CorrelationEntry } from '@/lib/types'
import { CorrelationBar } from './CorrelationBar'
import { clsx } from 'clsx'

export function CorrelationRow({ entry: e }: { entry: CorrelationEntry }) {
  const quoteTs = typeof e.quote_updated_at === 'number' ? e.quote_updated_at : Number(e.quote_updated_at || 0)
  const quoteAge = quoteTs
    ? Math.max(0, Math.floor(Date.now() / 1000) - (quoteTs > 1_000_000_000_000 ? Math.floor(quoteTs / 1000) : quoteTs))
    : null
  const quoteAgeLabel = quoteAge == null
    ? 'no quote time'
    : quoteAge < 3600
      ? `${Math.floor(quoteAge / 60)}m old`
      : `${Math.floor(quoteAge / 3600)}h old`

  return (
    <tr className="border-b border-slate-700/30 hover:bg-card-hover transition-colors">
      <td className="px-3 py-2.5">
        <span className="font-mono font-bold text-accent text-xs">{e.ticker}</span>
      </td>
      <td className={clsx('px-3 py-2.5 font-mono text-xs', e.correlation >= 0 ? 'text-emerald-400' : 'text-red-400')}>
        {e.correlation >= 0 ? '+' : ''}{e.correlation.toFixed(3)}
      </td>
      <td className="px-3 py-2.5 font-mono text-xs text-slate-200">{e.price == null ? '—' : `$${e.price.toFixed(2)}`}</td>
      <td className={clsx('px-3 py-2.5 font-mono text-xs', (e.change_pct ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400')}>
        {e.change_pct == null ? '—' : `${e.change_pct >= 0 ? '+' : ''}${e.change_pct.toFixed(2)}%`}
      </td>
      <td className={clsx('px-3 py-2.5 font-mono text-xs', (e.combined_sentiment ?? e.news_sentiment ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400')}>
        {e.combined_sentiment == null ? '—' : `${e.combined_sentiment >= 0 ? '+' : ''}${e.combined_sentiment.toFixed(3)}`}
      </td>
      <td className="px-3 py-2.5 font-mono text-xs text-neutral">
        <div>{e.sample_size}</div>
        <div className="text-[10px] text-slate-500">{e.article_count ?? 0} news · {e.social_count ?? 0} social</div>
      </td>
      <td className="px-3 py-2.5 font-mono text-xs text-neutral">{e.reliability_weight == null ? '—' : e.reliability_weight.toFixed(2)}</td>
      <td className="px-3 py-2.5">
        <div className="space-y-1">
          <CorrelationBar value={e.correlation} />
          <div className="text-[10px] text-neutral whitespace-nowrap">{e.quote_source || 'quote'} · {quoteAgeLabel}</div>
        </div>
      </td>
    </tr>
  )
}
