'use client'
import { useState, useEffect } from 'react'
import { clsx } from 'clsx'
import type { Article } from '@/lib/types'
import { getLanguageLabel, useTargetLanguage, useTranslatedText } from '@/lib/translation'

interface Props {
  article: Article
  keywords: string[]
}

// Price cache (shared across all rows)
const priceCache: Record<string, { price: number; change: number; ts: number }> = {}

function formatTime(ts: number | null): string {
  if (!ts) return ''
  const d = new Date(ts * 1000)
  const now = Date.now()
  const diff = now - d.getTime()
  if (diff < 60_000) return 'just now'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m`
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h`
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function highlightKeywords(text: string, keywords: string[]): React.ReactNode {
  if (!keywords.length) return text
  const pattern = keywords.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  const regex = new RegExp(`(${pattern})`, 'gi')
  const parts = text.split(regex)
  return parts.map((part, i) =>
    regex.test(part)
      ? <mark key={i} className="bg-yellow-500/25 text-yellow-200 px-0.5 rounded">{part}</mark>
      : part
  )
}

export function NewsRow({ article: a, keywords }: Props) {
  const [price, setPrice] = useState<{ price: number; change: number } | null>(null)
  const targetLanguage = useTargetLanguage()
  const { translated, source } = useTranslatedText(a.title, targetLanguage)

  useEffect(() => {
    if (!a.ticker) return
    const cached = priceCache[a.ticker]
    if (cached && Date.now() - cached.ts < 60_000) {
      setPrice(cached)
      return
    }
    fetch(`/api/prices/${a.ticker}`).then(r => r.json()).then(d => {
      if (d.price != null) {
        const entry = { price: d.price, change: d.change_pct ?? 0, ts: Date.now() }
        priceCache[a.ticker!] = entry
        setPrice(entry)
      }
    }).catch(() => {})
  }, [a.ticker])

  const sentColor = a.sentiment === 'bullish' ? 'text-emerald-400' : a.sentiment === 'bearish' ? 'text-red-400' : 'text-slate-400'
  const sentLabel = a.sentiment ? a.sentiment.charAt(0).toUpperCase() + a.sentiment.slice(1) : ''

  return (
    <a
      href={a.url}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-2 px-3 py-2 hover:bg-card-hover transition-colors group cursor-pointer border-l-2 border-transparent hover:border-accent"
    >
      {/* Time */}
      <span className="text-[11px] font-mono text-neutral w-[42px] flex-shrink-0">
        {formatTime(a.publish_date ?? a.fetched_date)}
      </span>

      {/* Source badge */}
      <span className="text-[10px] uppercase font-bold bg-slate-700/70 text-neutral px-1.5 py-0.5 rounded w-[80px] truncate text-center flex-shrink-0">
        {a.source}
      </span>

      {/* Company/Category */}
      {(a.company || a.category) && (
        <span className="text-[11px] text-indigo-400 w-[100px] truncate flex-shrink-0 hidden sm:block">
          {a.company || a.category}
        </span>
      )}

      {/* Title with keyword highlighting */}
      <span className="text-sm text-slate-200 flex-1 min-w-0 group-hover:text-white transition-colors">
        <span className="block truncate">{highlightKeywords(a.title, keywords)}</span>
        {translated && translated !== a.title && (
          <span className="block truncate text-[11px] text-sky-300 mt-0.5">
            {getLanguageLabel(targetLanguage)}: {translated}
            {source === 'glossary' && <span className="text-neutral"> · glossary</span>}
          </span>
        )}
      </span>

      {/* Right-side badges */}
      <div className="flex items-center gap-2 flex-shrink-0">
        {/* Ticker */}
        {a.ticker && (
          <span className="text-[10px] font-mono font-bold text-accent bg-accent/10 px-1.5 py-0.5 rounded">
            {a.ticker}
          </span>
        )}

        {/* Live price */}
        {price && (
          <span className={clsx(
            'text-[10px] font-mono px-1.5 py-0.5 rounded',
            price.change >= 0 ? 'text-emerald-400 bg-emerald-500/10' : 'text-red-400 bg-red-500/10'
          )}>
            ${price.price.toFixed(2)} {price.change >= 0 ? '↑' : '↓'}{Math.abs(price.change).toFixed(1)}%
          </span>
        )}

        {/* Sentiment */}
        {a.sentiment && (
          <span className={clsx('text-[10px] font-medium', sentColor)}>
            {sentLabel}
          </span>
        )}
      </div>
    </a>
  )
}
