import { Router } from 'express'
import Screener from '../models/Screener.js'
import { normalizeScreenerRow, isCleanListedUsRow } from './screener.js'
import { scoreLongTerm, longTermLabel, LONG_TERM_WEIGHTS } from '../lib/longTermScore.js'

// GET /api/long-term-fundamentals?horizon=perf_year&limit=50&sector=Technology&...
//
// A multi-month/multi-year counterpart to the Entry/Exit/v11 screeners, which are
// all intraday (120-360 min rolling price×density correlation windows). This one
// never touches the chart-service, the social store, or minute bars: it reads only
// the fundamental + long-horizon columns already ingested from Finviz Elite by
// 2_Screener/pipeline/fetch_finviz_elite_to_mongo.py.
//
// SCOPE — why the name says "Active Movers". That ingest is not a full-universe
// fundamentals sync. Its TIER_FILTERS are intraday momentum screens
// (sh_relvol_o1.5..o4 + ta_change_u), so Elite fundamentals only ever land on
// tickers that are unusually active TODAY — about 250-300 names out of a ~1.7k
// universe, and the set rotates daily. This route therefore scores today's movers
// on long-horizon fundamentals; it is NOT a whole-market long-term screen. Making
// it one would need a separate, slower full-universe pass with the relvol/change
// filters dropped, which would be a change to a pipeline the intraday screeners
// depend on.
//
// DATA PREREQUISITE: the long-horizon columns (perf_*, sma200, analyst, roe,
// debt_equity, profit_margin, forward_pe) arrive ONLY from an Elite-authenticated
// v=152 export. When Elite auth fails, fetch_finviz_elite_to_mongo.py does not
// error — it silently falls back to scraping the PUBLIC Finviz screener, which
// returns roughly ten columns and no fundamentals at all. The ingest keeps
// reporting success on every cycle, so the failure is invisible from logs.
//
// That fallback stamps market_cap_tier = 'public_top_gainers' (and nothing else
// does), which makes it a reliable fingerprint. The coverage block below counts
// those rows so the response can name the real condition — an authentication
// failure — instead of implying the ingest is not running.
//
// Observed in production 2026-07-27: ingest running every 60s, static
// FINVIZ_AUTH_TOKEN returning HTTP 401 'Invalid export API token', 100% of
// Finviz rows on the public-fallback tier, 0% coverage on every Elite column.
// Fix is configuration, not code: set FINVIZ_LOGIN / FINVIZ_PASSWORD on the
// BACKEND service (they already work on chart-service) so the ingest uses the
// self-healing cookie login in chart-service/finviz_auth.py.
//
// The Long-Term Score is a display-ranking heuristic and is NOT validated against
// realized returns — same standing as entryScore in routes/entryScreener.js. See
// lib/longTermScore.js for the component design and its independence guarantees.
//
// CONFIDENTIALITY BOUNDARY: like the entry/exit screeners, this route must never
// read from or import anything under ~/dev/research-students.

const router = Router()

const UNIVERSE_SCAN_LIMIT = Number(process.env.SCREENER_UNIVERSE_SCAN_LIMIT || 6000)
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

// The horizon buckets Finviz already gives us. Arbitrary calendar start/end dates
// would need a multi-year daily bar store, which this repo does not have —
// ohlcv_bars is minute-keyed intraday. See the handoff notes for that follow-up.
const HORIZONS = {
  perf_week:    '1 Week',
  perf_month:   '1 Month',
  perf_quarter: '3 Months',
  perf_half:    '6 Months',
  perf_ytd:     'YTD',
  perf_year:    '1 Year',
}
const DEFAULT_HORIZON = 'perf_year'

// Long-horizon fields whose presence decides whether this page can say anything.
const COVERAGE_FIELDS = [
  'perf_year', 'sma200', 'analyst', 'roe', 'debt_equity',
  'profit_margin', 'forward_pe', 'week_52_high', 'week_52_low',
]

const MARKET_CAP_BUCKETS = new Set(['Mega', 'Large', 'Mid', 'Small', 'Micro'])

function clamp(value, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return min
  return Math.max(min, Math.min(max, n))
}

function optionalNumber(value) {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function isTruthyFlag(value) {
  return value != null && value !== '' && !['0', 'false', 'no'].includes(String(value).toLowerCase())
}

router.get('/', async (req, res) => {
  try {
    const limit = Math.round(clamp(req.query.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT))
    const horizon = HORIZONS[req.query.horizon] ? req.query.horizon : DEFAULT_HORIZON

    const sector = req.query.sector ? String(req.query.sector) : null
    const marketCap = MARKET_CAP_BUCKETS.has(String(req.query.market_cap)) ? String(req.query.market_cap) : null
    const maxPe = optionalNumber(req.query.max_pe)
    const minDividend = optionalNumber(req.query.min_dividend)
    const minInstOwn = optionalNumber(req.query.min_inst_own)
    const minScore = optionalNumber(req.query.min_score)
    const profitableOnly = isTruthyFlag(req.query.profitable_only)
    const sortBy = req.query.sort === 'horizon_return' ? 'horizon_return' : 'long_term_score'

    // 1. Same clean listed-US universe the other screeners use, so the tabs agree
    //    on what counts as a tradable row.
    const filter = {
      exchange: { $in: ['NASDAQ', 'NYSE', 'AMEX'] },
      ticker: { $not: /\./ },
      price: { $ne: null },
    }
    // Deterministic scan order, same reasoning as entry/exitScreener.js: an
    // unsorted find() takes UNIVERSE_SCAN_LIMIT docs in natural/storage order,
    // which Mongo does not guarantee to be stable, so once the universe exceeds
    // the cap it silently drops whichever rows happen to sit last on disk.
    //
    // Those routes order by change_pct because they rank on today's move. This
    // one deliberately orders by market cap instead: if the cap ever truncates,
    // dropping the smallest companies is defensible for a multi-year screener,
    // whereas dropping "did not move much today" would import an intraday bias
    // into a long-horizon tool. ticker breaks ties so the order is total.
    const docs = await Screener.find(filter).sort({ market_cap: -1, ticker: 1 }).limit(UNIVERSE_SCAN_LIMIT).lean()

    // Keep each raw doc beside its normalized row — normalizeScreenerRow does not
    // surface week_52_high / week_52_low / profit_margin, which the score needs.
    const paired = docs
      .map(doc => ({ raw: doc, row: normalizeScreenerRow(doc) }))
      .filter(({ row }) => isCleanListedUsRow(row))

    // 2. Coverage diagnostics, computed over the whole clean universe BEFORE any
    //    user filtering, so the number reflects the database rather than the query.
    const coverage = {}
    for (const field of COVERAGE_FIELDS) {
      coverage[field] = paired.filter(({ raw, row }) => (raw[field] ?? row[field]) != null).length
    }
    const universeSize = paired.length
    const eliteFieldsPresent = COVERAGE_FIELDS.some(f => coverage[f] > 0 && !f.startsWith('week_52'))

    // Fingerprint of the public-scrape fallback — only that path sets this tier.
    // Its presence alongside absent Elite columns means auth failed, as distinct
    // from the ingest simply never having run.
    const publicFallbackRows = paired.filter(
      ({ raw, row }) => (raw.market_cap_tier ?? row.market_cap_tier) === 'public_top_gainers'
    ).length
    const authFallbackDetected = !eliteFieldsPresent && publicFallbackRows > 0

    // 3. Score, then filter. Scoring first means min_score can be applied against
    //    the same renormalized value the UI displays.
    let scored = paired.map(({ raw, row }) => {
      const result = scoreLongTerm(row, raw)
      return {
        ticker: row.ticker,
        company: row.company,
        sector: row.sector,
        market_cap: row.market_cap,
        market_cap_bucket: row.market_cap_bucket,
        price: row.price,
        change_pct: row.change_pct,

        long_term_score: result.score,
        ranked_score: result.ranked_score,
        long_term_label: longTermLabel(result.score),
        components: result.components,
        components_available: result.components_available,
        components_total: result.components_total,
        score_coverage: result.coverage,

        horizon_return: row[horizon] ?? null,
        perf_week: row.perf_week,
        perf_month: row.perf_month,
        perf_quarter: row.perf_quarter,
        perf_half: row.perf_half,
        perf_ytd: row.perf_ytd,
        perf_year: row.perf_year,

        // Price levels. The Finviz Elite ingest converts its percent-distance
        // export before writing, so these agree with the CNBC quote path; the
        // raw percentages ride along so the page can show either.
        week_52_high: raw.week_52_high ?? null,
        week_52_low: raw.week_52_low ?? null,
        week_52_high_pct: raw.week_52_high_pct ?? null,
        week_52_low_pct: raw.week_52_low_pct ?? null,
        sma50: row.sma50,
        sma200: row.sma200,
        analyst: row.analyst ?? null,
        target_price: row.target_price,

        pe_ratio: row.pe_ratio,
        forward_pe: row.forward_pe,
        peg: row.peg,
        roe: row.roe,
        debt_equity: row.debt_equity,
        profit_margin: raw.profit_margin ?? null,
        dividend_yield: row.dividend_yield,
        inst_own: row.inst_own,
      }
    })

    if (sector) scored = scored.filter(r => r.sector === sector)
    if (marketCap) scored = scored.filter(r => r.market_cap_bucket === marketCap)
    // A P/E ceiling implies a profitable company; a negative P/E must not sneak
    // past "max_pe=20" just because -3 < 20.
    if (maxPe != null) scored = scored.filter(r => r.pe_ratio != null && r.pe_ratio > 0 && r.pe_ratio <= maxPe)
    if (profitableOnly) scored = scored.filter(r => r.pe_ratio != null && r.pe_ratio > 0)
    if (minDividend != null) scored = scored.filter(r => (r.dividend_yield ?? 0) >= minDividend)
    if (minInstOwn != null) scored = scored.filter(r => (r.inst_own ?? 0) >= minInstOwn)
    if (minScore != null) scored = scored.filter(r => r.long_term_score != null && r.long_term_score >= minScore)

    const matched = scored.length

    // 4. Sort with nulls last, then page. Score ranking uses the evidence-shrunk
    //    value so thin rows cannot top the board on absent data; the displayed
    //    long_term_score stays the honest renormalized number.
    scored.sort((a, b) => {
      const av = sortBy === 'horizon_return' ? a.horizon_return : a.ranked_score
      const bv = sortBy === 'horizon_return' ? b.horizon_return : b.ranked_score
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      return bv - av
    })

    const rows = scored.slice(0, limit)

    res.json({
      ok: true,
      horizon,
      horizon_label: HORIZONS[horizon],
      horizons: HORIZONS,
      weights: LONG_TERM_WEIGHTS,
      limit,
      universe_size: universeSize,
      matched,
      count: rows.length,
      rows,
      sorted_by: sortBy === 'horizon_return' ? 'horizon_return desc' : 'ranked_score desc',
      coverage,
      elite_fields_present: eliteFieldsPresent,
      public_fallback_rows: publicFallbackRows,
      auth_fallback_detected: authFallbackDetected,
      score_note:
        'Long-Term Score is a display-ranking heuristic over Finviz Elite fundamentals — ' +
        'not backtested and not a predictive signal. Missing components are dropped and the ' +
        'remaining weights renormalized, so sparse rows trend neutral rather than bearish.',
      ...(eliteFieldsPresent ? {} : {
        note_title: authFallbackDetected
          ? 'Finviz Elite authentication is failing — fundamentals unavailable'
          : 'No Finviz Elite data in this database — scores are partial',
        note: authFallbackDetected
          ? 'The ingest is running normally, but it is not authenticating. Finviz is rejecting the ' +
            `static export token, so fetch_finviz_elite_to_mongo.py is silently using its public-scrape ` +
            `fallback (${publicFallbackRows} of ${universeSize} rows are on the public_top_gainers tier). ` +
            'That path returns about ten columns and no fundamentals, so 1-year return, trend vs the ' +
            '200-day, analyst consensus, and most of the fundamentals blend cannot be scored. ' +
            'Re-running the script will not help — the fix is to set FINVIZ_LOGIN and FINVIZ_PASSWORD ' +
            'on the BACKEND service (the same credentials already working on chart-service), which ' +
            'switches the ingest to the self-healing cookie login instead of the expiring static token.'
          : 'No Finviz Elite long-horizon columns are present, so scores fall back to 52-week range ' +
            'and P/E alone. If the ingest is running, check that Elite authentication is succeeding ' +
            'on the backend service rather than falling through to the public screener.',
      }),
    })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

export default router
