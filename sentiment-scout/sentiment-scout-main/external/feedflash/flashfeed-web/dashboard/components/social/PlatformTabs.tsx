'use client'
import { clsx } from 'clsx'

const PLATFORMS = [
  { id: 'all', label: 'All' },
  { id: 'reddit', label: 'Reddit' },
  { id: 'bluesky', label: 'Bluesky' },
  { id: 'twitter', label: 'Twitter' },
  { id: 'stocktwits', label: 'StockTwits' },
]

interface Props { active: string; onChange: (p: string) => void }

export function PlatformTabs({ active, onChange }: Props) {
  return (
    <div className="flex gap-1 border-b border-border">
      {PLATFORMS.map(p => (
        <button
          key={p.id}
          onClick={() => onChange(p.id)}
          className={clsx(
            'px-3 py-2 text-sm transition-colors border-b-2 -mb-px',
            active === p.id
              ? 'text-white border-accent'
              : 'text-neutral border-transparent hover:text-white'
          )}
        >
          {p.label}
        </button>
      ))}
    </div>
  )
}
