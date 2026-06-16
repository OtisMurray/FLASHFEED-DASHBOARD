import type { CorrelationEntry } from '@/lib/types'
import { CorrelationBar } from './CorrelationBar'
import { clsx } from 'clsx'

export function CorrelationRow({ entry: e }: { entry: CorrelationEntry }) {
  return (
    <tr className="border-b border-slate-700/30 hover:bg-card-hover transition-colors">
      <td className="px-3 py-2.5">
        <span className="font-mono font-bold text-accent text-xs">{e.ticker}</span>
      </td>
      <td className={clsx('px-3 py-2.5 font-mono text-xs', e.correlation >= 0 ? 'text-emerald-400' : 'text-red-400')}>
        {e.correlation >= 0 ? '+' : ''}{e.correlation.toFixed(3)}
      </td>
      <td className="px-3 py-2.5 font-mono text-xs text-neutral">{e.p_value.toFixed(3)}</td>
      <td className="px-3 py-2.5 font-mono text-xs text-neutral">{e.sample_size}</td>
      <td className="px-3 py-2.5">
        <CorrelationBar value={e.correlation} />
      </td>
    </tr>
  )
}
