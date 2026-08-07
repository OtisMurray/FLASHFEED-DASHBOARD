// Alert event detection + durable delivery audit.
//
// TWO HARD RULES SHAPE THIS FILE.
//
// 1. It never decides what the strategy did. Entry and Exit eligibility are
//    read back from canonical screener_position_history rows that
//    persistPositionSnapshot/mergeTradeSnapshot already wrote and finalized.
//    Nothing here re-runs a threshold, re-derives a stop, or interprets a UI
//    label. If the canonical row does not say a trade opened or closed, no
//    alert exists to send.
//
// 2. Deduplication is durable, not in-memory. One document per LOGICAL event
//    (user + event type + subject) carries a unique index on `eventKey`, so a
//    process restart, an overlapping scheduler run, or a re-read of the same
//    trade cannot produce a second send. The document is reserved BEFORE the
//    provider call and only marked sent after the provider succeeds.
//
// Reading rather than hooking the in-memory merge result is deliberate: it
// survives restarts, it sees the reconciliation (`superseded`) that runs after
// the write, and it cannot be fooled by a cycle that crashed mid-flight.

import { isFillExitReason, POSITION_HISTORY_COLLECTION } from './positionHistory.js'
import { effectiveAlertPreferences, passesAiScoreFilter, scopeTickersFor } from './alertPreferences.js'
import { entryMessage, exitMessage, newsMessage } from './alertMessages.js'

export const ALERT_EVENTS_COLLECTION = 'alert_events'

const MARKET_TZ = process.env.MARKET_WINDOW_TIMEZONE || 'America/New_York'
// A cap called "per day" has to mean the user's trading day, not UTC midnight
// splitting the afternoon session in two.
export function marketDayKey(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: MARKET_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now)
}

export const eventKeyFor = (userId, eventType, subjectId) => `${userId}|${eventType}|${subjectId}`

export async function ensureAlertEventIndexes(db) {
  if (!db) return false
  const coll = db.collection(ALERT_EVENTS_COLLECTION)
  // The constraint that makes double-sending impossible even when two scheduler
  // runs overlap: the second insert loses with E11000 and is skipped.
  await coll.createIndex({ eventKey: 1 }, { unique: true })
  await coll.createIndex({ user: 1, dayKey: 1, countsTowardCap: 1 })
  await coll.createIndex({ user: 1, eventType: 1, subjectId: 1 })
  await coll.createIndex({ createdAt: -1 })
  return true
}

const isDuplicateKeyError = (err) => err?.code === 11000 || /duplicate key/i.test(String(err?.message || ''))

/**
 * Claim the right to send one logical event, exactly once.
 *
 * Returns null when this user has already been notified of this event — the
 * unique index, not a read-then-write check, is what makes that safe under
 * concurrency.
 */
export async function reserveEvent(db, { userId, eventType, subjectId, ticker, channels, dayKey, countsTowardCap }) {
  const doc = {
    eventKey: eventKeyFor(userId, eventType, subjectId),
    user: String(userId),
    eventType,
    subjectId: String(subjectId),
    ticker: String(ticker || '').toUpperCase() || null,
    dayKey,
    countsTowardCap: !!countsTowardCap,
    status: 'pending',
    channels: channels.map(channel => ({ channel, status: 'pending', sentAt: null, error: null })),
    createdAt: new Date(),
  }
  try {
    await db.collection(ALERT_EVENTS_COLLECTION).insertOne(doc)
    return doc
  } catch (err) {
    if (isDuplicateKeyError(err)) return null
    throw err
  }
}

/** Record the outcome of each channel. Never claims "sent" before the provider returned. */
export async function recordEventOutcome(db, eventKey, results) {
  const channels = results.map(r => ({
    channel: r.channel,
    status: r.ok ? 'sent' : 'failed',
    sentAt: r.ok ? new Date() : null,
    // Truncated: enough to diagnose a provider rejection, not a copy of the
    // message body or anything a provider echoed back.
    error: r.ok ? null : String(r.error || '').slice(0, 200),
  }))
  const anySent = channels.some(c => c.status === 'sent')
  const allSent = channels.every(c => c.status === 'sent')
  await db.collection(ALERT_EVENTS_COLLECTION).updateOne(
    { eventKey },
    { $set: { channels, status: allSent ? 'sent' : anySent ? 'partial' : 'failed', completedAt: new Date() } },
  )
  return anySent
}

export async function countCappedEventsToday(db, userId, dayKey) {
  return db.collection(ALERT_EVENTS_COLLECTION).countDocuments({
    user: String(userId), dayKey, countsTowardCap: true,
  })
}

/** Did this user actually receive the Entry alert for this trade? */
export async function entryWasDelivered(db, userId, subjectId) {
  const doc = await db.collection(ALERT_EVENTS_COLLECTION).findOne({
    user: String(userId), eventType: 'entry', subjectId: String(subjectId),
    status: { $in: ['sent', 'partial'] },
  })
  return !!doc
}

/** The channels a user wants AND the server can actually deliver on right now. */
export function activeChannels(prefs, { mailerReady, smsReady, phone, email }) {
  const channels = []
  if (prefs.emailEnabled && mailerReady && email) channels.push('email')
  if (prefs.smsEnabled && smsReady && phone) channels.push('sms')
  return channels
}

/**
 * Deliver one logical event across a user's channels, with the reservation and
 * audit trail around it.
 *
 * Provider failure is contained here: it is recorded and returned, never
 * thrown, so a Twilio outage cannot propagate into the position-history
 * scheduler that calls this.
 */
export async function deliverEvent(db, {
  userId, eventType, subjectId, ticker, channels, dayKey, countsTowardCap, message,
  email, phone, senders,
}) {
  const reserved = await reserveEvent(db, { userId, eventType, subjectId, ticker, channels, dayKey, countsTowardCap })
  if (!reserved) return { skipped: 'already_sent' }

  const results = []
  for (const channel of channels) {
    try {
      if (channel === 'email') await senders.sendEmail(email, message.subject, message.html, message.text)
      else await senders.sendSms(phone, message.sms)
      results.push({ channel, ok: true })
    } catch (err) {
      results.push({ channel, ok: false, error: err?.message || String(err) })
    }
  }
  const anySent = await recordEventOutcome(db, reserved.eventKey, results)
  return { sent: anySent, results }
}

/**
 * Scan canonical position history for newly eligible Entry/Exit alerts.
 *
 * Called right after persistPositionSnapshot + supersedeMissingTrades in the
 * position-history cycle, so reconciliation has already withdrawn the phantom
 * frontier-drift entries described in positionHistory.js before anything here
 * can alert on one.
 */
export async function runPositionAlertCheck(db, {
  users, mailerReady, smsReady, senders, now = new Date(), maxPerCycle = 50,
} = {}) {
  const summary = { entry: 0, exit: 0, skipped_cap: 0, skipped_no_entry: 0, failed: 0 }
  if (!db || !users?.length) return summary

  const dayKey = marketDayKey(now)
  const coll = db.collection(POSITION_HISTORY_COLLECTION)

  for (const user of users) {
    const prefs = effectiveAlertPreferences(user)
    if (!prefs.entryEnabled && !prefs.exitEnabled) continue

    const email = prefs.alertEmail || user.email || null
    const channels = activeChannels(prefs, { mailerReady, smsReady, phone: user.phone, email })
    if (!channels.length) continue

    // NO HISTORICAL BLAST. A user who has never saved preferences has no
    // watermark, and nothing is eligible — enabling alerts starts the clock, it
    // does not backfill. Rows recorded before that instant stay ineligible
    // forever, which is also what makes a restart safe: the watermark is stored,
    // not derived from process start time.
    const watermark = prefs.updatedAt ? new Date(prefs.updatedAt) : null
    if (!watermark) continue

    const scope = scopeTickersFor(prefs, 'position')

    // ── Entry ────────────────────────────────────────────────────────────
    if (prefs.entryEnabled) {
      const rows = await coll.find({
        superseded: { $ne: true },
        created_at: { $gte: watermark },
      }).sort({ created_at: 1 }).limit(maxPerCycle).toArray().catch(() => [])

      for (const row of rows) {
        if (scope && !scope.has(String(row.ticker || '').toUpperCase())) continue
        if (!passesAiScoreFilter(prefs, row.ai_rank_score)) continue

        if (prefs.maxPerDay != null) {
          const used = await countCappedEventsToday(db, user._id, dayKey)
          if (used >= prefs.maxPerDay) { summary.skipped_cap += 1; break }
        }
        const result = await deliverEvent(db, {
          userId: user._id, eventType: 'entry', subjectId: row._id, ticker: row.ticker,
          channels, dayKey, countsTowardCap: true,
          message: entryMessage(row), email, phone: user.phone, senders,
        })
        if (result.sent) summary.entry += 1
        else if (result.results) summary.failed += 1
      }
    }

    // ── Exit ─────────────────────────────────────────────────────────────
    if (prefs.exitEnabled) {
      const rows = await coll.find({
        superseded: { $ne: true },
        finalized: true,
        updated_at: { $gte: watermark },
      }).sort({ updated_at: 1 }).limit(maxPerCycle).toArray().catch(() => [])

      for (const row of rows) {
        // Only a real fill is an exit. A session_end row is the sim marking an
        // still-open position to its last bar, not a close.
        if (!isFillExitReason(row.exit_reason)) continue
        if (scope && !scope.has(String(row.ticker || '').toUpperCase())) continue

        // Telling someone a position closed when they were never told it opened
        // is noise at best and alarming at worst.
        if (!(await entryWasDelivered(db, user._id, row._id))) { summary.skipped_no_entry += 1; continue }

        // NO CAP CHECK, ON PURPOSE. If FlashFeed told the user about the entry,
        // it owes them the strategy's corresponding exit — a cap reached later
        // in the day must not leave them holding a position they were told to
        // watch. countsTowardCap is false for the same reason.
        const result = await deliverEvent(db, {
          userId: user._id, eventType: 'exit', subjectId: row._id, ticker: row.ticker,
          channels, dayKey, countsTowardCap: false,
          message: exitMessage(row), email, phone: user.phone, senders,
        })
        if (result.sent) summary.exit += 1
        else if (result.results) summary.failed += 1
      }
    }
  }
  return summary
}

/**
 * News alerts, on the same preference/dedupe/cap machinery as Entry/Exit.
 *
 * Article-level deduplication is preserved (subjectId is the article id), and
 * the per-ticker cooldown applies ONLY here — it can never delay an Entry or
 * Exit, which are scanned by a different function on a different schedule.
 */
export async function runNewsAlertCheck(db, {
  users, mailerReady, smsReady, senders, now = new Date(), windowMinutes = 10, maxPerCycle = 25,
} = {}) {
  const summary = { sent: 0, skipped_cap: 0, skipped_cooldown: 0, failed: 0 }
  if (!db || !users?.length) return summary

  const dayKey = marketDayKey(now)
  const subscribers = users
    .map(user => ({ user, prefs: effectiveAlertPreferences(user) }))
    .filter(({ prefs }) => prefs.newsEnabled && (prefs.newsTickers || []).length)
  if (!subscribers.length) return summary

  const watched = new Set()
  for (const { prefs } of subscribers) for (const t of prefs.newsTickers) watched.add(t)
  if (!watched.size) return summary

  const sinceSec = Math.floor(now.getTime() / 1000) - windowMinutes * 60
  const tickers = Array.from(watched)
  const articles = await db.collection('articles').find({
    $and: [
      { $or: [{ ticker: { $in: tickers } }, { tickers: { $in: tickers } }] },
      { $or: [
        { publish_date: { $type: 'number', $gte: sinceSec } },
        { publish_date: { $type: 'date', $gte: new Date(sinceSec * 1000) } },
        { fetched_date: { $type: 'number', $gte: sinceSec } },
        { fetched_date: { $type: 'date', $gte: new Date(sinceSec * 1000) } },
      ] },
    ],
  }, { projection: { ticker: 1, tickers: 1, title: 1, sentiment: 1, source: 1 } }).limit(200).toArray().catch(() => [])

  let sent = 0
  for (const article of articles) {
    if (sent >= maxPerCycle) break
    const articleTickers = new Set([article.ticker, ...(article.tickers || [])].filter(Boolean).map(t => String(t).toUpperCase()))

    for (const { user, prefs } of subscribers) {
      if (sent >= maxPerCycle) break
      const email = prefs.alertEmail || user.email || null
      const channels = activeChannels(prefs, { mailerReady, smsReady, phone: user.phone, email })
      if (!channels.length) continue
      if (!prefs.updatedAt) continue          // same no-backfill rule as Entry/Exit

      for (const ticker of articleTickers) {
        if (!prefs.newsTickers.includes(ticker)) continue

        // Per-ticker cooldown: news repeats on the same name are the noisy case
        // the user is actually trying to damp.
        const cooldownMs = Number(prefs.newsCooldownMinutes || 0) * 60_000
        if (cooldownMs > 0) {
          const recent = await db.collection(ALERT_EVENTS_COLLECTION).findOne({
            user: String(user._id), eventType: 'news', ticker,
            createdAt: { $gte: new Date(now.getTime() - cooldownMs) },
          })
          if (recent) { summary.skipped_cooldown += 1; continue }
        }

        if (prefs.maxPerDay != null) {
          const used = await countCappedEventsToday(db, user._id, dayKey)
          if (used >= prefs.maxPerDay) { summary.skipped_cap += 1; continue }
        }

        const result = await deliverEvent(db, {
          userId: user._id, eventType: 'news', subjectId: String(article._id), ticker,
          channels, dayKey, countsTowardCap: true,
          message: newsMessage(ticker, article), email, phone: user.phone, senders,
        })
        if (result.sent) { summary.sent += 1; sent += 1 }
        else if (result.results) summary.failed += 1
      }
    }
  }
  return summary
}
