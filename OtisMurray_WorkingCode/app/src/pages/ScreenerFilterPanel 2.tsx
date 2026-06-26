'use client'
import { clsx } from 'clsx'

type FilterTab = 'descriptive' | 'technical' | 'performance' | 'sentiment' | 'all'

interface Props {
  filters: Record<string, string>
  setFilter: (k: string, v: string) => void
  activeTab: FilterTab
  setActiveTab: (t: FilterTab) => void
}

const TABS: FilterTab[] = ['descriptive', 'technical', 'performance', 'sentiment', 'all']

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
              options={['Technology','Healthcare','Financial','Financial Services','Energy','Consumer Cyclical','Consumer Defensive','Consumer Discretionary','Industrials','Basic Materials','Utilities','Real Estate','Communication Services']} />
            <FilterSelect label="Exchange" k="exchange" value={filters.exchange} onChange={v => setFilter('exchange', v)}
              options={['NASDAQ','NYSE','AMEX']} />
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
            <FilterSelect label="Relative Volume" k="rel_volume" value={filters.rel_volume} onChange={v => setFilter('rel_volume', v)}
              options={[
                { value: 'over1', label: '>1x' },
                { value: 'over1_5', label: '>1.5x' },
                { value: 'over2', label: '>2x' },
                { value: 'over3', label: '>3x' },
              ]} />
            <FilterSelect label="RSI" k="rsi" value={filters.rsi} onChange={v => setFilter('rsi', v)}
              options={[
                { value: 'oversold', label: 'Oversold (<30)' },
                { value: 'overbought', label: 'Overbought (>70)' },
                { value: 'neutral', label: '30-70' },
              ]} />
            <FilterSelect label="SMA 20" k="sma20" value={filters.sma20} onChange={v => setFilter('sma20', v)}
              options={[
                { value: 'above', label: 'Above' },
                { value: 'below', label: 'Below' },
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

        {/* Performance */}
        {show('performance') && (
          <>
            <FilterSelect label="Performance Week" k="perf_week" value={filters.perf_week} onChange={v => setFilter('perf_week', v)}
              options={[
                { value: 'up', label: 'Up' },
                { value: 'down', label: 'Down' },
                { value: 'up5', label: 'Up >5%' },
                { value: 'down5', label: 'Down >5%' },
              ]} />
            <FilterSelect label="Performance Month" k="perf_month" value={filters.perf_month} onChange={v => setFilter('perf_month', v)}
              options={[
                { value: 'up', label: 'Up' },
                { value: 'down', label: 'Down' },
                { value: 'up10', label: 'Up >10%' },
                { value: 'down10', label: 'Down >10%' },
              ]} />
            <FilterSelect label="Performance Year" k="perf_year" value={filters.perf_year} onChange={v => setFilter('perf_year', v)}
              options={[
                { value: 'up', label: 'Up' },
                { value: 'down', label: 'Down' },
                { value: 'up25', label: 'Up >25%' },
                { value: 'down25', label: 'Down >25%' },
              ]} />
          </>
        )}

        {/* Sentiment */}
        {show('sentiment') && (
          <>
            <FilterSelect label="StockTwits Sentiment" k="stocktwits_sentiment" value={filters.stocktwits_sentiment} onChange={v => setFilter('stocktwits_sentiment', v)}
              options={['bullish','bearish','neutral']} />
            <FilterSelect label="StockTwits Density" k="stocktwits_density" value={filters.stocktwits_density} onChange={v => setFilter('stocktwits_density', v)}
              options={[
                { value: 'over0_05', label: '>0.05/min' },
                { value: 'over0_1', label: '>0.10/min' },
                { value: 'over0_5', label: '>0.50/min' },
                { value: 'over1', label: '>1/min' },
              ]} />
            <FilterSelect label="All Social Sentiment" k="social_sentiment" value={filters.social_sentiment} onChange={v => setFilter('social_sentiment', v)}
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
