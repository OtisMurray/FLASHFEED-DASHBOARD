'use client'
import { clsx } from 'clsx'

type FilterTab = 'descriptive' | 'fundamental' | 'technical' | 'sentiment' | 'all'

interface Props {
  filters: Record<string, string>
  setFilter: (k: string, v: string) => void
  activeTab: FilterTab
  setActiveTab: (t: FilterTab) => void
}

const TABS: FilterTab[] = ['descriptive', 'fundamental', 'technical', 'sentiment', 'all']

export function ScreenerFilterPanel({ filters, setFilter, activeTab, setActiveTab }: Props) {
  const show = (tab: FilterTab) => activeTab === 'all' || activeTab === tab

  return (
    <div className="mb-3 bg-surface border border-border rounded-lg overflow-hidden">
      {/* Tab bar */}
      <div className="flex border-b border-border">
        {TABS.map(t => (
          <button key={t} onClick={() => setActiveTab(t)}
            className={clsx(
              'px-3 py-1.5 text-xs capitalize transition-colors',
              activeTab === t ? 'text-white bg-slate-700/50' : 'text-neutral hover:text-white'
            )}>
            {t}
          </button>
        ))}
      </div>

      <div className="p-3 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        {/* Descriptive */}
        {show('descriptive') && (
          <>
            <FilterSelect label="Sector" k="sector" value={filters.sector} onChange={v => setFilter('sector', v)}
              options={['Technology','Healthcare','Finance','Energy','Consumer Discretionary','Industrials','Materials','Utilities','Real Estate','Communication Services']} />
            <FilterSelect label="Industry" k="industry" value={filters.industry} onChange={v => setFilter('industry', v)}
              options={[]} placeholder="(from data)" />
            <FilterSelect label="Market Cap" k="market_cap" value={filters.market_cap} onChange={v => setFilter('market_cap', v)}
              options={[
                { value: 'micro', label: 'Micro (<300M)' },
                { value: 'small', label: 'Small (300M-2B)' },
                { value: 'mid', label: 'Mid (2B-10B)' },
                { value: 'large', label: 'Large (10B-200B)' },
                { value: 'mega', label: 'Mega (>200B)' },
              ]} />
          </>
        )}

        {/* Fundamental */}
        {show('fundamental') && (
          <>
            <FilterSelect label="P/E Ratio" k="pe_ratio" value={filters.pe_ratio} onChange={v => setFilter('pe_ratio', v)}
              options={[
                { value: 'positive', label: 'Positive' },
                { value: 'low', label: 'Low (<15)' },
                { value: 'medium', label: 'Medium (15-25)' },
                { value: 'high', label: 'High (>25)' },
                { value: 'negative', label: 'Negative' },
              ]} />
            <FilterSelect label="Analyst Rating" k="analyst" value={filters.analyst} onChange={v => setFilter('analyst', v)}
              options={['Strong Buy','Buy','Hold','Sell']} />
          </>
        )}

        {/* Technical */}
        {show('technical') && (
          <>
            <FilterSelect label="Price Change" k="price_change" value={filters.price_change} onChange={v => setFilter('price_change', v)}
              options={[
                { value: 'up', label: 'Up' },
                { value: 'down', label: 'Down' },
                { value: 'up2', label: 'Up >2%' },
                { value: 'up5', label: 'Up >5%' },
                { value: 'up10', label: 'Up >10%' },
                { value: 'down2', label: 'Down >2%' },
                { value: 'down5', label: 'Down >5%' },
              ]} />
            <FilterSelect label="Avg Volume" k="avg_volume" value={filters.avg_volume} onChange={v => setFilter('avg_volume', v)}
              options={[
                { value: '50000', label: '>50K' },
                { value: '100000', label: '>100K' },
                { value: '500000', label: '>500K' },
                { value: '1000000', label: '>1M' },
                { value: '2000000', label: '>2M' },
              ]} />
            <FilterSelect label="Price Range" k="price_range" value={filters.price_range} onChange={v => setFilter('price_range', v)}
              options={[
                { value: 'under1', label: 'Under $1' },
                { value: 'under5', label: 'Under $5' },
                { value: 'under10', label: 'Under $10' },
                { value: 'under20', label: 'Under $20' },
                { value: 'over5', label: 'Over $5' },
                { value: 'over10', label: 'Over $10' },
                { value: 'over20', label: 'Over $20' },
                { value: 'over50', label: 'Over $50' },
                { value: 'over100', label: 'Over $100' },
              ]} />
          </>
        )}

        {/* Sentiment */}
        {show('sentiment') && (
          <>
            <FilterSelect label="Social Sentiment" k="social_sentiment" value={filters.social_sentiment} onChange={v => setFilter('social_sentiment', v)}
              options={['bullish','bearish','neutral']} />
            <FilterSelect label="News Sentiment" k="news_sentiment" value={filters.news_sentiment} onChange={v => setFilter('news_sentiment', v)}
              options={['bullish','bearish','neutral']} />
            <FilterSelect label="Min Posts/Window" k="min_posts" value={filters.min_posts} onChange={v => setFilter('min_posts', v)}
              options={[
                { value: '5', label: '5+' },
                { value: '10', label: '10+' },
                { value: '25', label: '25+' },
                { value: '50', label: '50+' },
                { value: '100', label: '100+' },
              ]} />
          </>
        )}
      </div>
    </div>
  )
}

function FilterSelect({ label, k, value, onChange, options, placeholder }: {
  label: string; k: string; value?: string; onChange: (v: string) => void
  options: Array<string | { value: string; label: string }>; placeholder?: string
}) {
  return (
    <div>
      <label className="text-[10px] text-neutral uppercase tracking-wide block mb-1">{label}</label>
      <select
        value={value ?? ''}
        onChange={e => onChange(e.target.value)}
        className="w-full bg-bg border border-border text-xs text-neutral rounded px-2 py-1.5 focus:outline-none focus:border-accent"
      >
        <option value="">{placeholder ?? 'All'}</option>
        {options.map(o => {
          const val = typeof o === 'string' ? o : o.value
          const lab = typeof o === 'string' ? o : o.label
          return <option key={val} value={val}>{lab}</option>
        })}
      </select>
    </div>
  )
}
