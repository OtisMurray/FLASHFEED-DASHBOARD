import { Router } from 'express'
import mongoose from 'mongoose'
import Screener from '../models/Screener.js'
import { normalizeScreenerRow, isCleanListedUsRow } from './screener.js'
import { CLEAN_UNIVERSE_MONGO_FILTER } from '../lib/cleanUniverse.js'
import {
  classifyRow,
  entryEpochUtcFor,
  isFillExitReason,
  POSITION_HISTORY_COLLECTION,
  utcEpochFromMarketTime,
} from '../lib/positionHistory.js'
import { loadAiPositionCandidates } from '../lib/aiPositionCandidates.js'
import {
  POSITION_PARAM_LIMITS,
  positionPolicySnapshot,
  positionTierFor,
} from '../lib/positionPolicy.js'

// GET /api/position-screener?threshold=0.1&stopPct=5&limit=30&historyDays=14
//
// The unified Positions view: the entry the strategy took, the exit it took (or
// the stop it is currently working), and the P&L that follows from the two —
// for today's live session AND for sessions already closed.
//
// TWO SOURCES, DELIBERATELY NOT INTERCHANGEABLE:
//
//   live      — today's session, re-simulated per request by the chart-service
//               at WHATEVER threshold/stop the caller asked for. This is what
//               the Entry and Exit screeners already show.
//   recorded  — prior sessions, read from screener_position_history, which the
//               background scheduler wrote at the CANONICAL parameters only
//               (0.10 / 5%). Past sessions cannot be re-simulated on demand:
//               Finviz Elite's 1-minute export only reaches back ~2 weeks and
//               the StockTwits walk cannot rebuild an old day's messages at all.
//
// So moving the sliders re-simulates today and CANNOT re-simulate history. Every
// row therefore carries its own provenance and its own active parameters, and
// the response says plainly whether the request is on-canonical. Silently
// mixing a 20%-stop live row with a 5%-stop recorded row in one P&L column is
// exactly the kind of thing this page exists to not do.
//
// THRESHOLDS ARE SERVER-BOUND ON PURPOSE. The Exit Screener recomputes its stop
// client-side while leaving status/exit_price/pnl frozen at the server's 5% sim,
// so at any other stop % it can show a "Stopped Out" row whose stop price sits
// far from the exit it claims to have filled at. Here the parameters go to the
// simulator, which is the only thing that can actually answer the question.
//
// CONFIDENTIALITY BOUNDARY: as with the entry/exit screeners, nothing here may
// read from or import anything under ~/dev/research-students.

const router = Router()

const CHART_SERVICE_URL = (process.env.CHART_SERVICE_URL || 'http://localhost:5055').replace(/\/+$/, '')
// Exported so the settings endpoint can report the window the screener actually
// runs at rather than keeping a second copy of the number.
export const CORR_WINDOW_MINUTES = 360
const UNIVERSE_SCAN_LIMIT = Number(process.env.SCREENER_UNIVERSE_SCAN_LIMIT || 6000)
const DEFAULT_LIMIT = 30
const MAX_LIMIT = 50                     // chart-service batch cap
const DEFAULT_HISTORY_DAYS = 14
const MAX_HISTORY_ROWS = 500
const AI_MIN_SCORE = Number(process.env.POSITION_AI_MIN_SCORE || 50)

// Must match the scheduler's canonical parameters in index.js. History exists
// only at these values.
const CANONICAL_THRESHOLD = Number(process.env.POSITION_HISTORY_THRESHOLD || 0.10)
const CANONICAL_STOP_PCT = Number(process.env.POSITION_HISTORY_STOP_PCT || 5)

function clamp(value, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return min
  return Math.max(min, Math.min(max, n))
}

function round(value, decimals = 2) {
  const n = Number(value)
  return Number.isFinite(n) ? Number(n.toFixed(decimals)) : null
}

// Group for a LIVE simulated trade, given the session the simulator actually
// covered. Mirrors classifyRow's date rule so a live row and the recorded row
// for the same trade can never land in different groups:
//   - session is today   -> a risk exit is closed_today; anything else is still open
//   - session is earlier -> the session is over, so the position is closed
//                           whichever way it ended (a session_end row on a past
//                           date is a real flatten at the close, not an open position)
// An unparseable or future date is treated as today: that is the conservative
// direction, since calling a live position "closed earlier" would assert a
// settlement that never happened.
export function liveGroupFor(sessionDate, riskExit, today) {
  const date = String(sessionDate || '')
  const isPast = /^\d{4}-\d{2}-\d{2}$/.test(date) && today && date < today
  if (isPast) return 'closed_earlier'
  return riskExit ? 'closed_today' : 'open'
}

// Identity of a simulated trade, independent of how it was reconstructed. The
// entry epoch is the discriminator — a ticker can enter more than once in a
// session, and the same entry minute at the same fill IS the same trade whether
// it arrived from the live sim or from recorded history.
export function tradeIdentity(row = {}) {
  return [
    String(row.ticker || '').toUpperCase(),
    String(row.date || ''),
    row.entry_epoch ?? row.entry_time ?? '',
  ].join('|')
}

// Has this trade had any tape to move against yet?
//
// An open position entered on the newest real bar is marked at its own fill, so
// pnl_pct is 0 by construction. The number is arithmetically true and
// presentationally a lie: it reads as "held and went nowhere" when the truth is
// "no elapsed session yet". The client renders the label instead of the figure —
// the same convention as the Unsettled badge, which refuses to let a frozen
// mid-session mark pass as a settled result.
//
// A risk exit is NEVER pending: stopping out is a real outcome no matter how few
// bars it took. `bars_since_entry` absent (an older chart-service, or a recorded
// row that predates the field) means unknown, which must not read as pending —
// an unlabelled real P&L is a smaller lie than a labelled fake one.
export function pnlPendingFor(trade = {}, { riskExit = false } = {}) {
  if (riskExit) return false
  return trade.bars_since_entry === 0
}

export function recordedPositionRow(doc = {}, { today, companyByTicker } = {}) {
  const stale = doc.finalized !== true
  const group = classifyRow(doc, { today })
  // A recorded session_end row becomes settled after its date passes; a same-day
  // risk exit is settled immediately. Stale rows stay marked as frozen snapshots.
  const realized = doc.pnl_is_realized === true
    || ((group === 'closed_earlier' || group === 'closed_today') && !stale)

  return {
    group,
    provenance: 'recorded',
    data_status: stale ? 'stale' : 'recorded',
    ticker: doc.ticker,
    company: doc.company || companyByTicker?.get(doc.ticker) || null,
    date: doc.date,
    entry_price: doc.entry_price,
    entry_time: doc.entry_time,
    entry_epoch: doc.entry_epoch,
    // The real instant, alongside the chart-axis coordinate. Derived on read
    // for rows written before the field existed, so a consumer never has to
    // know which vintage it is holding. See lib/positionHistory.js for why the
    // two differ and which one to use.
    entry_epoch_utc: doc.entry_epoch_utc ?? entryEpochUtcFor(doc),
    entry_corr: doc.entry_corr,
    exit_price: doc.exit_price ?? doc.session_end_price ?? null,
    exit_time: doc.exit_time,
    exit_reason: doc.exit_reason,
    exit_corr: doc.exit_corr,
    current_price: doc.current_price,
    peak_price: doc.peak_price,
    stop_price: doc.stop_price,
    distance_to_stop_pct: doc.distance_to_stop_pct,
    pnl_pct: doc.pnl_pct,
    pnl_is_realized: realized,
    // Never pending on a recorded row: a stored row is a past session's trade,
    // and a stored row that never reached a conclusion is already covered — and
    // more precisely labelled — by data_status: 'stale' / the Unsettled badge.
    pnl_pending: false,
    bars_since_entry: doc.bars_since_entry ?? null,
    // null on rows recorded before the gate existed — that IS the answer for a
    // pre-gate row, and it is what distinguishes the two regimes in history.
    rth_applied: doc.rth_applied ?? null,
    rth_rule_version: doc.rth_rule_version ?? null,
    // Integrity markers. These were being written to Mongo and never projected,
    // so a row could carry a known problem that nothing on the page could show.
    // A detection nobody can see is not a detection.
    price_basis: doc.price_basis ?? null,
    entry_price_drift: doc.entry_price_drift ?? null,
    peak_regressed: doc.peak_regressed ?? null,
    pnl_withheld_reason: doc.pnl_withheld_reason ?? null,
    // The parameters this row was actually simulated under — which are the
    // canonical ones, and may differ from what the caller asked for.
    threshold: doc.threshold,
    stop_pct: doc.stop_pct,
    // null for rows recorded before the policy layer existed; those predate
    // the field rather than being untiered.
    market_cap_tier: doc.market_cap_tier ?? null,
    position_policy_id: doc.position_policy_id ?? null,
    snapshots: doc.snapshots ?? null,
    recorded_at: doc.updated_at ?? null,
    candidate_source: doc.candidate_source || 'recorded_ai_suggestion',
    ai_rank: doc.ai_rank ?? null,
    ai_rank_score: doc.ai_rank_score ?? null,
    ai_direction: doc.ai_direction ?? null,
    ai_probability_up: doc.ai_probability_up ?? null,
    ai_entry_ready: doc.ai_entry_ready === true,
    ai_model: doc.ai_model ?? null,
  }
}

function todayKeyET() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: process.env.MARKET_WINDOW_TIMEZONE || 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date())
  const p = Object.fromEntries(parts.filter(x => x.type !== 'literal').map(x => [x.type, x.value]))
  return `${p.year}-${p.month}-${p.day}`
}

function shiftDateKey(dateKey, deltaDays) {
  const [y, m, d] = String(dateKey).split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + deltaDays)).toISOString().slice(0, 10)
}

// `envelope: true` returns the whole payload instead of just `results`, for the
// callers that need batch-level context (the regular-hours policy) alongside the
// per-ticker rows.
async function fetchChartService(path, params, { envelope = false } = {}) {
  const url = `${CHART_SERVICE_URL}${path}?${params.toString()}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 60_000)
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) throw new Error(`chart-service responded ${res.status}`)
    const data = await res.json()
    if (envelope) return data || {}
    return data?.results || {}
  } finally {
    clearTimeout(timer)
  }
}

router.get('/', async (req, res) => {
  try {
    // Clamp limits are shared with the entry/exit screeners (see
    // POSITION_PARAM_LIMITS) so the same query string cannot mean different
    // things depending on which route answers it.
    const threshold = clamp(req.query.threshold ?? CANONICAL_THRESHOLD,
      POSITION_PARAM_LIMITS.thresholdMin, POSITION_PARAM_LIMITS.thresholdMax)
    const stopPct = clamp(req.query.stopPct ?? CANONICAL_STOP_PCT,
      POSITION_PARAM_LIMITS.stopPctMin, POSITION_PARAM_LIMITS.stopPctMax)
    const limit = Math.round(clamp(req.query.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT))
    const historyDays = Math.round(clamp(req.query.historyDays ?? DEFAULT_HISTORY_DAYS, 0, 90))
    const today = todayKeyET()
    // Float comparison is fine here: both sides come from the same literals and
    // are rounded to the precision the sliders actually step in.
    const isCanonical = round(threshold, 4) === round(CANONICAL_THRESHOLD, 4)
      && round(stopPct, 2) === round(CANONICAL_STOP_PCT, 2)

    // 1. Start from the same clean listed-US quote universe as the rest of the
    //    dashboard, then let the canonical AI Rankings feed choose candidates.
    // Shared with every other screener; see lib/cleanUniverse.js for why this
    // must stay no stricter than isCleanListedUsRow.
    const filter = CLEAN_UNIVERSE_MONGO_FILTER
    const universe = (await Screener.find(filter).sort({ change_pct: -1, ticker: 1 }).limit(UNIVERSE_SCAN_LIMIT).lean())
      .map(normalizeScreenerRow)
      .filter(isCleanListedUsRow)

    // Company names for BOTH live and recorded rows: the backfill writes
    // company: null (it reads the social store, not the quote rows), so history
    // would otherwise render nameless.
    const companyByTicker = new Map(universe.map(row => [row.ticker, row.company || null]))

    const db = mongoose.connection.db
    let candidates = []
    let aiStatus = {
      ok: false,
      generated_at: null,
      source_rows: 0,
      min_score: AI_MIN_SCORE,
      model: null,
      error: null,
    }
    if (db && universe.length) {
      const universeByTicker = new Map(universe.map(row => [row.ticker, row]))
      let selected = []
      try {
        const ai = await loadAiPositionCandidates({ limit, minScore: AI_MIN_SCORE })
        aiStatus = {
          ok: true,
          generated_at: ai.generated_at,
          source_rows: ai.source_rows,
          min_score: ai.min_score,
          model: ai.model,
          error: null,
        }
        selected = ai.candidates
          .map(meta => ({ row: universeByTicker.get(meta.ticker), meta }))
          .filter(candidate => candidate.row)
      } catch (err) {
        aiStatus.error = String(err.message || err)
      }

      // Continue observing a position even if its ticker falls out of the next
      // AI ranking. Otherwise an open trade could disappear before its exit is
      // recorded. This fallback remains active even during a temporary AI API
      // failure; it never admits a new non-AI ticker.
      const pinnedDocs = await db.collection(POSITION_HISTORY_COLLECTION)
        .find({
          date: today,
          finalized: { $ne: true },
          superseded: { $ne: true },
          threshold: CANONICAL_THRESHOLD,
          stop_pct: CANONICAL_STOP_PCT,
        }, {
          projection: {
            ticker: 1,
            ai_rank: 1,
            ai_rank_score: 1,
            ai_direction: 1,
            ai_probability_up: 1,
            ai_entry_ready: 1,
            ai_model: 1,
          },
        })
        .toArray()
        .catch(() => [])
      const seen = new Set(selected.map(candidate => candidate.row.ticker))
      const pinned = pinnedDocs
        .map(doc => ({
          row: universeByTicker.get(String(doc.ticker || '').toUpperCase()),
          meta: {
            ai_rank: doc.ai_rank ?? null,
            ai_rank_score: doc.ai_rank_score ?? null,
            ai_direction: doc.ai_direction ?? null,
            ai_probability_up: doc.ai_probability_up ?? null,
            ai_entry_ready: doc.ai_entry_ready === true,
            ai_model: doc.ai_model ?? null,
            candidate_source: 'tracked_open_position',
          },
        }))
        .filter(candidate => candidate.row && !seen.has(candidate.row.ticker))
      candidates = [...pinned, ...selected].slice(0, limit)
    }

    // 2. Live sim + correlation for today, in parallel. Correlation is what
    //    explains a candidate that never triggered, so the watch group can say
    //    how far below the threshold it actually sits.
    const tickers = candidates.map(c => c.row.ticker)
    let positions = {}
    let corrResults = {}
    let chartServiceOk = true
    let rthPolicy = null
    if (tickers.length) {
      const positionParams = new URLSearchParams({
        tickers: tickers.join(','),
        stop_pct: String(stopPct),
        threshold: String(threshold),
      })
      const corrParams = new URLSearchParams({ tickers: tickers.join(',') })
      const [positionsResult, corrResult] = await Promise.allSettled([
        fetchChartService('/api/sentchart/positions/batch', positionParams, { envelope: true }),
        fetchChartService('/api/sentchart/corr/batch', corrParams),
      ])
      if (positionsResult.status === 'fulfilled') {
        positions = positionsResult.value?.results || {}
        // Absent when the chart-service predates the gate; the page then says
        // "unreported" rather than asserting an unrestricted session.
        rthPolicy = positionsResult.value?.rth || null
      } else {
        chartServiceOk = false
        console.error('GET /api/position-screener positions batch failed:', positionsResult.reason?.message)
      }
      // A correlation failure costs the watch group its explanation but must not
      // cost the page its positions.
      if (corrResult.status === 'fulfilled') corrResults = corrResult.value
    }

    // 3. Flatten today's live sim.
    const rows = []
    const coverage = { ok: 0, warming: 0, no_bars: 0, error: 0, other: 0 }
    for (const { row, meta } of candidates) {
      // Tier comes from predictionThresholdPolicy via positionTierFor — this
      // route defines no market-cap cutoffs of its own. Today every tier runs
      // identical parameters, so this is provenance only; it is what a later
      // tier-specific policy would key off.
      const marketCapTier = positionTierFor(row)
      const result = positions[row.ticker]
      const status = String(result?.status || (chartServiceOk ? 'other' : 'error'))
      if (status in coverage) coverage[status] += 1
      else coverage.other += 1

      const corrRow = corrResults[row.ticker] || null
      if (!result || status !== 'ok') {
        // Never silently dropped: a ticker we could not simulate is shown as a
        // watch row carrying the reason, so the page's candidate count and its
        // visible rows agree.
        rows.push({
          group: 'watch',
          provenance: 'live',
          data_status: !chartServiceOk ? 'chart_service_unavailable' : (status === 'other' ? 'no_bars' : status),
          ticker: row.ticker,
          company: row.company || null,
          date: result?.date ?? null,
          price: row.price ?? null,
          price_density_corr: corrRow?.corr ?? null,
          market_cap_tier: marketCapTier,
          threshold,
          stop_pct: stopPct,
          ...meta,
        })
        continue
      }

      const currentPrice = result.current_price ?? row.price ?? null
      const trades = result.trades || []
      if (!trades.length) {
        rows.push({
          group: 'watch',
          provenance: 'live',
          data_status: 'live',
          ticker: row.ticker,
          company: row.company || null,
          date: result.date,
          price: currentPrice,
          price_density_corr: corrRow?.corr ?? null,
          msg_density_rolling: corrRow?.msg_density_rolling ?? null,
          session_messages: result.messages ?? corrRow?.messages ?? null,
          market_cap_tier: marketCapTier,
          threshold,
          stop_pct: stopPct,
          ...meta,
        })
        continue
      }

      for (const trade of trades) {
        // Did this trade FILL? Read the reason, which is authoritative, and fall
        // back to the display string only for a chart-service old enough not to
        // send one. Sniffing 'Stopped Out' alone would misread a 16:00 flatten
        // (exit_reason 'rth_close') as a position still running.
        const exitReason = trade.exit_reason
          || (trade.status === 'Stopped Out' ? 'price_trailing_stop' : 'session_end')
        const riskExit = isFillExitReason(exitReason)
        const refPrice = riskExit ? trade.exit_price : currentPrice
        const stopPrice = trade.peak_price != null ? trade.peak_price * (1 - stopPct / 100) : null
        const pnlPending = pnlPendingFor(trade, { riskExit })
        rows.push({
          // Classified from the SESSION THE SIM ACTUALLY RETURNED, not assumed to
          // be today. The chart-service simulates the most recent session that
          // has bars, which stops being today the moment the clock rolls past
          // midnight ET: between 00:00 and the next premarket open, todayKeyET()
          // has already advanced while the sim still returns yesterday. Hardcoding
          // 'closed_today' here labelled a past session as today's AND collided
          // with recorded history, which correctly serves the same session as
          // closed_earlier — so every trade rendered twice, under both headings.
          group: liveGroupFor(result.date, riskExit, today),
          provenance: 'live',
          data_status: 'live',
          ticker: row.ticker,
          company: row.company || null,
          date: result.date,
          entry_price: trade.entry_price,
          entry_time: trade.entry_time,
          entry_epoch: trade.entry_epoch,
          // Derived the same way as on a recorded row, so live and recorded
          // rows for the same trade agree on the instant as well as on the
          // chart coordinate.
          entry_epoch_utc: utcEpochFromMarketTime(result.date, trade.entry_time),
          entry_corr: trade.entry_corr,
          exit_price: riskExit ? trade.exit_price : null,
          exit_time: riskExit ? trade.exit_time : null,
          exit_reason: exitReason,
          exit_corr: trade.exit_corr,
          current_price: currentPrice,
          peak_price: trade.peak_price,
          stop_price: round(stopPrice, 4),
          distance_to_stop_pct: refPrice && stopPrice != null
            ? round(((refPrice - stopPrice) / refPrice) * 100, 2)
            : null,
          pnl_pct: trade.entry_price
            ? round(((refPrice - trade.entry_price) / trade.entry_price) * 100, 2)
            : null,
          pnl_is_realized: riskExit,
          pnl_pending: pnlPending,
          bars_since_entry: trade.bars_since_entry ?? null,
          // Whether the regular-hours gate bound THIS ticker — false for an
          // exempt name even while the restriction is on for everything else.
          rth_applied: result.rth_applied ?? null,
          rth_rule_version: result.rth_rule_version ?? null,
          market_cap_tier: marketCapTier,
          threshold,
          stop_pct: stopPct,
          ...meta,
        })
      }
    }

    // 4. Recorded history. Prior sessions are read back from storage; finalized
    //    same-day risk exits are also used as a safety net at canonical settings
    //    so a closed trade cannot disappear just because it fell out of the next
    //    AI candidate batch after the exit was already observed.
    let historyRows = []
    let historyTruncated = false
    let newestHistoryDate = null
    let supersededCount = 0
    let todayFinalizedHistoryRows = 0
    if (db && historyDays > 0) {
      const since = shiftDateKey(today, -historyDays)
      // Superseded rows are withdrawn, not deleted: a later simulation of the
      // same session no longer produced that entry (see supersedeMissingTrades),
      // so showing it would assert a position the strategy never actually held.
      // The count is surfaced in the coverage line rather than hidden.
      const docs = await db.collection(POSITION_HISTORY_COLLECTION)
        .find({ date: { $gte: since, $lt: today }, superseded: { $ne: true } })
        .sort({ date: -1, entry_epoch: -1 })
        .limit(MAX_HISTORY_ROWS + 1)
        .toArray()
        .catch(() => [])
      supersededCount = await db.collection(POSITION_HISTORY_COLLECTION)
        .countDocuments({ date: { $gte: since, $lt: today }, superseded: true })
        .catch(() => 0)
      historyTruncated = docs.length > MAX_HISTORY_ROWS
      const todayFinalizedDocs = isCanonical
        ? await db.collection(POSITION_HISTORY_COLLECTION)
          .find({
            date: today,
            finalized: true,
            superseded: { $ne: true },
            threshold: CANONICAL_THRESHOLD,
            stop_pct: CANONICAL_STOP_PCT,
          })
          .sort({ entry_epoch: -1 })
          .limit(MAX_HISTORY_ROWS + 1)
          .toArray()
          .catch(() => [])
        : []

      if (todayFinalizedDocs.length > MAX_HISTORY_ROWS) historyTruncated = true
      todayFinalizedHistoryRows = Math.min(todayFinalizedDocs.length, MAX_HISTORY_ROWS)

      for (const doc of [
        ...todayFinalizedDocs.slice(0, MAX_HISTORY_ROWS),
        ...docs.slice(0, Math.max(0, MAX_HISTORY_ROWS - todayFinalizedHistoryRows)),
      ]) {
        if (!newestHistoryDate || doc.date > newestHistoryDate) newestHistoryDate = doc.date
        historyRows.push(recordedPositionRow(doc, { today, companyByTicker }))
      }
    }

    // The two sources overlap by construction whenever the simulator is still
    // returning a session that recorded history has already settled — which is
    // every request between midnight ET and the next premarket open. Both
    // descriptions are of the SAME trade, so exactly one must survive.
    //
    // Recorded wins. It is the settled figure, written at the canonical
    // parameters and frozen once final, whereas the live row is a re-simulation
    // that reflects whatever the caller's sliders currently say. Keeping the
    // live copy would also silently re-price closed history at off-canonical
    // settings, which the parameter_note explicitly promises does not happen.
    //
    // A live row for a past session with NO recorded counterpart still survives:
    // that is the scheduler-was-down case, where the live sim is the only
    // description of the trade that exists.
    // The session the simulator actually covered, for the response. Between
    // midnight ET and the next premarket open this is YESTERDAY, and a client
    // that says "closed today" without checking would be wrong.
    const liveSessionDate = rows.map(row => row.date).find(date => /^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) || null

    const recordedIdentities = new Set(historyRows.map(tradeIdentity))
    const supersededByHistory = rows.filter(
      row => row.group !== 'watch' && recordedIdentities.has(tradeIdentity(row)),
    ).length
    const liveRows = rows.filter(
      row => row.group === 'watch' || !recordedIdentities.has(tradeIdentity(row)),
    )

    const all = [...liveRows, ...historyRows]
    const counts = { open: 0, closed_today: 0, closed_earlier: 0, watch: 0 }
    for (const row of all) counts[row.group] = (counts[row.group] || 0) + 1

    const staleRows = all.filter(row => row.data_status === 'stale').length
    const historyDates = new Set(historyRows.map(row => row.date)).size

    res.json({
      ok: true,
      threshold,
      stopPct,
      corrExitThreshold: null,
      canonical: { threshold: CANONICAL_THRESHOLD, stop_pct: CANONICAL_STOP_PCT },
      is_canonical: isCanonical,
      // Tier-aware plumbing, seeded uniformly. Surfaced so the page can state
      // that no tier is tuned rather than implying tuning that has not happened.
      position_policy: positionPolicySnapshot(),
      corr_window_minutes: CORR_WINDOW_MINUTES,
      // Regular-hours restriction as the chart-service reported it, echoed
      // verbatim. The exemption list is configuration the page states out loud
      // rather than behaviour a reader has to infer from missing trades.
      rth: rthPolicy,
      chart_service_ok: chartServiceOk,
      tickers_scanned: candidates.length,
      universe_size: universe.length,
      candidate_policy: 'ai_rankings_non_bearish',
      ai_status: aiStatus,
      coverage,
      tickers_warming: coverage.warming,
      tickers_no_bars: coverage.no_bars,
      counts,
      history_days: historyDays,
      history_rows: historyRows.length,
      today_finalized_history_rows: todayFinalizedHistoryRows,
      history_dates: historyDates,
      history_truncated: historyTruncated,
      newest_history_date: newestHistoryDate,
      stale_rows: staleRows,
      superseded_rows: supersededCount,
      // Live rows dropped because recorded history already described the same
      // trade. Normal and expected outside market hours; surfaced rather than
      // hidden so "why is the live count lower than the sim found" is answerable.
      live_rows_superseded_by_history: supersededByHistory,
      live_session_date: liveSessionDate,
      live_session_is_today: liveSessionDate ? liveSessionDate === today : null,
      count: all.length,
      rows: all,
      sorted_by: 'client: open by distance_to_stop asc, closed_today by exit_time desc, closed_earlier by date desc',
      simulation_note:
        'Simulated positions, never executed. No order was placed and no fill is real — these are the entries and ' +
        'exits the strategy would have taken on the bars and message density it observed.',
      parameter_note: isCanonical
        ? `Live rows and recorded history are both at the canonical ${CANONICAL_THRESHOLD} entry threshold / ${CANONICAL_STOP_PCT}% trailing stop.`
        : `Live rows are re-simulated at ${threshold} / ${stopPct}%, but recorded history exists ONLY at the canonical ` +
          `${CANONICAL_THRESHOLD} / ${CANONICAL_STOP_PCT}%. Past sessions cannot be re-simulated on demand (Finviz ` +
          `intraday reaches back about two weeks and old StockTwits messages cannot be rebuilt), so the closed-earlier ` +
          `rows below are NOT a what-if at these settings.`,
      note: !candidates.length
        ? (aiStatus.error
          ? `AI rankings unavailable: ${aiStatus.error}`
          : `No non-bearish AI suggestions met the minimum score of ${AI_MIN_SCORE}.`)
        : (!chartServiceOk ? 'chart-service unreachable — no live positions could be simulated' : undefined),
    })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

export default router
