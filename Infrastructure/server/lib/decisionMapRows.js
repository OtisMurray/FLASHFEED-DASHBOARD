function normalizedTicker(value) {
  return String(value || '').trim().toUpperCase().replace(/^\$/, '')
}

function finiteCoordinate(value) {
  if (value == null || value === '') return false
  return Number.isFinite(Number(value))
}

export function decisionMapRowExclusionReasons(row = {}) {
  const reasons = []
  if (!normalizedTicker(row.ticker)) reasons.push('missing_ticker')
  if (!finiteCoordinate(row.combinedSentiment)) reasons.push('invalid_x_sentiment')
  if (!finiteCoordinate(row.priceChangePct)) reasons.push('invalid_y_price_change')
  if (!finiteCoordinate(row.relativeVolume)) reasons.push('invalid_z_relative_volume')
  return reasons
}

export function analyzeDecisionMapRows(rows = []) {
  const seen = new Set()
  const validRows = []
  const excluded = []
  let duplicateTickers = 0

  for (const row of Array.isArray(rows) ? rows : []) {
    const ticker = normalizedTicker(row?.ticker)
    const reasons = decisionMapRowExclusionReasons(row)
    if (ticker && seen.has(ticker)) {
      reasons.push('duplicate_ticker')
      duplicateTickers += 1
    }
    if (reasons.length) {
      excluded.push({ ticker: ticker || null, reasons })
      continue
    }
    seen.add(ticker)
    validRows.push(row)
  }

  return {
    input_rows: Array.isArray(rows) ? rows.length : 0,
    valid_coordinate_rows: validRows.length,
    unique_tickers: seen.size,
    duplicate_ticker_rows: duplicateTickers,
    excluded_rows: excluded.length,
    validRows,
    excluded,
  }
}

export function decisionMapRowLimit(query = {}, maximum = 30) {
  const hasTickerFocus = ['focusTicker', 'ticker', 'search', 'q']
    .some(key => String(query?.[key] || '').trim().length > 0)
  if (hasTickerFocus) return 1
  const requested = Number(query?.limit ?? maximum)
  const normalized = Number.isFinite(requested) ? Math.floor(requested) : maximum
  return Math.max(1, Math.min(maximum, normalized))
}

export function decisionMapPathScope({ windowHours = 4, volumeTimeframe = '5m', marketDayOnly = false } = {}) {
  const rawMinutes = Math.round(Number(windowHours) * 60)
  const minutes = Number.isFinite(rawMinutes) ? Math.max(5, Math.min(10_080, rawMinutes)) : 240
  const timeframe = /^[0-9]+[mh]$/.test(String(volumeTimeframe || '')) ? String(volumeTimeframe) : '5m'
  return `w${minutes}-v${timeframe}-${marketDayOnly ? 'market' : 'continuous'}`
}

export function analyzeDecisionMapPath(points = [], expectedTicker = '') {
  const ticker = normalizedTicker(expectedTicker)
  const source = Array.isArray(points) ? points : []
  const timestamps = source.map(point => Number(point?.timestamp || point?.time || 0))
  const invalidTimestampRows = timestamps.filter(timestamp => !Number.isFinite(timestamp) || timestamp <= 0).length
  const wrongTickerRows = source.filter(point => {
    const pointTicker = normalizedTicker(point?.ticker)
    return Boolean(pointTicker && ticker && pointTicker !== ticker)
  }).length
  const chronological = invalidTimestampRows === 0 && timestamps.every((timestamp, index) => index === 0 || timestamp >= timestamps[index - 1])

  return {
    points: source.length,
    chronological,
    invalid_timestamp_rows: invalidTimestampRows,
    wrong_ticker_rows: wrongTickerRows,
    first_timestamp: timestamps[0] || null,
    latest_timestamp: timestamps[timestamps.length - 1] || null,
  }
}
