import { Router } from 'express'
import mongoose from 'mongoose'
import Screener from '../models/Screener.js'
import { normalizeScreenerRow, isCleanListedUsRow, loadAdaptiveSocialStatsForRows } from './screener.js'
import { classifyRow, POSITION_HISTORY_COLLECTION } from '../lib/positionHistory.js'

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
const CORR_WINDOW_MINUTES = 360
const UNIVERSE_SCAN_LIMIT = Number(process.env.SCREENER_UNIVERSE_SCAN_LIMIT || 6000)
const DEFAULT_LIMIT = 30
const MAX_LIMIT = 50                     // chart-service batch cap
const DEFAULT_HISTORY_DAYS = 14
const MAX_HISTORY_ROWS = 500

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

async function fetchChartService(path, params) {
  const url = `${CHART_SERVICE_URL}${path}?${params.toString()}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 60_000)
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) throw new Error(`chart-service responded ${res.status}`)
    const data = await res.json()
    return data?.results || {}
  } finally {
    clearTimeout(timer)
  }
}

router.get('/', async (req, res) => {
  try {
    const threshold = clamp(req.query.threshold ?? CANONICAL_THRESHOLD, 0.05, 1)
    const stopPct = clamp(req.query.stopPct ?? CANONICAL_STOP_PCT, 1, 30)
    const limit = Math.round(clamp(req.query.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT))
    const historyDays = Math.round(clamp(req.query.historyDays ?? DEFAULT_HISTORY_DAYS, 0, 90))
    const today = todayKeyET()
    // Float comparison is fine here: both sides come from the same literals and
    // are rounded to the precision the sliders actually step in.
    const isCanonical = round(threshold, 4) === round(CANONICAL_THRESHOLD, 4)
      && round(stopPct, 2) === round(CANONICAL_STOP_PCT, 2)

    // 1. Same clean listed-US universe and deterministic scan order as
    //    /api/entry-screener and /api/exit-screener.
    const filter = {
      exchange: { $in: ['NASDAQ', 'NYSE', 'AMEX'] },
      ticker: { $not: /\./ },
      price: { $ne: null },
    }
    const universe = (await Screener.find(filter).sort({ change_pct: -1, ticker: 1 }).limit(UNIVERSE_SCAN_LIMIT).lean())
      .map(normalizeScreenerRow)
      .filter(isCleanListedUsRow)

    // Company names for BOTH live and recorded rows: the backfill writes
    // company: null (it reads the social store, not the quote rows), so history
    // would otherwise render nameless.
    const companyByTicker = new Map(universe.map(row => [row.ticker, row.company || null]))

    const db = mongoose.connection.db
    let candidates = []
    if (db && universe.length) {
      const socialMap = await loadAdaptiveSocialStatsForRows(db, universe, CORR_WINDOW_MINUTES)
      candidates = universe
        .map(row => ({ row, social: socialMap.get(row.ticker) }))
        .filter(c => Number(c.social?.stocktwits_count || c.social?.count || 0) > 0)
        .sort((a, b) =>
          (Number(b.social?.stocktwits_count || 0) - Number(a.social?.stocktwits_count || 0)) ||
          (Number(b.social?.count || 0) - Number(a.social?.count || 0)))
        .slice(0, limit)
    }

    // 2. Live sim + correlation for today, in parallel. Correlation is what
    //    explains a candidate that never triggered, so the watch group can say
    //    how far below the threshold it actually sits.
    const tickers = candidates.map(c => c.row.ticker)
    let positions = {}
    let corrResults = {}
    let chartServiceOk = true
    if (tickers.length) {
      const positionParams = new URLSearchParams({
        tickers: tickers.join(','),
        stop_pct: String(stopPct),
        threshold: String(threshold),
      })
      const corrParams = new URLSearchParams({ tickers: tickers.join(',') })
      const [positionsResult, corrResult] = await Promise.allSettled([
        fetchChartService('/api/sentchart/positions/batch', positionParams),
        fetchChartService('/api/sentchart/corr/batch', corrParams),
      ])
      if (positionsResult.status === 'fulfilled') positions = positionsResult.value
      else {
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
    for (const { row } of candidates) {
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
          threshold,
          stop_pct: stopPct,
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
          threshold,
          stop_pct: stopPct,
        })
        continue
      }

      for (const trade of trades) {
        const riskExit = trade.status === 'Stopped Out'
        const refPrice = riskExit ? trade.exit_price : currentPrice
        const stopPrice = trade.peak_price != null ? trade.peak_price * (1 - stopPct / 100) : null
        rows.push({
          group: riskExit ? 'closed_today' : 'open',
          provenance: 'live',
          data_status: 'live',
          ticker: row.ticker,
          company: row.company || null,
          date: result.date,
          entry_price: trade.entry_price,
          entry_time: trade.entry_time,
          entry_epoch: trade.entry_epoch,
          entry_corr: trade.entry_corr,
          exit_price: riskExit ? trade.exit_price : null,
          exit_time: riskExit ? trade.exit_time : null,
          exit_reason: trade.exit_reason || (riskExit ? 'price_trailing_stop' : 'session_end'),
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
          threshold,
          stop_pct: stopPct,
        })
      }
    }

    // 4. Recorded history for sessions already closed. Strictly date < today:
    //    today belongs to the live sim, which is authoritative and reflects the
    //    caller's parameters.
    let historyRows = []
    let historyTruncated = false
    let newestHistoryDate = null
    let supersededCount = 0
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
      for (const doc of docs.slice(0, MAX_HISTORY_ROWS)) {
        if (!newestHistoryDate || doc.date > newestHistoryDate) newestHistoryDate = doc.date
        // A recorded row that never reached a final state was observed
        // mid-session and then never seen again (the scheduler was down, or the
        // ticker fell out of the candidate set before the close). Its P&L is a
        // frozen intraday mark, NOT a settled result — that distinction is the
        // whole point of the badge.
        const stale = doc.finalized !== true
        const group = classifyRow(doc, { today })
        // A session_end row is stored unrealized because, at the moment it was
        // written, the session was still running. Once that session is over the
        // position was flattened at the close and the number IS settled — unless
        // the row is stale, in which case its mark really is a mid-session
        // snapshot and must not be dressed up as a result.
        const realized = doc.pnl_is_realized === true || (group === 'closed_earlier' && !stale)
        historyRows.push({
          group,
          provenance: 'recorded',
          data_status: stale ? 'stale' : 'recorded',
          ticker: doc.ticker,
          company: doc.company || companyByTicker.get(doc.ticker) || null,
          date: doc.date,
          entry_price: doc.entry_price,
          entry_time: doc.entry_time,
          entry_epoch: doc.entry_epoch,
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
          // The parameters this row was actually simulated under — which are the
          // canonical ones, and may differ from what the caller asked for.
          threshold: doc.threshold,
          stop_pct: doc.stop_pct,
          snapshots: doc.snapshots ?? null,
          recorded_at: doc.updated_at ?? null,
        })
      }
    }

    const all = [...rows, ...historyRows]
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
      corr_window_minutes: CORR_WINDOW_MINUTES,
      chart_service_ok: chartServiceOk,
      tickers_scanned: candidates.length,
      universe_size: universe.length,
      coverage,
      tickers_warming: coverage.warming,
      tickers_no_bars: coverage.no_bars,
      counts,
      history_days: historyDays,
      history_rows: historyRows.length,
      history_dates: historyDates,
      history_truncated: historyTruncated,
      newest_history_date: newestHistoryDate,
      stale_rows: staleRows,
      superseded_rows: supersededCount,
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
        ? `No tickers with StockTwits activity in the last ${CORR_WINDOW_MINUTES} minutes.`
        : (!chartServiceOk ? 'chart-service unreachable — no live positions could be simulated' : undefined),
    })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

export default router
