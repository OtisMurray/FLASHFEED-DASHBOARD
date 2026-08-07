import test from 'node:test'
import assert from 'node:assert/strict'

import { articleWindowFilter, socialWindowFilter } from '../routes/aiCatalyst.js'

// The articles/socials collections store their timestamps as BSON int (epoch
// seconds) far more often than as a real Date. A Date-only `$gte` bound
// silently matches zero int-typed documents (Mongo range operators compare
// same-BSON-type only) — no error, no throw, just an empty result forever.
// These tests pin the shape of the fix: an explicit int/long/double branch
// whose bound is epoch SECONDS, alongside the date branch, mirroring
// lib/catalystIntelligence.js's causalWindowFilter.

function intBranch(filterOr, field) {
  return filterOr.find(clause => clause[field]?.$type === 'int')
}

test('articleWindowFilter carries an int branch bounded in epoch seconds, not ms or Date', () => {
  const since = new Date('2026-08-01T00:00:00Z')
  const now = new Date('2026-08-04T00:00:00Z')
  const filter = articleWindowFilter(since, now)

  assert.ok(Array.isArray(filter.$or), 'filter must be an $or of type-specific branches')

  const publishInt = intBranch(filter.$or, 'publish_date')
  assert.ok(publishInt, 'publish_date must have an int-typed branch')
  assert.equal(publishInt.publish_date.$type, 'int')
  assert.equal(publishInt.publish_date.$gte, Math.floor(since.getTime() / 1000))
  // Bound must be epoch SECONDS: getTime() is ms, so the branch bound is far
  // smaller than the raw millisecond value and is not a Date instance.
  assert.ok(!(publishInt.publish_date.$gte instanceof Date))
  assert.ok(publishInt.publish_date.$gte < since.getTime(), 'bound must be seconds, not milliseconds')

  const firstSeenInt = intBranch(filter.$or, 'first_seen_at')
  assert.ok(firstSeenInt, 'first_seen_at must have an int-typed branch')
  assert.equal(firstSeenInt.first_seen_at.$gte, Math.floor(since.getTime() / 1000))

  // The date branch must still exist so a real Date-typed doc keeps matching.
  const publishDateBranch = filter.$or.find(clause => clause.publish_date?.$type === 'date')
  assert.ok(publishDateBranch)
  assert.deepEqual(publishDateBranch.publish_date.$gte, since)
})

test('socialWindowFilter carries the same int-in-seconds branch for created_at', () => {
  const since = new Date('2026-08-06T00:00:00Z')
  const now = new Date('2026-08-07T00:00:00Z')
  const filter = socialWindowFilter(since, now)

  const createdInt = intBranch(filter.$or, 'created_at')
  assert.ok(createdInt, 'created_at must have an int-typed branch')
  assert.equal(createdInt.created_at.$type, 'int')
  assert.equal(createdInt.created_at.$gte, Math.floor(since.getTime() / 1000))
  assert.ok(!(createdInt.created_at.$gte instanceof Date))
})

// Mimics Mongo's own comparison for the int branch (same-type numeric range)
// so this can be asserted without a live Mongo connection.
function matchesIntBranch(filter, field, value) {
  const branch = intBranch(filter.$or, field)
  return value >= branch[field].$gte && value <= branch[field].$lte
}

test('a document with an integer publish_date inside the window matches; outside does not', () => {
  const since = new Date('2026-08-01T00:00:00Z')
  const now = new Date('2026-08-04T00:00:00Z')
  const filter = articleWindowFilter(since, now)

  const sinceSec = Math.floor(since.getTime() / 1000)
  const nowSec = Math.floor(now.getTime() / 1000)

  const insideWindow = sinceSec + 3600            // 1 hour after `since`
  const beforeWindow = sinceSec - 3600             // 1 hour before `since`
  const wayAfterWindow = nowSec + 10 * 24 * 60 * 60 // 10 days after `now`

  assert.equal(matchesIntBranch(filter, 'publish_date', insideWindow), true)
  assert.equal(matchesIntBranch(filter, 'publish_date', beforeWindow), false)
  assert.equal(matchesIntBranch(filter, 'publish_date', wayAfterWindow), false)
})

test('a document with an integer created_at inside the social window matches; outside does not', () => {
  const since = new Date('2026-08-06T00:00:00Z')
  const now = new Date('2026-08-07T00:00:00Z')
  const filter = socialWindowFilter(since, now)

  const sinceSec = Math.floor(since.getTime() / 1000)

  const insideWindow = sinceSec + 60
  const beforeWindow = sinceSec - 60

  assert.equal(matchesIntBranch(filter, 'created_at', insideWindow), true)
  assert.equal(matchesIntBranch(filter, 'created_at', beforeWindow), false)
})
