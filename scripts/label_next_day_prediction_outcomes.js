#!/usr/bin/env node

const path = require('path')
let mongoose
try {
  mongoose = require('mongoose')
} catch (_) {
  mongoose = require(path.join(__dirname, '..', 'Infrastructure', 'server', 'node_modules', 'mongoose'))
}

function argValue(name, fallback = '') {
  const prefix = `--${name}=`
  const inline = process.argv.find(arg => arg.startsWith(prefix))
  if (inline) return inline.slice(prefix.length)
  const index = process.argv.indexOf(`--${name}`)
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1]
  return fallback
}

function toNumber(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function pct(from, to) {
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

function firstFinite(...values) {
  for (const value of values) {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  return null
}

function normalizeCandle(doc = {}, source = 'mongo_ohlcv_bars') {
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

async function fetchMongoIntradayCandles(db, ticker, snapshotSec) {
  if (!db || !ticker) return []
  const start = Math.max(0, Number(snapshotSec || 0) - 6 * 60 * 60)
  const end = Number(snapshotSec || 0) + 7 * 86400
  const docs = await db.collection('ohlcv_bars').find({
    ticker: String(ticker).toUpperCase(),
    minute: { $gte: start, $lte: end },
  }, {
    projection: {
      _id: 0,
      ticker: 1,
      minute: 1,
      time: 1,
      open: 1,
      high: 1,
      low: 1,
      close: 1,
      price: 1,
      volume: 1,
      providerInterval: 1,
      providerIntervalSec: 1,
    },
  }).sort({ minute: 1 }).limit(5000).toArray()
  return docs.map(doc => normalizeCandle(doc, 'mongo_ohlcv_bars')).filter(Boolean)
}

function simulatePayoffCapture(entryPrice, candles = [], options = {}) {
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

function catalystSec(row = {}) {
  return toSec(row.main_catalyst?.event_sec ?? row.main_catalyst?.published_at ?? row.catalysts?.[0]?.event_sec ?? row.catalysts?.[0]?.published_at)
}

function classifyOutcome(row = {}, outcome = {}, candles = []) {
  if (!outcome || outcome.outcome_status !== 'labeled') return outcome
  const labels = []
  const reasons = []
  const closeReturn = firstFinite(outcome.close_return_pct, outcome.last_return_pct)
  const highReturn = firstFinite(outcome.high_return_pct, outcome.max_gain_pct)
  const lowReturn = firstFinite(outcome.low_return_pct, outcome.max_drawdown_pct)
  const payoffReturn = firstFinite(outcome.payoff_capture_return_pct)
  const tradableWin = Number(highReturn) >= 2
  const closeWin = Number(closeReturn) > 0
  const payoffWin = Number(payoffReturn) > 0
  const fadedFromHigh = Number(highReturn) >= 2 && Number(closeReturn) <= Number(highReturn) - 2
  const failedImmediately = Number(highReturn) < 1 && Number(lowReturn) <= -2
  const riskFlags = Array.isArray(row.risk_flags) ? row.risk_flags : []
  const catalystAge = firstFinite(row.main_catalyst_age_minutes, row.main_catalyst?.age_minutes, row.catalysts?.[0]?.age_minutes)
  const catalystWindowCount = firstFinite(row.catalyst_window_article_count, row.news_article_count, 0)
  const catalystInWindow = Boolean(row.main_catalyst?.in_session_window || row.catalysts?.some(c => c?.in_session_window))
  const changePct = firstFinite(row.change_pct, row.prediction?.features?.change_pct, 0)
  const messageCount = firstFinite(row.message_count, row.threshold_trailing_60m_messages, row.prediction_debug?.message_density_session_count, 0)
  const corr = firstFinite(row.correlation_score, row.price_density_correlation, row.threshold_policy?.correlation, row.prediction_threshold_policy?.correlation)
  const thresholdStatus = String(row.threshold_status || row.threshold_policy?.status || row.prediction_threshold_policy?.status || row.entry_signal?.status || '').toLowerCase()
  const thresholdSetup = String(row.threshold_setup_status || row.entry_signal?.setup_status || '').toLowerCase()
  const catalystQualityTier = String(row.catalyst_quality_tier || row.catalyst_quality?.tier || '').toLowerCase()
  const catalystQualityScore = firstFinite(row.catalyst_quality_score, row.catalyst_quality?.score)
  const pendingOpen = Boolean(row.pending_open_confirmation?.is_pending_open || row.prediction_readiness_level === 'fresh_catalyst_pending_open')
  const pendingConfirmed = row.pending_open_confirmed ?? row.pending_open_confirmation?.passes
  const pendingPayoffOverride = Boolean(row.pending_open_payoff_override)
  const firstReactionState = String(row.first_reaction_state || row.catalyst_reaction_summary?.first_reaction_state || '').toLowerCase()

  if (payoffWin) labels.push('payoff_capture_win')
  if (tradableWin) labels.push('tradable_win')
  if (closeWin) labels.push('close_win')
  if (fadedFromHigh) labels.push('opened_up_then_faded')
  if (failedImmediately) labels.push('failed_without_tradeable_followthrough')
  if (!tradableWin && !closeWin) labels.push('miss_no_upside')

  if (!catalystWindowCount || (!catalystInWindow && Number(catalystAge) > 360)) {
    labels.push('no_fresh_catalyst')
    reasons.push('Catalyst was absent, stale, or outside the active prediction window.')
  }
  if (Number(changePct) >= 20 && Number(catalystAge) > 240) {
    labels.push('already_priced_in')
    reasons.push('Large move was already present while the selected catalyst was several hours old.')
  }
  if (Number(messageCount) <= 0 || riskFlags.includes('LOW_OR_MISSING_SOCIAL_CONFIRMATION')) {
    labels.push('social_confirmation_failed')
    reasons.push('Prediction lacked enough direct social/message-density confirmation.')
  }
  if (thresholdStatus && thresholdStatus !== 'entry_passed') {
    labels.push('density_entry_not_crossed')
    reasons.push(`Density/correlation threshold status was ${thresholdStatus}.`)
  }
  if (thresholdSetup.includes('already_above')) {
    labels.push('stale_density_setup')
    reasons.push('Correlation setup was already active instead of a fresh cross.')
  }
  if (Number.isFinite(Number(corr)) && Number(corr) < 0) {
    labels.push('negative_density_correlation')
    reasons.push('Price/social-density correlation was negative at prediction time.')
  }
  if (pendingOpen) {
    labels.push(pendingConfirmed ? 'pending_open_confirmed_at_signal' : 'pending_open_unconfirmed_at_signal')
    reasons.push(pendingConfirmed ? 'Pending-open catalyst had at least one secondary confirmation at prediction time.' : 'Pending-open catalyst lacked the required secondary confirmation at prediction time.')
  }
  if (pendingPayoffOverride) {
    labels.push('pending_open_payoff_override')
    reasons.push('Pending-open catalyst was allowed through despite being below the payoff model threshold; high conviction still required payoff validation.')
  }
  if (catalystQualityTier === 'weak' || catalystQualityTier === 'reject' || (Number.isFinite(Number(catalystQualityScore)) && Number(catalystQualityScore) < 68)) {
    labels.push('weak_catalyst_quality')
    reasons.push(`Catalyst quality was ${catalystQualityTier || 'low'}${catalystQualityScore != null ? ` (${catalystQualityScore}/100)` : ''}.`)
  }
  if (firstReactionState) {
    labels.push(`first_reaction_${firstReactionState}`)
    reasons.push(`First reaction state at prediction time was ${firstReactionState}.`)
  }
  if (riskFlags.includes('LOW_OR_MISSING_SOCIAL_CONFIRMATION')) labels.push('risk_flag_low_social')
  if (riskFlags.includes('NO_FRESH_DENSITY_ENTRY_CROSS')) labels.push('risk_flag_no_fresh_density_cross')

  const primary = payoffWin
    ? fadedFromHigh ? 'profit_capture_win_after_fade' : 'clean_payoff_win'
    : tradableWin
      ? 'tradable_but_exit_needed'
      : labels.includes('already_priced_in')
        ? 'already_priced_in_miss'
        : labels.includes('no_fresh_catalyst')
          ? 'no_fresh_catalyst_miss'
          : labels.includes('social_confirmation_failed')
            ? 'social_failed_miss'
            : labels.includes('density_entry_not_crossed')
              ? 'density_failed_miss'
              : failedImmediately
                ? 'failed_without_followthrough'
                : closeWin
                  ? 'small_close_win'
                  : 'unclassified_miss'

  return {
    ...outcome,
    professor_win: Boolean(payoffWin || tradableWin || closeWin),
    payoff_capture_win: Boolean(payoffWin),
    tradable_win: Boolean(tradableWin),
    close_win: Boolean(closeWin),
    faded_from_high: Boolean(fadedFromHigh),
    postmortem_primary_label: primary,
    postmortem_labels: Array.from(new Set(labels)),
    postmortem_reasons: Array.from(new Set(reasons)),
    postmortem_inputs: {
      close_return_pct: closeReturn,
      high_return_pct: highReturn,
      low_return_pct: lowReturn,
      payoff_capture_return_pct: payoffReturn,
      catalyst_age_minutes: catalystAge ?? null,
      catalyst_in_window: catalystInWindow,
      catalyst_window_article_count: catalystWindowCount ?? null,
      change_pct: changePct ?? null,
      message_count: messageCount ?? null,
      correlation_score: corr ?? null,
      threshold_status: thresholdStatus || null,
      threshold_setup_status: thresholdSetup || null,
      catalyst_quality_tier: catalystQualityTier || null,
      catalyst_quality_score: catalystQualityScore ?? null,
      pending_open: pendingOpen,
      pending_open_confirmed: pendingConfirmed ?? null,
      pending_open_payoff_override: pendingPayoffOverride,
      first_reaction_state: firstReactionState || null,
      catalyst_sec: catalystSec(row),
      label_candle_count: Array.isArray(candles) ? candles.length : null,
    },
  }
}

async function fetchDailyCandles(ticker) {
  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}`)
  url.searchParams.set('range', '2mo')
  url.searchParams.set('interval', '1d')
  url.searchParams.set('includePrePost', 'false')
  url.searchParams.set('events', 'history')
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'FeedFlashStockDashboard/0.1',
      Accept: 'application/json',
    },
  })
  if (!response.ok) throw new Error(`${ticker} chart provider HTTP ${response.status}`)
  const payload = await response.json()
  const result = payload?.chart?.result?.[0]
  const timestamps = result?.timestamp || []
  const quote = result?.indicators?.quote?.[0] || {}
  const candles = []
  for (let i = 0; i < timestamps.length; i += 1) {
    const open = Number(quote.open?.[i])
    const high = Number(quote.high?.[i])
    const low = Number(quote.low?.[i])
    const close = Number(quote.close?.[i])
    if (![open, high, low, close].every(Number.isFinite)) continue
    if (open <= 0 || high <= 0 || low <= 0 || close <= 0) continue
    candles.push({
      time: Number(timestamps[i]),
      open,
      high,
      low,
      close,
      volume: Number.isFinite(Number(quote.volume?.[i])) ? Number(quote.volume[i]) : 0,
    })
  }
  return candles
}

async function fetchIntradayCandles(ticker) {
  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}`)
  url.searchParams.set('range', '7d')
  url.searchParams.set('interval', '5m')
  url.searchParams.set('includePrePost', 'true')
  url.searchParams.set('events', 'history')
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'FeedFlashStockDashboard/0.1',
      Accept: 'application/json',
    },
  })
  if (!response.ok) throw new Error(`${ticker} intraday chart provider HTTP ${response.status}`)
  const payload = await response.json()
  const result = payload?.chart?.result?.[0]
  const timestamps = result?.timestamp || []
  const quote = result?.indicators?.quote?.[0] || {}
  const candles = []
  for (let i = 0; i < timestamps.length; i += 1) {
    const close = Number(quote.close?.[i])
    if (!Number.isFinite(close) || close <= 0) continue
    const open = Number(quote.open?.[i])
    const high = Number(quote.high?.[i])
    const low = Number(quote.low?.[i])
    candles.push({
      time: Number(timestamps[i]),
      open: Number.isFinite(open) && open > 0 ? open : close,
      high: Number.isFinite(high) && high > 0 ? high : close,
      low: Number.isFinite(low) && low > 0 ? low : close,
      close,
      volume: Number.isFinite(Number(quote.volume?.[i])) ? Number(quote.volume[i]) : 0,
    })
  }
  return candles
}

function easternParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  return Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]))
}

function sessionForSec(sec) {
  const parts = easternParts(new Date(Number(sec || 0) * 1000))
  const weekday = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay()
  if (weekday === 0 || weekday === 6) return 'weekend'
  const minutes = parts.hour * 60 + parts.minute
  if (minutes >= 4 * 60 && minutes < 9 * 60 + 30) return 'premarket'
  if (minutes >= 9 * 60 + 30 && minutes < 16 * 60) return 'regular'
  if (minutes >= 16 * 60 && minutes < 20 * 60) return 'afterhours'
  return 'closed'
}

function dateKeyEt(sec) {
  const p = easternParts(new Date(Number(sec || 0) * 1000))
  return `${String(p.year).padStart(4, '0')}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`
}

function sessionTargetForRow(row = {}, snapshot = {}) {
  const session = row.prediction_session || snapshot.prediction_session_context?.session || row.prediction?.predictionSession || ''
  const target = row.prediction_target || snapshot.prediction_session_context?.target || row.prediction?.predictionTarget || ''
  if (target) return target
  if (session === 'premarket' || session === 'overnight' || session === 'weekend') return 'regular_session_risers'
  if (session === 'regular') return 'late_day_and_afterhours_continuation'
  if (session === 'afterhours' || session === 'closed_post_afterhours') return 'afterhours_and_next_premarket_risers'
  return 'next_regular_session'
}

function intradaySessionLabel(row, snapshotSec, candles, snapshot = {}) {
  const entryPrice = Number(row.price || row.prediction?.entry_price || row.entry_price || 0)
  if (!entryPrice) return null
  const target = sessionTargetForRow(row, snapshot)
  const after = candles.filter(candle => Number(candle.time || 0) > Number(snapshotSec || 0))
  if (!after.length) return { outcome_status: 'pending', reason: 'no_intraday_candles_after_snapshot' }
  const snapshotDate = dateKeyEt(snapshotSec)
  const targetCandles = after.filter(candle => {
    const session = sessionForSec(candle.time)
    const d = dateKeyEt(candle.time)
    if (target === 'regular_session_risers') return session === 'regular'
    if (target === 'late_day_and_afterhours_continuation') return d === snapshotDate && (session === 'regular' || session === 'afterhours')
    if (target === 'afterhours_and_next_premarket_risers') return session === 'afterhours' || session === 'premarket'
    return session === 'regular'
  })
  if (!targetCandles.length) return { outcome_status: 'pending', reason: `no_intraday_candles_for_${target}` }
  const first = targetCandles[0]
  const last = targetCandles[targetCandles.length - 1]
  const high = Math.max(...targetCandles.map(c => Number(c.high || c.close || 0)).filter(Number.isFinite))
  const low = Math.min(...targetCandles.map(c => Number(c.low || c.close || 0)).filter(Number.isFinite))
  const predictedReturn = Number(row.predicted_return)
  const predictedDirection = predictedReturn > 0 ? 'up' : predictedReturn < 0 ? 'down' : 'watch'
  const closeReturn = pct(entryPrice, last.close)
  const highReturn = pct(entryPrice, high)
  const lowReturn = pct(entryPrice, low)
  const payoffCapture = simulatePayoffCapture(entryPrice, targetCandles)
  return {
    outcome_status: 'labeled',
    label_source: targetCandles.some(candle => candle.source === 'mongo_ohlcv_bars') ? 'mongo_ohlcv_bars_intraday' : 'yahoo_5m_intraday_prepost',
    horizon: target,
    entry_price: Number(entryPrice.toFixed(4)),
    prediction_snapshot_sec: Number(snapshotSec || 0),
    label_start_sec: Number(first.time),
    label_end_sec: Number(last.time),
    first_price: Number(first.close.toFixed(4)),
    last_price: Number(last.close.toFixed(4)),
    high: Number(high.toFixed(4)),
    low: Number(low.toFixed(4)),
    close_return_pct: closeReturn,
    high_return_pct: highReturn,
    low_return_pct: lowReturn,
    max_gain_pct: highReturn,
    max_drawdown_pct: lowReturn,
    predicted_return: Number.isFinite(predictedReturn) ? predictedReturn : null,
    predicted_direction: predictedDirection,
    direction_correct_close: predictedDirection === 'up' ? closeReturn > 0 : predictedDirection === 'down' ? closeReturn < 0 : null,
    touched_positive: highReturn > 0,
    payoff_capture_return_pct: payoffCapture?.return_pct ?? null,
    payoff_capture_win: payoffCapture?.won ?? null,
    payoff_capture_exit_reason: payoffCapture?.exit_reason ?? null,
    payoff_capture_exit_price: payoffCapture?.exit_price ?? null,
    payoff_capture_exit_sec: payoffCapture?.exit_sec ?? null,
    payoff_capture_partial_exit_price: payoffCapture?.partial_exit_price ?? null,
    payoff_capture_peak_return_pct: payoffCapture?.peak_return_pct ?? null,
    target_session: target,
    labeled_at: new Date(),
  }
}

function nextTradingDayLabel(row, snapshotSec, candles) {
  const entryPrice = Number(row.price || row.prediction?.entry_price || row.entry_price || 0)
  if (!entryPrice) return { outcome_status: 'unavailable', reason: 'missing_entry_price' }
  const next = candles.find(candle => Number(candle.time || 0) > Number(snapshotSec || 0) + 60 * 60)
  if (!next) return { outcome_status: 'pending', reason: 'no_next_daily_candle_yet' }

  const predictedReturn = Number(row.predicted_return)
  const predictedDirection = predictedReturn > 0 ? 'up' : predictedReturn < 0 ? 'down' : 'watch'
  const closeReturn = pct(entryPrice, next.close)
  const highReturn = pct(entryPrice, next.high)
  const lowReturn = pct(entryPrice, next.low)
  return {
    outcome_status: 'labeled',
    label_source: 'yahoo_daily_chart',
    horizon: 'next_trading_day',
    entry_price: Number(entryPrice.toFixed(4)),
    prediction_snapshot_sec: Number(snapshotSec || 0),
    label_candle_sec: Number(next.time),
    label_date_utc: new Date(Number(next.time) * 1000).toISOString().slice(0, 10),
    open: Number(next.open.toFixed(4)),
    high: Number(next.high.toFixed(4)),
    low: Number(next.low.toFixed(4)),
    close: Number(next.close.toFixed(4)),
    volume: Number(next.volume || 0),
    open_return_pct: pct(entryPrice, next.open),
    high_return_pct: highReturn,
    low_return_pct: lowReturn,
    close_return_pct: closeReturn,
    max_gain_pct: highReturn,
    max_drawdown_pct: lowReturn,
    predicted_return: Number.isFinite(predictedReturn) ? predictedReturn : null,
    predicted_direction: predictedDirection,
    direction_correct_close: predictedDirection === 'up' ? closeReturn > 0 : predictedDirection === 'down' ? closeReturn < 0 : null,
    touched_positive: highReturn > 0,
    labeled_at: new Date(),
  }
}

async function main() {
  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI || argValue('mongo', 'mongodb://localhost:27017/feedflash')
  const limit = Math.max(1, Math.min(500, toNumber(argValue('limit', '100'), 100)))
  const snapshotId = argValue('snapshot', '')
  const includeRaw = argValue('includeRaw', 'true') !== 'false'
  const includeHigh = argValue('includeHigh', 'true') !== 'false'

  await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 10000 })
  const db = mongoose.connection.db
  const filter = snapshotId
    ? { _id: snapshotId }
    : {
        $or: [
          { 'raw_rows.outcome.outcome_status': { $exists: false } },
          { 'high_conviction_rows.outcome.outcome_status': { $exists: false } },
          { 'raw_rows.outcome.outcome_status': { $in: ['pending', 'unavailable'] } },
          { 'high_conviction_rows.outcome.outcome_status': { $in: ['pending', 'unavailable'] } },
        ],
      }
  const snapshots = await db.collection('daily_prediction_snapshots')
    .find(filter)
    .sort({ generated_at: -1 })
    .limit(limit)
    .toArray()

  const tickerCandles = new Map()
  const tickerIntradayCandles = new Map()
  const tickerMongoIntradayCandles = new Map()
  const outcomes = []
  let labeled = 0
  let pending = 0

  for (const snapshot of snapshots) {
    const snapshotSec = Number(snapshot.generated_at_sec || Math.floor(new Date(snapshot.generated_at || 0).getTime() / 1000))
    const rowGroups = []
    if (includeRaw) rowGroups.push(['raw_rows', Array.isArray(snapshot.raw_rows) ? snapshot.raw_rows : []])
    if (includeHigh) rowGroups.push(['high_conviction_rows', Array.isArray(snapshot.high_conviction_rows) ? snapshot.high_conviction_rows : []])
    const updated = {}

    for (const [field, rows] of rowGroups) {
      const nextRows = []
      for (const row of rows) {
        if (row.outcome?.outcome_status === 'labeled') {
          nextRows.push(row)
          continue
        }
        const ticker = String(row.ticker || '').toUpperCase()
        if (!ticker) {
          nextRows.push(row)
          continue
        }
        const mongoKey = `${ticker}:${snapshotSec}`
        if (!tickerMongoIntradayCandles.has(mongoKey)) {
          try { tickerMongoIntradayCandles.set(mongoKey, await fetchMongoIntradayCandles(db, ticker, snapshotSec)) }
          catch (err) { tickerMongoIntradayCandles.set(mongoKey, { error: String(err.message || err) }) }
        }
        const mongoIntradayResult = tickerMongoIntradayCandles.get(mongoKey)
        if ((!Array.isArray(mongoIntradayResult) || !mongoIntradayResult.length) && !tickerCandles.has(ticker)) {
          try { tickerCandles.set(ticker, await fetchDailyCandles(ticker)) }
          catch (err) { tickerCandles.set(ticker, { error: String(err.message || err) }) }
        }
        if ((!Array.isArray(mongoIntradayResult) || !mongoIntradayResult.length) && !tickerIntradayCandles.has(ticker)) {
          try { tickerIntradayCandles.set(ticker, await fetchIntradayCandles(ticker)) }
          catch (err) { tickerIntradayCandles.set(ticker, { error: String(err.message || err) }) }
        }
        const candleResult = tickerCandles.get(ticker)
        const intradayResult = Array.isArray(mongoIntradayResult) && mongoIntradayResult.length
          ? mongoIntradayResult
          : tickerIntradayCandles.get(ticker)
        const intradayOutcome = Array.isArray(intradayResult)
          ? intradaySessionLabel(row, snapshotSec, intradayResult, snapshot)
          : { outcome_status: 'unavailable', reason: intradayResult?.error || mongoIntradayResult?.error || 'intraday_chart_fetch_failed' }
        const baseOutcome = intradayOutcome?.outcome_status === 'labeled'
          ? intradayOutcome
          : Array.isArray(candleResult)
            ? { ...nextTradingDayLabel(row, snapshotSec, candleResult), intraday_status: intradayOutcome?.outcome_status, intraday_reason: intradayOutcome?.reason }
            : { outcome_status: 'unavailable', reason: candleResult?.error || 'chart_fetch_failed', intraday_status: intradayOutcome?.outcome_status, intraday_reason: intradayOutcome?.reason }
        const outcome = classifyOutcome(row, baseOutcome, Array.isArray(intradayResult) ? intradayResult : [])
        if (outcome.outcome_status === 'labeled') labeled += 1
        if (outcome.outcome_status === 'pending') pending += 1
        const outcomeDoc = {
          _id: `${snapshot._id}:${field}:${ticker}`,
          snapshot_id: snapshot._id,
          date_key: snapshot.date_key,
          row_group: field,
          ticker,
          rank: row.rank,
          final_prediction_score: row.final_prediction_score,
          signal_quality: row.signal_quality,
          risk_flags: row.risk_flags || [],
          outcome,
          updated_at: new Date(),
        }
        await db.collection('prediction_outcomes').updateOne(
          { _id: outcomeDoc._id },
          { $set: outcomeDoc, $setOnInsert: { created_at: new Date() } },
          { upsert: true }
        )
        outcomes.push(outcomeDoc)
        nextRows.push({
          ...row,
          outcome,
          outcome_status: outcome.outcome_status,
          realized_return_pct: outcome.close_return_pct ?? null,
          realized_high_return_pct: outcome.high_return_pct ?? null,
          realized_low_return_pct: outcome.low_return_pct ?? null,
          realized_price: outcome.last_price ?? outcome.close ?? null,
          realized_at: outcome.label_end_sec
            ? new Date(Number(outcome.label_end_sec) * 1000)
            : outcome.label_candle_sec
              ? new Date(Number(outcome.label_candle_sec) * 1000)
              : null,
          direction_correct_close: outcome.direction_correct_close ?? null,
        })
      }
      updated[field] = nextRows
    }

    await db.collection('daily_prediction_snapshots').updateOne(
      { _id: snapshot._id },
      {
        $set: {
          ...updated,
          outcomes_labeled_at: new Date(),
          updated_at: new Date(),
        },
      }
    )
  }

  await db.collection('prediction_outcomes').createIndex({ snapshot_id: 1, ticker: 1 })
  await db.collection('prediction_outcomes').createIndex({ ticker: 1, 'outcome.label_candle_sec': -1 })

  console.log(JSON.stringify({
    ok: true,
    snapshots_checked: snapshots.length,
    outcomes_written: outcomes.length,
    labeled,
    pending,
    examples: outcomes.slice(0, 10).map(row => ({
      snapshot_id: row.snapshot_id,
      group: row.row_group,
      ticker: row.ticker,
      score: row.final_prediction_score,
      status: row.outcome.outcome_status,
      close_return_pct: row.outcome.close_return_pct,
      high_return_pct: row.outcome.high_return_pct,
      payoff_capture_return_pct: row.outcome.payoff_capture_return_pct,
      professor_win: row.outcome.professor_win,
      postmortem_primary_label: row.outcome.postmortem_primary_label,
      postmortem_labels: row.outcome.postmortem_labels,
      direction_correct_close: row.outcome.direction_correct_close,
      reason: row.outcome.reason,
    })),
  }, null, 2))

  await mongoose.disconnect()
}

main().catch(async err => {
  console.error(JSON.stringify({ ok: false, error: String(err.message || err) }, null, 2))
  try { await mongoose.disconnect() } catch (_) {}
  process.exit(1)
})
