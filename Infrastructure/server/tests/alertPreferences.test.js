import test from 'node:test'
import assert from 'node:assert/strict'

import {
  normalizeAlertPreferences,
  effectiveAlertPreferences,
  resolveAlertEmail,
  scopeTickersFor,
  passesAiScoreFilter,
  normalizeTickerList,
  AlertPreferenceError,
  DEFAULT_ALERT_PREFERENCES,
  MAX_ALERT_TICKERS,
} from '../lib/alertPreferences.js'

const PHONE = '+15551234567'
const throws = (fn) => assert.throws(fn, AlertPreferenceError)

// ── validation / normalization (prompt requirement 4) ───────────────────────

test('tickers are uppercased, de-duplicated and order-preserving', () => {
  assert.deepEqual(normalizeTickerList(['nvda', 'AMD', 'nvda', ' tsla ']), ['NVDA', 'AMD', 'TSLA'])
})

test('invalid tickers and oversized lists are rejected, not silently dropped', () => {
  throws(() => normalizeTickerList(['NOT A TICKER']))
  throws(() => normalizeTickerList(['TOOOOLONGGG']))
  throws(() => normalizeTickerList(Array.from({ length: MAX_ALERT_TICKERS + 1 }, (_, i) => `A${i}`)))
  throws(() => normalizeTickerList('NVDA'))
})

test('a malformed alert email is rejected', () => {
  throws(() => normalizeAlertPreferences({ alertEmail: 'not-an-email' }, { accountEmail: 'a@b.com' }))
})

test('an alert email equal to the account email is stored as null so the fallback stays live', () => {
  const prefs = normalizeAlertPreferences({ alertEmail: 'Me@Example.com' }, { accountEmail: 'me@example.com' })
  assert.equal(prefs.alertEmail, null)
  // ...and a genuinely different address is kept.
  const other = normalizeAlertPreferences({ alertEmail: 'alerts@example.com' }, { accountEmail: 'me@example.com' })
  assert.equal(other.alertEmail, 'alerts@example.com')
})

test('SMS cannot be enabled without a valid E.164 phone number', () => {
  throws(() => normalizeAlertPreferences({ smsEnabled: true }, { phone: null }))
  throws(() => normalizeAlertPreferences({ smsEnabled: true }, { phone: '5551234567' }))
  const ok = normalizeAlertPreferences({ smsEnabled: true }, { phone: PHONE })
  assert.equal(ok.smsEnabled, true)
})

test('out-of-range filter values are rejected', () => {
  throws(() => normalizeAlertPreferences({ minAiScore: 101 }))
  throws(() => normalizeAlertPreferences({ minAiScore: -1 }))
  throws(() => normalizeAlertPreferences({ maxPerDay: 7 }))
  throws(() => normalizeAlertPreferences({ newsCooldownMinutes: 45 }))
  throws(() => normalizeAlertPreferences({ tickerScope: 'some' }))
})

test('unlimited is representable and round-trips as null', () => {
  assert.equal(normalizeAlertPreferences({ maxPerDay: null }).maxPerDay, null)
  assert.equal(normalizeAlertPreferences({ maxPerDay: 'unlimited' }).maxPerDay, null)
})

test('selected scope with no tickers is refused rather than silently alerting on everything', () => {
  throws(() => normalizeAlertPreferences({ tickerScope: 'selected', entryEnabled: true }, { current: { tickers: [] } }))
})

test('a partial patch cannot blank fields it did not mention', () => {
  const current = { ...DEFAULT_ALERT_PREFERENCES, tickers: ['NVDA'], minAiScore: 70, newsEnabled: true }
  const next = normalizeAlertPreferences({ emailEnabled: true }, { current })
  assert.deepEqual(next.tickers, ['NVDA'])
  assert.equal(next.minAiScore, 70)
  assert.equal(next.newsEnabled, true)
  assert.equal(next.emailEnabled, true)
})

// ── 2FA separation (prompt: alerts and 2FA must stay separate concepts) ─────

test('saving alert preferences produces no 2FA field at all', () => {
  const next = normalizeAlertPreferences({ smsEnabled: true, entryEnabled: true }, { phone: PHONE })
  assert.equal('twoFactorMethod' in next, false)
  assert.equal('twoFactorCodeHash' in next, false)
})

// ── legacy migration ───────────────────────────────────────────────────────

test('a legacy SMS opt-in is honoured until the user saves real preferences', () => {
  const legacy = effectiveAlertPreferences({ smsAlertsOptIn: true, smsAlertTickers: ['nvda', 'amd'] })
  assert.equal(legacy.smsEnabled, true)
  assert.equal(legacy.newsEnabled, true)
  assert.deepEqual(legacy.newsTickers, ['NVDA', 'AMD'])
  // No watermark: migration alone must never make historical events eligible.
  assert.equal(legacy.updatedAt, null)
})

test('an explicit save wins over the legacy flag, so turning news off stays off', () => {
  const saved = effectiveAlertPreferences({
    smsAlertsOptIn: true,
    smsAlertTickers: ['NVDA'],
    alertPreferences: { ...DEFAULT_ALERT_PREFERENCES, newsEnabled: false, updatedAt: new Date() },
  })
  assert.equal(saved.newsEnabled, false)
})

// ── resolution helpers ─────────────────────────────────────────────────────

test('the alert email falls back to the account email but is never invented', () => {
  assert.equal(resolveAlertEmail({ email: 'me@example.com' }), 'me@example.com')
  assert.equal(resolveAlertEmail({ email: 'me@example.com', alertPreferences: { alertEmail: 'x@y.com' } }), 'x@y.com')
  assert.equal(resolveAlertEmail({}), null)
})

test('ticker scope: all means unrestricted, selected means exactly the list', () => {
  assert.equal(scopeTickersFor({ tickerScope: 'all' }, 'position'), null)
  assert.deepEqual([...scopeTickersFor({ tickerScope: 'selected', tickers: ['NVDA'] }, 'position')], ['NVDA'])
})

test('news scope is always explicit — an empty list means no news, not all news', () => {
  assert.equal(scopeTickersFor({ newsTickers: [] }, 'news').size, 0)
})

test('the AI score filter never manufactures a score for a row that has none', () => {
  assert.equal(passesAiScoreFilter({ minAiScore: 50 }, 80), true)
  assert.equal(passesAiScoreFilter({ minAiScore: 50 }, 20), false)
  assert.equal(passesAiScoreFilter({ minAiScore: 50 }, null), false)
  assert.equal(passesAiScoreFilter({ minAiScore: 50 }, undefined), false)
  // A zero floor is "no filter", so an unscored row still passes.
  assert.equal(passesAiScoreFilter({ minAiScore: 0 }, null), true)
})
