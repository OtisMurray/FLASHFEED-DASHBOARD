// Shared stock universe for the Charts dropdown + Settings custom-stocks.
// Custom stocks are stored in the browser (localStorage) so they persist per device
// and immediately show up in the Charts ticker dropdown.

export const TOP_50_STOCKS: string[] = [
  'AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'AVGO', 'LLY', 'JPM',
  'XOM', 'UNH', 'V', 'PG', 'MA', 'HD', 'COST', 'JNJ', 'MRK', 'ABBV',
  'CVX', 'ADBE', 'PEP', 'KO', 'WMT', 'CRM', 'BAC', 'NFLX', 'AMD', 'TMO',
  'ACN', 'MCD', 'CSCO', 'ABT', 'INTC', 'QCOM', 'DHR', 'TXN', 'PM', 'INTU',
  'VZ', 'AMGN', 'NEE', 'UNP', 'LOW', 'SPGI', 'RTX', 'HON', 'PLTR', 'UBER',
]

const STORAGE_KEY = 'flashfeed_custom_stocks'

function readStore(): string[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((t) => typeof t === 'string') : []
  } catch {
    return []
  }
}

function writeStore(list: string[]): void {
  if (typeof window === 'undefined') return
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list)) } catch { /* ignore quota */ }
}

/** Normalize a user-typed symbol: uppercase, trimmed, letters/digits/.-/ only. */
export function normalizeTicker(input: string): string {
  return (input || '').trim().toUpperCase().replace(/[^A-Z0-9.\-]/g, '').slice(0, 12)
}

export function getCustomStocks(): string[] {
  return readStore()
}

export function addCustomStock(input: string): string[] {
  const sym = normalizeTicker(input)
  const cur = readStore()
  if (sym && !cur.includes(sym)) cur.unshift(sym)
  writeStore(cur)
  return cur
}

export function removeCustomStock(sym: string): string[] {
  const next = readStore().filter((t) => t !== normalizeTicker(sym))
  writeStore(next)
  return next
}

/** Custom stocks first, then the top-50 (de-duplicated) — the Charts dropdown order. */
export function getAllChartStocks(): string[] {
  const custom = readStore()
  const rest = TOP_50_STOCKS.filter((t) => !custom.includes(t))
  return [...custom, ...rest]
}
