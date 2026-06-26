'use client'
import { useState } from 'react'
import { CorrelationRow } from './CorrelationRow'
import type { CorrelationEntry } from '@/lib/types'

interface Props { entries: CorrelationEntry[] }

export function CorrelationTable({ entries }: Props) {
  const [sort, setSort] = useState<{ key: keyof CorrelationEntry; dir: 'asc' | 'desc' }>({ key: 'correlation', dir: 'desc' })

  const sorted = [...entries].sort((a, b) => {
    const av = a[sort.key] as number ?? 0
    const bv = b[sort.key] as number ?? 0
    return sort.dir === 'desc' ? bv - av : av - bv
  })

  return (
    <div className="bg-surface border border-border rounded-lg overflow-hidden">
      <table className="w-full text-sm">
        <thead className="border-b border-border">
          <tr>
            {[
              { key: 'ticker' as keyof CorrelationEntry, label: 'TICKER' },
              { key: 'correlation' as keyof CorrelationEntry, label: 'CORRELATION' },
              { key: 'p_value' as keyof CorrelationEntry, label: 'P-VALUE' },
              { key: 'sample_size' as keyof CorrelationEntry, label: 'SAMPLES' },
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
