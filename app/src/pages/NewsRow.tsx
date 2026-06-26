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

function formatTime(ts: number | null | undefined, refTs?: number | null | undefined): string {
  if (!ts) return ''
  const d = new Date(ts * 1000)
  const now = Date.now()
  const refTime = refTs ? new Date(refTs * 1000).getTime() : d.getTime()
  const diff = now - refTime
  if (diff < 60_000) return 'just now'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m`
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h`
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function detectionLagLabel(published: number | null | undefined, detected: number | null | undefined): string {
  if (!published || !detected) return ''
  const lagSeconds = Math.max(0, Math.floor(detected - published))
  if (lagSeconds < 60) return 'detected less than 1m after publish'
  if (lagSeconds < 3600) return `detected ${Math.floor(lagSeconds / 60)}m after publish`
  if (lagSeconds < 86400) return `detected ${Math.floor(lagSeconds / 3600)}h after publish`
  return `detected ${Math.floor(lagSeconds / 86400)}d after publish`
}

function highlightKeywords(text: string, keywords: string[]): React.ReactNode {
  const cleaned = keywords
    .map(k => String(k || '').trim())
    .filter(k => k.length >= 2)

  if (!cleaned.length) return text

  const escapedPatterns = cleaned.map(k => {
    const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

    // Strict matching:
    // SEC should match "SEC" but not "Security" or "Second".
    // FDA should match "FDA" but not inside another word.
    if (/^[A-Za-z0-9]+$/.test(k)) {
      return `\\b${escaped}\\b`
    }

    return escaped
  })

  const regex = new RegExp(`(${escapedPatterns.join('|')})`, 'gi')
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
      {/* Published / detected timing — accurate because detected_at is preserved on first insert */}
      <span
        className="text-[11px] font-mono text-neutral w-[130px] flex-shrink-0 leading-tight"
        title={detectionLagLabel(a.publish_date, a.detected_at)}
      >
        <span className="block text-slate-300">{formatTime(a.publish_date, a.publish_date)}</span>
        {a.detected_at != null && (
          <span className="block text-[10px] text-sky-300">Detected {formatTime(a.detected_at, a.detected_at)}</span>
        )}
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