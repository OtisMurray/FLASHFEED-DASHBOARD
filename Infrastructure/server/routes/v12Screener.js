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

// GET /api/v12-screener?limit=30&maxCandidates=120
//
// EXPERIMENTAL PROFILE PROBE — not a third interchangeable screener.
//
// Direct sibling of routes/v11Screener.js: same universe, same postmortem-only
// framing, same discipline of reusing production functions rather than porting
// math. For each catalyst-enriched candidate it replays the completed target
// session and asks "would v12 have entered, and how would its runner exit have
// played out?".
//   - evaluatePredictionEntryThreshold(row, V12_PROFILE) → cross + pre-move
//     + message + opening-block gate
//   - simulatePayoffCapture(entry, candles, V12_PROFILE) → full-position runner
// plus the same two probe-only gates v11 layers on top: the active-move band and
// the low-float/Nano evidence guard.
//
// v12 IS NOT THE LIVE POLICY. The shared prediction-threshold policy is v11 and
// stays v11; v12 exists only as the explicit profileOverride below. Any caller
// that does not pass V12_PROFILE — the main screener, the prediction pipeline,
// the squeeze screener — resolves v11. tests/defaultPolicyIsV11.test.js enforces
// that, because installing a v12 policy file wholesale once made v12 the silent
// default for all of them.
//
// HOW v12 DIFFERS FROM v11 (the whole point of the probe):
//   - 180-minute correlation window vs 120, crossing 0.40 vs 0.38
//   - >= 5 trailing-60m messages vs >= 3
//   - active-move band widened to 0–20% from 0–12%
//   - NO new entries in the first 20 regular-session minutes (v11 has no opening gate)
//   - full-position runner: no 50%-at-+5% partial leg; 4% giveback vs 5%
//
// ── HONESTY BANNER ────────────────────────────────────────────────────────────
// v12's headline backtest (38 trades, 60.53% win rate, +2.7306% mean net, PF
// 4.4833) is RETROSPECTIVE and was NOT independently reproduced. Re-running the
// config against locally held OHLC yields a handful of trades, not 38, because
// the backtest window needs history this environment does not have.
//
// What WAS verified is narrower and worth stating precisely: every headline
// number and the entire buy-and-hold table recompute exactly from the delivered
// raw trade rows, with identical per-trade costs applied to the strategy and to
// both passive benchmarks. That proves the report matches its own trade data. It
// does not prove the trade data faithfully reflects the market.
//
// Two corrections are already folded into the numbers reported here:
//   1. The original harness computed profit giveback as a percentage of
//      ACCUMULATED PROFIT; production defines it as a percentage decline from the
//      post-entry peak. The harness was corrected and the earlier +3.2828% mean
//      was withdrawn — +2.7306% is the corrected, production-parity figure.
//   2. The published -7.8429 max drawdown was an artifact of accumulating equity
//      in ticker-grouped array order. In signal-time order it is -8.6274.
//
// And the finding that most limits this probe: v12 does NOT beat passive holding
// from the same entries. Holding to the strategy's own exit bar returns +3.0054%
// versus v12's +2.7306%, and holding to session end returns +2.6728%. Day-block
// bootstrap intervals for both alphas cross zero. The evidence supports the
// ticker-days this entry gate selects, NOT the exit overlay layered on them.
//
// Promotion criteria are unmet: 38 of 60 required trades. This route exists to
// accumulate forward evidence, not to justify a switch.
//
// CONFIDENTIALITY BOUNDARY: reads only Mongo (daily_prediction_snapshots,
// ohlcv_bars, socials) via this repo's own math. It must never read from or
// import anything under ~/dev/research-students (confidential student research
// data).

const router = Router()

// ── The v12 profile (fixed; this is what we are testing) ──────────────────────
export const V12_PROFILE = {
  label: 'v12',
  policyVersion: 'v12_experimental_profile',
  entrySignal: 'corr180_crosses_above_0.40_with_premove_active_move_message_opening_block_and_lowfloat_evidence_gates',
  windowMinutes: 180,
  smoothingMinutes: 180,
  thresholdC: 0.4,
  setupNearThresholdBand: 0.04,
  maxPreSignalReturn60mPct: 4,     // prior 60m return must be <= +4%
  minTrailing60Messages: 5,        // >= 5 trailing-60m (Small 8 / Nano 12 via floatEvidenceGates)
  minSignalChangePct: 0,           // explicit override threaded into the policy gate
  maxSignalChangePct: 20,
  // v12's defining entry change: no new positions in the first 20 regular-session
  // minutes. Pinned explicitly rather than inherited — the live base is v11 and
  // sets no opening block at all, so without this the probe would not have one.
  openingNoEntryMinutes: 20,
  openingVolatilityGuardMinutes: 20,
  openingMaxPreSignalReturn60mPct: 1.5,
  openingMinTrailing60MessagesMultiplier: 1.5,
  openingMaxSignalAbsChangePct: 8,
  activeMoveMinPct: 0,             // the active move itself must be in [0%, 20%]
  activeMoveMaxPct: 20,
  // Exit: FULL-POSITION runner. partialExitFraction is explicitly 0, not null and
  // not omitted — simulatePayoffCapture treats an OMITTED value as v11's legacy
  // 0.5 partial leg, so dropping the key would silently simulate v11's exit.
  exitStrategy: 'profit_giveback_runner',
  partialExitFraction: 0,
  partialProfitTargetPct: null,
  profitGivebackPct: 4,
  profitGivebackActivationPct: 10,
  protectiveStopPct: 3,
  runnerTrailingStopPct: 99,
  trailingStopPct: 10,
  exitPlan: 'hold the full position until it gives back 4% from a peak that reached +10%; keep the 3% protective stop and flatten by end of day',
}

// Correlation floor: require at least this many observations in the rolling
// window before a corr is defined. Mirrors v11's floor and the feature-writer's
// default; v12's 180m window needs a longer warm-up but does not demand a
// strictly full window.
const V12_MIN_OBSERVATIONS = 30

// Evidence-gate thresholds — kept in sync with routes/screener.js's fuller
// recognized*Catalyst gates, same as the v11 probe.
const SQUEEZE_WATCHER_MIN = Math.max(1000, Number(process.env.SQUEEZE_WATCHER_MIN || 5000))
const PEOPLE_MIN_MESSAGES = Math.max(1, Number(process.env.PREDICTION_PEOPLE_MIN_MESSAGES || 12))

const DEFAULT_LIMIT = 30
const MAX_LIMIT = 100
const DEFAULT_MAX_CANDIDATES = 120
const CONCURRENCY = 6

// Regular session opens 09:30 ET. Bars are naive-ET-encoded-as-UTC, so the
// minute-of-day arithmetic below is ET by construction.
const REGULAR_OPEN_MINUTE_OF_DAY = 9 * 60 + 30

function clamp(value, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return min
  return Math.max(min, Math.min(max, n))
}

function num(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function minutesSinceRegularOpen(minuteSec) {
  const d = new Date(Number(minuteSec) * 1000)
  if (Number.isNaN(d.getTime())) return null
  return d.getUTCHours() * 60 + d.getUTCMinutes() - REGULAR_OPEN_MINUTE_OF_DAY
}

// ── Probe-only evidence guard: for low-float (Nano) names, require >= 1 of
// {catalyst support, social support, short-interest support}. Identical to the
// v11 probe's guard, including failing CLOSED when the fields are absent. ──
function v12EvidenceGate(row, tier) {
  const lowFloat = tier === 'Nano'
  const shortInterestPct = num(row.short_interest_pct ?? row.short_interest_pct_shares_out ?? row.short_interest_pct_float)
  const floatShort = num(row.float_short)
  const catalystPower = num(row.catalyst_power_score) || 0
  const catalystArticles = num(row.catalyst_window_article_count ?? row.news_article_count) || 0
  const watcherCount = num(row.stocktwits_watcher_count) || 0
  // Same field-ordering rule as the v11 probe: threshold_trailing_60m_messages
  // comes from lib/thresholdFeatures.js, whose candidateTickers has always
  // deduped ticker/symbol/cashtag. message_count comes from the screener.js
  // aggregation, which counted one real message three times until the $setUnion
  // fix. Read the deduped field first so PEOPLE_MIN_MESSAGES means one thing.
  const messages = num(row.threshold_trailing_60m_messages ?? row.message_count) || 0

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
  return docs
    .map(doc => {
      const candle = normalizeCandle(doc, 'mongo_ohlcv_bars')
      return candle ? { ...candle, minute: candle.time } : null
    })
    .filter(Boolean)
}

// Replay one candidate's completed target session through the v12 profile.
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
  if (bars.length < V12_MIN_OBSERVATIONS + 2) {
    return { ...base, status: 'insufficient_bars', bars: bars.length }
  }

  // Evidence guard is a candidate-level property (not per-minute); evaluate once.
  const evidence = v12EvidenceGate(candidate, tier)

  // 180m causal density + rolling correlation over the session.
  const rawCounts = await loadRawSocialCountsFor(db, new Set([ticker]), bounds.startSec, bounds.endSec)
  const densityByMinute = densityByMinuteFor(ticker, bars, rawCounts, V12_PROFILE.smoothingMinutes)
  const corrByMinute = rollingCorrelation(bars, densityByMinute, V12_PROFILE.windowMinutes, V12_MIN_OBSERVATIONS)

  const sessionOpen = bars[0].close
  let entered = null
  let lastReject = null
  let openingBlocked = 0

  // Scan for the FIRST minute where corr crosses up through the threshold AND all
  // gates pass. The entry executes at the next real bar's close (t+1), per policy.
  for (let i = 1; i < bars.length; i += 1) {
    const bar = bars[i]
    const prev = corrByMinute.get(bars[i - 1].minute)
    const cur = corrByMinute.get(bar.minute)
    if (prev == null || cur == null) continue
    const crossedUp = prev <= V12_PROFILE.thresholdC && cur > V12_PROFILE.thresholdC
    if (!crossedUp) continue

    const prior = findBarAtOrBefore(bars, bar.minute - 60 * 60)
    const pre60 = prior ? pctReturn(prior.close, bar.close) : null
    const activeMove = pctReturn(sessionOpen, bar.close)
    const trailing60 = trailingMessageCount(ticker, bar.minute, rawCounts, 60)

    // Reuse the production gate with the v12 profile override. The signal minute
    // is what makes the opening block evaluable — without it the gate cannot know
    // where in the session it is, and v12's defining rule would be skipped.
    const synthetic = {
      ...candidate,
      threshold_feature_snapshot_sec: bar.minute,
      price_density_correlation: cur,
      previous_price_density_correlation: prev,
      threshold_pre_return_60m_pct: pre60,
      threshold_trailing_60m_messages: trailing60,
    }
    const gate = evaluatePredictionEntryThreshold(synthetic, V12_PROFILE)
    const activeMoveOk = activeMove != null && activeMove >= V12_PROFILE.activeMoveMinPct && activeMove <= V12_PROFILE.activeMoveMaxPct

    if (gate.openingVolatilityGuard?.no_entry_active) openingBlocked += 1

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
      minutes_since_open: minutesSinceRegularOpen(bar.minute),
      reason: !activeMoveOk
        ? `active move ${activeMove == null ? 'n/a' : `${activeMove.toFixed(2)}%`} outside [${V12_PROFILE.activeMoveMinPct}, ${V12_PROFILE.activeMoveMaxPct}]%`
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
      opening_blocked_crosses: openingBlocked,
      note: lastReject
        ? `Closest: ${lastReject.reason}`
        : 'No 180m correlation cross above 0.40 this session.',
    }
  }

  // Simulate the full-position runner exit forward from the entry bar.
  const forward = bars.filter(b => b.minute > entered.entryBar.minute)
  const sim = simulatePayoffCapture(entered.entryBar.close, forward, V12_PROFILE)

  const entryPrice = entered.entryBar.close
  const runnerPnl = sim?.exit_price != null ? pctReturn(entryPrice, sim.exit_price) : null

  return {
    ...base,
    status: 'entered',
    evidence,
    opening_blocked_crosses: openingBlocked,
    entry: {
      price: Number(entryPrice.toFixed(4)),
      signal_sec: entered.signalBar.minute,
      entry_sec: entered.entryBar.minute,
      minutes_since_open: minutesSinceRegularOpen(entered.signalBar.minute),
      corr: Number(entered.corr.toFixed(4)),
      prev_corr: Number(entered.prevCorr.toFixed(4)),
      pre_return_60m_pct: entered.pre60 == null ? null : Number(entered.pre60.toFixed(3)),
      active_move_pct: entered.activeMove == null ? null : Number(entered.activeMove.toFixed(3)),
      trailing_60m_messages: entered.trailing60,
      gate_status: entered.gate.status,
      gate_reason: entered.gate.reason,
    },
    // ONE leg, unlike v11. The partial is reported as explicitly disabled rather
    // than omitted, so a client diffing v11 against v12 sees why the blended
    // return it knows from v11 is absent here.
    legs: {
      partial: {
        enabled: false,
        reason: 'v12 holds the full position; there is no partial profit leg',
        fraction: 0,
      },
      runner: {
        fraction: 1,
        price: sim?.exit_price ?? null,
        exit_sec: sim?.exit_sec ?? null,
        exit_reason: sim?.exit_reason ?? null,
        pnl_pct: runnerPnl == null ? null : Number(runnerPnl.toFixed(3)),
      },
    },
    outcome: sim
      ? {
          realized_return_pct: sim.return_pct,          // whole position, single leg
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
// market_cap, short_interest_pct*, float_short, and catalyst_power_score —
// exactly the fields tier classification and the low-float evidence guard need.
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

// Shipped with every response so the caveats travel with the data rather than
// living only in this file's header, where an API consumer never sees them.
const BACKTEST_PROVENANCE = {
  headline: '38 trades, 60.53% win rate, +2.7306% mean net, PF 4.4833, -8.6274 chronological max drawdown',
  source_backtest: 'backtests/message_density_thresholds/outputs_v12_final_confirmation_mongo_ohlc',
  independently_reproduced: false,
  reproduction_note: 'The 38-trade result was NOT re-derived locally: the backtest window requires OHLC history not held in this environment, so re-running the config produces a handful of trades, not 38. Verified instead: every headline number and the full buy-and-hold table recompute exactly from the delivered raw trade rows, with identical per-trade costs on the strategy and both passive benchmarks.',
  corrections_applied: [
    'The original harness computed profit giveback as a percentage of ACCUMULATED PROFIT; production defines it as a percentage decline from the post-entry peak. The harness was corrected and the earlier +3.2828% mean was WITHDRAWN. +2.7306% is the corrected production-parity figure.',
    'The published -7.8429 max drawdown was an artifact of accumulating equity in ticker-grouped array order rather than signal-time order. Chronologically it is -8.6274.',
  ],
  passive_benchmark_warning: 'v12 does NOT beat passive holding from the same 38 entries: holding to the strategy exit bar returns +3.0054% and holding to session end +2.6728%, versus v12 +2.7306%. Day-block bootstrap intervals for both alphas cross zero. The evidence supports the ticker-days this entry gate selects, not the exit overlay.',
  v11_comparison_warning: 'The commonly quoted v11 comparison (+1.5719% mean, PF 2.3875, -18.5464 chronological drawdown) is v11 ENTRY GATE + v12 EXIT OVERLAY, not v11 as deployed. v11 with its real live exit (50% at +5%, 5% giveback) over the same 40 entries returns +1.0692% mean, PF 2.0327.',
  promotion_status: 'unmet: 38 of 60 required trades, 16 of 20 temporal-development, 6 of 8 temporal-validation',
  live_policy_note: 'v12 is NOT the live threshold policy. The shared policy is v11; v12 is reachable only through this route\'s explicit profile override.',
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
        profile: V12_PROFILE,
        universe: 'catalyst_enriched_daily_prediction_snapshots',
        mode: 'postmortem_completed_sessions',
        experimental: true,
        probe_status: 'historically_validated_probe_requires_forward_evidence',
        backtest_provenance: BACKTEST_PROVENANCE,
        count: 0,
        entered: 0,
        rows: [],
        note: 'No catalyst-enriched candidates with a completed target session were found.',
      })
    }

    // 2. Replay each through the v12 profile.
    const replayed = await mapPool(candidates, CONCURRENCY, c => replayCandidate(db, c))

    // 3. Entered rows first (by realized return desc), then the rest.
    const rows = replayed.filter(Boolean)
    const entered = rows.filter(r => r.status === 'entered')
    const others = rows.filter(r => r.status !== 'entered')
    entered.sort((a, b) => (b.outcome?.realized_return_pct ?? -Infinity) - (a.outcome?.realized_return_pct ?? -Infinity))
    const ordered = [...entered, ...others].slice(0, limit)

    res.json({
      ok: true,
      profile: V12_PROFILE,
      universe: 'catalyst_enriched_daily_prediction_snapshots',
      mode: 'postmortem_completed_sessions',
      experimental: true,
      probe_status: 'historically_validated_probe_requires_forward_evidence',
      disclaimer: 'Testing a single fixed backtest profile (v12) over the catalyst-enriched set only — NOT a live trading screener, not trading advice, and not comparable to the Entry/Exit Screeners. v12 is a PROBE: its backtest was not independently reproduced, and it has not been shown to beat passive holding from the same entries. See backtest_provenance.',
      backtest_provenance: BACKTEST_PROVENANCE,
      compare_with: '/api/v11-screener runs the same universe and the same postmortem replay through the v11 profile; v11 remains the live policy and the reference, not the loser of a settled comparison.',
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
