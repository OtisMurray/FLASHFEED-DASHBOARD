'use client'
import useSWR from 'swr'
import { useState } from 'react'
import { clsx } from 'clsx'

const fetcher = (url: string) => fetch(url).then(r => r.json())

export function LogsTab() {
  const [source, setSource] = useState<'feedflash' | 'server'>('feedflash')
  const endpoint = source === 'feedflash' ? '/api/logs?lines=200' : '/api/weblog?lines=200'
  const { data, mutate } = useSWR(endpoint, fetcher, { refreshInterval: 10_000 })

  const logs: string[] = data?.logs ?? []

  return (
    <div>
      <div className="flex items-center gap-3 mb-3">
        <div className="flex gap-1">
          {(['feedflash', 'server'] as const).map(s => (
            <button key={s} onClick={() => setSource(s)}
              className={clsx('px-3 py-1.5 text-xs rounded transition-colors',
                source === s ? 'bg-accent text-white' : 'bg-surface border border-border text-neutral hover:text-white'
              )}>
              {s === 'feedflash' ? 'feedflash.log' : 'server.log'}
            </button>
          ))}
        </div>
        <button onClick={() => mutate()}
          className="px-3 py-1.5 text-xs bg-surface border border-border text-neutral rounded hover:text-white transition-colors">
          Refresh
        </button>
        <span className="text-xs text-neutral ml-auto">{logs.length} lines</span>
      </div>
      <div className="bg-bg border border-border rounded-lg p-3 h-[500px] overflow-y-auto font-mono text-xs text-slate-400">
        {logs.length === 0 ? (
          <div className="text-neutral text-center py-8">No logs available</div>
        ) : (
          logs.map((line, i) => (
            <div key={i} className={clsx(
              'py-0.5 whitespace-pre-wrap break-all',
              line.includes('ERROR') && 'text-red-400',
              line.includes('WARN') && 'text-yellow-400',
              line.includes('INFO') && 'text-slate-300',
            )}>
              {line}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
