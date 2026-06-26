interface Props { phrases: Array<{ phrase: string; count: number }> }

export function TrendingPhrases({ phrases }: Props) {
  return (
    <div className="bg-surface border border-border rounded-lg p-3">
      <h2 className="label mb-3">Trending Phrases</h2>
      {phrases.length === 0
        ? <p className="text-neutral text-xs">No trending phrases</p>
        : (
          <div className="flex flex-wrap gap-1.5">
            {phrases.slice(0, 20).map((p, i) => (
              <span key={i} className="text-xs bg-slate-700 text-neutral px-2 py-1 rounded" style={{ opacity: 0.5 + 0.5 * (1 - i / 20) }}>
                {p.phrase} {p.count > 1 && <span className="text-accent">{p.count}</span>}
              </span>
            ))}
          </div>
        )
      }
    </div>
  )
}
