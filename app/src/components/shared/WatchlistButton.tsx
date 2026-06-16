import { useWatchlist } from '@/hooks/useWatchlist'
import { useState } from 'react'

export function WatchlistButton({ ticker }: { ticker: string }) {
  const { isWatched, toggle } = useWatchlist()
  const [showList, setShowList] = useState(false)
  const watched = isWatched(ticker)

  return (
    <div className="relative">
      <button
        onClick={() => toggle(ticker)}
        className={`px-2 py-1 text-xs rounded border transition-colors ${
          watched
            ? 'bg-accent/20 border-accent text-accent'
            : 'border-border text-neutral hover:text-white hover:border-accent'
        }`}
        title={watched ? 'Remove from watchlist' : 'Add to watchlist'}
      >
        {watched ? '★ Watching' : '☆ Watch'}
      </button>
    </div>
  )
}