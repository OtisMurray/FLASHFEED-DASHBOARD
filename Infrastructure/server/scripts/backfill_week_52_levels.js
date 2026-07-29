#!/usr/bin/env node
//
// One-off normalization for week_52_high / week_52_low in the screeners
// collection.
//
// WHY THIS IS NEEDED AT ALL — and why it is smaller than it looks.
//
// Two ingests write these two field names into db.screeners keyed by ticker:
//
//   2_Screener/pipeline/fetch_finviz_elite_to_mongo.py — Finviz's v=152 export
//     gives 52-week high/low as PERCENT DISTANCE from the extreme (the same
//     convention as its SMA20/50/200 columns), e.g. -24.08 = 24.08% below the
//     52-week high, 124.55 = 124.55% above the 52-week low.
//   1_News/pipeline/fetch_quotes_to_mongo.py — writes ABSOLUTE DOLLARS.
//
// The Elite ingest now converts to price levels at write time, so both agree.
// Because that ingest does `{$set: row}` over every ticker it returns on every
// fetch cycle, ACTIVE rows heal themselves within one cycle and need nothing
// from this script.
//
// The exception is rows the Elite universe has dropped. _write_rows only $sets
// {finviz_status, finviz_seen_at, quote_source} for those, never touching their
// 52-week fields again, so a dropped row keeps whatever convention it last had
// forever. Those are what this script exists for.
//
// IDEMPOTENT AND RE-RUNNABLE. It only rewrites a row when the stored value is
// unambiguously the percent form, and it stamps week_52_units so a second run
// skips what it already converted. Running it twice is a no-op; running it
// against an already-correct row does nothing.
//
// Usage:
//   node scripts/backfill_week_52_levels.js --dry-run          # report only
//   node scripts/backfill_week_52_levels.js                    # apply
//   node scripts/backfill_week_52_levels.js --limit 100        # cap the work
//   node scripts/backfill_week_52_levels.js --all              # not just dropped rows

import mongoose from 'mongoose'

function argValue(name, fallback = '') {
  const prefix = `--${name}=`
  const inline = process.argv.find(arg => arg.startsWith(prefix))
  if (inline) return inline.slice(prefix.length)
  const index = process.argv.indexOf(`--${name}`)
  if (index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--')) return process.argv[index + 1]
  return fallback
}
const hasFlag = name => process.argv.includes(`--${name}`)

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI || argValue('mongo', 'mongodb://localhost:27017/feedflash')
const LIMIT = Number(argValue('limit', '0')) || Infinity
const DRY_RUN = hasFlag('dry-run')
const ALL_ROWS = hasFlag('all')
const COLLECTION = 'screeners'

// Same derivation and the same guards as _week_52_levels() in
// fetch_finviz_elite_to_mongo.py. Kept deliberately in lockstep: if one changes
// the other has to, or a backfilled row stops matching a freshly ingested one.
// Number(null) and Number('') are both 0, which would turn an ABSENT percentage
// into a real 0 and, worse, make `high <= 0` fire on a row that simply has no
// 52-week data. Absent has to stay absent.
function finite(value) {
  if (value == null || value === '' || typeof value === 'boolean') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function week52Levels(price, pctFromHigh, pctAboveLow) {
  const p = finite(price)
  if (p == null || p <= 0) return { high: null, low: null }
  const level = pct => {
    const v = finite(pct)
    if (v == null) return null
    const factor = 1 + v / 100
    if (factor <= 0.01) return null
    const out = p / factor
    return Number.isFinite(out) && out > 0 ? out : null
  }
  const high = level(pctFromHigh)
  const low = level(pctAboveLow)
  // The pair is all-or-nothing. If either side cannot be derived — absent input,
  // degenerate divisor, or implausible against the price — the row is not being
  // read correctly and the surviving number is only accidentally sane. The one
  // consumer needs both anyway, so a lone value buys nothing and risks storing a
  // wrong figure in a field whose name promises a price.
  if (high == null || low == null) return { high: null, low: null }
  const tolerance = p * 0.02
  if (high + tolerance < p) return { high: null, low: null }
  if (low - tolerance > p) return { high: null, low: null }
  if (!(high > low)) return { high: null, low: null }
  return { high, low }
}

// Is this row's stored pair the PERCENT form? Convert ONLY on an unambiguous
// signal. A wrong guess corrupts a correct price row, which is far worse than
// leaving a stale one alone — and unlike the ingest, this script cannot see
// which pipeline wrote the row.
//
//   percent : week_52_high <= 0. A price level can never be zero or negative,
//             so this is the one signal that cannot be anything else. It is
//             Finviz's normal output for any stock below its 52-week high.
//   price   : low < price < high — a real range bracketing the last trade.
//   else    : ambiguous, left alone.
//
// "low >= 100" was tried as a second percent signal and is WRONG: it fires on
// any stock whose 52-week low is above $100. It misclassified WAB (price $290,
// range $184.26-$284.91, sitting at a new high so price > high) as percent form
// and would have overwritten correct dollars with derived nonsense.
//
// The conservative cost is real but small: a percent-form row whose stock sits
// AT its 52-week high has high >= 0 and lands in `ambiguous`. Those rows keep
// their stale values until the live ingest rewrites them — and for the dropped
// rows this script targets, that never happens. They stay null-scored, which is
// exactly where they already were.
function classify(row) {
  const price = finite(row.price)
  const high = finite(row.week_52_high)
  const low = finite(row.week_52_low)
  if (high == null && low == null) return 'absent'
  if (row.week_52_units === 'price') return 'already_converted'
  if (low != null && high != null && price != null && low < price && price < high) return 'price'
  if (high != null && high <= 0) return 'percent'
  return 'ambiguous'
}

async function main() {
  console.log(`week_52 unit normalization — ${DRY_RUN ? 'DRY RUN' : 'APPLY'}`)
  await mongoose.connect(MONGO_URI)
  const db = mongoose.connection.db
  const coll = db.collection(COLLECTION)

  // Default scope is exactly the rows the live ingest can never heal.
  const filter = ALL_ROWS ? {} : { finviz_status: 'dropped' }
  const scopeLabel = ALL_ROWS ? 'ALL rows' : 'finviz_status:dropped rows only'
  const total = await coll.countDocuments(filter)
  console.log(`Scope: ${scopeLabel} in ${db.databaseName}.${COLLECTION} — ${total} candidate rows`)

  const cursor = coll.find(filter, {
    projection: { _id: 1, ticker: 1, price: 1, week_52_high: 1, week_52_low: 1, week_52_units: 1 },
  })

  const tally = { absent: 0, price: 0, percent: 0, ambiguous: 0, already_converted: 0 }
  const converted = { written: 0, nulled: 0 }
  const samples = []
  let examined = 0

  for await (const row of cursor) {
    if (examined >= LIMIT) break
    examined += 1
    const kind = classify(row)
    tally[kind] += 1
    if (kind !== 'percent') continue

    const { high, low } = week52Levels(row.price, row.week_52_high, row.week_52_low)
    const update = {
      week_52_high: high == null ? null : Number(high.toFixed(4)),
      week_52_low: low == null ? null : Number(low.toFixed(4)),
      // Raw percentages preserved, matching what the ingest now writes.
      week_52_high_pct: finite(row.week_52_high),
      week_52_low_pct: finite(row.week_52_low),
      // The idempotency marker. A second run classifies this row as
      // already_converted and skips it.
      week_52_units: 'price',
      week_52_normalized_at: new Date(),
    }
    if (high == null && low == null) converted.nulled += 1
    else converted.written += 1

    if (samples.length < 5) {
      samples.push(`${row.ticker}: price=${row.price} pct(${row.week_52_high}, ${row.week_52_low}) `
        + `-> ${high == null ? 'null' : '$' + high.toFixed(2)} / ${low == null ? 'null' : '$' + low.toFixed(2)}`)
    }
    if (!DRY_RUN) await coll.updateOne({ _id: row._id }, { $set: update })
  }

  console.log(`\nExamined ${examined} rows:`)
  console.log(`  percent form (converted)   : ${tally.percent}`)
  console.log(`    -> real levels written   : ${converted.written}`)
  console.log(`    -> nulled (implausible)  : ${converted.nulled}`)
  console.log(`  already price form (left)  : ${tally.price}`)
  console.log(`  already converted (skipped): ${tally.already_converted}`)
  console.log(`  ambiguous (left untouched) : ${tally.ambiguous}`)
  console.log(`  no 52-week data at all     : ${tally.absent}`)
  if (samples.length) {
    console.log('\nSample conversions:')
    for (const s of samples) console.log(`  ${s}`)
  }
  if (DRY_RUN) console.log('\nDRY RUN — nothing was written. Re-run without --dry-run to apply.')

  await mongoose.disconnect()
}

main().catch(err => {
  console.error('backfill failed:', err.message)
  process.exitCode = 1
})
