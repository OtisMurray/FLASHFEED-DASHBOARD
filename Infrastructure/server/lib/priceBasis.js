// PRICE BASIS — is a stored price still comparable to today's bars?
//
// Stored position history holds AS-TRADED prices: what the tape actually printed
// when the row was written. Finviz serves SPLIT-ADJUSTED bars: the same minute,
// restated onto the current share count. After a split the two disagree by the
// split ratio, and NEITHER IS WRONG — they are simply on different bases.
//
// Returns are basis-invariant, so a stored pnl_pct stays correct across a split
// (NEXR: (0.28 - 0.295)/0.295 = -5.08% before and after a 1:11 reverse split).
// What breaks is any calculation that MIXES the two — a stored entry against a
// freshly-fetched mark. Observed live during the 2026-07-31 audit: NEXR's stored
// $0.295 entry against a re-fetched $3.243 bar produced a +1022% "buy and hold"
// return that was pure arithmetic on incompatible units.
//
// The policy here is flag, never rewrite. Adjusting stored prices would trade a
// known-good as-traded record for one that moves again at the next corporate
// action, and would silently restate history a reader may already have seen.

// Ordinary minute-to-minute noise between a stored fill and a re-fetched bar:
// different vendor snapshots, a late correction, a thin print. Inside this band
// nothing is claimed.
const NEUTRAL_LOW = 0.9
const NEUTRAL_HIGH = 1.1

// How close the ratio must sit to a whole-number split to be called one. A real
// split lands essentially exactly; 2% is loose enough for rounding on sub-cent
// prices and tight enough that ordinary drift never qualifies.
const SIMPLE_RATIO_TOLERANCE = 0.02

// Beyond this a "split" is more likely a bad price or a ticker reassignment.
const MAX_SPLIT_FACTOR = 1000

function finite(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/**
 * Compare a stored price against a freshly-fetched bar for the SAME minute.
 *
 * Returns null when the two are comparable (or when there is not enough to
 * judge). Returns a descriptor when they are not — which is a statement about
 * COMPARABILITY, not about either price being wrong.
 *
 * Deliberately only recognises whole-number splits (n:1 and 1:n). A fractional
 * split such as 3:2 will NOT be flagged: admitting ratios like 1.5 would put the
 * detector inside the range ordinary drift can reach, and a missed flag is much
 * cheaper than a false one that impugns a good row. Documented as a known gap
 * rather than papered over.
 */
export function detectPriceBasisMismatch(storedPrice, freshPrice) {
  const stored = finite(storedPrice)
  const fresh = finite(freshPrice)
  if (stored == null || fresh == null || stored <= 0 || fresh <= 0) return null

  const ratio = fresh / stored
  if (ratio >= NEUTRAL_LOW && ratio <= NEUTRAL_HIGH) return null

  // A reverse split raises the adjusted price (ratio > 1); a forward split
  // lowers it (ratio < 1). Normalise so the same whole-number test covers both.
  const inverted = ratio < 1
  const magnitude = inverted ? 1 / ratio : ratio
  if (!Number.isFinite(magnitude) || magnitude > MAX_SPLIT_FACTOR) {
    return {
      comparable: false,
      ratio: round(ratio, 6),
      kind: 'implausible',
      split_suspected: false,
      note: 'Prices differ by more than a plausible corporate action; treat the pair as unusable rather than as a split.',
    }
  }

  const nearest = Math.round(magnitude)
  const relativeError = nearest >= 2 ? Math.abs(magnitude - nearest) / nearest : Infinity
  const isSimpleSplit = nearest >= 2 && relativeError <= SIMPLE_RATIO_TOLERANCE

  return {
    comparable: false,
    ratio: round(ratio, 6),
    kind: isSimpleSplit ? 'split' : 'unexplained',
    split_suspected: isSimpleSplit,
    // "11:1" reverse (adjusted price is 11x the as-traded one) or "1:11" forward.
    split_ratio: isSimpleSplit ? (inverted ? `1:${nearest}` : `${nearest}:1`) : null,
    split_factor: isSimpleSplit ? nearest : null,
    direction: isSimpleSplit ? (inverted ? 'forward' : 'reverse') : null,
    relative_error: isSimpleSplit ? round(relativeError, 6) : null,
    note: isSimpleSplit
      ? `Stored prices are as-traded; today's bars are adjusted for an apparent ${inverted ? 'forward' : 'reverse'} split of ${inverted ? `1:${nearest}` : `${nearest}:1`}. The stored RETURN is unaffected; the price LEVELS are not comparable to a current chart.`
      : 'Stored and freshly-fetched prices disagree by more than ordinary drift and do not match a whole-number split. Cause unknown — do not mix the two.',
  }
}

function round(value, decimals) {
  const n = Number(value)
  return Number.isFinite(n) ? Number(n.toFixed(decimals)) : null
}

/**
 * Build the stamp stored on a row. Records only what was OBSERVED — the two
 * prices and the minute they came from — so a later reader can re-derive the
 * verdict instead of trusting it.
 */
export function priceBasisStamp({ storedPrice, freshPrice, minute, source = 'chart_service', now } = {}) {
  const mismatch = detectPriceBasisMismatch(storedPrice, freshPrice)
  const checkedAt = now instanceof Date ? now : new Date()
  const base = {
    checked_at: checkedAt,
    sampled_minute: minute ?? null,
    stored_price: finite(storedPrice),
    fresh_price: finite(freshPrice),
    source,
  }
  if (!mismatch) return { ...base, comparable: true, split_suspected: false }
  return { ...base, ...mismatch }
}

/**
 * THE GUARD FOR ANALYSIS PATHS.
 *
 * Any tooling that joins a stored row to freshly-fetched bars must call this
 * first. It throws rather than returning a flag on purpose: the failure mode
 * being prevented is a plausible-looking number (+1022%) computed straight
 * through a unit mismatch, and a return value is too easy to ignore. An audit
 * that stops loudly is worth more than one that quietly reports nonsense.
 *
 * Pass { soft: true } to get the reason back instead of an exception, for
 * callers that want to skip-and-tally rather than abort.
 */
export function assertComparableBasis(row = {}, { soft = false } = {}) {
  const basis = row.price_basis
  const bad = basis && basis.comparable === false
  if (!bad) return null
  const label = `${row.ticker ?? '?'} ${row.date ?? '?'}`
  const reason = basis.split_suspected
    ? `${label}: stored prices are as-traded, current bars are adjusted for an apparent ${basis.split_ratio} split (ratio ${basis.ratio}). Returns remain valid; price levels must not be mixed with freshly-fetched bars.`
    : `${label}: stored and current prices disagree by ratio ${basis.ratio} with no whole-number split explanation. Do not mix them.`
  if (soft) return reason
  throw new Error(`price basis mismatch — refusing to compute. ${reason}`)
}

export const PRICE_BASIS_CONSTANTS = {
  NEUTRAL_LOW,
  NEUTRAL_HIGH,
  SIMPLE_RATIO_TOLERANCE,
  MAX_SPLIT_FACTOR,
}
