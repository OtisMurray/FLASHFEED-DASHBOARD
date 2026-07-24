import { Router } from 'express'
import mongoose from 'mongoose'
import {
  evaluatePredictionEntryThreshold,
  predictionMarketCapTier,
} from './screener.js'
import { simulatePayoffCapture, normalizeCandle } from '../lib/payoffCapture.js'
import {
  rollingCorrelation,
  densityByMinuteFor,
  findBarAtOrBefore,
  pctReturn,
  trailingMessageCount,
  loadRawSocialCountsFor,
} from '../lib/thresholdFeatures.js'

// GET /api/v11-screener?limit=30&maxCandidates=120
//
// EXPERIMENTAL PROFILE PROBE — not a third interchangeable screener.
//
// Evaluates one specific backtest strategy profile ("v11") over the
// catalyst-enriched prediction universe (daily_prediction_snapshots), POSTMORTEM
// only: for each enriched candidate it replays the candidate's completed target
// session and asks "would v11 have entered, and how would its multi-leg exit have
// played out?". It reuses the exact production functions rather than porting math:
//   - evaluatePredictionEntryThreshold(row, V11_PROFILE)  → cross + pre-move + msg gate
//   - simulatePayoffCapture(entry, candles, V11_PROFILE)  → 50%@+5% / giveback / stop / EOD
// plus two v11-only gates layered on top: the active-move (0–12%) band and the
// low-float/Nano evidence guard (catalyst OR social OR short-interest support).
//
// v11 needs a 120-minute correlation window, which no STORED tier feature uses,
// so the 120m corr / pre-60m return / trailing-60m message features are recomputed
// live per candidate from Mongo ohlcv_bars + socials (chart-service is NOT touched).
//
// CONFIDENTIALITY BOUNDARY: reads only Mongo (daily_prediction_snapshots,
// ohlcv_bars, socials) via this repo's own math. It must never read from or import
// anything under ~/dev/research-students (confidential student research data).

const router = Router()

// ── The v11 profile (fixed; this is what we are testing) ──────────────────────
export const V11_PROFILE = {
  label: 'v11',
  policyVersion: 'v11_experimental_profile',
  entrySignal: 'corr120_crosses_above_0.38_with_premove_active_move_message_and_lowfloat_evidence_gates',
  windowMinutes: 120,
  smoothingMinutes: 120,
  thresholdC: 0.38,
  setupNearThresholdBand: 0.05,
  maxPreSignalReturn60mPct: 4,     // prior 60m return must be <= +4%
  minTrailing60Messages: 3,        // >= 3 trailing-60m messages
  minSignalChangePct: 0,           // explicit override threaded into the policy gate
  maxSignalChangePct: 12,
  activeMoveMinPct: 0,             // the active move itself must be in [0%, 12%]
  activeMoveMaxPct: 12,
  // Exit == V7_PAYOFF_CAPTURE_EXIT (screener.js): 50% at +5%; runner gives back 5%
  // after reaching +10%; 3% protective stop on the whole position; EOD flatten.
  exitStrategy: 'partial_profit_then_profit_giveback_runner',
  partialExitFraction: 0.5,
  partialProfitTargetPct: 5,
  profitGivebackPct: 5,
  profitGivebackActivationPct: 10,
  protectiveStopPct: 3,
  runnerTrailingStopPct: 99,
  trailingStopPct: 10,
  exitPlan: 'sell 50% at +5%; hold the runner until it gives back 5% after reaching +10%; keep the 3% protective stop and flatten by end of day',
}

// Correlation floor: require at least this many observations in the rolling window
// before a corr is defined. Mirrors the feature-writer's default (30); v11's
// 120m window still needs a warm-up but does not demand a strictly full window.
const V11_MIN_OBSERVATIONS = 30

// Evidence-gate thresholds — kept in sync with routes/screener.js's fuller
// recognized*Catalyst gates (SQUEEZE_WATCHER_MIN, PREDICTION_PEOPLE_MIN_MESSAGES,
// verifiedShortInterest). This is a compact proxy of that logic for the probe.
const SQUEEZE_WATCHER_MIN = Math.max(1000, Number(process.env.SQUEEZE_WATCHER_MIN || 5000))
const PEOPLE_MIN_MESSAGES = Math.max(1, Number(process.env.PREDICTION_PEOPLE_MIN_MESSAGES || 12))

const DEFAULT_LIMIT = 30
const MAX_LIMIT = 100
const DEFAULT_MAX_CANDIDATES = 120
const CONCURRENCY = 6

function clamp(value, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return min
  return Math.max(min, Math.min(max, n))
}

function num(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

// ── v11-only evidence guard: for low-float (Nano) names, require >= 1 of
// {catalyst support, social support, short-interest support}. Non-low-float tiers
// are not gated by this rule. When the underlying fields are entirely absent the
// guard FAILS CLOSED (evidence_unavailable) rather than silently passing. ──
function v11EvidenceGate(row, tier) {
  const lowFloat = tier === 'Nano'
  const shortInterestPct = num(row.short_interest_pct ?? row.short_interest_pct_shares_out ?? row.short_interest_pct_float)
  const floatShort = num(row.float_short)
  const catalystPower = num(row.catalyst_power_score) || 0
  const catalystArticles = num(row.catalyst_window_article_count ?? row.news_article_count) || 0
  const watcherCount = num(row.stocktwits_watcher_count) || 0
  const messages = num(row.message_count ?? row.threshold_trailing_60m_messages) || 0

  const shortSupport = (shortInterestPct != null && shortInterestPct >= 10) || (floatShort != null && floatShort >= 10)
  const catalystSupport = catalystPower >= 1 || catalystArticles > 0
  const socialSupport = watcherCount >= SQUEEZE_WATCHER_MIN || messages >= PEOPLE_MIN_MESSAGES

  if (!lowFloat) {
    return { required: false, ok: true, status: 'not_low_float', shortSupport, catalystSupport, socialSupport }
  }
  const dataPresent = shortInterestPct != null || floatShort != null || catalystPower > 0 || catalystArticles > 0 || watcherCount > 0 || messages > 0
  if (!dataPresent) {
    return { required: true, ok: false, status: 'evidence_unavailable', shortSupport, catalystSupport, socialSupport }
  }
  const ok = shortSupport || catalystSupport || socialSupport
  return { required: true, ok, status: ok ? 'evidence_ok' : 'evidence_missing', shortSupport, catalystSupport, socialSupport }
}

// Target ET session bounds (bars are naive-ET-encoded-as-UTC, so a UTC-midnight
// day window isolates exactly that ET session, 04:00–20:00 ET included).
function sessionBoundsSec(dateStr) {
  const start = Math.floor(Date.parse(`${dateStr}T00:00:00Z`) / 1000)
  if (!Number.isFinite(start)) return null
  return { startSec: start, endSec: start + 24 * 3600 }
}

async function loadSessionBars(db, ticker, startSec, endSec) {
  const docs = await db.collection('ohlcv_bars')
    .find({
      ticker: String(ticker).toUpperCase(),
      minute: { $gte: startSec, $lt: endSec },
    }, {
      projection: { _id: 0, ticker: 1, minute: 1, time: 1, open: 1, high: 1, low: 1, close: 1, price: 1, volume: 1 },
    })
    .sort({ minute: 1 })
    .limit(2000)
    .toArray()
    .catch(() => [])
  // Normalize to {minute, close, high, low, open, ...}; keep epoch-sec `minute`.
  return docs
    .map(doc => {
      const candle = normalizeCandle(doc, 'mongo_ohlcv_bars')
      return candle ? { ...candle, minute: candle.time } : null
    })
    .filter(Boolean)
}

// Replay one candidate's completed target session through the v11 profile.
async function replayCandidate(db, candidate) {
  const ticker = String(candidate.ticker || '').toUpperCase()
  const sessionDate = candidate.targetDate || candidate.predictionDate
  const tier = predictionMarketCapTier(candidate)
  const base = {
    ticker,
    company: candidate.company || '',
    tier,
    market_cap: num(candidate.market_cap),
    session_date: sessionDate || null,
    prediction_date: candidate.predictionDate || null,
    target_date: candidate.targetDate || null,
    catalyst_reason: candidate.catalystReason || candidate.catalyst_reason || candidate.main_catalyst?.title || '',
  }
  if (!ticker || !sessionDate) return { ...base, status: 'missing_session_date' }

  const bounds = sessionBoundsSec(sessionDate)
  if (!bounds) return { ...base, status: 'bad_session_date' }

  const bars = await loadSessionBars(db, ticker, bounds.startSec, bounds.endSec)
  if (bars.length < V11_MIN_OBSERVATIONS + 2) {
    return { ...base, status: 'insufficient_bars', bars: bars.length }
  }

  // Evidence guard is a candidate-level property (not per-minute); evaluate once.
  const evidence = v11EvidenceGate(candidate, tier)

  // 120m causal density + rolling correlation over the session.
  const rawCounts = await loadRawSocialCountsFor(db, new Set([ticker]), bounds.startSec, bounds.endSec)
  const densityByMinute = densityByMinuteFor(ticker, bars, rawCounts, V11_PROFILE.smoothingMinutes)
  const corrByMinute = rollingCorrelation(bars, densityByMinute, V11_PROFILE.windowMinutes, V11_MIN_OBSERVATIONS)

  const sessionOpen = bars[0].close
  let entered = null
  let lastReject = null

  // Scan for the FIRST minute where corr crosses up through the threshold AND all
  // gates pass. The entry executes at the next real bar's close (t+1), per policy.
  for (let i = 1; i < bars.length; i += 1) {
    const bar = bars[i]
    const prev = corrByMinute.get(bars[i - 1].minute)
    const cur = corrByMinute.get(bar.minute)
    if (prev == null || cur == null) continue
    const crossedUp = prev <= V11_PROFILE.thresholdC && cur > V11_PROFILE.thresholdC
    if (!crossedUp) continue

    const prior = findBarAtOrBefore(bars, bar.minute - 60 * 60)
    const pre60 = prior ? pctReturn(prior.close, bar.close) : null
    const activeMove = pctReturn(sessionOpen, bar.close)
    const trailing60 = trailingMessageCount(ticker, bar.minute, rawCounts, 60)

    // Reuse the production gate with the v11 profile override.
    const synthetic = {
      ...candidate,
      price_density_correlation: cur,
      previous_price_density_correlation: prev,
      threshold_pre_return_60m_pct: pre60,
      threshold_trailing_60m_messages: trailing60,
    }
    const gate = evaluatePredictionEntryThreshold(synthetic, V11_PROFILE)
    const activeMoveOk = activeMove != null && activeMove >= V11_PROFILE.activeMoveMinPct && activeMove <= V11_PROFILE.activeMoveMaxPct

    if (gate.passed && activeMoveOk && evidence.ok) {
      const entryBar = bars[i + 1] || bar     // execute at next real bar close (t+1)
      entered = { i, signalBar: bar, entryBar, corr: cur, prevCorr: prev, pre60, activeMove, trailing60, gate }
      break
    }
    // Remember the most-progressed near-miss for diagnostics.
    lastReject = {
      minute: bar.minute,
      corr: cur,
      pre60,
      activeMove,
      trailing60,
      reason: !activeMoveOk
        ? `active move ${activeMove == null ? 'n/a' : `${activeMove.toFixed(2)}%`} outside [${V11_PROFILE.activeMoveMinPct}, ${V11_PROFILE.activeMoveMaxPct}]%`
        : !evidence.ok
          ? `low-float evidence: ${evidence.status}`
          : gate.status,
    }
  }

  if (!entered) {
    return {
      ...base,
      status: 'no_entry',
      evidence,
      reject: lastReject,
      note: lastReject ? `Closest: ${lastReject.reason}` : 'No 120m correlation cross above 0.38 this session.',
    }
  }

  // Simulate the multi-leg exit forward from the entry bar over the rest of the session.
  const forward = bars.filter(b => b.minute > entered.entryBar.minute)
  const sim = simulatePayoffCapture(entered.entryBar.close, forward, V11_PROFILE)

  const entryPrice = entered.entryBar.close
  const partialPnl = sim?.partial_exit_price != null ? pctReturn(entryPrice, sim.partial_exit_price) : null
  const runnerPnl = sim?.exit_price != null ? pctReturn(entryPrice, sim.exit_price) : null

  return {
    ...base,
    status: 'entered',
    evidence,
    entry: {
      price: Number(entryPrice.toFixed(4)),
      signal_sec: entered.signalBar.minute,
      entry_sec: entered.entryBar.minute,
      corr: Number(entered.corr.toFixed(4)),
      prev_corr: Number(entered.prevCorr.toFixed(4)),
      pre_return_60m_pct: entered.pre60 == null ? null : Number(entered.pre60.toFixed(3)),
      active_move_pct: entered.activeMove == null ? null : Number(entered.activeMove.toFixed(3)),
      trailing_60m_messages: entered.trailing60,
      gate_status: entered.gate.status,
      gate_reason: entered.gate.reason,
    },
    // Two exit legs, as v11's exit is a partial + runner.
    legs: {
      partial: {
        target_pct: V11_PROFILE.partialProfitTargetPct,
        fraction: V11_PROFILE.partialExitFraction,
        filled: sim?.partial_exit_price != null,
        price: sim?.partial_exit_price ?? null,
        exit_sec: sim?.partial_exit_sec ?? null,
        pnl_pct: partialPnl == null ? null : Number(partialPnl.toFixed(3)),
      },
      runner: {
        price: sim?.exit_price ?? null,
        exit_sec: sim?.exit_sec ?? null,
        exit_reason: sim?.exit_reason ?? null,
        pnl_pct: runnerPnl == null ? null : Number(runnerPnl.toFixed(3)),
      },
    },
    outcome: sim
      ? {
          realized_return_pct: sim.return_pct,          // 50/50 blended across the two legs
          won: sim.won,
          exit_reason: sim.exit_reason,
          peak_return_pct: sim.peak_return_pct,
        }
      : { realized_return_pct: null, won: null, exit_reason: 'no_forward_bars', peak_return_pct: null },
  }
}

// Load RAW catalyst-enriched candidate docs from daily_prediction_snapshots.
//
// Deliberately does NOT go through screener.js's normalizeStoredPredictionRow:
// that normalizer returns a curated allow-list that strips market_cap_tier,
// market_cap, short_interest_pct*, float_short, and catalyst_power_score — exactly
// the fields v11's tier classification and low-float evidence guard need. We keep
// the raw doc (augmented with resolved prediction/target dates) so those fields
// survive to replayCandidate.
async function loadEnrichedCandidates(db, maxCandidates) {
  const snapshots = await db.collection('daily_prediction_snapshots')
    .find({})
    .sort({ created_at: -1, createdAt: -1, _id: -1 })
    .limit(8)
    .toArray()
    .catch(() => [])
  const out = []
  const seen = new Set()
  for (const snapshot of snapshots) {
    const snapTarget = snapshot.targetDate || snapshot.target_date || snapshot.predicted_for_date || snapshot.trading_date_predicted_for || null
    const snapPrediction = snapshot.predictionDate || snapshot.prediction_date || snapshot.date_key || snapshot.prediction_date_key || null
    const preds = [
      ...(Array.isArray(snapshot.predictions) ? snapshot.predictions : []),
      ...(Array.isArray(snapshot.rows) ? snapshot.rows : []),
      ...(Array.isArray(snapshot.high_conviction_rows) ? snapshot.high_conviction_rows : []),
    ]
    for (const raw of preds) {
      const ticker = String(raw?.ticker || raw?.symbol || '').toUpperCase()
      if (!ticker) continue
      const targetDate = raw.targetDate || raw.target_date || snapTarget
      const predictionDate = raw.predictionDate || raw.prediction_date || snapPrediction
      const key = `${ticker}|${predictionDate || ''}|${targetDate || ''}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ ...raw, ticker, predictionDate, targetDate })
      if (out.length >= maxCandidates) return out
    }
  }
  return out
}

// Simple bounded-concurrency map.
async function mapPool(items, limit, fn) {
  const out = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const idx = cursor++
      if (idx >= items.length) break
      try {
        out[idx] = await fn(items[idx], idx)
      } catch (err) {
        out[idx] = { ticker: items[idx]?.ticker, status: 'error', error: err.message }
      }
    }
  })
  await Promise.all(workers)
  return out
}

router.get('/', async (req, res) => {
  try {
    const limit = Math.round(clamp(req.query.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT))
    const maxCandidates = Math.round(clamp(req.query.maxCandidates ?? DEFAULT_MAX_CANDIDATES, 1, 400))
    const db = mongoose.connection.db
    if (!db) return res.status(503).json({ ok: false, error: 'database unavailable' })

    // 1. Catalyst-enriched candidate universe (postmortem: only rows with a
    //    completed target session).
    const enriched = await loadEnrichedCandidates(db, maxCandidates)
    const candidates = enriched.filter(row => row && row.ticker && (row.targetDate || row.predictionDate))

    if (!candidates.length) {
      return res.json({
        ok: true,
        profile: V11_PROFILE,
        universe: 'catalyst_enriched_daily_prediction_snapshots',
        mode: 'postmortem_completed_sessions',
        experimental: true,
        count: 0,
        entered: 0,
        rows: [],
        note: 'No catalyst-enriched candidates with a completed target session were found.',
      })
    }

    // 2. Replay each through the v11 profile.
    const replayed = await mapPool(candidates, CONCURRENCY, c => replayCandidate(db, c))

    // 3. Entered rows first (by realized return desc), then the rest.
    const rows = replayed.filter(Boolean)
    const entered = rows.filter(r => r.status === 'entered')
    const others = rows.filter(r => r.status !== 'entered')
    entered.sort((a, b) => (b.outcome?.realized_return_pct ?? -Infinity) - (a.outcome?.realized_return_pct ?? -Infinity))
    const ordered = [...entered, ...others].slice(0, limit)

    res.json({
      ok: true,
      profile: V11_PROFILE,
      universe: 'catalyst_enriched_daily_prediction_snapshots',
      mode: 'postmortem_completed_sessions',
      experimental: true,
      disclaimer: 'Testing a single fixed backtest profile (v11) over the catalyst-enriched set only — NOT a live trading screener and not comparable to the Entry/Exit Screeners.',
      candidates_scanned: candidates.length,
      count: ordered.length,
      entered: entered.length,
      rows: ordered,
      sorted_by: 'entered first, realized_return_pct desc',
    })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

export default router
