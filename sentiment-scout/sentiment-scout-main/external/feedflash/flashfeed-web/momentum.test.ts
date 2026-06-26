/**
 * Momentum Scanner — Unit Tests
 * Run: cd flashfeed-web && bun test momentum.test.ts
 */
import { describe, it, expect } from 'bun:test'

// ─── Catalyst keyword detection ──────────────────────────────────────────────

const CATALYST_KEYWORDS = [
  'contract', 'fda', 'earnings', 'merger', 'acquisition',
  'data center', 'offering', 'split', 'partnership', 'guidance',
]

function detectCatalysts(title: string): string[] {
  const lower = title.toLowerCase()
  return CATALYST_KEYWORDS.filter(kw => lower.includes(kw))
}

describe('Catalyst keyword detection', () => {
  it('detects single catalyst keyword', () => {
    expect(detectCatalysts('Company receives FDA approval for new drug')).toEqual(['fda'])
  })

  it('detects multiple catalyst keywords', () => {
    const result = detectCatalysts('Merger talks continue after major contract win')
    expect(result).toContain('merger')
    expect(result).toContain('contract')
    expect(result.length).toBe(2)
  })

  it('detects multi-word catalyst "data center"', () => {
    expect(detectCatalysts('New data center expansion announced')).toEqual(['data center'])
  })

  it('returns empty array when no catalysts found', () => {
    expect(detectCatalysts('Stock rises on positive market conditions')).toEqual([])
  })

  it('is case-insensitive', () => {
    expect(detectCatalysts('FDA APPROVAL GRANTED')).toEqual(['fda'])
    expect(detectCatalysts('New Partnership With Microsoft')).toEqual(['partnership'])
  })

  it('detects earnings keyword', () => {
    expect(detectCatalysts('Q3 Earnings beat expectations')).toEqual(['earnings'])
  })

  it('detects all keywords across a complex headline', () => {
    const result = detectCatalysts('Post-merger guidance includes data center offering and new partnership')
    expect(result).toContain('merger')
    expect(result).toContain('guidance')
    expect(result).toContain('data center')
    expect(result).toContain('offering')
    expect(result).toContain('partnership')
    expect(result.length).toBe(5)
  })
})

// ─── Momentum filtering ─────────────────────────────────────────────────────

interface MockTicker {
  ticker: string
  volume_num: number
  avg_volume_num: number
  rvol: number
  change_pct: number
}

function applyMomentumFilters(tickers: MockTicker[], minVolume: number, minRvol: number, limit: number): MockTicker[] {
  return tickers
    .filter(t => t.volume_num > minVolume && t.rvol >= minRvol)
    .sort((a, b) => (b.change_pct ?? 0) - (a.change_pct ?? 0))
    .slice(0, limit)
}

const SAMPLE_TICKERS: MockTicker[] = [
  { ticker: 'AAA', volume_num: 500000,  avg_volume_num: 50000,  rvol: 10,   change_pct: 15.0 },
  { ticker: 'BBB', volume_num: 200000,  avg_volume_num: 40000,  rvol: 5,    change_pct: 8.5 },
  { ticker: 'CCC', volume_num: 50000,   avg_volume_num: 10000,  rvol: 5,    change_pct: 25.0 },  // below 100K volume
  { ticker: 'DDD', volume_num: 1000000, avg_volume_num: 500000, rvol: 2,    change_pct: 3.0 },   // below 5x rvol
  { ticker: 'EEE', volume_num: 300000,  avg_volume_num: 30000,  rvol: 10,   change_pct: 12.0 },
  { ticker: 'FFF', volume_num: 150000,  avg_volume_num: 15000,  rvol: 10,   change_pct: -5.0 },  // negative change
  { ticker: 'GGG', volume_num: 800000,  avg_volume_num: 100000, rvol: 8,    change_pct: 20.0 },
]

describe('Momentum filtering', () => {
  it('filters by minimum volume (100K) and rvol (5x)', () => {
    const result = applyMomentumFilters(SAMPLE_TICKERS, 100000, 5, 10)
    // CCC is excluded (volume 50K < 100K), DDD excluded (rvol 2 < 5)
    const tickers = result.map(t => t.ticker)
    expect(tickers).not.toContain('CCC')
    expect(tickers).not.toContain('DDD')
    expect(tickers).toContain('AAA')
    expect(tickers).toContain('BBB')
    expect(tickers).toContain('EEE')
    expect(tickers).toContain('GGG')
  })

  it('includes negative change tickers that meet volume/rvol criteria', () => {
    const result = applyMomentumFilters(SAMPLE_TICKERS, 100000, 5, 10)
    expect(result.map(t => t.ticker)).toContain('FFF')
  })

  it('respects limit parameter', () => {
    const result = applyMomentumFilters(SAMPLE_TICKERS, 100000, 5, 3)
    expect(result.length).toBe(3)
  })

  it('returns empty when no tickers match', () => {
    const result = applyMomentumFilters(SAMPLE_TICKERS, 10000000, 100, 10)
    expect(result.length).toBe(0)
  })

  it('works with custom thresholds', () => {
    const result = applyMomentumFilters(SAMPLE_TICKERS, 50000, 2, 10)
    // CCC excluded (volume 50K is not > 50K, strict inequality)
    expect(result.length).toBe(6)
  })
})

// ─── Momentum sorting ───────────────────────────────────────────────────────

describe('Momentum sorting (% change descending)', () => {
  it('sorts by change_pct descending', () => {
    const result = applyMomentumFilters(SAMPLE_TICKERS, 100000, 5, 10)
    for (let i = 1; i < result.length; i++) {
      expect(result[i - 1].change_pct).toBeGreaterThanOrEqual(result[i].change_pct)
    }
  })

  it('top result has highest change_pct', () => {
    const result = applyMomentumFilters(SAMPLE_TICKERS, 100000, 5, 10)
    // GGG has 20%, AAA has 15%, EEE has 12% — GGG should be first
    expect(result[0].ticker).toBe('GGG')
  })

  it('negative change tickers are ranked last', () => {
    const result = applyMomentumFilters(SAMPLE_TICKERS, 100000, 5, 10)
    const lastTicker = result[result.length - 1]
    expect(lastTicker.ticker).toBe('FFF')
    expect(lastTicker.change_pct).toBeLessThan(0)
  })

  it('limit truncates after sorting', () => {
    const result = applyMomentumFilters(SAMPLE_TICKERS, 100000, 5, 2)
    expect(result.length).toBe(2)
    expect(result[0].ticker).toBe('GGG')  // 20%
    expect(result[1].ticker).toBe('AAA')  // 15%
  })
})
