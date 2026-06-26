'use client'
import useSWR from 'swr'
import { Modal } from './Modal'

const fetcher = (url: string) => fetch(url).then(r => r.json())

interface Props {
  ticker: string | null
  onClose: () => void
}

export function TickerDetailModal({ ticker, onClose }: Props) {
  const { data } = useSWR(ticker ? `/api/screener/${ticker}` : null, fetcher)

  if (!ticker) return null

  const info = data ?? {}

  return (
    <Modal open={!!ticker} onClose={onClose} title={`Ticker: ${ticker}`} wide>
      <div className="space-y-4">
        {/* Price section */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <WindowCard label="Price" value={info.price != null ? `$${info.price.toFixed(2)}` : '—'} />
          <WindowCard label="Change" value={info.change_pct != null ? `${info.change_pct >= 0 ? '+' : ''}${info.change_pct.toFixed(2)}%` : '—'}
            color={info.change_pct >= 0 ? 'text-emerald-400' : 'text-red-400'} />
          <WindowCard label="Volume" value={info.volume ? fmtCompact(info.volume) : '—'} />
          <WindowCard label="Avg Vol" value={info.avg_volume ? fmtCompact(info.avg_volume) : '—'} />
        </div>

        {/* Sentiment section */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <WindowCard label="Social Sent." value={info.social_sentiment != null ? info.social_sentiment.toFixed(2) : '—'}
            color={info.social_sentiment >= 0.2 ? 'text-emerald-400' : info.social_sentiment <= -0.2 ? 'text-red-400' : 'text-neutral'} />
          <WindowCard label="News Sent." value={info.structured_sentiment != null ? info.structured_sentiment.toFixed(2) : '—'} />
          <WindowCard label="Messages" value={info.message_count != null ? String(info.message_count) : '—'} />
          <WindowCard label="News Count" value={info.news_article_count != null ? String(info.news_article_count) : '—'} />
        </div>

        {/* Company info */}
        {(info.company || info.sector || info.industry) && (
          <div className="bg-bg border border-border rounded-lg p-3 space-y-1">
            {info.company && <div className="text-sm text-white">{info.company}</div>}
            {info.sector && <div className="text-xs text-neutral">Sector: {info.sector}</div>}
            {info.industry && <div className="text-xs text-neutral">Industry: {info.industry}</div>}
          </div>
        )}

        {/* Recent posts */}
        {info.recent_posts && info.recent_posts.length > 0 && (
          <div>
            <div className="text-xs text-neutral uppercase tracking-wide mb-2">Recent Social Posts</div>
            <div className="space-y-1 max-h-[200px] overflow-y-auto">
              {info.recent_posts.map((p: any, i: number) => (
                <div key={i} className="bg-bg border border-border rounded px-3 py-2">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-[10px] bg-slate-700 text-neutral px-1.5 py-0.5 rounded capitalize">{p.platform}</span>
                    <span className="text-[10px] text-neutral">@{p.author}</span>
                    {p.sentiment != null && (
                      <span className={`text-[10px] ml-auto ${p.sentiment >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        {p.sentiment >= 0 ? '+' : ''}{p.sentiment.toFixed(2)}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-slate-300 line-clamp-2">{p.content}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="flex justify-end">
          <a href={`/charts?ticker=${ticker}`} className="text-xs text-accent hover:text-sky-300 transition-colors">
            Open Charts →
          </a>
        </div>
      </div>
    </Modal>
  )
}

function WindowCard({ label, value, color = 'text-white' }: { label: string; value: string; color?: string }) {
  return (
    <div className="bg-bg border border-border rounded-lg px-3 py-2">
      <div className="text-[10px] text-neutral uppercase tracking-wide mb-0.5">{label}</div>
      <div className={`text-sm font-mono font-bold ${color}`}>{value}</div>
    </div>
  )
}

function fmtCompact(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`
  return String(n)
}
