import { useState } from 'react'
import { CorrelationRow } from './CorrelationRow'
import type { CorrelationEntry } from '@/lib/types'

interface Props { entries: CorrelationEntry[] }

export function CorrelationTable({ entries }: Props) {
  const [sort, setSort] = useState<{ key: keyof CorrelationEntry; dir: 'asc' | 'desc' }>({ key: 'correlation', dir: 'desc' })

  const sorted = [...entries].sort((a, b) => {
    const av = a[sort.key] ?? 0
    const bv = b[sort.key] ?? 0
    if (typeof av === 'string' || typeof bv === 'string') {
      return sort.dir === 'desc' ? String(bv).localeCompare(String(av)) : String(av).localeCompare(String(bv))
    }
    return sort.dir === 'desc' ? bv - av : av - bv
  })

  return (
    <div className="bg-surface border border-border rounded-lg overflow-hidden">
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
