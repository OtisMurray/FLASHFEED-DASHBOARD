// Payoff-capture multi-leg exit simulator (shared ESM module).
//
// This is a faithful extraction of `simulatePayoffCapture` (+ its `pct` and
// `normalizeCandle` helpers) from scripts/label_next_day_prediction_outcomes.js,
// lifted into an ESM module so the server (v11 screener route) can reuse the
// EXACT same exit math the offline outcome-labeler uses. The two must stay in
// sync; the label script is CJS (require) and cannot import this ESM module, so
// if you change the exit rule, change it in BOTH places.
//
// Exit rule (the "V7_PAYOFF_CAPTURE_EXIT" profile, == v11):
//   - sell `partialExitFraction` (50%) at `partialProfitTargetPct` (+5%)
//   - hold the runner until it gives back `profitGivebackPct` (5%) from a peak
//     that reached at least `profitGivebackActivationPct` (+10%)
//   - `protectiveStopPct` (3%) protective stop on the whole position
//   - otherwise flatten at end of the provided candle series (EOD)
//
// CONFIDENTIALITY BOUNDARY: pure price math only. No Mongo, no network, and
// nothing under ~/dev/research-students. Keep it that way.

export function pct(from, to) {
  const a = Number(from)
  const b = Number(to)
  if (!a || !Number.isFinite(a) || !Number.isFinite(b)) return null
  return Number((((b - a) / a) * 100).toFixed(3))
}

function toSec(value) {
  if (value == null) return null
  if (value instanceof Date) return Math.floor(value.getTime() / 1000)
  const n = Number(value)
  if (Number.isFinite(n) && n > 0) return n > 1_000_000_000_000 ? Math.floor(n / 1000) : Math.floor(n)
  const ms = Date.parse(String(value))
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null
}

// Normalize a raw ohlcv_bars doc into a candle {time, open, high, low, close, ...}.
// `time` is an epoch second; rejects candles whose OHLC is internally inconsistent.
export function normalizeCandle(doc = {}, source = 'mongo_ohlcv_bars') {
  const time = toSec(doc.minute ?? doc.time ?? doc.timestamp ?? doc.date)
  const close = Number(doc.close ?? doc.price)
  const open = Number(doc.open)
  const high = Number(doc.high)
  const low = Number(doc.low)
  if (!time || !Number.isFinite(close) || close <= 0) return null
  const candle = {
    time,
    open: Number.isFinite(open) && open > 0 ? open : close,
    high: Number.isFinite(high) && high > 0 ? high : close,
    low: Number.isFinite(low) && low > 0 ? low : close,
    close,
    volume: Number.isFinite(Number(doc.volume)) ? Number(doc.volume) : 0,
    providerInterval: doc.providerInterval || doc.interval || null,
    source,
  }
  if (candle.high < Math.max(candle.open, candle.close, candle.low)) return null
  if (candle.low > Math.min(candle.open, candle.close, candle.high)) return null
  return candle
}

// Simulate the multi-leg payoff-capture exit from `entryPrice` over `candles`
// (chronological, intrabar OHLC). Returns null if there is nothing to simulate.
export function simulatePayoffCapture(entryPrice, candles = [], options = {}) {
  const entry = Number(entryPrice)
  if (!Number.isFinite(entry) || entry <= 0 || !candles.length) return null
  const partialFraction = Number(options.partialExitFraction ?? 0.5)
  const partialTargetPct = Number(options.partialProfitTargetPct ?? 5)
  const activationPct = Number(options.profitGivebackActivationPct ?? 10)
  const givebackPct = Number(options.profitGivebackPct ?? 5)
  const protectiveStopPct = Number(options.protectiveStopPct ?? 3)
  const partialTarget = entry * (1 + partialTargetPct / 100)
  const protectiveStop = entry * (1 - protectiveStopPct / 100)
  let peak = entry
  let partialExitPrice = null
  let partialExitSec = null

  for (const candle of candles) {
    const high = Number(candle.high || candle.close)
    const low = Number(candle.low || candle.close)
    const close = Number(candle.close)
    if (![high, low, close].every(Number.isFinite)) continue
    peak = Math.max(peak, high)
    if (partialExitPrice == null && high >= partialTarget) {
      partialExitPrice = partialTarget
      partialExitSec = Number(candle.time || 0)
    }
    const activated = pct(entry, peak) >= activationPct
    const givebackStop = activated ? peak * (1 - givebackPct / 100) : null
    const runnerStop = Math.max(protectiveStop, givebackStop || protectiveStop)
    if (low <= runnerStop) {
      const runnerExit = runnerStop
      const realized = partialExitPrice == null
        ? pct(entry, runnerExit)
        : (((partialExitPrice - entry) / entry) * partialFraction + ((runnerExit - entry) / entry) * (1 - partialFraction)) * 100
      return {
        return_pct: Number(realized.toFixed(3)),
        won: realized > 0,
        exit_reason: givebackStop != null && runnerStop === givebackStop ? 'profit_giveback_stop' : 'protective_stop',
        exit_price: Number(runnerExit.toFixed(4)),
        exit_sec: Number(candle.time || 0),
        partial_exit_price: partialExitPrice == null ? null : Number(partialExitPrice.toFixed(4)),
        partial_exit_sec: partialExitSec,
        peak_return_pct: pct(entry, peak),
      }
    }
  }

  const last = candles[candles.length - 1]
  const lastClose = Number(last.close)
  const realized = partialExitPrice == null
    ? pct(entry, lastClose)
    : (((partialExitPrice - entry) / entry) * partialFraction + ((lastClose - entry) / entry) * (1 - partialFraction)) * 100
  return {
    return_pct: Number((realized ?? 0).toFixed(3)),
    won: Number(realized) > 0,
    exit_reason: partialExitPrice == null ? 'eod_flatten' : 'partial_profit_then_eod_flatten',
    exit_price: Number(lastClose.toFixed(4)),
    exit_sec: Number(last.time || 0),
    partial_exit_price: partialExitPrice == null ? null : Number(partialExitPrice.toFixed(4)),
    partial_exit_sec: partialExitSec,
    peak_return_pct: pct(entry, peak),
  }
}
