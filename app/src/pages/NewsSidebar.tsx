'use client'
import { clsx } from 'clsx'

interface Props {
  sources: Array<{ source: string; count: number }>
  categories: Array<{ category: string; count: number }>
  activeSource?: string
  activeCategory?: string
  onSelectSource: (s: string) => void
  onSelectCategory: (c: string) => void
}

function categoryLabel(category: string) {
  const normalized = String(category || '').toLowerCase()
  if (normalized === 'filings' || normalized === 'sec_filing') return 'SEC Filings'
  return category
}

export function NewsSidebar({ sources, categories, activeSource, activeCategory, onSelectSource, onSelectCategory }: Props) {
  const sortedCategories = [...categories].sort((a, b) => {
    const aIsFiling = ['filings', 'sec_filing'].includes(String(a.category || '').toLowerCase())
    const bIsFiling = ['filings', 'sec_filing'].includes(String(b.category || '').toLowerCase())
    if (aIsFiling !== bIsFiling) return aIsFiling ? -1 : 1
    return Number(b.count || 0) - Number(a.count || 0)
  })

  return (
    <aside className="w-[180px] flex-shrink-0 hidden lg:block space-y-4">
      {/* Sources */}
      <div className="bg-surface border border-border rounded-lg overflow-hidden">
        <div className="px-3 py-2 border-b border-border">
          <span className="text-[10px] uppercase tracking-wide text-neutral font-medium">Sources</span>
        </div>
        <div className="max-h-[220px] overflow-y-auto">
          <button
            onClick={() => onSelectSource('')}
            className={clsx(
              'w-full text-left px-3 py-1.5 text-xs transition-colors flex items-center justify-between',
              !activeSource ? 'text-white bg-slate-700/40' : 'text-neutral hover:text-white hover:bg-slate-800'
            )}
          >
            <span>All Feeds</span>
          </button>
          {sources.map(s => (
            <button
              key={s.source}
              onClick={() => onSelectSource(s.source)}
              className={clsx(
                'w-full text-left px-3 py-1.5 text-xs transition-colors flex items-center justify-between',
                activeSource === s.source ? 'text-white bg-slate-700/40' : 'text-neutral hover:text-white hover:bg-slate-800'
              )}
            >
              <span className="truncate">{s.source}</span>
              <span className="text-[10px] font-mono text-neutral ml-1">{s.count}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Categories */}
      {categories.length > 0 && (
        <div className="bg-surface border border-border rounded-lg overflow-hidden">
          <div className="px-3 py-2 border-b border-border">
            <span className="text-[10px] uppercase tracking-wide text-neutral font-medium">Categories</span>
          </div>
          <div className="max-h-[180px] overflow-y-auto">
            <button
              onClick={() => onSelectCategory('')}
              className={clsx(
                'w-full text-left px-3 py-1.5 text-xs transition-colors flex items-center justify-between',
                !activeCategory ? 'text-white bg-slate-700/40' : 'text-neutral hover:text-white hover:bg-slate-800'
              )}
            >
              <span>All Categories</span>
            </button>
            {sortedCategories.map(c => (
              <button
                key={c.category}
                onClick={() => onSelectCategory(c.category)}
                className={clsx(
                  'w-full text-left px-3 py-1.5 text-xs transition-colors flex items-center justify-between',
                  activeCategory === c.category ? 'text-white bg-slate-700/40' : 'text-neutral hover:text-white hover:bg-slate-800'
                )}
              >
                <span className="truncate">{categoryLabel(c.category)}</span>
                <span className="text-[10px] font-mono text-neutral ml-1">{c.count}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </aside>
  )
}
