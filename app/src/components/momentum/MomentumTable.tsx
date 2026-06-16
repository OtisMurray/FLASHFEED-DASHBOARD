import { useState } from 'react'
import { MomentumRow } from './MomentumRow'
import type { MomentumRow as MR } from '@/lib/types'
import { downloadCSV } from '@/hooks/useCSVExport'
import { TableSkeleton } from '@/components/shared/Skeleton'

interface Props { rows: MR[]; isLoading: boolean }

export function MomentumTable({ rows, isLoading }: Props) {
  const [sort, setSort] = useState<{ key: keyof MR; dir: 'asc' | 'desc' }>({ key: 'sentiment', dir: 'desc' })

  const sorted = [...rows].sort((a, b) => {
    const av = (a[sort.key] as number) ?? 0
    const bv = (b[sort.key] as number) ?? 0
    return sort.dir === 'desc' ? bv - av : av - bv
  })

  const toggle = (key: keyof MR) => setSort(s => ({ key, dir: s.key === key && s.dir === 'desc' ? 'asc' : 'desc' }))
  const arrow = (key: keyof MR) => sort.key === key ? (sort.dir === 'desc' ? ' ↓' : ' ↑') : ''

  if (isLoading) return <TableSkeleton rows={8} cols={6} />

  const handleExport = () => {
    const exportData = sorted.map(row => ({
      TICKER: row.ticker,
      COMPANY: row.company,
      PRICE: row.price,
      'CHANGE%': row.change_pct,
      VOL: row.volume,
      SENT: row.sentiment,
    }))
    downloadCSV(exportData, 'momentum')
  }

  return (
    <div className="bg-surface border border-border rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="text-xs text-neutral">{rows.length} results</span>
        <button
          onClick={handleExport}
          disabled={rows.length === 0}
          className="px-2 py-1 text-xs rounded border border-border text-neutral hover:text-white hover:border-accent disabled:opacity-50 transition-colors"
          title="Export to CSV"
        >
          📥 Export CSV
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-border">
            <tr>
              {[
                { key: 'ticker' as keyof MR, label: 'TICKER' },
                { key: 'company' as keyof MR, label: 'COMPANY' },
                { key: 'price' as keyof MR, label: 'PRICE' },
                { key: 'change_pct' as keyof MR, label: 'CHANGE%' },
                { key: 'volume' as keyof MR, label: 'VOL' },
                { key: 'sentiment' as keyof MR, label: 'SENT' },
              ].map(({ key, label }) => (
                <th key={key} onClick={() => toggle(key)}
                  className="px-3 py-2 text-left label cursor-pointer hover:text-neutral select-none whitespace-nowrap">
                  {label}{arrow(key)}
                </th>
              ))}
              <th className="px-3 py-2 label">7D TREND</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map(row => <MomentumRow key={row.ticker} row={row} />)}
          </tbody>
        </table>
      </div>
    </div>
  )
}
