#!/usr/bin/env node
/**
 * Backfill `entry_epoch_utc` on screener_position_history.
 *
 *   node Infrastructure/server/scripts/backfill_entry_epoch_utc.js --dry-run
 *   node Infrastructure/server/scripts/backfill_entry_epoch_utc.js --apply
 *
 * WHAT THIS IS NOT. It is not an _id migration and it rewrites no existing
 * value. `entry_epoch` stays exactly as stored — it is the chart-service's
 * chart-axis coordinate (ET wall-clock encoded as a UTC second), it is part of
 * every document's _id, and the charts depend on that encoding. Re-keying the
 * collection would orphan every stored row and re-insert today's open positions
 * as duplicates, in exchange for nothing: no production consumer reads
 * entry_epoch as an instant.
 *
 * What was actually missing is a field that means what a reader assumes
 * `entry_epoch` means. This adds it, computed from `date` + `entry_time` —
 * both already stored, both correct ET, and together an exact pin on the
 * moment. Purely additive: every existing field, including _id, is untouched.
 *
 * SAFETY. Dry-run is the default; --apply is required to write. Each update
 * touches exactly one new field via $set, is guarded on the document still
 * lacking a correct value, and is verified by re-reading the collection
 * afterwards. Rows whose date/entry_time cannot produce a timestamp are
 * reported and skipped rather than given a plausible wrong one.
 */
import mongoose from 'mongoose'
import {
  POSITION_HISTORY_COLLECTION,
  utcEpochFromMarketTime,
} from '../lib/positionHistory.js'

const APPLY = process.argv.includes('--apply')
const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://localhost:27017/feedflash'

function fmt(epoch, tz) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false, month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }).format(new Date(epoch * 1000))
}

async function main() {
  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} — backfill entry_epoch_utc`)
  console.log(`  mongo: ${MONGODB_URI.replace(/\/\/[^@]*@/, '//<redacted>@')}`)

  await mongoose.connect(MONGODB_URI)
  const coll = mongoose.connection.db.collection(POSITION_HISTORY_COLLECTION)

  const total = await coll.countDocuments({})
  const docs = await coll.find({}, {
    projection: { _id: 1, ticker: 1, date: 1, entry_time: 1, entry_epoch: 1, entry_epoch_utc: 1 },
  }).sort({ date: 1, entry_epoch: 1 }).toArray()
  console.log(`  ${total} documents in ${POSITION_HISTORY_COLLECTION}\n`)

  const planned = []
  const unconvertible = []
  let alreadyCorrect = 0

  for (const doc of docs) {
    const want = utcEpochFromMarketTime(doc.date, doc.entry_time)
    if (want == null) { unconvertible.push(doc); continue }
    if (doc.entry_epoch_utc === want) { alreadyCorrect += 1; continue }
    planned.push({ doc, want })
  }

  // Show the transformation on a sample, in both readings, so the direction of
  // the correction is visible rather than asserted.
  console.log('  sample (stored chart-axis value vs the instant being added):')
  for (const { doc, want } of planned.slice(0, 5)) {
    console.log(`    ${String(doc.ticker).padEnd(6)} ${doc.date} ${doc.entry_time} ET`)
    console.log(`      entry_epoch     ${doc.entry_epoch}  reads ${fmt(doc.entry_epoch, 'UTC')} UTC`
      + ` / ${fmt(doc.entry_epoch, 'America/New_York')} ET   (unchanged)`)
    console.log(`      entry_epoch_utc ${want}  reads ${fmt(want, 'UTC')} UTC`
      + ` / ${fmt(want, 'America/New_York')} ET   (added)`)
    console.log(`      delta ${(doc.entry_epoch - want) / 3600}h`)
  }

  console.log(`\n  to write:          ${planned.length}`)
  console.log(`  already correct:   ${alreadyCorrect}`)
  console.log(`  unconvertible:     ${unconvertible.length}`)
  for (const doc of unconvertible.slice(0, 10)) {
    console.log(`    ${doc._id} — date=${doc.date} entry_time=${doc.entry_time} (skipped, left without the field)`)
  }

  if (!APPLY) {
    console.log('\nDry run — nothing written. Re-run with --apply to write.')
    await mongoose.disconnect()
    return
  }

  let written = 0
  for (const { doc, want } of planned) {
    const res = await coll.updateOne(
      { _id: doc._id, entry_epoch_utc: { $ne: want } },
      { $set: { entry_epoch_utc: want } },
    )
    written += res.modifiedCount
  }
  console.log(`\n  wrote ${written} of ${planned.length}`)

  // Verify by re-reading, not by trusting the write result.
  const after = await coll.find({}, {
    projection: { _id: 1, date: 1, entry_time: 1, entry_epoch: 1, entry_epoch_utc: 1 },
  }).toArray()
  let verified = 0
  let wrong = 0
  let epochChanged = 0
  const before = new Map(docs.map(d => [String(d._id), d.entry_epoch]))
  for (const doc of after) {
    const want = utcEpochFromMarketTime(doc.date, doc.entry_time)
    if (want == null) continue
    if (doc.entry_epoch_utc === want) verified += 1
    else { wrong += 1; console.error(`    ✗ ${doc._id}: got ${doc.entry_epoch_utc} want ${want}`) }
    // The whole point of this approach: the keyed value must not have moved.
    if (before.get(String(doc._id)) !== doc.entry_epoch) {
      epochChanged += 1
      console.error(`    ✗ ${doc._id}: entry_epoch CHANGED — this script must never do that`)
    }
  }
  console.log(`  verified ${verified} rows carry the correct instant, ${wrong} wrong`)
  console.log(`  entry_epoch unchanged on all rows: ${epochChanged === 0 ? 'yes' : `NO (${epochChanged} moved)`}`)
  console.log(`  document count ${total} -> ${after.length} (must be equal)`)

  await mongoose.disconnect()
  if (wrong || epochChanged || after.length !== total) process.exit(1)
}

main().catch(err => { console.error(err); process.exit(1) })
