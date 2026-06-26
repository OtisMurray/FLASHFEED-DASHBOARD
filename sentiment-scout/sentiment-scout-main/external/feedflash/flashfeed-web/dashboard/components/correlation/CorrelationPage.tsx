'use client'
import useSWR from 'swr'
import { CorrelationTable } from './CorrelationTable'
import { EmptyState } from './EmptyState'
import { RunButton } from './RunButton'
import type { CorrelationEntry } from '@/lib/types'

const fetcher = (url: string) => fetch(url).then(r => r.json())

export function CorrelationPage() {
  const { data, isLoading, mutate } = useSWR('/api/correlation', fetcher, { refreshInterval: 60_000 })
  const entries: CorrelationEntry[] = data?.entries ?? []

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-white font-semibold text-lg">Sentiment Correlation</h1>
          {data?.accuracy && (
            <div className="text-neutral text-xs mt-0.5">
              1h accuracy: {(data.accuracy.accuracy_1h * 100).toFixed(1)}% · 24h accuracy: {(data.accuracy.accuracy_24h * 100).toFixed(1)}%
            </div>
          )}
        </div>
        <RunButton onComplete={() => mutate()} />
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
