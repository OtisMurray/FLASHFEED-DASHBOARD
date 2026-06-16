
interface HealthItem {
  name: string
  status: 'healthy' | 'degraded' | 'down'
  last_seen?: string
}

interface Props { health: HealthItem[] }

export function SubredditHealth({ health }: Props) {
  if (health.length === 0) return null

  const colors: Record<string, string> = {
    healthy: 'bg-emerald-500',
    degraded: 'bg-orange-500',
    down: 'bg-red-500',
  }

  return (
    <div className="bg-surface border border-border rounded-lg overflow-hidden">
      <div className="px-3 py-2 border-b border-border">
        <span className="text-[10px] uppercase tracking-wide text-neutral font-medium">Subreddit Health</span>
      </div>
      <div className="p-2 space-y-1">
        {health.map(h => (
          <div key={h.name} className="flex items-center gap-2 px-2 py-1">
            <span className={`w-2 h-2 rounded-full flex-shrink-0 ${colors[h.status] ?? 'bg-slate-500'}`} />
            <span className="text-xs text-neutral flex-1 truncate">{h.name}</span>
            <span className="text-[10px] text-neutral capitalize">{h.status}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
