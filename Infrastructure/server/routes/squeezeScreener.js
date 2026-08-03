import { Router } from 'express'
import mongoose from 'mongoose'
import Screener from '../models/Screener.js'
import {
  normalizeScreenerRow,
  isCleanListedUsRow,
  enrichScreenerRow,
  attachShortInterestEvidence,
  attachWatcherSqueezeEvidence,
  loadArticleStatsForTickers,
  loadAdaptiveSocialStatsForRows,
  loadShortInterestSnapshots,
  loadStocktwitsWatcherSnapshots,
  marketSessionContext,
  evaluatePredictionEntryThreshold,
  predictionEvidenceValidation,
  resolvedRollingWindowMinutes,
} from './screener.js'
import { CLEAN_UNIVERSE_MONGO_FILTER } from '../lib/cleanUniverse.js'

// GET /api/squeeze-screener?limit=50&passing_only=0&window_minutes=
//
// Surfaces the short-squeeze evidence gate that already exists in
// routes/screener.js against LIVE quote rows, joined with the short-interest
// snapshots that routes/../../2_Screener/pipeline/fetch_short_interest_estimates_to_mongo.py
// now produces daily.
//
// NO NEW SCORING. Every threshold and every boolean below is read back out of
// predictionEvidenceValidation() — the same function the /api/screener prediction
// tabs call. This route assembles the same enrichment chain, calls that function,
// and reports what it said. It does not add, weight, or blend anything.
//
// ── WHY LIVE ROWS AND NOT daily_prediction_snapshots ─────────────────────────
// v11Screener.js already runs an evidence gate, but over
// daily_prediction_snapshots, and that is the wrong substrate for this page for
// three independent reasons:
//
//   1. FRESHNESS. The SI estimator writes short_interest_snapshots, which reach a
//      row through attachShortInterestEvidence at request time. The snapshot
//      collection is written AFTER that enrichment step, so a stored prediction
//      snapshot carries whatever short interest was current when it was written
//      and never picks up a newer estimate. Reading live rows is the only path on
//      which today's estimate is actually today's estimate.
//   2. UNIVERSE. daily_prediction_snapshots holds the catalyst-enriched
//      prediction set — rows that already cleared a news/catalyst bar. A squeeze
//      is precisely the case where short interest IS the catalyst, so gating on
//      "already looked like a catalyst prediction" would hide the population this
//      page exists to show.
//   3. DIRECTION. v11 is explicitly postmortem: it replays completed sessions.
//      This page answers "what is squeezed right now", which a completed-session
//      universe cannot answer.
//
// The cost of live rows is that the gate's `social` input is the ADAPTIVE rolling
// window (5-120 minutes by market-cap tier — see rollingWindowMinutes in
// screener.js), which is short. That is reported per row rather than papered over;
// see the gate trace's window_minutes.
//
// CONFIDENTIALITY BOUNDARY: like the entry/exit/long-term screeners, this route
// must never read from or import anything under ~/dev/research-students.

const router = Router()

const UNIVERSE_SCAN_LIMIT = Number(process.env.SCREENER_UNIVERSE_SCAN_LIMIT || 6000)
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
const ARTICLE_LOOKBACK_DAYS = 3   // matches GET /api/screener's default

// MIRRORS of the literals inside predictionEvidenceValidation's
// recognizedSqueezeCatalyst / verifiedShortInterest (screener.js ~2385 and ~2442).
// They exist ONLY to label the per-check trace with the number a user failed
// against — the pass/fail decision itself is always taken from the validation
// object, never from these. If they ever drift from screener.js the derived
// conjunction stops matching validation.recognizedSqueezeCatalyst, and every
// affected row is stamped trace_in_sync=false rather than quietly lying. See
// assertTraceInSync below.
const GATE_MIN_SQUEEZE_SCORE = 70
const GATE_MIN_SHORT_INTEREST_PCT = 10
const GATE_MIN_SOCIAL_MESSAGES = 3

function clamp(value, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return min
  return Math.max(min, Math.min(max, n))
}

function num(value) {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function isTruthyFlag(value) {
  return value != null && value !== '' && !['0', 'false', 'no'].includes(String(value).toLowerCase())
}

// Per-row honesty label for the short-interest number itself. Three genuinely
// different states, and the page must not blur them:
//   live_estimate    — FINRA daily short volume layered on the last settlement
//   settlement_only  — no FINRA daily coverage since settlement; official figure
//                      passed through unchanged (the ticker is NOT covered)
//   finviz_only      — no snapshot at all; float_short straight off the Finviz
//                      quote row, which is the stale pre-estimator behaviour
//   none             — no short-interest figure from any source
function shortInterestCoverage(row, shortRow) {
  const mode = row.short_interest_data_mode || shortRow?.si_data_mode || null
  if (mode === 'live_estimated') return 'live_estimate'
  if (mode === 'settlement_only') return 'settlement_only'
  if (num(row.float_short) != null) return 'finviz_only'
  return 'none'
}

// How many live estimates carry each calibration status the pipeline stamped.
// 'uncalibrated_fallback' (no file), 'calibration_rejected' (file present, nothing
// in it usable) and 'calibrated' are three different operational situations and
// the page must be able to tell them apart.
function calibrationStatusCounts(rows) {
  return rows
    .filter(r => r.si_coverage === 'live_estimate')
    .reduce((acc, r) => {
      const key = r.si_calibration_status || 'unknown'
      acc[key] = (acc[key] || 0) + 1
      return acc
    }, {})
}

const SI_PASSTHROUGH_NOTE =
  'Rows labelled settlement-only have no FINRA daily coverage since the last settlement and are ' +
  'the official figure passed through unchanged; rows labelled Finviz-only have no snapshot at all.'

// The calibration disclosure is DERIVED from what the rows actually carry, never
// asserted as a constant. A hardcoded "no calibration file exists, k=0.25" line is
// true only until the day one is installed, and after that the page keeps repeating
// it over numbers it no longer describes — the exact failure this replaces.
function shortInterestCalibrationNote(rows) {
  const live = rows.filter(r => r.si_coverage === 'live_estimate')
  if (!live.length) return SI_PASSTHROUGH_NOTE

  const uncalibrated = live.filter(r => r.si_uncalibrated === true)
  const ks = [...new Set(live.map(r => r.si_k).filter(k => k != null))].sort((a, b) => a - b)
  const kPhrase = !ks.length
    ? 'the dampening constant is not reported on these rows'
    : ks.length === 1
      ? `the dampening constant is k=${ks[0]}`
      : `the dampening constant ranges k=${ks[0]}–${ks[ks.length - 1]} across liquidity buckets`

  if (!uncalibrated.length) {
    return `Short-interest estimates are CALIBRATED: ${kPhrase}, fitted against realised settlements ` +
      `rather than the documented fallback. ${SI_PASSTHROUGH_NOTE}`
  }

  // Why they are uncalibrated is the actionable part, and the two reasons need
  // different responses: install a calibration file, versus fix the one that exists.
  const statuses = new Set(uncalibrated.map(r => r.si_calibration_status).filter(Boolean))
  const reason = statuses.has('calibration_rejected')
    ? statuses.size > 1
      ? 'a calibration file exists but some of it was rejected as unusable, and some rows had no file to read'
      : 'a calibration file exists but nothing in it was usable and it was rejected'
    : 'no calibration file exists'

  const scope = uncalibrated.length === live.length
    ? 'Short-interest estimates are UNCALIBRATED'
    : `${uncalibrated.length} of ${live.length} short-interest estimates are UNCALIBRATED`

  return `${scope}: ${reason}, so ${kPhrase} and it has not been fitted against a realised ` +
    `settlement. ${SI_PASSTHROUGH_NOTE}`
}

// Build the exact context object that GET /api/screener/audit/:ticker builds
// before calling predictionEvidenceValidation. Kept in one place so the two
// callers cannot drift in what they feed the gate.
function evidenceContextFor(enriched, setupStatus) {
  return {
    catalystText: enriched.main_catalyst?.title || enriched.catalyst_summary || '',
    news: Number(enriched.news_article_count || 0),
    social: Number(enriched.message_count || 0),
    sentiment: Number(enriched.avg_sentiment || 0),
    change: num(enriched.change_pct),
    relVolume: num(enriched.rel_volume),
    catalystPower: num(enriched.catalyst_power_score) || 0,
    squeezeScore: num(enriched.short_squeeze_score) || 0,
    watcherCount: num(enriched.stocktwits_watcher_count) || 0,
    floatShort: num(enriched.float_short),
    setupStatus,
  }
}

// Gate trace, in the shape v11Screener.js's v11EvidenceGate uses (an `ok` plus
// the individual supports), extended with the observed value and the threshold
// each check was measured against so a failing row explains itself.
function squeezeGateTrace(validation, context, enriched, windowMinutes) {
  const squeezeScore = Number(context.squeezeScore || 0)
  const social = Number(context.social || 0)
  // What the check REPORTS, as opposed to what it compares. evidenceContextFor
  // collapses an absent score to 0 before the gate ever sees it, so `observed`
  // has to come off the row instead: a row that was never scored would
  // otherwise be reported as a measured 0.0, asserting a measurement that never
  // happened. Same treatment the short-interest check below already gives its
  // own missing case. Reporting only — squeezeScore above still drives `ok`, so
  // no verdict moves.
  const observedSqueezeScore = num(enriched.short_squeeze_score)
  const shortInterestPct = num(
    enriched.short_interest_pct ?? enriched.short_interest_pct_shares_out ?? enriched.short_interest_pct_float
  )
  const floatShort = num(context.floatShort)
  // The value verifiedShortInterest actually compared: whichever of the two
  // inputs cleared the bar, else the larger available one for display.
  const observedShortPct = [shortInterestPct, floatShort].filter(v => v != null).sort((a, b) => b - a)[0] ?? null

  const checks = [
    {
      key: 'squeeze_score',
      label: `Squeeze score ≥ ${GATE_MIN_SQUEEZE_SCORE}`,
      ok: squeezeScore >= GATE_MIN_SQUEEZE_SCORE,
      observed: observedSqueezeScore == null ? null : Number(observedSqueezeScore.toFixed(1)),
      required: GATE_MIN_SQUEEZE_SCORE,
    },
    {
      key: 'verified_short_interest',
      // Authoritative: taken from the validation object, not recomputed.
      label: `Short interest ≥ ${GATE_MIN_SHORT_INTEREST_PCT}% (of float or of shares out)`,
      ok: Boolean(validation.verifiedShortInterest),
      observed: observedShortPct == null ? null : Number(observedShortPct.toFixed(2)),
      required: GATE_MIN_SHORT_INTEREST_PCT,
    },
    {
      key: 'social',
      label: `≥ ${GATE_MIN_SOCIAL_MESSAGES} social messages in the rolling window`,
      ok: social >= GATE_MIN_SOCIAL_MESSAGES,
      observed: social,
      required: GATE_MIN_SOCIAL_MESSAGES,
      window_minutes: windowMinutes,
    },
    {
      key: 'not_bearish_catalyst',
      label: 'Catalyst text is not bearish/risk-flavoured',
      ok: !validation.bearishCatalyst,
      observed: validation.bearishCatalyst ? (context.catalystText || 'bearish catalyst text') : null,
      required: null,
    },
  ]

  // Authoritative pass/fail. recognizedSqueezeCatalyst already implies
  // verifiedShortInterest; the second term mirrors hasPrimaryPredictionCatalyst's
  // verifiedSqueeze (screener.js ~2518) so this page and the prediction tabs agree
  // on what counts as a squeeze-primary row.
  const passed = Boolean(validation.recognizedSqueezeCatalyst && validation.verifiedShortInterest)

  // Drift guard — see the constants block. If the mirrored literals no longer
  // reproduce the authoritative boolean, say so instead of showing a trace that
  // disagrees with the decision beside it.
  const derived = checks.every(check => check.ok)
  const traceInSync = derived === Boolean(validation.recognizedSqueezeCatalyst)

  const failed = checks.filter(check => !check.ok).map(check => check.key)
  return {
    passed,
    status: passed
      ? 'squeeze_catalyst_confirmed'
      : failed.length
        ? 'blocked'
        : 'blocked_upstream',
    checks,
    failed,
    reason: passed
      ? 'Verified squeeze/social-interest catalyst'
      : checks.filter(check => !check.ok).map(check => check.label).join(' · ') || 'Blocked by the full evidence validation',
    trace_in_sync: traceInSync,
  }
}

router.get('/', async (req, res) => {
  try {
    const limit = Math.round(clamp(req.query.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT))
    const passingOnly = isTruthyFlag(req.query.passing_only)
    // Same knob GET /api/screener exposes, threaded into the same function. Left
    // null it uses the per-tier adaptive window; setting it changes the `social`
    // input the gate sees, which is why the resolved value is reported per row.
    const windowOverride = req.query.window_minutes ? Number(req.query.window_minutes) : null

    const db = mongoose.connection.db
    if (!db) return res.status(503).json({ ok: false, error: 'database unavailable' })

    // 1. Same clean listed-US universe as every other screener tab, with the same
    //    deterministic scan order as entry/exitScreener.js (an unsorted find()
    //    takes UNIVERSE_SCAN_LIMIT docs in unstable storage order, so once the
    //    universe exceeds the cap it silently drops whichever rows sit last on
    //    disk). ticker breaks change_pct ties so the order is total.
    const docs = await Screener.find(CLEAN_UNIVERSE_MONGO_FILTER).sort({ change_pct: -1, ticker: 1 }).limit(UNIVERSE_SCAN_LIMIT).lean()

    // Keep the raw doc beside the normalized row: normalizeScreenerRow does not
    // surface shares_float or short_ratio, which are the float and days-to-cover
    // this page displays.
    const paired = docs
      .map(doc => ({ raw: doc, row: normalizeScreenerRow(doc) }))
      .filter(({ row }) => isCleanListedUsRow(row))

    const universeSize = paired.length
    if (!universeSize) {
      return res.json({
        ok: true, limit, universe_size: 0, candidate_pool: 0, count: 0, passing: 0, rows: [],
        note: 'No clean listed-US rows in the screener universe.',
      })
    }

    // 2. Short-interest snapshots for the whole universe first — one cheap
    //    aggregate, and it decides the candidate pool.
    const shortMap = await loadShortInterestSnapshots(db, paired.map(({ row }) => row.ticker))

    // 3. Candidate pool = rows that carry short-interest data from ANY source.
    //    This is not a ranking cap; verifiedShortInterest is a hard prerequisite
    //    of recognizedSqueezeCatalyst, so a row with no short-interest figure at
    //    all cannot pass the gate by any route and has nothing to explain beyond
    //    "no data". The count of what this dropped is reported, never silent.
    const candidates = paired.filter(({ raw, row }) => (
      shortMap.has(row.ticker) || num(row.float_short) != null || num(raw.shares_float) != null
    ))
    const noShortInterestData = universeSize - candidates.length

    if (!candidates.length) {
      return res.json({
        ok: true,
        limit,
        universe_size: universeSize,
        candidate_pool: 0,
        no_short_interest_data: noShortInterestData,
        count: 0,
        passing: 0,
        rows: [],
        note: 'No ticker in the screener universe carries a short-interest figure, from either the ' +
          'short_interest_snapshots estimator or Finviz float_short. Check that ' +
          'fetch_short_interest_estimates_to_mongo.py is running.',
      })
    }

    // 4. Enrich EXACTLY as GET /api/screener/audit/:ticker does — articles,
    //    adaptive social, short interest, watchers, in that order. The order is
    //    load-bearing: attachShortInterestEvidence and attachWatcherSqueezeEvidence
    //    both raise short_squeeze_score, which is the gate's squeezeScore input.
    const sessionContext = marketSessionContext()
    const candidateRows = candidates.map(({ row }) => row)
    const tickers = candidateRows.map(row => row.ticker)
    const [articleMap, socialMap, watcherMap] = await Promise.all([
      loadArticleStatsForTickers(db, tickers, ARTICLE_LOOKBACK_DAYS, sessionContext),
      loadAdaptiveSocialStatsForRows(db, candidateRows, windowOverride),
      loadStocktwitsWatcherSnapshots(db, tickers),
    ])

    const scored = candidates.map(({ raw, row }) => {
      const shortRow = shortMap.get(row.ticker) || null
      const enriched = attachWatcherSqueezeEvidence(
        attachShortInterestEvidence(
          enrichScreenerRow(row, articleMap.get(row.ticker), socialMap.get(row.ticker), windowOverride),
          shortRow,
        ),
        watcherMap.get(row.ticker),
      )

      const threshold = evaluatePredictionEntryThreshold(enriched)
      const setupStatus = enriched.threshold_setup_status || threshold.setupStatus || threshold.status
      const context = evidenceContextFor(enriched, setupStatus)
      const validation = predictionEvidenceValidation(enriched, context)
      const windowMinutes = resolvedRollingWindowMinutes(row, windowOverride)
      const gate = squeezeGateTrace(validation, context, enriched, windowMinutes)

      const coverage = shortInterestCoverage(enriched, shortRow)
      const liveEstimate = coverage === 'live_estimate' ? num(enriched.short_interest_pct) : null
      // days_to_cover rides the snapshot; short_ratio is the Finviz column it was
      // built from and is the fallback when no snapshot exists for this ticker.
      const daysToCover = num(enriched.days_to_cover) ?? num(raw.short_ratio)
      const floatShares = num(raw.shares_float) ?? num(shortRow?.si_float_shares)

      return {
        ticker: row.ticker,
        company: row.company,
        sector: row.sector,
        market_cap: row.market_cap,
        market_cap_bucket: row.market_cap_bucket,
        price: row.price,
        change_pct: row.change_pct,
        rel_volume: row.rel_volume,

        // Existing squeeze score — read straight off the enriched row, unmodified.
        squeeze_score: num(enriched.short_squeeze_score),
        squeeze_signal: enriched.squeeze_signal || null,
        squeeze_reason: enriched.short_squeeze_reason || null,

        // Short interest, with every number labelled by where it came from.
        short_interest_official_pct: num(enriched.short_interest_official_pct) ?? num(row.float_short),
        short_interest_live_estimate: liveEstimate,
        short_interest_delta_pct: num(enriched.short_interest_estimate_delta_pct),
        short_interest_pct: num(enriched.short_interest_pct),
        short_interest_shares: num(enriched.short_interest_shares),
        short_interest_change_pct: num(enriched.short_interest_change_pct),
        short_covering_signal: enriched.short_covering_signal || null,

        // Honest per-row provenance / calibration status.
        si_coverage: coverage,
        si_data_mode: enriched.short_interest_data_mode || null,
        si_uncalibrated: enriched.short_interest_estimate_uncalibrated ?? null,
        si_calibration_status: shortRow?.si_calibration_status || null,
        // The dampening constant actually used for this row. Exposed so the
        // calibration disclosure can report the real value instead of restating a
        // constant that stops being true the moment a calibration file lands.
        si_k: num(shortRow?.si_k),
        si_sanity_band_clamped: shortRow?.si_sanity_band_clamped ?? null,
        si_baseline_is_ticker_specific: shortRow?.si_baseline_is_ticker_specific ?? null,
        si_observed_days: num(shortRow?.si_observed_days),
        si_source: enriched.short_interest_source || null,
        si_as_of_date: enriched.short_interest_as_of || null,
        si_settlement_date: enriched.short_interest_settlement_date || null,
        si_note: enriched.short_interest_estimate_note || null,

        days_to_cover: daysToCover,
        float_shares: floatShares,
        float_short_pct: num(row.float_short),

        // Gate inputs, so the trace is auditable against what fed it.
        social_messages: Number(enriched.message_count || 0),
        social_window_minutes: windowMinutes,
        stocktwits_watcher_count: num(enriched.stocktwits_watcher_count),
        news_article_count: Number(enriched.news_article_count || 0),
        catalyst: enriched.main_catalyst?.title || enriched.catalyst_summary || null,

        gate,
        evidence_primary: validation.primary,
        evidence_labels: validation.labels,
        // Why the verdict is what it is, as opposed to just what it is. A gate
        // leg nothing ever measured returns the same `false` as one that was
        // measured and genuinely failed; these two say which happened.
        evidence_state: validation.squeezeEvidenceState,
        evidence_unmeasured_legs: validation.squeezeEvidenceUnmeasuredLegs || [],
        risk_flags: validation.riskFlags || [],
      }
    })

    const passingCount = scored.filter(r => r.gate.passed).length
    const outOfSync = scored.filter(r => r.gate.trace_in_sync === false).length

    // 5. Passing rows first, then the near misses ordered by how much squeeze
    //    evidence they carry. Ordering only — no blended score.
    const visible = passingOnly ? scored.filter(r => r.gate.passed) : scored
    visible.sort((a, b) => {
      if (a.gate.passed !== b.gate.passed) return a.gate.passed ? -1 : 1
      const byChecks = a.gate.failed.length - b.gate.failed.length
      if (byChecks) return byChecks
      const bySqueeze = (b.squeeze_score ?? -Infinity) - (a.squeeze_score ?? -Infinity)
      if (bySqueeze) return bySqueeze
      const byShort = (b.short_interest_pct ?? -Infinity) - (a.short_interest_pct ?? -Infinity)
      if (byShort) return byShort
      return a.ticker.localeCompare(b.ticker)
    })

    const rows = visible.slice(0, limit)

    // Coverage / calibration aggregate for the page header. Counted over the whole
    // candidate pool, not the returned page, so it describes the database.
    const coverageCounts = candidates.length
      ? scored.reduce((acc, r) => { acc[r.si_coverage] = (acc[r.si_coverage] || 0) + 1; return acc }, {})
      : {}
    const uncalibratedCount = scored.filter(r => r.si_uncalibrated === true).length
    const liveEstimateCount = coverageCounts.live_estimate || 0

    res.json({
      ok: true,
      limit,
      passing_only: passingOnly,
      window_minutes: windowOverride,
      universe_size: universeSize,
      candidate_pool: candidates.length,
      no_short_interest_data: noShortInterestData,
      count: rows.length,
      passing: passingCount,
      near_misses: scored.length - passingCount,
      rows,
      sorted_by: 'gate passed first, then fewest failed checks, then squeeze_score desc',

      si_coverage_counts: coverageCounts,
      si_uncalibrated_rows: uncalibratedCount,
      si_live_estimate_rows: liveEstimateCount,
      si_all_uncalibrated: liveEstimateCount > 0 && uncalibratedCount === liveEstimateCount,
      gate_trace_out_of_sync_rows: outOfSync,

      gate_note:
        'No new scoring. Pass/fail is predictionEvidenceValidation() in routes/screener.js — the same ' +
        'gate the /api/screener prediction tabs use: squeeze score ≥ 70 AND verified short interest ' +
        '(≥ 10% of float or of shares out) AND ≥ 3 social messages in the rolling window AND no bearish ' +
        'catalyst text. This route only joins that verdict with the short-interest snapshot data.',
      si_note: shortInterestCalibrationNote(scored),
      si_calibration_statuses: calibrationStatusCounts(scored),
      social_note:
        'The gate\'s social input is the adaptive rolling window (5-120 minutes by market-cap tier), not ' +
        'a session total, so a ticker can be heavily discussed today and still show 0 here. Each row ' +
        'reports the window it was measured over.',
      ...(outOfSync ? {
        trace_warning:
          `${outOfSync} row(s) have a gate trace that no longer reproduces predictionEvidenceValidation's ` +
          'verdict — the per-check thresholds mirrored in squeezeScreener.js have drifted from ' +
          'screener.js. The pass/fail column is still authoritative; the per-check breakdown is not.',
      } : {}),
    })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

// Exported for tests/squeezeGate.test.js. The passing branch of the gate cannot be
// exercised from live rows on demand (it needs a real squeeze with live social
// traffic in the same rolling window), so it is covered by constructed rows there.
export {
  squeezeGateTrace,
  shortInterestCoverage,
  evidenceContextFor,
  shortInterestCalibrationNote,
  calibrationStatusCounts,
}

export default router
