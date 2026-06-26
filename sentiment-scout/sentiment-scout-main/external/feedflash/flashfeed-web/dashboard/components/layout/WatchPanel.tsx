'use client'
import { useRef, useEffect, useState } from 'react'
import { clsx } from 'clsx'

interface WatchLine { text: string; type: string; ts: number }

interface Props {
  lines: WatchLine[]
  interval: string
  onStop: () => void
  onClear: () => void
}

export function WatchPanel({ lines, interval, onStop, onClear }: Props) {
  const termRef = useRef<HTMLDivElement>(null)
  const [minimized, setMinimized] = useState(false)

  useEffect(() => {
    if (termRef.current && !minimized) {
      termRef.current.scrollTop = termRef.current.scrollHeight
    }
  }, [lines, minimized])

  return (
    <div className="fixed bottom-5 right-5 w-[420px] bg-surface border border-border rounded-lg shadow-2xl z-50 flex flex-col overflow-hidden text-xs">
      {/* Header */}
      <div
        className="flex items-center gap-2 px-3 py-2 bg-bg border-b border-border cursor-pointer"
        onClick={() => setMinimized(m => !m)}
      >
        <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
        <span className="font-semibold text-white flex-1">Watch Mode — Live Feed</span>
        <span className="text-[10px] text-neutral">every {interval}s</span>
        <button
          onClick={e => { e.stopPropagation(); setMinimized(m => !m) }}
          className="text-neutral hover:text-white px-1"
          title={minimized ? 'Expand' : 'Minimize'}
        >
          {minimized ? '+' : '−'}
        </button>
        <button
          onClick={e => { e.stopPropagation(); onStop() }}
          className="bg-red-500/15 text-red-400 px-2 py-0.5 rounded text-[11px] hover:bg-red-500/25"
        >
          Stop
        </button>
      </div>

      {/* Terminal body */}
      {!minimized && (
        <>
          <div ref={termRef} className="max-h-[220px] overflow-y-auto p-2 font-mono text-[11px] leading-relaxed">
            {lines.map((l, i) => (
              <div key={i} className={clsx(
                'py-px whitespace-pre-wrap break-all',
                l.type === 'new' && 'text-emerald-400',
                l.type === 'err' && 'text-red-400',
                l.type === 'info' && 'text-sky-300',
                !l.type && 'text-slate-400',
              )}>
                {l.text}
              </div>
            ))}
          </div>
          <div className="flex gap-2 px-2 py-1.5 border-t border-border">
            <button onClick={onClear} className="text-neutral hover:text-white text-[11px]">Clear</button>
            <span className="text-neutral ml-auto">{lines.length} lines</span>
          </div>
        </>
      )}
    </div>
  )
}
