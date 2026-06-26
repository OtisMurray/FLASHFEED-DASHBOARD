import useSWR from 'swr'
import { clsx } from 'clsx'

const fetcher = (url: string) => fetch(url).then(r => r.json())

function compact(n: number | null | undefined) {
  if (n == null || Number.isNaN(n)) return '--'
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1)}K`
  return n.toLocaleString()
}

function scoreTone(value: number) {
  if (value > 0.05) return 'text-emerald-400'
  if (value < -0.05) return 'text-red-400'
  return 'text-neutral'
}

type SentimentRow = {
  id?: string
  ticker?: string
  title?: string
  source?: string
  sentiment_score?: number
}

export function SentimentModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data, isLoading } = useSWR(open ? '/api/sentiment/snapshot?limit=5&days=3&window_minutes=1440' : null, fetcher, { refreshInterval: 60_000 })

  if (!open) return null

  const summary = data?.summary ?? {}
  const topPositive: SentimentRow[] = Array.isArray(data?.top_positive) ? data.top_positive.slice(0, 5) : []
  const topNegative: SentimentRow[] = Array.isArray(data?.top_negative) ? data.top_negative.slice(0, 5) : []
  const combinedAvg = Number(summary.combined_avg_sentiment ?? summary.avg_sentiment ?? 0)
  const newsAvg = Number(summary.avg_sentiment ?? 0)
  const socialAvg = Number(summary.social_avg_sentiment ?? 0)
  const sourceCount = Array.isArray(data?.sources) ? data.sources.length : 0

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="bg-surface border border-border rounded-lg w-full max-w-2xl overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div>
            <div className="text-white font-semibold">Sentiment Snapshot</div>
            <div className="text-xs text-neutral">Last 3 days news · 24h social · ticker matched</div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close sentiment snapshot"
            className="h-8 w-8 rounded border border-border text-neutral hover:text-white hover:border-accent"
          >
            ×
          </button>
        </div>

        <div className="p-4 space-y-3">
          {data?.ok === false && (
            <div className="border border-red-500/40 bg-red-500/10 text-red-200 text-sm rounded p-3">
              {data.error || 'Sentiment snapshot failed.'}
            </div>
          )}

          <div className="grid grid-cols-3 gap-2">
            <Metric label="Combined Avg" value={isLoading ? '...' : `${combinedAvg > 0 ? '+' : ''}${combinedAvg.toFixed(3)}`} toneClass={scoreTone(combinedAvg)} />
            <Metric label="News Avg" value={`${newsAvg > 0 ? '+' : ''}${newsAvg.toFixed(3)}`} toneClass={scoreTone(newsAvg)} />
            <Metric label="Social Avg" value={`${socialAvg > 0 ? '+' : ''}${socialAvg.toFixed(3)}`} toneClass={scoreTone(socialAvg)} />
          </div>
          <div className="grid grid-cols-4 gap-2">
            <Metric label="Actionable" value={compact(summary.actionable)} toneClass="text-emerald-300" />
            <Metric label="Tickered News" value={`${compact(summary.ticker_matched)}/${compact(summary.total)}`} />
            <Metric label="Social Posts" value={compact(summary.social_total)} />
            <Metric label="Sources" value={compact(sourceCount)} />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <List title="Top Positive" rows={topPositive} empty="No positive scored headlines." />
            <List title="Top Negative" rows={topNegative} empty="No negative scored headlines." negative />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Breakdown title="Top Sources" rows={data?.sources ?? []} labelKey="source" />
            <Breakdown title="Active Tickers" rows={data?.ticker_breakdown ?? []} labelKey="ticker" />
          </div>
        </div>
      </div>
    </div>
  )
}

function Metric({ label, value, toneClass = 'text-slate-100' }: { label: string; value: string; toneClass?: string }) {
  return (
    <div className="bg-bg/60 border border-border rounded p-3 min-w-0">
      <div className={clsx('font-mono text-lg truncate', toneClass)}>{value}</div>
      <div className="text-[10px] text-neutral uppercase mt-1">{label}</div>
    </div>
  )
}

function Breakdown({ title, rows, labelKey }: { title: string; rows: any[]; labelKey: string }) {
  const list = Array.isArray(rows) ? rows.slice(0, 5) : []
  return (
    <section className="border border-border rounded overflow-hidden">
      <div className="px-3 py-2 border-b border-border bg-bg/40 text-xs font-medium text-white">{title}</div>
      <div className="divide-y divide-slate-700/30">
        {list.length ? list.map(row => {
          const avg = Number(row.avg_sentiment ?? 0)
          return (
            <div key={`${row[labelKey]}-${row.count}`} className="px-3 py-2 flex items-center gap-2 text-xs">
              <span className="text-slate-200 truncate">{row[labelKey] || 'Unknown'}</span>
              <span className="ml-auto text-neutral font-mono">{compact(row.count)}</span>
              <span className={clsx('font-mono w-12 text-right', scoreTone(avg))}>
                {avg > 0 ? '+' : ''}{avg.toFixed(2)}
              </span>
            </div>
          )
        }) : (
          <div className="px-3 py-4 text-sm text-neutral text-center">No rows yet.</div>
        )}
      </div>
    </section>
  )
}

function List({ title, rows, empty, negative = false }: { title: string; rows: SentimentRow[]; empty: string; negative?: boolean }) {
  return (
    <section className="border border-border rounded overflow-hidden">
      <div className="px-3 py-2 border-b border-border bg-bg/40 text-xs font-medium text-white">{title}</div>
      <div className="divide-y divide-slate-700/30">
        {rows.length ? rows.map(row => {
          const score = Number(row.sentiment_score ?? 0)
          return (
            <div key={row.id || row.title} className="px-3 py-2">
              <div className="flex items-center gap-2 text-[11px] mb-1">
                <span className="font-mono text-accent">{row.ticker || '--'}</span>
                <span className="text-neutral truncate">{row.source || 'Source'}</span>
                <span className={clsx('ml-auto font-mono', negative ? 'text-red-400' : 'text-emerald-400')}>
                  {score > 0 ? '+' : ''}{score.toFixed(2)}
                </span>
              </div>
              <div className="text-xs text-slate-200 line-clamp-2">{row.title || 'Untitled headline'}</div>
            </div>
          )
        }) : (
          <div className="px-3 py-5 text-sm text-neutral text-center">{empty}</div>
        )}
      </div>
    </section>
  )
}
