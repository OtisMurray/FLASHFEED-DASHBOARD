import test from 'node:test'
import assert from 'node:assert/strict'

// Boundary behaviour for the future-dated social row filter.
//
// The rolling route bounds _event_sec to [now - window, now + tolerance]. These
// tests pin the exact edges of that upper bound, because the whole point of the
// tolerance is that it is small and deliberate — an accidental change from 300
// seconds to 300 minutes would silently readmit the corrupt rows it exists to
// keep out.

const SOCIAL_FUTURE_TOLERANCE_SECONDS = 300

function socialMaxEventSec(nowSec) {
  return nowSec + SOCIAL_FUTURE_TOLERANCE_SECONDS
}

// Mirrors the Mongo $match: { _event_sec: { $gte: sinceSec, $lte: maxEventSec } }
function isServed(eventSec, { nowSec, windowMinutes }) {
  const sinceSec = nowSec - windowMinutes * 60
  return eventSec >= sinceSec && eventSec <= socialMaxEventSec(nowSec)
}

const NOW = 1_770_000_000
const win = { nowSec: NOW, windowMinutes: 5 }

test('the tolerance is minutes, not hours', () => {
  assert.equal(SOCIAL_FUTURE_TOLERANCE_SECONDS, 300)
  assert.ok(SOCIAL_FUTURE_TOLERANCE_SECONDS < 3600, 'an hour of slack would readmit corrupt rows')
})

test('a row exactly at now is served', () => {
  assert.equal(isServed(NOW, win), true)
})

test('a row one second inside the future tolerance is served', () => {
  assert.equal(isServed(NOW + SOCIAL_FUTURE_TOLERANCE_SECONDS - 1, win), true)
})

test('a row exactly at the tolerance edge is served (bound is inclusive)', () => {
  assert.equal(isServed(NOW + SOCIAL_FUTURE_TOLERANCE_SECONDS, win), true)
})

test('a row one second past the tolerance is refused', () => {
  assert.equal(isServed(NOW + SOCIAL_FUTURE_TOLERANCE_SECONDS + 1, win), false)
})

test('the real production corruption — days ahead — is refused', () => {
  // The 81 rows found in production on 2026-08-05 sat between 4.9 and 65.9 days
  // ahead of now. Both ends must be excluded.
  assert.equal(isServed(NOW + Math.round(4.9 * 86_400), win), false)
  assert.equal(isServed(NOW + Math.round(65.9 * 86_400), win), false)
})

test('the lower bound still works — a row older than the window is refused', () => {
  assert.equal(isServed(NOW - 5 * 60 - 1, win), false)
  assert.equal(isServed(NOW - 5 * 60, win), true)
})

test('widening the window does not widen the future tolerance', () => {
  // A 24h window must still refuse a row 10 minutes in the future: the upper
  // bound is anchored to now, not to the window size.
  const day = { nowSec: NOW, windowMinutes: 1440 }
  assert.equal(isServed(NOW - 23 * 3600, day), true)
  assert.equal(isServed(NOW + 600, day), false)
})
