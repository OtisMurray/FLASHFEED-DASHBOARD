export const MIN_ROLLING_WINDOW_MINUTES = 5
export const MAX_ROLLING_WINDOW_MINUTES = 7 * 24 * 60
export const DEFAULT_ROLLING_WINDOW_MINUTES = 24 * 60

export function normalizeRollingWindowMinutes(value, fallback = DEFAULT_ROLLING_WINDOW_MINUTES) {
  const fallbackNumber = Number(fallback)
  const safeFallback = Number.isFinite(fallbackNumber)
    ? fallbackNumber
    : DEFAULT_ROLLING_WINDOW_MINUTES
  if (value == null || value === '' || String(value).toLowerCase() === 'adaptive') {
    return Math.max(MIN_ROLLING_WINDOW_MINUTES, Math.min(MAX_ROLLING_WINDOW_MINUTES, Math.round(safeFallback)))
  }
  const number = Number(value)
  if (!Number.isFinite(number)) return normalizeRollingWindowMinutes(null, safeFallback)
  return Math.max(MIN_ROLLING_WINDOW_MINUTES, Math.min(MAX_ROLLING_WINDOW_MINUTES, Math.round(number)))
}

export function sliceCandlesToRollingWindow(candles = [], windowMinutes = DEFAULT_ROLLING_WINDOW_MINUTES) {
  if (!Array.isArray(candles) || !candles.length) return []
  const minutes = normalizeRollingWindowMinutes(windowMinutes)
  const anchorSec = candles.reduce((max, candle) => {
    const sec = Number(candle?.time || 0)
    return Number.isFinite(sec) ? Math.max(max, sec) : max
  }, 0)
  if (!anchorSec) return []
  const cutoffSec = anchorSec - minutes * 60
  return candles.filter(candle => {
    const sec = Number(candle?.time || 0)
    return Number.isFinite(sec) && sec > cutoffSec && sec <= anchorSec
  })
}

export function recordIsInsideRollingWindow(timestampSec, windowMinutes, nowSec = Math.floor(Date.now() / 1000)) {
  const sec = Number(timestampSec)
  const end = Number(nowSec)
  if (!Number.isFinite(sec) || !Number.isFinite(end)) return false
  const cutoffSec = end - normalizeRollingWindowMinutes(windowMinutes) * 60
  return sec >= cutoffSec && sec <= end
}
