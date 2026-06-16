import useSWR from 'swr'
import { CorrelationTable } from './CorrelationTable'
import { EmptyState } from './EmptyState'
import { RunButton } from './RunButton'
import type { CorrelationEntry } from '@/lib/types'

const fetcher = (url: string) => fetch(url).then(r => r.json())

export function CorrelationPage() {
  const { data, isLoading, mutate } = useSWR('/api/correlation', fetcher, { refreshInterval: 60_000 })
  const entries: CorrelationEntry[] = data?.entries ?? []
  const summary = data?.summary
  const pearsonR = summary?.pearson_correlation ?? null
  const directionalRate = summary?.directional_alignment_rate ?? null
  const pearsonStats = summary?.pearson_stats
  const avgSignal = summary?.avg_abs_alignment ?? (
    entries.length ? entries.reduce((sum, row) => sum + Math.abs(row.correlation || 0), 0) / entries.length : 0
  )
  const fallbackReliable = entries.filter(row => Number(row.evidence_count ?? row.sample_size ?? 0) >= 3 && Number(row.reliability_weight ?? 0) >= 0.15).length
  const reliableRows = summary?.reliable_rows ?? fallbackReliable
  const thinRows = summary?.thin_rows ?? Math.max(0, entries.length - fallbackReliable)

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-white font-semibold text-lg">Correlation</h1>
          {typeof data?.accuracy?.accuracy_1h === 'number' && typeof data?.accuracy?.accuracy_24h === 'number' && (
            <div className="text-neutral text-xs mt-0.5">
              1h accuracy: {(data.accuracy.accuracy_1h * 100).toFixed(1)}% · 24h accuracy: {(data.accuracy.accuracy_24h * 100).toFixed(1)}%
            </div>
          )}
          <div className="text-neutral text-xs mt-0.5">
            Rows are evidence-weighted alignment signals. Pearson r is calculated only across reliable ticker rows, so values near 0 can be a valid weak relationship reading.
          </div>
          {summary?.interpretation && (
            <div className="text-slate-400 text-xs mt-0.5">{summary.interpretation}</div>
          )}
        </div>
        <RunButton onComplete={() => mutate()} />
      </div>
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mb-4">
        <Metric label="Signals" value={String(entries.length)} />
        <Metric
          label="Pearson r"
          value={pearsonR == null ? '--' : pearsonR.toFixed(3)}
          tone="text-yellow-300"
          subvalue={summary?.raw_sentiment_pearson == null ? undefined : `raw sent ${summary.raw_sentiment_pearson.toFixed(3)}`}
        />
        <Metric label="Dir Align" value={directionalRate == null ? '--' : `${(directionalRate * 100).toFixed(1)}%`} tone="text-emerald-300" />
        <Metric label="Avg |Signal|" value={avgSignal == null ? '--' : avgSignal.toFixed(3)} tone="text-indigo-300" />
        <Metric
          label="Reliable / Thin"
          value={`${reliableRows}/${thinRows}`}
          subvalue={pearsonStats?.effective_n ? `price n ${summary?.price_valid_rows ?? pearsonStats.n} · eff n ${pearsonStats.effective_n}` : undefined}
        />
      </div>
      {isLoading
        ? <div className="text-neutral text-sm animate-pulse p-4">Loading correlation data...</div>
        : entries.length === 0
          ? <EmptyState onRun={() => mutate()} />
          : <CorrelationTable entries={entries} />
      }
    </div>
  )
}

function Metric({ label, value, tone = 'text-white', subvalue }: { label: string; value: string; tone?: string; subvalue?: string }) {
  return (
    <div className="bg-surface border border-border rounded-lg px-3 py-2 min-w-0">
      <div className={`font-mono text-lg font-semibold truncate ${tone}`}>{value}</div>
      <div className="text-[10px] uppercase text-neutral mt-0.5">{label}</div>
      {subvalue && <div className="text-[10px] text-slate-500 mt-0.5">{subvalue}</div>}
    </div>
  )
}
