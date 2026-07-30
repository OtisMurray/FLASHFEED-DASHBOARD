// The single definition of "a clean, listed-US row we are willing to act on".
//
// WHY THIS MODULE EXISTS: there used to be three of these predicates —
// isCleanListedUsRow (routes/screener.js), isCleanListedUsScreenerRow and
// isCleanListedUsThresholdEntryRow (index.js) — and they disagreed on five
// separate conditions while all claiming to answer the same question. The
// consequence was concrete and user-visible: the AI ranker scored and ranked
// tickers that the Positions universe then silently discarded, so a gate that
// passed 20 candidates delivered 6.
//
// The differences that were REAL intent are preserved, as named wrappers around
// one base predicate. The differences that were accidents are gone.
//
// ── The exchange bypass, and why it is not a shortcut ────────────────────────
//
// Finviz Elite's v=152 CSV export has NO exchange column. That was verified
// against the live authenticated export: 90 columns, and the closest are
// `Country` (domicile) and `Index` (S&P/DJIA membership). Neither identifies a
// listing venue. So `exchange` on a Finviz row is only ever present when the
// CNBC quote ingest happened to write the same ticker — in production that is
// 768 of 1719 Finviz-marked rows, leaving 932 with no exchange at all.
//
// Requiring `exchange` unconditionally therefore does not enforce "US-listed".
// It enforces "also covered by CNBC", which is a coverage artifact, not a
// property of the security. Finviz provenance is the listing signal actually
// available: every tier query in fetch_finviz_elite_to_mongo.py is a US-market
// screen, so a row that came from it is US-listed by construction of the query.
//
// The honest framing: this is provenance-based, weaker than a per-row venue
// check, and it is the strongest signal the upstream data supports. If Finviz
// ever exposes an exchange column, tighten this to require it.

const US_EXCHANGES = new Set(['NASDAQ', 'NYSE', 'AMEX'])

// Crypto/FX symbols that arrive through the same pipes as equities.
const NON_STOCK_TICKERS = new Set([
  'BTC', 'ETH', 'LTC', 'DOGE', 'SOL', 'ADA', 'XRP', 'BNB', 'DOT', 'AVAX',
  'MATIC', 'SHIB', 'TRX', 'BCH', 'LINK', 'ATOM', 'UNI', 'ETC', 'FIL',
  'USD', 'USDT', 'USDC', 'SPOT',
])

// A sanity ceiling, not a strategy rule — it rejects corrupt rows, not big
// movers. The default is deliberately far above any real session move.
const MAX_SIGNAL_CHANGE_PCT = Math.max(10, Number(process.env.MAX_SIGNAL_CHANGE_PCT || 300))

function normalizeExchange(value) {
  const raw = String(value || '').trim().toUpperCase()
  if (raw === 'NYSEAMERICAN' || raw === 'NYSE AMERICAN') return 'AMEX'
  if (raw === 'NAS') return 'NASDAQ'
  return raw
}

function isFinvizScreenerRow(row = {}) {
  const sourceText = `${row.quote_source || ''} ${row.source || ''} ${row.screener_source || ''} ${row.finviz_filter || ''}`.toLowerCase()
  return sourceText.includes('finviz')
}

/**
 * The base predicate. Everything else composes this.
 *
 * Two divergences between the old three were resolved rather than preserved,
 * because neither looked deliberate:
 *
 *   quote_status — one required exactly 'priced', the others only rejected
 *     'missing'. In production `priced` is the ONLY value that occurs (2748
 *     rows, all with price > 0), so the two were empirically identical. Settled
 *     on `!== 'missing'` because the price checks below are what actually do the
 *     work; demanding an exact string would reject a future valid status (say
 *     'delayed') on a row carrying a perfectly good price.
 *
 *   dash in ticker — index.js excluded it, screener.js did not. Settled on
 *     excluding, matching the dot rule: both mark share classes and preferreds.
 *     Production impact is exactly one row (BF-B). It also removes an asymmetry
 *     that mattered once Positions began taking candidates from the AI ranker —
 *     Positions could otherwise hold a name the ranker would never surface.
 */
export function isCleanListedUsRow(row) {
  const ticker = String(row?.ticker || '').toUpperCase()
  if (!ticker || ticker.includes('.') || ticker.includes('-')) return false
  if (NON_STOCK_TICKERS.has(ticker)) return false
  if (row.quote_status === 'missing') return false

  const price = Number(row.price)
  if (row.price == null || !Number.isFinite(price) || price <= 0) return false

  const changePct = Number(row.change_pct)
  if (row.change_pct == null || !Number.isFinite(changePct)) return false
  if (Math.abs(changePct) > MAX_SIGNAL_CHANGE_PCT) return false

  return isFinvizScreenerRow(row) || US_EXCHANGES.has(normalizeExchange(row.exchange))
}

/**
 * The AI ranker's universe: clean, and moving UP today.
 *
 * The `change_pct > 0` requirement is deliberate scope, not an accident — that
 * feed exists to rank positive movers — so it stays, visibly, instead of being
 * flattened into the base.
 */
export function isPositiveMoverRow(row) {
  return isCleanListedUsRow(row) && Number(row?.change_pct) > 0
}

/**
 * Rows whose stored threshold features already cleared the entry gate.
 * Deliberately does NOT require positive change: the gate itself decides.
 */
export function isThresholdEntryRow(row) {
  return isCleanListedUsRow(row) && row?.threshold_feature_status === 'entry_passed'
}

export { US_EXCHANGES, NON_STOCK_TICKERS, MAX_SIGNAL_CHANGE_PCT, normalizeExchange, isFinvizScreenerRow }
