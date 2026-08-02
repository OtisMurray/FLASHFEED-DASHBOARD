export function mean(values) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null
}

export function median(values) {
  if (!values.length) return null
  const x = [...values].sort((a, b) => a - b)
  const mid = Math.floor(x.length / 2)
  return x.length % 2 ? x[mid] : (x[mid - 1] + x[mid]) / 2
}

export function summarizeReturns(rows, valueKey = 'aligned_return_pct') {
  const values = rows.map(x => Number(x[valueKey])).filter(Number.isFinite)
  const wins = values.filter(x => x > 0)
  const losses = values.filter(x => x < 0)
  let equity = 1
  let peak = 1
  let maxDrawdown = 0
  for (const value of values) {
    equity *= 1 + value / 100
    peak = Math.max(peak, equity)
    maxDrawdown = Math.min(maxDrawdown, (equity / peak - 1) * 100)
  }
  const grossProfit = wins.reduce((a, b) => a + b, 0)
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0))
  return {
    trade_count: values.length,
    win_rate_pct: values.length ? wins.length / values.length * 100 : null,
    mean_return_pct: mean(values),
    median_return_pct: median(values),
    compounded_return_pct: (equity - 1) * 100,
    profit_factor: grossLoss ? grossProfit / grossLoss : grossProfit > 0 ? null : 0,
    max_drawdown_pct: maxDrawdown,
    worst_trade_pct: values.length ? Math.min(...values) : null,
  }
}

export function splitTemporal(rows) {
  const sorted = [...rows].sort((a, b) => a.signal_sec - b.signal_sec)
  const n = sorted.length
  return {
    development: sorted.slice(0, Math.floor(n * 0.6)),
    validation: sorted.slice(Math.floor(n * 0.6), Math.floor(n * 0.8)),
    test: sorted.slice(Math.floor(n * 0.8)),
  }
}

export function csv(rows, columns = null) {
  const cols = columns || [...new Set(rows.flatMap(Object.keys))]
  const esc = value => {
    if (value == null) return ''
    const text = typeof value === 'object' ? JSON.stringify(value) : String(value)
    return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
  }
  return [cols.join(','), ...rows.map(row => cols.map(col => esc(row[col])).join(','))].join('\n') + '\n'
}

export function roundObject(value, digits = 4) {
  if (Array.isArray(value)) return value.map(x => roundObject(x, digits))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, roundObject(v, digits)]))
  return typeof value === 'number' && Number.isFinite(value) ? Number(value.toFixed(digits)) : value
}
