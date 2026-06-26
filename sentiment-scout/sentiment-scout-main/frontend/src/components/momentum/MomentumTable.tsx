import { useState } from 'react'
import { MomentumRow } from './MomentumRow'
import type { MomentumRow as MR } from '@/lib/types'

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

  if (isLoading) return <div className="text-neutral text-sm animate-pulse p-4">Loading momentum data...</div>

  return (
    <div className="bg-surface border border-border rounded-lg overflow-hidden">
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
