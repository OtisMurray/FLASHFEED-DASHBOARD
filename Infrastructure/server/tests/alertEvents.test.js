import test from 'node:test'
import assert from 'node:assert/strict'

import {
  runPositionAlertCheck,
  runNewsAlertCheck,
  ensureAlertEventIndexes,
  marketDayKey,
  ALERT_EVENTS_COLLECTION,
} from '../lib/alertEvents.js'
import { POSITION_HISTORY_COLLECTION } from '../lib/positionHistory.js'
import { DEFAULT_ALERT_PREFERENCES } from '../lib/alertPreferences.js'

const NOW = new Date('2026-08-07T18:00:00Z')      // 14:00 ET
const ENABLED_AT = new Date('2026-08-07T13:00:00Z')

// Minimal Mongo stand-in. It enforces the ONE constraint the dedupe design
// actually leans on — the unique index on eventKey — because a fake that lets a
// duplicate insert through would make the very bug these tests exist to catch
// invisible.
function fakeDb() {
  const store = new Map()
  const uniqueFields = new Map()

  const matches = (doc, query) => Object.entries(query).every(([key, cond]) => {
    // The news scan combines two $or clauses under $and, so the fake has to
    // understand both operators or it silently matches nothing.
    if (key === '$and') return cond.every(sub => matches(doc, sub))
    if (key === '$or') return cond.some(sub => matches(doc, sub))

    const value = doc[key]
    if (cond && typeof cond === 'object' && !(cond instanceof Date) && !Array.isArray(cond)) {
      if ('$ne' in cond) return value !== cond.$ne
      if ('$gte' in cond) {
        if (value == null) return false
        // $type narrows which representation a clause applies to; articles store
        // timestamps as either epoch seconds or Dates and the real query has one
        // clause per shape.
        if (cond.$type === 'number' && typeof value !== 'number') return false
        if (cond.$type === 'date' && !(value instanceof Date)) return false
        const left = typeof value === 'number' ? value : new Date(value).getTime()
        const right = typeof cond.$gte === 'number' ? cond.$gte : new Date(cond.$gte).getTime()
        return left >= right
      }
      if ('$in' in cond) {
        return Array.isArray(value) ? value.some(v => cond.$in.includes(v)) : cond.$in.includes(value)
      }
      if ('$exists' in cond) return (value !== undefined) === cond.$exists
    }
    return value === cond
  })

  const collection = (name) => {
    if (!store.has(name)) store.set(name, [])
    const docs = store.get(name)
    return {
      createIndex: async (spec, opts) => {
        if (opts?.unique) uniqueFields.set(name, Object.keys(spec)[0])
        return 'ok'
      },
      insertOne: async (doc) => {
        const uf = uniqueFields.get(name)
        if (uf && docs.some(d => d[uf] === doc[uf])) {
          const err = new Error(`E11000 duplicate key error: ${uf}`)
          err.code = 11000
          throw err
        }
        docs.push({ ...doc })
        return { insertedId: doc._id || docs.length }
      },
      findOne: async (query) => docs.find(d => matches(d, query)) || null,
      countDocuments: async (query = {}) => docs.filter(d => matches(d, query)).length,
      updateOne: async (query, update) => {
        const doc = docs.find(d => matches(d, query))
        if (doc) Object.assign(doc, update.$set || {})
        return { matchedCount: doc ? 1 : 0 }
      },
      find: (query = {}) => {
        let rows = docs.filter(d => matches(d, query))
        const api = {
          sort: () => api,
          limit: (n) => { rows = rows.slice(0, n); return api },
          toArray: async () => rows.map(r => ({ ...r })),
        }
        return api
      },
    }
  }
  return { db: { collection }, store }
}

function recordingSenders() {
  const sent = { email: [], sms: [] }
  return {
    sent,
    senders: {
      sendEmail: async (to, subject) => { sent.email.push({ to, subject }) },
      sendSms: async (to, body) => { sent.sms.push({ to, body }) },
    },
  }
}

const failingSenders = {
  sendEmail: async () => { throw new Error('Gmail is down') },
  sendSms: async () => { throw new Error('Twilio 500') },
}

function user(overrides = {}) {
  const { alertPreferences, ...rest } = overrides
  return {
    _id: 'user-1',
    email: 'me@example.com',
    phone: '+15551234567',
    ...rest,
    alertPreferences: {
      ...DEFAULT_ALERT_PREFERENCES,
      emailEnabled: true,
      entryEnabled: true,
      exitEnabled: true,
      minAiScore: 0,
      updatedAt: ENABLED_AT,
      ...alertPreferences,
    },
  }
}

function tradeRow(overrides = {}) {
  return {
    _id: 'NVDA|2026-08-07|1786000000|0.1000|5.00',
    ticker: 'NVDA',
    date: '2026-08-07',
    entry_price: 123.45,
    entry_time: '10:42',
    ai_rank_score: 78,
    created_at: new Date('2026-08-07T14:42:00Z'),
    updated_at: new Date('2026-08-07T14:42:00Z'),
    ...overrides,
  }
}

const closedRow = (overrides = {}) => tradeRow({
  finalized: true,
  exit_reason: 'price_trailing_stop',
  exit_price: 128.1,
  exit_time: '13:18',
  pnl_pct: 3.77,
  ...overrides,
})

async function seed(db, rows) {
  await ensureAlertEventIndexes(db)
  for (const row of rows) await db.collection(POSITION_HISTORY_COLLECTION).insertOne(row)
}

const events = (store) => store.get(ALERT_EVENTS_COLLECTION) || []
const run = (db, opts) => runPositionAlertCheck(db, {
  mailerReady: true, smsReady: true, now: NOW, ...opts,
})

// ── Entry: exactly once, ever (prompt requirements 5, 6, 10) ────────────────

test('a new canonical trade produces exactly one Entry event per enabled channel', async () => {
  const { db, store } = fakeDb()
  const { sent, senders } = recordingSenders()
  await seed(db, [tradeRow()])

  const u = user({ alertPreferences: { smsEnabled: true } })
  const summary = await run(db, { users: [u], senders })

  assert.equal(summary.entry, 1)
  assert.equal(sent.email.length, 1)
  assert.equal(sent.sms.length, 1)
  assert.match(sent.email[0].subject, /ENTRY — NVDA/)
  // One LOGICAL event, despite two channels.
  assert.equal(events(store).length, 1)
})

test('re-processing the same trade never resends Entry', async () => {
  const { db, store } = fakeDb()
  const { sent, senders } = recordingSenders()
  await seed(db, [tradeRow()])
  const u = user()

  for (let cycle = 0; cycle < 4; cycle += 1) await run(db, { users: [u], senders })

  assert.equal(sent.email.length, 1)
  assert.equal(events(store).length, 1)
})

test('a process restart does not replay entries already recorded today', async () => {
  const { db, store } = fakeDb()
  const first = recordingSenders()
  await seed(db, [tradeRow()])
  const u = user()
  await run(db, { users: [u], senders: first.senders })

  // A restart loses all process memory; the durable alert_events row is the
  // only thing standing between the user and a duplicate. Fresh senders stand
  // in for the new process.
  const second = recordingSenders()
  await run(db, { users: [u], senders: second.senders })

  assert.equal(first.sent.email.length, 1)
  assert.equal(second.sent.email.length, 0)
  assert.equal(events(store).length, 1)
})

test('superseded phantom entries are never alerted on', async () => {
  const { db } = fakeDb()
  const { sent, senders } = recordingSenders()
  await seed(db, [tradeRow({ superseded: true })])

  await run(db, { users: [user()], senders })
  assert.equal(sent.email.length, 0)
})

// ── No historical blast (prompt requirement 9) ──────────────────────────────

test('positions recorded before alerts were enabled never notify', async () => {
  const { db } = fakeDb()
  const { sent, senders } = recordingSenders()
  await seed(db, [tradeRow({ created_at: new Date('2026-08-01T14:00:00Z') })])

  await run(db, { users: [user()], senders })
  assert.equal(sent.email.length, 0)
})

test('a user who has never saved preferences gets nothing, even with a legacy opt-in', async () => {
  const { db } = fakeDb()
  const { sent, senders } = recordingSenders()
  await seed(db, [tradeRow()])

  const legacy = { _id: 'u2', email: 'x@y.com', phone: '+15550000000', smsAlertsOptIn: true, smsAlertTickers: ['NVDA'] }
  await run(db, { users: [legacy], senders })
  assert.equal(sent.email.length + sent.sms.length, 0)
})

// ── Filters (prompt requirements 11, 12) ────────────────────────────────────

test('ticker scope limits which positions alert', async () => {
  const { db } = fakeDb()
  const { sent, senders } = recordingSenders()
  await seed(db, [tradeRow(), tradeRow({ _id: 'AMD|x', ticker: 'AMD' })])

  await run(db, {
    users: [user({ alertPreferences: { tickerScope: 'selected', tickers: ['AMD'] } })],
    senders,
  })
  assert.equal(sent.email.length, 1)
  assert.match(sent.email[0].subject, /AMD/)
})

test('the minimum AI score filters notifications without touching strategy output', async () => {
  const { db, store } = fakeDb()
  const { sent, senders } = recordingSenders()
  await seed(db, [tradeRow({ ai_rank_score: 30 })])

  await run(db, { users: [user({ alertPreferences: { minAiScore: 60 } })], senders })

  assert.equal(sent.email.length, 0)
  // The canonical row is untouched — a notification filter must never edit history.
  const rows = store.get(POSITION_HISTORY_COLLECTION)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].ai_rank_score, 30)
})

// ── Daily cap (prompt requirements 13, 14, 15) ──────────────────────────────

test('the daily cap limits Entry alerts', async () => {
  const { db } = fakeDb()
  const { sent, senders } = recordingSenders()
  await seed(db, [
    tradeRow({ _id: 't1', ticker: 'AAA' }),
    tradeRow({ _id: 't2', ticker: 'BBB' }),
    tradeRow({ _id: 't3', ticker: 'CCC' }),
  ])

  const summary = await run(db, { users: [user({ alertPreferences: { maxPerDay: 2 } })], senders })
  assert.equal(sent.email.length, 2)
  assert.equal(summary.skipped_cap > 0, true)
})

test('one event on two channels counts once toward the cap', async () => {
  const { db } = fakeDb()
  const { sent, senders } = recordingSenders()
  await seed(db, [tradeRow({ _id: 't1', ticker: 'AAA' }), tradeRow({ _id: 't2', ticker: 'BBB' })])

  await run(db, {
    users: [user({ alertPreferences: { smsEnabled: true, maxPerDay: 2 } })],
    senders,
  })
  // Two events × two channels = 4 sends, still only 2 against a cap of 2.
  assert.equal(sent.email.length, 2)
  assert.equal(sent.sms.length, 2)
})

test('an Exit for a delivered Entry is never suppressed by the daily cap', async () => {
  const { db, store } = fakeDb()
  const { sent, senders } = recordingSenders()
  const u = user({ alertPreferences: { maxPerDay: 1 } })

  await seed(db, [tradeRow()])
  await run(db, { users: [u], senders })          // burns the single daily slot
  assert.equal(sent.email.length, 1)

  // Same trade now closes. The cap is already spent — the exit must still go.
  store.set(POSITION_HISTORY_COLLECTION, [closedRow({ updated_at: new Date('2026-08-07T17:18:00Z') })])
  const summary = await run(db, { users: [u], senders })

  assert.equal(summary.exit, 1)
  assert.equal(sent.email.length, 2)
  assert.match(sent.email[1].subject, /EXIT — NVDA/)
  const exitEvent = events(store).find(e => e.eventType === 'exit')
  assert.equal(exitEvent.countsTowardCap, false)
})

// ── Exit correctness (prompt requirements 7, 8) ─────────────────────────────

test('a canonical exit sends once and never resends', async () => {
  const { db, store } = fakeDb()
  const { sent, senders } = recordingSenders()
  const u = user()
  await seed(db, [tradeRow()])
  await run(db, { users: [u], senders })

  store.set(POSITION_HISTORY_COLLECTION, [closedRow({ updated_at: new Date('2026-08-07T17:18:00Z') })])
  await run(db, { users: [u], senders })
  await run(db, { users: [u], senders })
  await run(db, { users: [u], senders })

  assert.equal(sent.email.filter(m => /EXIT/.test(m.subject)).length, 1)
})

test('no isolated Exit for a trade whose Entry was filtered out', async () => {
  const { db } = fakeDb()
  const { sent, senders } = recordingSenders()
  // Entry filtered by score; the exit must not arrive on its own.
  await seed(db, [closedRow({ ai_rank_score: 10, updated_at: new Date('2026-08-07T17:18:00Z') })])

  const summary = await run(db, { users: [user({ alertPreferences: { minAiScore: 60 } })], senders })
  assert.equal(sent.email.length, 0)
  assert.equal(summary.skipped_no_entry > 0, true)
})

test('session_end is a mark, not a close, so it raises no Exit alert', async () => {
  const { db, store } = fakeDb()
  const { sent, senders } = recordingSenders()
  const u = user()
  await seed(db, [tradeRow()])
  await run(db, { users: [u], senders })

  store.set(POSITION_HISTORY_COLLECTION, [tradeRow({
    finalized: true, exit_reason: 'session_end', updated_at: new Date('2026-08-07T17:18:00Z'),
  })])
  const summary = await run(db, { users: [u], senders })
  assert.equal(summary.exit, 0)
})

// ── Provider failure containment (prompt requirement 17) ────────────────────

test('a provider outage neither throws nor marks the event sent', async () => {
  const { db, store } = fakeDb()
  await seed(db, [tradeRow()])

  const summary = await run(db, { users: [user()], senders: failingSenders })
  assert.equal(summary.entry, 0)
  assert.equal(summary.failed, 1)

  const event = events(store)[0]
  assert.equal(event.status, 'failed')
  assert.equal(event.channels[0].status, 'failed')
  assert.equal(event.channels[0].sentAt, null)
  assert.match(event.channels[0].error, /Gmail is down/)
})

test('a failed Entry does not unlock an Exit alert', async () => {
  const { db, store } = fakeDb()
  await seed(db, [tradeRow()])
  const u = user()
  await run(db, { users: [u], senders: failingSenders })

  store.set(POSITION_HISTORY_COLLECTION, [closedRow({ updated_at: new Date('2026-08-07T17:18:00Z') })])
  const { sent, senders } = recordingSenders()
  const summary = await run(db, { users: [u], senders })
  assert.equal(sent.email.length, 0)
  assert.equal(summary.skipped_no_entry > 0, true)
})

// ── Channel availability ────────────────────────────────────────────────────

test('an unconfigured provider is simply not used', async () => {
  const { db } = fakeDb()
  const { sent, senders } = recordingSenders()
  await seed(db, [tradeRow()])

  await run(db, {
    users: [user({ alertPreferences: { smsEnabled: true } })],
    senders,
    smsReady: false,
  })
  assert.equal(sent.email.length, 1)
  assert.equal(sent.sms.length, 0)
})

// ── News (prompt requirement 16) ────────────────────────────────────────────

const newsUser = (overrides = {}) => user({
  alertPreferences: {
    entryEnabled: false, exitEnabled: false, newsEnabled: true,
    newsTickers: ['NVDA'], newsCooldownMinutes: 30, ...overrides,
  },
})

async function seedArticle(db, overrides = {}) {
  await ensureAlertEventIndexes(db)
  await db.collection('articles').insertOne({
    _id: 'a1', ticker: 'NVDA', title: 'NVDA beats estimates',
    sentiment: 'bullish', publish_date: Math.floor(NOW.getTime() / 1000) - 60,
    ...overrides,
  })
}

test('a watched-ticker article alerts once and is not resent', async () => {
  const { db } = fakeDb()
  const { sent, senders } = recordingSenders()
  await seedArticle(db)
  const opts = { users: [newsUser()], mailerReady: true, smsReady: true, senders, now: NOW }

  await runNewsAlertCheck(db, opts)
  await runNewsAlertCheck(db, opts)

  assert.equal(sent.email.length, 1)
  assert.match(sent.email[0].subject, /NEWS — NVDA/)
})

test('the news cooldown suppresses a second article on the same ticker', async () => {
  const { db } = fakeDb()
  const { sent, senders } = recordingSenders()
  await seedArticle(db)
  const opts = { users: [newsUser()], mailerReady: true, smsReady: true, senders, now: NOW }
  await runNewsAlertCheck(db, opts)

  await db.collection('articles').insertOne({
    _id: 'a2', ticker: 'NVDA', title: 'NVDA again', publish_date: Math.floor(NOW.getTime() / 1000) - 30,
  })
  const summary = await runNewsAlertCheck(db, opts)

  assert.equal(sent.email.length, 1)
  assert.equal(summary.skipped_cooldown > 0, true)
})

test('news for an unwatched ticker is ignored', async () => {
  const { db } = fakeDb()
  const { sent, senders } = recordingSenders()
  await seedArticle(db, { _id: 'a3', ticker: 'TSLA' })

  await runNewsAlertCheck(db, {
    users: [newsUser()], mailerReady: true, smsReady: true, senders, now: NOW,
  })
  assert.equal(sent.email.length, 0)
})

// ── Day bucketing ──────────────────────────────────────────────────────────

test('the daily cap buckets by market day, not UTC day', () => {
  // 21:00 ET on the 7th is 01:00 UTC on the 8th. A UTC bucket would split the
  // evening session away from the afternoon that preceded it.
  assert.equal(marketDayKey(new Date('2026-08-08T01:00:00Z')), '2026-08-07')
})
