// Per-account trading-alert preferences: defaults, validation, normalization.
//
// Pure functions only — no Mongo, no network — so every validation rule is
// testable on its own and the route layer stays a thin wrapper. The React
// client is never trusted: everything that arrives from the browser goes
// through normalizeAlertPreferences before it reaches the database.
//
// SEPARATE FROM 2FA, DELIBERATELY. twoFactorMethod and the alert channel flags
// are different fields with different meanings — enabling SMS alerts must never
// silently move a user's login codes to SMS, and vice versa. The only field
// shared with 2FA is `phone`, which is the user's one real phone number.

const TICKER_RE = /^[A-Z][A-Z0-9.-]{0,7}$/
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const E164_RE = /^\+[1-9]\d{6,14}$/

export const MAX_ALERT_TICKERS = 50
export const TICKER_SCOPES = ['all', 'selected']
export const NEWS_COOLDOWN_CHOICES = [15, 30, 60]
// null means unlimited. Kept as null rather than Infinity so it round-trips
// through JSON and Mongo unchanged.
export const MAX_PER_DAY_CHOICES = [5, 10, 20, null]

// Aligned with POSITION_AI_MIN_SCORE (default 50), the floor the production
// candidate pipeline already applies in lib/aiPositionCandidates.js. Starting
// the NOTIFICATION filter at the same value means turning alerts on does not
// silently widen or narrow what the user hears about relative to what the
// strategy actually trades.
export const DEFAULT_MIN_AI_SCORE = Number(process.env.POSITION_AI_MIN_SCORE || 50)

export const DEFAULT_ALERT_PREFERENCES = Object.freeze({
  alertEmail: null,          // null => fall back to the account email
  emailEnabled: false,
  smsEnabled: false,
  entryEnabled: false,
  exitEnabled: false,
  newsEnabled: false,
  tickerScope: 'all',
  tickers: [],
  newsTickers: [],
  minAiScore: DEFAULT_MIN_AI_SCORE,
  maxPerDay: 10,
  newsCooldownMinutes: 30,
  updatedAt: null,
})

export class AlertPreferenceError extends Error {}

function fail(message) {
  throw new AlertPreferenceError(message)
}

function asBool(value, current) {
  if (value === undefined) return current
  if (typeof value !== 'boolean') fail('Enable/disable values must be true or false.')
  return value
}

/** Uppercases, de-duplicates and validates a ticker list. Order is preserved. */
export function normalizeTickerList(value, { field = 'tickers' } = {}) {
  if (!Array.isArray(value)) fail(`${field} must be a list.`)
  const seen = new Set()
  const out = []
  for (const raw of value) {
    const ticker = String(raw ?? '').trim().toUpperCase()
    if (!ticker) continue
    if (!TICKER_RE.test(ticker)) fail(`"${ticker}" is not a valid ticker symbol.`)
    if (seen.has(ticker)) continue
    seen.add(ticker)
    out.push(ticker)
  }
  if (out.length > MAX_ALERT_TICKERS) fail(`Pick at most ${MAX_ALERT_TICKERS} tickers.`)
  return out
}

/**
 * Merge a client patch onto the stored preferences.
 *
 * Only keys actually present in `patch` are considered, so a partial save from
 * one part of the UI cannot blank out a field another part owns. Anything
 * invalid throws AlertPreferenceError, which the route turns into a 400 —
 * nothing is silently coerced into a value the user did not choose.
 */
export function normalizeAlertPreferences(patch = {}, { current = {}, accountEmail = '', phone = null } = {}) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    fail('Preferences must be an object.')
  }
  const base = { ...DEFAULT_ALERT_PREFERENCES, ...current }
  const next = { ...base }

  if (patch.alertEmail !== undefined) {
    const raw = String(patch.alertEmail ?? '').trim().toLowerCase()
    if (!raw) {
      next.alertEmail = null              // explicit clear => fall back to account email
    } else {
      if (!EMAIL_RE.test(raw)) fail('Enter a valid alert email address.')
      // Storing null when it matches the account email keeps the fallback live:
      // if the account email later changes, alerts follow it automatically.
      next.alertEmail = raw === String(accountEmail || '').trim().toLowerCase() ? null : raw
    }
  }

  next.emailEnabled = asBool(patch.emailEnabled, base.emailEnabled)
  next.smsEnabled = asBool(patch.smsEnabled, base.smsEnabled)
  next.entryEnabled = asBool(patch.entryEnabled, base.entryEnabled)
  next.exitEnabled = asBool(patch.exitEnabled, base.exitEnabled)
  next.newsEnabled = asBool(patch.newsEnabled, base.newsEnabled)

  // SMS without a number would be a control that looks on and never delivers.
  // Refuse it at the API rather than letting the UI imply it works.
  if (next.smsEnabled && !E164_RE.test(String(phone || ''))) {
    fail('Add a mobile number in E.164 format (e.g. +15551234567) before enabling text alerts.')
  }

  if (patch.tickerScope !== undefined) {
    const scope = String(patch.tickerScope || '')
    if (!TICKER_SCOPES.includes(scope)) fail('Stock scope must be "all" or "selected".')
    next.tickerScope = scope
  }
  if (patch.tickers !== undefined) next.tickers = normalizeTickerList(patch.tickers, { field: 'tickers' })
  if (patch.newsTickers !== undefined) next.newsTickers = normalizeTickerList(patch.newsTickers, { field: 'newsTickers' })

  if (next.tickerScope === 'selected' && !next.tickers.length && (next.entryEnabled || next.exitEnabled)) {
    fail('Add at least one ticker, or switch the scope back to all qualifying positions.')
  }

  if (patch.minAiScore !== undefined) {
    const n = Number(patch.minAiScore)
    if (!Number.isFinite(n) || n < 0 || n > 100) fail('Minimum AI score must be between 0 and 100.')
    next.minAiScore = Math.round(n)
  }

  if (patch.maxPerDay !== undefined) {
    const raw = patch.maxPerDay
    if (raw === null || raw === 'unlimited') {
      next.maxPerDay = null
    } else {
      const n = Number(raw)
      if (!MAX_PER_DAY_CHOICES.includes(n)) fail('Maximum alerts per day must be 5, 10, 20, or unlimited.')
      next.maxPerDay = n
    }
  }

  if (patch.newsCooldownMinutes !== undefined) {
    const n = Number(patch.newsCooldownMinutes)
    if (!NEWS_COOLDOWN_CHOICES.includes(n)) fail('News cooldown must be 15, 30, or 60 minutes.')
    next.newsCooldownMinutes = n
  }

  return next
}

/**
 * The address alerts actually go to: the saved alert email when set, otherwise
 * the account's own email. Never invents an address.
 */
export function resolveAlertEmail(user = {}) {
  const explicit = String(user?.alertPreferences?.alertEmail || '').trim()
  if (explicit) return explicit
  const account = String(user?.email || '').trim()
  return account || null
}

/**
 * Read a user's effective preferences, folding in the legacy SMS-news settings
 * so an existing opted-in user keeps their choice instead of silently losing it.
 *
 * Legacy migration only applies when the account has never saved the new
 * preferences (updatedAt is null). Once they have, their explicit choices win —
 * a user who deliberately turned news alerts OFF must not have the old
 * smsAlertsOptIn flag turn them back on.
 */
export function effectiveAlertPreferences(user = {}) {
  const stored = user?.alertPreferences || {}
  const hasSaved = !!stored.updatedAt
  if (hasSaved) return { ...DEFAULT_ALERT_PREFERENCES, ...stored }

  const legacyOptIn = user?.smsAlertsOptIn === true
  const legacyTickers = Array.isArray(user?.smsAlertTickers) ? user.smsAlertTickers : []
  if (!legacyOptIn || !legacyTickers.length) return { ...DEFAULT_ALERT_PREFERENCES, ...stored }

  return {
    ...DEFAULT_ALERT_PREFERENCES,
    ...stored,
    smsEnabled: true,
    newsEnabled: true,
    newsTickers: legacyTickers.map(t => String(t).toUpperCase()).filter(t => TICKER_RE.test(t)),
    // No updatedAt: this is a READ-time interpretation of the old settings, not
    // a save. It stays live until the user saves real preferences, and it never
    // acts as an alert watermark (see alertEvents.js — a null watermark means
    // "nothing is eligible yet", so migration alone cannot trigger a backfill).
  }
}

/** Which tickers a given alert type should fire on, or null meaning "all". */
export function scopeTickersFor(prefs, type) {
  if (type === 'news') {
    // News is always explicitly scoped. "Every ticker in the market" is not a
    // useful or safe default for a per-article firehose, so an empty list means
    // no news alerts rather than all of them.
    return new Set(prefs.newsTickers || [])
  }
  if (prefs.tickerScope === 'all') return null
  return new Set(prefs.tickers || [])
}

/** True when this trade passes the user's notification-only AI score filter. */
export function passesAiScoreFilter(prefs, aiRankScore) {
  const floor = Number(prefs?.minAiScore ?? 0)
  if (!(floor > 0)) return true
  const score = aiRankScore == null ? null : Number(aiRankScore)
  // Never manufacture a score. A row with no ai_rank_score cannot be shown to
  // clear a floor, so it does not.
  if (score == null || !Number.isFinite(score)) return false
  return score >= floor
}
