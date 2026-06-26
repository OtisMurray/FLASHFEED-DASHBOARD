interface Props {
  filters: Record<string, string>
  setFilter: (k: string, v: string) => void
}

export function FilterPanel({ filters, setFilter }: Props) {
  return (
    <div className="mb-3 p-3 bg-surface border border-border rounded-lg grid grid-cols-2 sm:grid-cols-4 gap-3">
      <div>
        <label className="label block mb-1">Sector</label>
        <select value={filters.sector ?? ''} onChange={e => setFilter('sector', e.target.value)}
          className="w-full bg-bg border border-border text-sm text-neutral rounded px-2 py-1.5 focus:outline-none focus:border-accent">
          <option value="">All</option>
          {['Technology','Healthcare','Finance','Energy','Consumer Discretionary','Industrials','Materials','Utilities','Real Estate','Communication Services'].map(s => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      </div>
      <div>
        <label className="label block mb-1">Min Sentiment</label>
        <input type="number" step="0.1" min="-1" max="1" value={filters.sentiment ?? ''} onChange={e => setFilter('sentiment', e.target.value)}
          placeholder="e.g. 0.3"
          className="w-full bg-bg border border-border text-sm text-neutral rounded px-2 py-1.5 focus:outline-none focus:border-accent placeholder:text-slate-600" />
      </div>
    </div>
  )
}
