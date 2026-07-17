import { Router } from 'express'
import mongoose from 'mongoose'
import Screener from '../models/Screener.js'
import { normalizeScreenerRow, isCleanListedUsRow, loadAdaptiveSocialStatsForRows } from './screener.js'

// GET /api/entry-screener?threshold=0.5&limit=30
//
// Ranks the most StockTwits-active clean listed-US tickers by an entry score
// built from the strategy's rolling price×density Pearson correlation. The
// correlation itself is computed by the chart-service (/api/sentchart/corr/batch),
// which owns the 1-min session grid and the social message store — this route
// only joins those values with Mongo quote rows and scores/sorts them.
//
// CONFIDENTIALITY BOUNDARY: the entry/exit screeners must never read from or
// import anything under ~/dev/research-students (confidential student research
// data — not for distribution). The strategy math they rely on is this repo's
// own clean reimplementation in chart-service/chart_service.py; keep it that way.

const router = Router()

// Dev default 5055 matches the Vite proxy comment (5050 is held by the local
// sentiment-scout dashboard); docker-compose overrides to http://chart-service:5050.
const CHART_SERVICE_URL = (process.env.CHART_SERVICE_URL || 'http://localhost:5055').replace(/\/+$/, '')
const CORR_WINDOW_MINUTES = 360        // the strategy's rolling window (chart-service STRAT_ROLL_WINDOW)
const EVIDENCE_TARGET_MESSAGES = 100   // message count at which evidence weight saturates to 1
const DEFAULT_LIMIT = 30
const MAX_LIMIT = 50                   // chart-service batch cap

function clamp(value, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return min
  return Math.max(min, Math.min(max, n))
}

// Display-ranking heuristic ONLY: the raw correlation shrunk toward 0 when
// message evidence is thin (same shrinkage idea as routes/correlation.js's
// evidenceConfidence). Message count stands in for "evidence" here, and density
// is known to lag price, so this score must NOT be promoted to a predictive or
// decision-relevant signal without a proper revisit.
function entryScore(corr, messages) {
  if (corr == null || !Number.isFinite(Number(corr))) return null
  const evidence = Math.min(1, Math.log1p(Math.max(0, Number(messages || 0))) / Math.log1p(EVIDENCE_TARGET_MESSAGES))
  return Number((Number(corr) * evidence).toFixed(3))
}

async function fetchCorrBatch(tickers) {
  const url = `${CHART_SERVICE_URL}/api/sentchart/corr/batch?tickers=${tickers.join(',')}`
  const controller = new AbortController()
  // A cold batch is one Finviz bars fetch per ticker on the chart-service side;
  // warm batches answer from its 120s row cache.
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
    const threshold = clamp(req.query.threshold ?? 0.5, 0.1, 1)
    const limit = Math.round(clamp(req.query.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT))

    // 1. Same clean listed-US universe as /api/screener
    const filter = {
      exchange: { $in: ['NASDAQ', 'NYSE', 'AMEX'] },
      ticker: { $not: /\./ },
      price: { $ne: null },
    }
    const rows = (await Screener.find(filter).limit(1500).lean())
      .map(normalizeScreenerRow)
      .filter(isCleanListedUsRow)

    // 2. Candidates = most StockTwits-active tickers within the strategy window
    const db = mongoose.connection.db
    let candidates = []
    if (db && rows.length) {
      const socialMap = await loadAdaptiveSocialStatsForRows(db, rows, CORR_WINDOW_MINUTES)
      candidates = rows
        .map(row => ({ row, social: socialMap.get(row.ticker) }))
        .filter(c => Number(c.social?.stocktwits_count || c.social?.count || 0) > 0)
        .sort((a, b) =>
          (Number(b.social?.stocktwits_count || 0) - Number(a.social?.stocktwits_count || 0)) ||
          (Number(b.social?.count || 0) - Number(a.social?.count || 0)))
        .slice(0, limit)
    }
    if (!candidates.length) {
      return res.json({
        ok: true, threshold, corr_window_minutes: CORR_WINDOW_MINUTES,
        count: 0, rows: [], sorted_by: 'entry_score desc',
        note: `No tickers with StockTwits activity in the last ${CORR_WINDOW_MINUTES} minutes.`,
      })
    }

    // 3. Batch correlation from the chart-service (never fail the whole page on it)
    let corrResults = {}
    let chartServiceOk = true
    try {
      corrResults = await fetchCorrBatch(candidates.map(c => c.row.ticker))
    } catch (err) {
      chartServiceOk = false
      console.error('GET /api/entry-screener corr batch failed:', err.message)
    }

    // 4. Join, score, sort (entry score desc, unscored rows last)
    const out = candidates.map(({ row, social }) => {
      const corrRow = corrResults[row.ticker] || null
      const corr = corrRow?.corr ?? null
      const messages = Number(corrRow?.messages ?? 0)
      return {
        ticker: row.ticker,
        company: row.company,
        market_cap: row.market_cap,
        price: row.price,
        change_pct: row.change_pct,
        msg_density_rolling: corrRow?.msg_density_rolling ?? null,
        session_messages: messages,
        stocktwits_count_window: Number(social?.stocktwits_count || 0),
        price_density_corr: corr,
        entry_score: entryScore(corr, messages),
        passes_threshold: corr != null && corr >= threshold,
        corr_status: corrRow?.status ?? (chartServiceOk ? 'missing' : 'chart_service_unavailable'),
        corr_date: corrRow?.date ?? null,
      }
    }).sort((a, b) => (b.entry_score ?? -Infinity) - (a.entry_score ?? -Infinity))

    res.json({
      ok: true,
      threshold,
      corr_window_minutes: CORR_WINDOW_MINUTES,
      entry_score_note: 'Display-ranking heuristic (evidence-shrunk correlation) — not a predictive signal.',
      chart_service_ok: chartServiceOk,
      count: out.length,
      rows: out,
      sorted_by: 'entry_score desc',
    })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

export default router
