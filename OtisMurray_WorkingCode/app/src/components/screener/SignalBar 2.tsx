
interface Props {
  signal: string; setSignal: (s: string) => void
  orderBy: string; setOrderBy: (s: string) => void
  orderDir: 'asc' | 'desc'; setOrderDir: (d: 'asc' | 'desc') => void
  search: string; setSearch: (s: string) => void
  onRefresh: () => void
}

const ORDER_OPTIONS = [
  { value: 'ticker', label: 'Ticker' },
  { value: 'price', label: 'Price' },
  { value: 'change_pct', label: 'Change %' },
  { value: 'volume', label: 'Volume' },
  { value: 'market_cap', label: 'Market Cap' },
  { value: 'avg_sentiment', label: 'Avg Sentiment' },
  { value: 'social_sentiment', label: 'Social Sent.' },
  { value: 'message_count', label: 'Messages' },
  { value: 'news_article_count', label: 'News Count' },
  { value: 'sector', label: 'Sector' },
]

export function SignalBar({ signal, setSignal, orderBy, setOrderBy, orderDir, setOrderDir, search, setSearch, onRefresh }: Props) {
  return (
    <div className="flex items-center gap-2 mb-3 flex-wrap bg-surface border border-border rounded-lg px-3 py-2">
      {/* Signal */}
      <div className="flex items-center gap-1">
        <span className="text-[10px] text-neutral uppercase">Signal</span>
        <select value={signal} onChange={e => setSignal(e.target.value)}
          className="bg-bg border border-border text-xs text-neutral rounded px-1.5 py-1 focus:outline-none focus:border-accent">
          <option value="">None</option>
          <option value="social_bullish">Social Bullish</option>
          <option value="social_bearish">Social Bearish</option>
          <option value="unusual_volume">Unusual Volume</option>
        </select>
      </div>

      {/* Order */}
      <div className="flex items-center gap-1">
        <span className="text-[10px] text-neutral uppercase">Order</span>
        <select value={orderBy} onChange={e => setOrderBy(e.target.value)}
          className="bg-bg border border-border text-xs text-neutral rounded px-1.5 py-1 focus:outline-none focus:border-accent">
          {ORDER_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <button onClick={() => setOrderDir(orderDir === 'asc' ? 'desc' : 'asc')}
          className="text-xs text-neutral hover:text-white px-1.5 py-1 bg-bg border border-border rounded">
          {orderDir === 'asc' ? '↑' : '↓'}
        </button>
      </div>

      {/* Search */}
      <div className="flex-1 min-w-[120px]">
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search tickers..."
          className="w-full bg-bg border border-border text-xs text-neutral rounded px-2 py-1 focus:outline-none focus:border-accent placeholder:text-slate-600"
        />
      </div>

      {/* Refresh */}
      <button onClick={onRefresh}
        className="px-2 py-1 text-xs bg-bg border border-border text-neutral rounded hover:text-white hover:border-accent transition-colors">
        ↻
      </button>
    </div>
  )
}
