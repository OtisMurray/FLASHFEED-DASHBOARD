// Simulated-position history store (screener_position_history).
//
// WHY THIS EXISTS: the Entry/Exit screeners derive positions live from the
// chart-service strategy sim and keep NOTHING. The sim runs over a single
// session (`_latest_session_bars`), so yesterday's trades are simply absent from
// today's response, and the 120s in-process cache is the only memory in the
// system. "Full daily activity is recorded" therefore requires a real write
// path, which is what this module is.
//
// WHAT A ROW MEANS: one simulated trade, identified by
//   ${ticker}|${date}|${entry_epoch}|${threshold}|${stopPct}[|${policyId}]
// The parameters are IN THE KEY on purpose. The trade set is a function of the
// parameters — a different entry threshold produces different entries — so
// "the history" only exists relative to one parameter set. Every row also
// stamps threshold/stop_pct/corr_exit_threshold as fields, because a row whose
// active parameters are unknown cannot be interpreted after the fact.
//
// The threshold/stop in the key are the EFFECTIVE values for that row, resolved
// per market-cap tier by lib/positionPolicy.js. That keeps distinguishing tiers
// automatically once their values diverge. The policy id disambiguates the
// remaining case — two policies that happen to assign a tier the same two
// numbers — and is appended only for a non-baseline policy so that introducing
// the policy layer at today's uniform values leaves every existing _id
// unchanged. See tradeKey.
//
// WHY WRITE-ONCE-THEN-UPDATE IS SAFE: entries are causal. The sim enters on a
// rolling correlation crossing up through the threshold, using only data at or
// before that minute, and social_store.incremental_update only ever APPENDS
// messages newer than the stored newest_id. So a recorded entry does not
// retroactively move or vanish. What legitimately evolves while a position is
// held is the post-entry peak (and therefore the trailing stop), the mark, and
// eventually the exit. Hence: insert the trade once, update it until it closes,
// then freeze it.
//
// CONFIDENTIALITY BOUNDARY: like the screeners this serves, nothing here may
// read from or import anything under ~/dev/research-students. This module is
// pure bookkeeping over the chart-service's own clean reimplementation.

import { BASELINE_POSITION_POLICY_ID } from './positionPolicy.js'
import { detectPriceBasisMismatch, priceBasisStamp } from './priceBasis.js'

const TICKER_RE = /^[A-Z][A-Z0-9.-]{0,7}$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

// Exit reasons the chart-service can emit. A "risk exit" is a real, final fill;
// session_end is the sim flattening at the last bar it had, which is only a
// closed position once that session is actually over (see classifyRow).
// Exit reasons that represent an ACTUAL FILL, as opposed to a position still
// running and merely marked to the latest bar. This drives isFinalTrade,
// classifyRow, pnl_is_realized, and whether exit_price or session_end_price is
// the populated field — so membership here is the difference between "this trade
// concluded" and "this is a mid-flight mark".
//
// rth_close is a fill: a non-exempt position flattened at 16:00 ET under the
// regular-hours restriction closed at that bar, at that price. Only session_end
// leaves a position genuinely open.
const RISK_EXIT_REASONS = new Set(['price_trailing_stop', 'correlation_break', 'rth_close'])

// The same question, exported for the live path so it does not have to sniff a
// display string to decide whether a trade filled.
export function isFillExitReason(reason) {
  return RISK_EXIT_REASONS.has(String(reason || ''))
}

export const POSITION_HISTORY_COLLECTION = 'screener_position_history'

// ── entry_epoch IS NOT A WALL-CLOCK TIMESTAMP ────────────────────────────────
//
// `entry_epoch` carries the chart-service's CHART-AXIS coordinate, not a unix
// second. chart_service.py's _epoch_utc encodes naive ET wall-clock as a UTC
// second on purpose, so that markers land on lightweight-charts' UTC time axis
// at the ET time the trade actually happened — the same convention the candle,
// MACD, RSI, Bollinger and social-density series all use. Reading it back in
// UTC yields the ET clock; reading it as a real instant puts the trade four
// hours early in summer and five in winter.
//
// This is deliberate and load-bearing for the charts, so the value STAYS. What
// was missing is a field that means what a reader assumes `entry_epoch` means.
// Hence `entry_epoch_utc`: the same entry as a true UTC second.
//
// WHY IT IS DERIVED RATHER THAN RE-EMITTED. `date` and `entry_time` are both
// stored, both correct ET, and together pin the instant exactly — verified
// against all 75 rows on record, where date+entry_time read as UTC reproduces
// the stored entry_epoch byte for byte. So the true instant was always
// recoverable; nothing had to be re-simulated to obtain it, and no stored value
// had to change. In particular the _id, which contains entry_epoch, is
// untouched: re-keying history would orphan every stored row and re-insert
// today's open positions as duplicates, for no gain.
//
// USE THIS, NOT entry_epoch, for anything that compares a trade to a real-world
// time — news/catalyst matching, look-ahead-leakage checks, cross-source joins.
// Use entry_epoch for identity, ordering and chart alignment, which is all it
// was ever fit for.

const MARKET_TZ = process.env.MARKET_WINDOW_TIMEZONE || 'America/New_York'
const HHMM_RE = /^(\d{1,2}):(\d{2})$/

// Offset of the market timezone at a given instant, in ms (negative west of
// UTC). Derived from Intl rather than a fixed -4/-5 so the conversion is
// correct across the DST boundary instead of only in summer.
function marketOffsetMs(utcMs) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: MARKET_TZ,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs))
  const p = Object.fromEntries(parts.filter(x => x.type !== 'literal').map(x => [x.type, x.value]))
  // The local wall clock, read as if it were UTC. Its distance from the true
  // instant IS the offset.
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day),
    Number(p.hour) % 24, Number(p.minute), Number(p.second))
  return asUtc - utcMs
}

/**
 * ET session date + ET clock time -> true UTC unix second.
 *
 * Two passes: guess by treating the wall clock as UTC, correct by the offset in
 * force at that guess, then re-check the offset at the corrected instant. The
 * second pass only matters within an hour of a DST transition, where the first
 * guess can land on the wrong side of the change — which is precisely when a
 * one-pass conversion would be silently off by an hour.
 *
 * Returns null for anything unparseable, so a row that cannot be converted gets
 * no timestamp rather than a plausible wrong one.
 */
export function utcEpochFromMarketTime(dateKey, hhmm) {
  const date = String(dateKey || '').trim()
  const m = HHMM_RE.exec(String(hhmm ?? '').trim())
  if (!DATE_RE.test(date) || !m) return null
  const hour = Number(m[1])
  const minute = Number(m[2])
  if (hour > 23 || minute > 59) return null
  const [y, mo, d] = date.split('-').map(Number)

  const guess = Date.UTC(y, mo - 1, d, hour, minute)
  const firstPass = guess - marketOffsetMs(guess)
  const settled = guess - marketOffsetMs(firstPass)
  return Math.floor(settled / 1000)
}

/** The true UTC second a stored/normalized row entered. null when underivable. */
export function entryEpochUtcFor(row = {}) {
  return utcEpochFromMarketTime(row.date, row.entry_time)
}

// Deliberately stricter than Number(): Number(null) and Number('') are both 0,
// which would turn a DISABLED corr-exit threshold into "corr exit enabled at
// 0" and a missing exit price into a $0 fill. Absent must stay absent.
function finiteNumber(value) {
  if (value == null || value === '' || typeof value === 'boolean') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function round(value, decimals = 2) {
  const n = finiteNumber(value)
  return n == null ? null : Number(n.toFixed(decimals))
}

// Parameters participate in the _id, so their formatting has to be stable:
// 0.1 and 0.10 are the same parameter set and must not produce two histories.
function formatParam(value, decimals) {
  const n = finiteNumber(value)
  return n == null ? 'na' : n.toFixed(decimals)
}

// The parameter set a row was simulated under, as an id rather than two loose
// numbers. Appended to the key ONLY for a non-baseline policy: seeding the
// baseline must reproduce the pre-existing key byte for byte, or every stored
// row orphans and today's open positions re-insert as duplicates under new ids.
// Once tier values actually diverge (Phase 2) the suffix separates the
// histories cleanly, and the effective per-tier threshold/stop already in the
// key keep distinguishing tiers within a policy.
function policyKeySuffix(policyId) {
  const id = String(policyId || '').trim()
  return !id || id === BASELINE_POSITION_POLICY_ID ? '' : `|${id}`
}

export function tradeKey({ ticker, date, entry_epoch: entryEpoch, threshold, stopPct, policyId } = {}) {
  const t = String(ticker || '').trim().toUpperCase()
  const d = String(date || '').trim()
  const epoch = finiteNumber(entryEpoch)
  if (!TICKER_RE.test(t) || !DATE_RE.test(d) || epoch == null || epoch <= 0) return null
  return `${t}|${d}|${Math.floor(epoch)}|${formatParam(threshold, 4)}|${formatParam(stopPct, 2)}`
    + policyKeySuffix(policyId)
}

// A trade is FINAL when it can never change again:
//   - a risk exit already filled, or
//   - the session it belongs to is over (a session_end row on a past date is a
//     real flatten at the close, not an open position).
// Anything else is still live and will keep being updated by later snapshots.
export function isFinalTrade({ exit_reason: exitReason, date } = {}, { today } = {}) {
  if (RISK_EXIT_REASONS.has(String(exitReason || ''))) return true
  if (!today || !DATE_RE.test(String(date || ''))) return false
  return String(date) < String(today)
}

// The three groups the unified view renders, derived at READ time. This cannot
// be a stored flag alone: a position left open at 20:00 is never re-observed
// (the next cycle sims the NEW session), so "yesterday's open position is now a
// closed one" is a fact about the current date, not about the stored row.
export function classifyRow(row = {}, { today } = {}) {
  const date = String(row.date || '')
  const reason = String(row.exit_reason || '')
  if (RISK_EXIT_REASONS.has(reason)) {
    return date && today && date === today ? 'closed_today' : 'closed_earlier'
  }
  // session_end (or an unfinished row with no exit at all)
  if (today && DATE_RE.test(date) && date < today) return 'closed_earlier'
  return 'open'
}

/**
 * One chart-service trade -> one storable row, or null if it is not a usable
 * trade. Returns null rather than a half-populated document: a row that cannot
 * be keyed cannot be reconciled on the next cycle, and silently storing it
 * would create duplicates.
 */
export function normalizeTrade(trade = {}, context = {}) {
  const ticker = String(context.ticker || '').trim().toUpperCase()
  const date = String(context.date || '').trim()
  const entryEpoch = finiteNumber(trade.entry_epoch)
  const entryPrice = finiteNumber(trade.entry_price)
  if (!TICKER_RE.test(ticker) || !DATE_RE.test(date)) return null
  if (entryEpoch == null || entryEpoch <= 0) return null
  if (entryPrice == null || entryPrice <= 0) return null

  const threshold = finiteNumber(context.threshold)
  const stopPct = finiteNumber(context.stopPct)
  if (threshold == null || stopPct == null) return null

  const policyId = context.policyId || BASELINE_POSITION_POLICY_ID
  const _id = tradeKey({ ticker, date, entry_epoch: entryEpoch, threshold, stopPct, policyId })
  if (!_id) return null

  const exitReason = String(trade.exit_reason || (trade.status === 'Stopped Out' ? 'price_trailing_stop' : 'session_end'))
  const riskExit = RISK_EXIT_REASONS.has(exitReason)
  const peakPrice = finiteNumber(trade.peak_price)
  const currentPrice = finiteNumber(context.currentPrice)
  const exitPrice = finiteNumber(trade.exit_price)

  // The mark a P&L is measured against: a filled risk exit is frozen at its
  // fill; anything still running is marked to the latest bar.
  const refPrice = riskExit ? exitPrice : (currentPrice ?? exitPrice)
  const stopPrice = peakPrice != null ? peakPrice * (1 - stopPct / 100) : null

  return {
    _id,
    ticker,
    company: context.company || null,
    date,

    // Capture why the ticker entered the candidate universe without implying
    // that the AI score itself caused the correlation entry or strategy exit.
    candidate_source: context.candidateSource || null,
    ai_rank: finiteNumber(context.aiRank),
    ai_rank_score: finiteNumber(context.aiRankScore),
    ai_direction: context.aiDirection || null,
    ai_probability_up: finiteNumber(context.aiProbabilityUp),
    ai_entry_ready: context.aiEntryReady === true,
    ai_model: context.aiModel || null,

    // Parameters this row was simulated under. Without these the row is
    // uninterpretable later — a 5% stop and a 20% stop produce different exits
    // from identical price data.
    threshold,
    stop_pct: stopPct,
    corr_exit_threshold: finiteNumber(context.corrExitThreshold),

    // Which parameter SET produced those two numbers, and which tier the row
    // resolved to. Both are provenance, not inputs: the sim already ran at the
    // threshold/stop above. Stored so that once tier values diverge, a row can
    // still be attributed to the policy that generated it. Rows written before
    // this change simply lack the fields.
    position_policy_id: policyId,
    market_cap_tier: context.marketCapTier || null,

    // Which TRADING-HOURS regime produced this row. Same purpose as
    // position_policy_id: history spans a rule change, so a later analysis must
    // be able to separate pre-gate trades (free to enter and exit across
    // 04:00-20:00) from post-gate ones (regular hours only, unless exempt).
    // null means either a pre-gate row or an exempt ticker — rth_applied
    // disambiguates, and rows written before this change lack both fields.
    rth_rule_version: trade.rth_rule_version ?? context.rthRuleVersion ?? null,
    rth_applied: trade.rth_applied ?? context.rthApplied ?? null,

    // Entry: immutable once observed.
    //
    // entry_epoch is the chart-axis coordinate (ET wall-clock encoded as UTC);
    // entry_epoch_utc is the same moment as a real instant. Both are stored
    // because they answer different questions — see the commentary above
    // utcEpochFromMarketTime. Only entry_epoch is in the _id.
    entry_epoch: Math.floor(entryEpoch),
    entry_epoch_utc: utcEpochFromMarketTime(date, trade.entry_time),
    entry_price: round(entryPrice, 4),
    entry_time: trade.entry_time ?? null,
    entry_corr: round(trade.entry_corr, 4),

    // Evolving while held.
    peak_price: round(peakPrice, 4),
    stop_price: round(stopPrice, 4),
    current_price: round(currentPrice, 4),
    distance_to_stop_pct: refPrice != null && stopPrice != null && refPrice !== 0
      ? round(((refPrice - stopPrice) / refPrice) * 100, 2)
      : null,
    pnl_pct: refPrice != null ? round(((refPrice - entryPrice) / entryPrice) * 100, 2) : null,
    pnl_is_realized: riskExit,

    // Exit: only a risk exit is a real fill. A session_end row carries the last
    // bar it saw so a past session can be settled, but it is not a fill while
    // that session is still running.
    exit_reason: exitReason,
    exit_is_session_end: !riskExit,
    exit_price: round(riskExit ? exitPrice : null, 4),
    exit_time: riskExit ? (trade.exit_time ?? null) : null,
    exit_corr: round(trade.exit_corr, 4),
    session_end_price: round(riskExit ? null : exitPrice, 4),

    // Provenance / honesty.
    sim_status: context.corrStatus || null,
    chart_service_date: context.chartServiceDate || date,
    observed_at: context.observedAt instanceof Date ? context.observedAt : new Date(),
    collector: context.collector || 'server_position_history_v1',
  }
}

/**
 * Reconcile a freshly-simulated row against what is already stored.
 *
 * Returns { doc, changed, reason }. `changed:false` means the caller must not
 * write — which is how "a closed position never reopens" is enforced: once a
 * trade is final, later cycles cannot touch it at all.
 */
export function mergeTradeSnapshot(existing, incoming, { today } = {}) {
  if (!incoming) return { doc: existing || null, changed: false, reason: 'no_incoming' }
  if (!existing) {
    return {
      doc: { ...incoming, first_seen_at: incoming.observed_at, snapshots: 1, finalized: isFinalTrade(incoming, { today }) },
      changed: true,
      reason: 'inserted',
    }
  }
  // Frozen. A filled exit is a fact; re-simulating it later must never rewrite
  // it, and a stale/partial bar fetch must never resurrect it as open.
  if (existing.finalized || isFinalTrade(existing, { today })) {
    return { doc: existing, changed: false, reason: 'already_final' }
  }

  // The post-entry peak the trailing stop tracks can only ratchet up. A lower
  // incoming peak means the sim saw fewer bars than before (truncated fetch),
  // not that the high went away — keep the high-water mark and say so rather
  // than silently loosening the stop.
  //
  // ...UNLESS the trading-hours regime changed underneath the row. The ratchet
  // assumes both peaks were measured by the same rules; when the regular-hours
  // gate turns on, a LOWER incoming peak is not a truncated fetch, it is the new
  // rule correctly refusing to count an after-hours high the strategy could never
  // have acted on. Holding the old high-water mark there would keep a stop
  // pinned to an unactionable price and quietly defeat the freeze — so on a
  // regime change the incoming peak wins.
  const existingPeak = finiteNumber(existing.peak_price)
  const incomingPeak = finiteNumber(incoming.peak_price)
  const regimeChanged = String(existing.rth_rule_version || '') !== String(incoming.rth_rule_version || '')
  const peakRegressed = !regimeChanged
    && existingPeak != null && incomingPeak != null && incomingPeak < existingPeak
  const peakPrice = peakRegressed ? existingPeak : (incomingPeak ?? existingPeak)

  // Entry is keyed and immutable. If the sim reports a different fill for the
  // same entry minute, record the discrepancy instead of overwriting history.
  const entryDrift = finiteNumber(existing.entry_price) != null
    && finiteNumber(incoming.entry_price) != null
    && Number(existing.entry_price) !== Number(incoming.entry_price)

  // A drifting entry price for the SAME minute is usually a small vendor
  // correction. When it drifts by a whole-number factor it is a split, and the
  // stored entry is now on a different basis from the incoming mark. Computing
  // pnl_pct across the two would emit a plausible-looking, wholly fabricated
  // number — a stored $0.295 entry against a re-fetched $3.243 mark reads as
  // +1000%. Better to publish no P&L and say why.
  const basisMismatch = entryDrift
    ? detectPriceBasisMismatch(existing.entry_price, incoming.entry_price)
    : null
  const basisBroken = basisMismatch != null

  const stopPct = finiteNumber(existing.stop_pct) ?? finiteNumber(incoming.stop_pct)
  const stopPrice = peakPrice != null && stopPct != null ? peakPrice * (1 - stopPct / 100) : null
  const riskExit = RISK_EXIT_REASONS.has(String(incoming.exit_reason || ''))
  const refPrice = riskExit ? finiteNumber(incoming.exit_price) : finiteNumber(incoming.current_price)
  const entryPrice = finiteNumber(existing.entry_price)

  const doc = {
    ...existing,
    ...incoming,
    // Entry fields survive from the first observation.
    entry_price: existing.entry_price,
    entry_time: existing.entry_time ?? incoming.entry_time,
    entry_corr: existing.entry_corr ?? incoming.entry_corr,
    // Derived from whichever entry_time survived, NOT carried from `incoming`,
    // so it can never describe a different minute than the row's own
    // entry_time. Recomputing also backfills rows written before the field
    // existed, the next time one of them is updated.
    entry_epoch_utc: utcEpochFromMarketTime(
      existing.date ?? incoming.date,
      existing.entry_time ?? incoming.entry_time,
    ),
    first_seen_at: existing.first_seen_at ?? existing.observed_at ?? incoming.observed_at,
    peak_price: round(peakPrice, 4),
    stop_price: round(stopPrice, 4),
    // Both of these mix the stored entry with the incoming mark, so both are
    // withheld when the two are on different bases. The previously stored values
    // survive via the `...existing` spread — the last figures computed from a
    // consistent pair — rather than being overwritten with mixed-basis ones.
    distance_to_stop_pct: basisBroken
      ? (existing.distance_to_stop_pct ?? null)
      : (refPrice != null && stopPrice != null && refPrice !== 0
        ? round(((refPrice - stopPrice) / refPrice) * 100, 2)
        : null),
    pnl_pct: basisBroken
      ? (existing.pnl_pct ?? null)
      : (refPrice != null && entryPrice ? round(((refPrice - entryPrice) / entryPrice) * 100, 2) : null),
    snapshots: Number(existing.snapshots || 1) + 1,
    finalized: isFinalTrade(incoming, { today }),
    ...(peakRegressed ? { peak_regressed: true } : {}),
    ...(entryDrift ? { entry_price_drift: round(incoming.entry_price, 4) } : {}),
    // Stamped from what the merge itself observed, so a row caught this way is
    // labelled without waiting for the periodic audit to come round.
    ...(basisBroken
      ? {
        price_basis: priceBasisStamp({
          storedPrice: existing.entry_price,
          freshPrice: incoming.entry_price,
          minute: existing.entry_time ?? null,
          source: 'merge_entry_drift',
          now: incoming.observed_at instanceof Date ? incoming.observed_at : undefined,
        }),
        pnl_withheld_reason: 'price_basis_mismatch',
      }
      : {}),
  }
  return { doc, changed: true, reason: riskExit ? 'closed' : 'updated' }
}

/**
 * Flatten a /api/sentchart/positions/batch payload into storable rows.
 * Pure — no Mongo — so the flattening rules are testable on their own.
 */
export function rowsFromPositionsBatch(results = {}, context = {}) {
  const rows = []
  const coverage = { ok: 0, warming: 0, no_bars: 0, error: 0, other: 0 }
  const companies = context.companies instanceof Map ? context.companies : new Map()
  const candidateMetadata = context.candidateMetadata instanceof Map ? context.candidateMetadata : new Map()
  const tiers = context.tiers instanceof Map ? context.tiers : new Map()
  const observedAt = context.observedAt instanceof Date ? context.observedAt : new Date()

  for (const [rawTicker, result] of Object.entries(results || {})) {
    const status = String(result?.status || 'other')
    if (status in coverage) coverage[status] += 1
    else coverage.other += 1
    if (!result || status !== 'ok') continue

    const ticker = String(rawTicker || '').trim().toUpperCase()
    const meta = candidateMetadata.get(ticker) || {}
    for (const trade of result.trades || []) {
      const row = normalizeTrade(trade, {
        ticker,
        company: companies.get(ticker) || null,
        date: result.date,
        currentPrice: result.current_price,
        threshold: context.threshold,
        stopPct: context.stopPct,
        corrExitThreshold: context.corrExitThreshold,
        policyId: context.policyId,
        marketCapTier: tiers.get(ticker) || null,
        // Per-ticker: the batch ran under one policy, but an exempt name was
        // not bound by it, and the row has to record which was true for itself.
        rthRuleVersion: result.rth_rule_version ?? null,
        rthApplied: result.rth_applied ?? null,
        corrStatus: status,
        chartServiceDate: result.date,
        observedAt,
        collector: context.collector,
        candidateSource: meta.candidate_source,
        aiRank: meta.ai_rank,
        aiRankScore: meta.ai_rank_score,
        aiDirection: meta.ai_direction,
        aiProbabilityUp: meta.ai_probability_up,
        aiEntryReady: meta.ai_entry_ready,
        aiModel: meta.ai_model,
      })
      if (row) rows.push(row)
    }
  }
  return { rows, coverage }
}

export async function ensurePositionHistoryIndexes(db) {
  if (!db) return false
  const coll = db.collection(POSITION_HISTORY_COLLECTION)
  await coll.createIndex({ date: -1, status: 1 })
  await coll.createIndex({ ticker: 1, date: -1 })
  await coll.createIndex({ updated_at: -1 })
  return true
}

/**
 * Upsert a cycle's rows. Reads the existing docs first so mergeTradeSnapshot
 * can refuse to touch finalized trades — the write is deliberately not a blind
 * $set.
 */
export async function persistPositionSnapshot(db, rows = [], { today, now } = {}) {
  const summary = { inserted: 0, updated: 0, closed: 0, skipped_final: 0, failed: 0 }
  if (!db || !rows.length) return summary
  const coll = db.collection(POSITION_HISTORY_COLLECTION)
  const stamp = now instanceof Date ? now : new Date()

  const ids = rows.map(row => row._id)
  const existingDocs = await coll.find({ _id: { $in: ids } }).toArray().catch(() => [])
  const existingById = new Map(existingDocs.map(doc => [doc._id, doc]))

  for (const row of rows) {
    const existing = existingById.get(row._id) || null
    const { doc, changed, reason } = mergeTradeSnapshot(existing, row, { today })
    if (!changed) {
      if (reason === 'already_final') summary.skipped_final += 1
      continue
    }
    try {
      // `status` is stored for the {date:-1, status:1} index; it is the
      // read-time classification so history queries can filter without
      // recomputing it per document.
      const status = classifyRow(doc, { today })
      // Strip the two server-managed fields before they reach $set. Both failure
      // modes are silent, asymmetric (insert succeeds, update dies) and would
      // leave positions frozen at the moment they opened:
      //   _id        — Mongo rejects any update touching the immutable _id path,
      //                even to an identical value.
      //   created_at — belongs to $setOnInsert, but the merge round-trips the
      //                stored document, so it comes back in and conflicts.
      const { _id: _ignoredId, created_at: _ignoredCreatedAt, ...fields } = doc
      await coll.updateOne(
        { _id: row._id },
        {
          $set: { ...fields, status, updated_at: stamp },
          $setOnInsert: { created_at: stamp },
        },
        { upsert: true },
      )
      if (reason === 'inserted') summary.inserted += 1
      else summary.updated += 1
      if (reason === 'closed') summary.closed += 1
    } catch (err) {
      summary.failed += 1
      summary.last_error = String(err.message || err).slice(0, 200)
    }
  }
  return summary
}

/**
 * Withdraw stored trades that the latest simulation of the same session no
 * longer produces.
 *
 * WHY THIS IS NECESSARY: entries are only causal with respect to MESSAGES, not
 * bars. _price_density_grid forward-fills the last close across the rest of the
 * 04:00-20:00 grid, so a rolling-correlation window near the data frontier is
 * computed partly over flat filler. As real bars arrive that filler is replaced
 * and the correlation there changes, which walks the entry crossing forward.
 * Without this reconciliation a 5-minute scheduler records a fresh phantom
 * entry every cycle — observed live: 23 stored "open" positions for one ticker
 * in one afternoon, at 13:17, 13:23, 13:28, ... while the simulator only ever
 * claimed one.
 *
 * The latest successful sim is the authority for a session that can still be
 * re-simulated. Rows it no longer contains are marked superseded rather than
 * deleted: the audit trail survives, "a closed position never disappears" stays
 * literally true, and the read path can simply exclude them. Only the exact
 * (ticker, date, parameters) just simulated is touched, so past sessions — which
 * the scheduler never re-simulates — are never at risk.
 */
export async function supersedeMissingTrades(db, { ticker, date, threshold, stopPct, policyId, keepEpochs = [], now } = {}) {
  if (!db) return 0
  const t = String(ticker || '').trim().toUpperCase()
  if (!TICKER_RE.test(t) || !DATE_RE.test(String(date || ''))) return 0
  const keep = keepEpochs.map(epoch => Math.floor(Number(epoch))).filter(Number.isFinite)
  // Scoped to the policy that just ran, so one policy can never withdraw
  // another's rows. Omitted for the baseline exactly as the key suffix is:
  // existing rows predate the field, and matching on it would make them
  // invisible to reconciliation — which is the frontier-drift bug returning.
  const policyScope = policyId && policyId !== BASELINE_POSITION_POLICY_ID
    ? { position_policy_id: policyId }
    : {}
  const result = await db.collection(POSITION_HISTORY_COLLECTION).updateMany(
    {
      ticker: t,
      date,
      threshold,
      stop_pct: stopPct,
      ...policyScope,
      entry_epoch: { $nin: keep },
      superseded: { $ne: true },
    },
    { $set: { superseded: true, superseded_at: now instanceof Date ? now : new Date() } },
  ).catch(() => ({ modifiedCount: 0 }))
  return result.modifiedCount || 0
}

/**
 * Retention by DISTINCT RECORDED DATE, matching
 * scripts/save_daily_prediction_snapshot.js. Deliberately not "N calendar
 * days": trading days are sparse, so keeping the newest N dates that actually
 * have rows retains N sessions rather than N-minus-weekends.
 */
export async function prunePositionHistory(db, { retentionDays = 90 } = {}) {
  if (!db) return { deleted: 0, retained_dates: 0 }
  const keep = Math.max(1, Math.min(365, Number(retentionDays) || 90))
  const coll = db.collection(POSITION_HISTORY_COLLECTION)
  const dates = (await coll.distinct('date').catch(() => []))
    .filter(date => DATE_RE.test(String(date || '')))
    .sort()
    .reverse()
  if (dates.length <= keep) return { deleted: 0, retained_dates: dates.length }
  const retained = dates.slice(0, keep)
  const cutoff = retained[retained.length - 1]
  const result = await coll.deleteMany({ date: { $lt: cutoff } }).catch(() => ({ deletedCount: 0 }))
  return { deleted: result.deletedCount || 0, retained_dates: retained.length, cutoff_date: cutoff }
}
