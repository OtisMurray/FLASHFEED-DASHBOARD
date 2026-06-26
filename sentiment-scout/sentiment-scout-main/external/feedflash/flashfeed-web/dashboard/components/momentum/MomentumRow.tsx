'use client'
import type { MomentumRow } from '@/lib/types'
import { MiniSparkline } from './MiniSparkline'
import useSWR from 'swr'
import { clsx } from 'clsx'

const fetcher = (url: string) => fetch(url).then(r => r.json())

export function MomentumRow({ row }: { row: MomentumRow }) {
  const { data } = useSWR(`/api/charts/${row.ticker}?range=1mo&interval=1d`, fetcher)
  const prices: number[] = data?.candles?.slice(-7).map((c: any) => c.close) ?? []
  const chg = row.change_pct ?? 0
  const sent = row.sentiment ?? 0

  return (
    <tr className="border-b border-slate-700/30 hover:bg-card-hover transition-colors">
      <td className="px-3 py-2.5">
        <span className="font-mono font-bold text-accent text-xs">{row.ticker}</span>
      </td>
      <td className="px-3 py-2.5 text-neutral text-xs max-w-[120px] truncate">{row.company ?? '—'}</td>
      <td className="px-3 py-2.5 text-white font-mono text-xs">
        {row.price != null ? `$${row.price.toFixed(2)}` : '—'}
      </td>
      <td className={clsx('px-3 py-2.5 font-mono text-xs', chg >= 0 ? 'text-emerald-400' : 'text-red-400')}>
        {chg >= 0 ? '+' : ''}{chg.toFixed(2)}%
      </td>
      <td className="px-3 py-2.5 text-neutral font-mono text-xs">
        {row.volume != null ? (row.volume >= 1e6 ? `${(row.volume / 1e6).toFixed(1)}M` : `${(row.volume / 1e3).toFixed(0)}K`) : '—'}
      </td>
      <td className={clsx('px-3 py-2.5 font-mono text-xs', sent >= 0 ? 'text-emerald-400' : 'text-red-400')}>
        {sent >= 0 ? '+' : ''}{sent.toFixed(2)}
      </td>
      <td className="px-3 py-2.5">
        <MiniSparkline prices={prices} />
      </td>
    </tr>
  )
}
