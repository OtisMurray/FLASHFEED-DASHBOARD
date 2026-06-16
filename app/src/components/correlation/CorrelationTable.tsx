import { useState } from 'react'
import { CorrelationRow } from './CorrelationRow'
import type { CorrelationEntry } from '@/lib/types'
import { downloadCSV } from '@/hooks/useCSVExport'
import { TableSkeleton } from '@/components/shared/Skeleton'

interface Props { entries: CorrelationEntry[]; isLoading?: boolean }

export function CorrelationTable({ entries, isLoading }: Props) {
  const [sort, setSort] = useState<{ key: keyof CorrelationEntry; dir: 'asc' | 'desc' }>({ key: 'correlation', dir: 'desc' })

  if (isLoading) return <TableSkeleton rows={6} cols={7} />
  if (entries.length === 0) return (
    <div className="text-center py-12 text-neutral">
      <div className="text-3xl mb-2">📊</div>
      <div className="text-sm">No correlation data available</div>
    </div>
  )

  const sorted = [...entries].sort((a, b) => {
    const av = Number(a[sort.key] ?? 0)
    const bv = Number(b[sort.key] ?? 0)
    if (isNaN(av) || isNaN(bv)) {
      return sort.dir === 'desc' ? String(bv).localeCompare(String(av)) : String(av).localeCompare(String(bv))
    }
    return sort.dir === 'desc' ? bv - av : av - bv
  })

  const handleExport = () => {
    const exportData = sorted.map(e => ({
      TICKER: e.ticker,
      'ALIGN SCORE': e.correlation,
      PRICE: e.price,
      'CHG%': e.change_pct,
      SENT: e.combined_sentiment,
      EVIDENCE: e.sample_size,
      REL: e.reliability_weight,
    }))
    downloadCSV(exportData, 'correlation')
  }

  return (
    <div className="bg-surface border border-border rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="text-xs text-neutral">{entries.length} results</span>
        <button
          onClick={handleExport}
          disabled={entries.length === 0}
          className="px-2 py-1 text-xs rounded border border-border text-neutral hover:text-white hover:border-accent disabled:opacity-50 transition-colors"
          title="Export to CSV"
        >
          📥 Export CSV
        </button>
      </div>
      <table className="w-full text-sm">
        <thead className="border-b border-border">
          <tr>
            {[
              { key: 'ticker' as keyof CorrelationEntry, label: 'TICKER' },
              { key: 'correlation' as keyof CorrelationEntry, label: 'ALIGN SCORE' },
              { key: 'price' as keyof CorrelationEntry, label: 'PRICE' },
              { key: 'change_pct' as keyof CorrelationEntry, label: 'CHG%' },
              { key: 'combined_sentiment' as keyof CorrelationEntry, label: 'SENT' },
              { key: 'sample_size' as keyof CorrelationEntry, label: 'EVIDENCE' },
              { key: 'reliability_weight' as keyof CorrelationEntry, label: 'REL' },
            ].map(({ key, label }) => (
              <th key={key} onClick={() => setSort(s => ({ key, dir: s.key === key && s.dir === 'desc' ? 'asc' : 'desc' }))}
                className="px-3 py-2 text-left label cursor-pointer hover:text-neutral select-none">
                {label} {sort.key === key ? (sort.dir === 'desc' ? '↓' : '↑') : ''}
              </th>
            ))}
            <th className="px-3 py-2 label">VISUAL</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map(e => <CorrelationRow key={e.ticker} entry={e} />)}
        </tbody>
      </table>
    </div>
  )
}
