// Long-Term Score — a 0-100 display-ranking heuristic for multi-month/multi-year
// horizons, built entirely from fields this repo already ingests from Finviz Elite
// (2_Screener/pipeline/fetch_finviz_elite_to_mongo.py).
//
// NOT a predictive signal and NOT validated against realized returns. It is a
// ranking convenience for research browsing, in the same spirit as (and with the
// same caveat as) entryScore in routes/entryScreener.js. Nothing here has been
// backtested; do not promote it to a decision-relevant signal without one.
//
// PROVENANCE: the component *idea set* (52-week range position + analyst rating +
// long-horizon return) was suggested by an external student project. No code was
// copied — that repo carries no LICENSE and is therefore all-rights-reserved.
// This is an independent implementation on our own data, and it deliberately
// fixes two defects in the design that inspired it:
//
//   1. NO DOUBLE-COUNTING. The original blended "price position in 52W range" and
//      a "52W return proxy" that was algebraically the same quantity one day
//      apart, so ~70% of its score was one variable wearing two hats. Here every
//      component is an independent measurement, and the 1-year return is the
//      REAL trailing return (perf_year) rather than a range-position proxy.
//
//   2. MISSING DATA GOES NEUTRAL, NEVER BEARISH. The original appended a
//      component's weight only on exception, so a merely-absent field silently
//      shrank the total and a data gap read as a bearish score. Here an
//      unavailable component is dropped and the remaining weights are
//      renormalized, so coverage gaps move the score toward neutral instead of
//      down. Callers get `components_available` to judge how much to trust it.
//
// UNITS: Finviz percent columns arrive as percentage points (25.5 === +25.5%),
// stripped of '%' by _num() in the ingest. Finviz's SMA20/50/200 export columns
// are the price's % DISTANCE from that average, not the average's price level.

// Component weights. Must be independent measurements — see note 1 above.
export const LONG_TERM_WEIGHTS = {
  range_position: 0.20,   // where price sits within its own 52-week range (a level)
  return_1y:      0.25,   // realized trailing 1-year return (a return)
  trend_200d:     0.20,   // price vs its 200-day average (a trend)
  analyst_rating: 0.15,   // sell-side consensus (an outside opinion)
  fundamentals:   0.20,   // profitability / leverage / valuation (business quality)
}

const clamp = (n, min, max) => Math.max(min, Math.min(max, n))

function num(value) {
  if (value == null) return null
  const n = typeof value === 'number' ? value : Number(String(value).replace(/[%,$]/g, '').trim())
  return Number.isFinite(n) ? n : null
}

// Map a symmetric quantity to 0-100 with `mid` scoring 50 and ±`span` hitting the
// rails. Linear and symmetric so a -X% move is penalized as much as +X% is rewarded.
function symmetric(value, mid, span) {
  if (value == null || span <= 0) return null
  return clamp(50 + 50 * ((value - mid) / span), 0, 100)
}

// Business quality: averaged over whatever of the four sub-metrics exist, so a
// sparse fundamentals row still yields a usable (if less certain) sub-score.
function fundamentalsComponent(row) {
  const parts = []

  const roe = num(row.roe)
  if (roe != null) parts.push(symmetric(roe, 10, 20))            // 10% ROE → 50, 30% → 100

  const de = num(row.debt_equity)
  if (de != null) parts.push(clamp(100 - 100 * clamp(de / 2, 0, 1), 0, 100))  // 0x → 100, ≥2x → 0

  const margin = num(row.profit_margin)
  if (margin != null) parts.push(symmetric(margin, 5, 15))       // 5% margin → 50, 20% → 100

  // Valuation prefers forward P/E; a non-positive P/E means no earnings to value
  // against, which we score poorly-but-not-zero rather than discarding.
  const pe = num(row.forward_pe) ?? num(row.pe_ratio)
  if (pe != null) parts.push(pe <= 0 ? 25 : clamp(100 - 100 * clamp((pe - 5) / 35, 0, 1), 0, 100))

  if (!parts.length) return null
  return parts.reduce((a, b) => a + b, 0) / parts.length
}

/**
 * Score one screener row for long-horizon attractiveness.
 *
 * @param {object} row  normalized screener row (routes/screener.js normalizeScreenerRow)
 * @param {object} raw  the underlying Mongo doc, for fields normalize doesn't surface
 *                      (week_52_high / week_52_low / profit_margin)
 * @returns {{score: number|null, components: object, components_available: number,
 *            components_total: number, coverage: number}}
 */
export function scoreLongTerm(row = {}, raw = {}) {
  const components = {}

  // 1. Position within the 52-week range. Needs a real range to divide by.
  const high = num(raw.week_52_high ?? row.week_52_high)
  const low = num(raw.week_52_low ?? row.week_52_low)
  const price = num(row.price)
  components.range_position =
    high != null && low != null && price != null && high > low
      ? clamp(((price - low) / (high - low)) * 100, 0, 100)
      : null

  // 2. Realized trailing 1-year return. -50% → 0, flat → 50, +50% → 100.
  components.return_1y = symmetric(num(row.perf_year), 0, 50)

  // 3. Long-term trend: price's distance from its 200-day average.
  //    20% below → 0, at the average → 50, 20% above → 100.
  components.trend_200d = symmetric(num(row.sma200), 0, 20)

  // 4. Analyst consensus. Finviz scores 1.0 (Strong Buy) … 5.0 (Strong Sell).
  const analyst = num(row.analyst ?? raw.analyst ?? raw.analyst_recom)
  components.analyst_rating =
    analyst != null && analyst >= 1 && analyst <= 5
      ? clamp(((5 - analyst) / 4) * 100, 0, 100)
      : null

  // 5. Business quality.
  components.fundamentals = fundamentalsComponent({
    roe: row.roe,
    debt_equity: row.debt_equity,
    profit_margin: raw.profit_margin ?? row.profit_margin,
    forward_pe: row.forward_pe,
    pe_ratio: row.pe_ratio,
  })

  // Renormalize over available components — a missing field must not deflate the
  // score (see note 2 above). All-missing yields null, never a misleading 0.
  let weighted = 0
  let availableWeight = 0
  let available = 0
  for (const [key, weight] of Object.entries(LONG_TERM_WEIGHTS)) {
    const value = components[key]
    if (value == null) continue
    weighted += value * weight
    availableWeight += weight
    available += 1
  }

  const total = Object.keys(LONG_TERM_WEIGHTS).length
  const score = availableWeight > 0 ? Number((weighted / availableWeight).toFixed(1)) : null

  // Renormalizing keeps a thin row honest, but it also lets a row scored on ONE
  // component claim a perfect 100 and outrank fully-evidenced rows. So ranking
  // uses the score shrunk toward neutral by how much evidence backed it — the
  // same evidence-shrinkage idea as entryScore in routes/entryScreener.js.
  //
  // At full coverage this is an identity (ranked_score === score), so it changes
  // nothing once the Elite ingest has populated every column; it only demotes
  // rows that are winning on absence of data.
  const rankedScore = score == null ? null : Number((50 + (score - 50) * availableWeight).toFixed(1))

  return {
    score,
    ranked_score: rankedScore,
    components: Object.fromEntries(
      Object.entries(components).map(([k, v]) => [k, v == null ? null : Number(v.toFixed(1))])
    ),
    components_available: available,
    components_total: total,
    coverage: Number((availableWeight).toFixed(2)),   // fraction of total weight that was scorable
  }
}

// Bucket label for the score, mirroring how the rest of the app narrates 0-100
// values. Deliberately hedged wording — this is a ranking, not a recommendation.
export function longTermLabel(score) {
  if (score == null) return 'No Data'
  if (score >= 70) return 'Strong'
  if (score >= 55) return 'Positive'
  if (score >= 45) return 'Neutral'
  if (score >= 30) return 'Weak'
  return 'Poor'
}
