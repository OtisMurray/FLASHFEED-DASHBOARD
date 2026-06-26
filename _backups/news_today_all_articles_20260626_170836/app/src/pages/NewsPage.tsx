'use client'
import useSWR from 'swr'
import { useState, useMemo } from 'react'
import { NewsRow } from './NewsRow'
import { NewsSidebar } from './NewsSidebar'
import { ArticleFilters } from './ArticleFilters'
import type { Article } from '@/lib/types'

const fetcher = (url: string) => fetch(url).then(r => r.json())

export function NewsPage() {
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [page, setPage] = useState(0)
  const [keywordsOnly, setKeywordsOnly] = useState(false)
  const [moversOnly, setMoversOnly] = useState(false)
  const limit = 30

  const params = new URLSearchParams({ ...filters, limit: String(limit), offset: String(page * limit) })
  if (keywordsOnly) params.set('keywords_only', '1')
  if (moversOnly) params.set('mover_only', '1')
  const { data, isLoading } = useSWR(`/api/articles?${params}`, fetcher, { refreshInterval: 15_000 })
  const { data: stats } = useSWR('/api/stats', fetcher, { refreshInterval: 30_000 })
  const { data: kwData } = useSWR('/api/keywords', fetcher)

  const articles: Article[] = data?.articles ?? []
  const total: number = data?.total ?? 0
  const sources: Array<{ source: string; count: number }> = stats?.sources ?? []
  const categories: Array<{ category: string; count: number }> = stats?.categories ?? []
  const keywords: string[] = useMemo(() => (kwData?.keywords ?? []).map((k: any) => k.keyword || k), [kwData])

  const setFilter = (key: string, value: string) => {
    setPage(0)
    if (value) setFilters(f => ({ ...f, [key]: value }))
    else setFilters(f => { const n = { ...f }; delete n[key]; return n })
  }

  return (
    <div className="flex gap-4 max-w-full">
      {/* Sidebar */}
      <NewsSidebar
        sources={sources}
        categories={categories}
        activeSource={filters.source}
        activeCategory={filters.category}
        onSelectSource={s => setFilter('source', filters.source === s ? '' : s)}
        onSelectCategory={c => setFilter('category', filters.category === c ? '' : c)}
      />

      {/* Main content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-3">
            <h1 className="text-white font-semibold text-lg">News Feed</h1>
            <span className="text-neutral text-sm">{total.toLocaleString()} articles</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => { setKeywordsOnly(!keywordsOnly); setPage(0) }}
              className={`text-xs px-2.5 py-1 rounded border transition-colors ${
                keywordsOnly
                  ? 'bg-yellow-500/15 border-yellow-500/40 text-yellow-400'
                  : 'bg-surface border-border text-neutral hover:text-white'
              }`}
            >
              Keywords Only
            </button>
            <button
              onClick={() => { setMoversOnly(!moversOnly); setPage(0) }}
              className={`text-xs px-2.5 py-1 rounded border transition-colors ${
                moversOnly
                  ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-400'
                  : 'bg-surface border-border text-neutral hover:text-white'
              }`}
            >
              Movers Only
            </button>
          </div>
        </div>

        <ArticleFilters filters={filters} onChange={f => { setFilters(f); setPage(0) }} />

        {/* Compact news rows */}
        <div className="mt-3 bg-surface border border-border rounded-lg overflow-hidden">
          {isLoading ? (
            <div className="p-4 text-neutral text-sm animate-pulse">Loading articles...</div>
          ) : articles.length === 0 ? (
            <div className="p-8 text-center text-neutral">
              <div className="text-3xl mb-2">📰</div>
              <div className="text-sm">No articles yet. Click Fetch to load news.</div>
            </div>
          ) : (
            <div className="divide-y divide-slate-700/30">
              {articles.map(a => (
                <NewsRow key={a.id} article={a} keywords={keywords} />
              ))}
            </div>
          )}
        </div>

        {/* Pagination */}
        {total > limit && (
          <div className="flex items-center justify-between mt-4">
            <span className="text-xs text-neutral">
              {page * limit + 1}–{Math.min((page + 1) * limit, total)} of {total}
            </span>
            <div className="flex gap-1">
              <button
                disabled={page === 0}
                onClick={() => setPage(p => p - 1)}
                className="px-3 py-1 text-xs bg-surface border border-border rounded text-neutral disabled:opacity-40 hover:text-white transition-colors"
              >Prev</button>
              {Array.from({ length: Math.min(7, Math.ceil(total / limit)) }, (_, i) => {
                const totalPages = Math.ceil(total / limit)
                let pageNum: number
                if (totalPages <= 7) pageNum = i
                else if (page < 4) pageNum = i
                else if (page >= totalPages - 4) pageNum = totalPages - 7 + i
                else pageNum = page - 3 + i
                return (
                  <button
                    key={pageNum}
                    onClick={() => setPage(pageNum)}
                    className={`w-7 h-7 text-xs rounded transition-colors ${
                      page === pageNum
                        ? 'bg-accent text-white'
                        : 'bg-surface border border-border text-neutral hover:text-white'
                    }`}
                  >
                    {pageNum + 1}
                  </button>
                )
              })}
              <button
                disabled={(page + 1) * limit >= total}
                onClick={() => setPage(p => p + 1)}
                className="px-3 py-1 text-xs bg-surface border border-border rounded text-neutral disabled:opacity-40 hover:text-white transition-colors"
              >Next</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
