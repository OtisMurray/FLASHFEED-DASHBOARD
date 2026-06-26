import { clsx } from 'clsx'

interface Props {
  tickers: Array<{ ticker: string; count: number; sentiment?: number }>
  activeTicker: string | null
  onSelect: (ticker: string) => void
}

export function TickerSidebar({ tickers, activeTicker, onSelect }: Props) {
  return (
    <div className="bg-surface border border-border rounded-lg overflow-hidden">
      <div className="px-3 py-2 border-b border-border">
        <span className="text-[10px] uppercase tracking-wide text-neutral font-medium">Active Tickers</span>
      </div>
      <div className="max-h-[300px] overflow-y-auto">
        {tickers.length === 0 ? (
          <div className="p-3 text-xs text-neutral text-center">No active tickers</div>
        ) : (
          tickers.map(t => (
            <button
              key={t.ticker}
              onClick={() => onSelect(t.ticker)}
              className={clsx(
                'w-full flex items-center gap-2 px-3 py-2 text-left transition-colors border-l-2',
                activeTicker === t.ticker
                  ? 'bg-slate-700/40 border-accent text-white'
                  : 'border-transparent text-neutral hover:text-white hover:bg-slate-800'
              )}
            >
              <span className="font-mono text-xs font-bold text-accent flex-1">{t.ticker}</span>
              <span className="text-[10px] font-mono text-neutral">{t.count}</span>
              {t.sentiment != null && (
                <span className={clsx(
                  'text-[10px] font-mono',
                  t.sentiment >= 0.2 ? 'text-emerald-400' : t.sentiment <= -0.2 ? 'text-red-400' : 'text-slate-400'
                )}>
                  {t.sentiment >= 0 ? '+' : ''}{t.sentiment.toFixed(1)}
                </span>
              )}
            </button>
          ))
        )}
      </div>
    </div>
  )
}
