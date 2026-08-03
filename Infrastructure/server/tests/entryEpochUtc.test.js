import test from 'node:test'
import assert from 'node:assert/strict'

import {
  entryEpochUtcFor,
  mergeTradeSnapshot,
  normalizeTrade,
  tradeKey,
  utcEpochFromMarketTime,
} from '../lib/positionHistory.js'

// entry_epoch is the chart-service's chart-axis coordinate: ET wall-clock
// encoded as a UTC second, so lightweight-charts markers land on the same axis
// as the candles. entry_epoch_utc is the real instant. These tests pin the
// difference, and — more importantly — pin that adding the second one did not
// move the first, because the first is inside every document's _id.

const ET = tz => new Intl.DateTimeFormat('en-US', {
  timeZone: tz, hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
})

test('the true instant is four hours after the chart-axis value in EDT', () => {
  // CRWV 2026-07-31 15:35 ET, verbatim from recorded history.
  const chartAxis = 1785512100
  const trueUtc = utcEpochFromMarketTime('2026-07-31', '15:35')
  assert.equal(trueUtc, 1785526500)
  assert.equal(chartAxis - trueUtc, -4 * 3600)
  // The defining property of each: the chart-axis value reads as the ET clock
  // when interpreted as UTC; the true value reads as the ET clock in ET.
  assert.equal(ET('UTC').format(new Date(chartAxis * 1000)), ET('America/New_York').format(new Date(trueUtc * 1000)))
})

test('conversion is DST-aware, not a fixed -4h', () => {
  // Standard time: ET is UTC-5, so the same wall clock is an hour further out.
  const winter = utcEpochFromMarketTime('2026-01-15', '15:35')
  const summer = utcEpochFromMarketTime('2026-07-15', '15:35')
  const chartAxisWinter = Date.UTC(2026, 0, 15, 15, 35) / 1000
  const chartAxisSummer = Date.UTC(2026, 6, 15, 15, 35) / 1000
  assert.equal(winter - chartAxisWinter, 5 * 3600, 'EST is UTC-5')
  assert.equal(summer - chartAxisSummer, 4 * 3600, 'EDT is UTC-4')
  // Both still render as 15:35 in ET — that is what "correct" means here.
  for (const e of [winter, summer]) {
    assert.match(ET('America/New_York').format(new Date(e * 1000)), /15:35$/)
  }
})

test('a session on the DST boundary converts without the one-hour slip', () => {
  // 2026 US DST begins Sunday 2026-03-08. A 09:30 entry on the Monday after is
  // already EDT; a one-pass conversion that samples the offset at the pre-shift
  // guess would land an hour off.
  const after = utcEpochFromMarketTime('2026-03-09', '09:30')
  assert.match(ET('America/New_York').format(new Date(after * 1000)), /09:30$/)
  const before = utcEpochFromMarketTime('2026-03-06', '09:30')
  assert.match(ET('America/New_York').format(new Date(before * 1000)), /09:30$/)
  assert.equal(after - before, 3 * 86400 - 3600, 'three days minus the hour lost to the shift')
})

test('unconvertible input yields null, never a plausible wrong instant', () => {
  for (const [d, t] of [
    [null, '10:00'], ['2026-07-31', null], ['not-a-date', '10:00'],
    ['2026-07-31', '99:99'], ['2026-07-31', '10:60'], ['2026-07-31', ''], ['', ''],
  ]) {
    assert.equal(utcEpochFromMarketTime(d, t), null, `${d} ${t}`)
  }
})

function trade(over = {}) {
  return {
    entry_epoch: 1785512100, entry_price: 72, entry_time: '15:35',
    exit_price: 71.85, exit_time: '16:00', exit_reason: 'rth_close', peak_price: 72.25, ...over,
  }
}
function context(over = {}) {
  return { ticker: 'CRWV', date: '2026-07-31', threshold: 0.1, stopPct: 5, currentPrice: 71.83, ...over }
}

test('normalizeTrade stores both, and the _id still keys off the chart-axis value', () => {
  const row = normalizeTrade(trade(), context())
  assert.equal(row.entry_epoch, 1785512100, 'chart-axis value must not move')
  assert.equal(row.entry_epoch_utc, 1785526500)
  // The key is the thing that must not change: a different _id orphans every
  // stored row and re-inserts open positions as duplicates.
  assert.equal(row._id, 'CRWV|2026-07-31|1785512100|0.1000|5.00')
  assert.equal(row._id, tradeKey({ ticker: 'CRWV', date: '2026-07-31', entry_epoch: 1785512100, threshold: 0.1, stopPct: 5 }))
  assert.ok(!row._id.includes(String(row.entry_epoch_utc)), 'the true instant must stay out of the key')
})

test('a trade with no entry_time still stores and keys, with a null instant', () => {
  const row = normalizeTrade(trade({ entry_time: null }), context())
  assert.equal(row.entry_epoch_utc, null)
  assert.equal(row._id, 'CRWV|2026-07-31|1785512100|0.1000|5.00', 'key unaffected by the new field')
})

test('merge backfills the instant on a row written before the field existed', () => {
  const existing = {
    ...normalizeTrade(trade({ exit_reason: 'session_end', exit_price: 71.9 }), context()),
    finalized: false,
    snapshots: 1,
  }
  delete existing.entry_epoch_utc                                  // pre-field vintage
  const incoming = normalizeTrade(trade({ exit_reason: 'session_end', exit_price: 71.95 }), context())
  const { doc, changed } = mergeTradeSnapshot(existing, incoming, { today: '2026-07-31' })
  assert.equal(changed, true)
  assert.equal(doc.entry_epoch_utc, 1785526500, 'backfilled on update')
  assert.equal(doc.entry_epoch, 1785512100, 'chart-axis value survives the merge')
  assert.equal(doc._id, existing._id, '_id must survive a merge untouched')
})

test('the instant follows the surviving entry_time, not the incoming one', () => {
  // Entry is immutable: if a later sim reports a different minute for the same
  // keyed trade, the stored entry wins — and the instant has to agree with it
  // rather than describing a minute the row does not claim.
  const existing = {
    ...normalizeTrade(trade({ exit_reason: 'session_end' }), context()),
    finalized: false, snapshots: 1,
  }
  const incoming = normalizeTrade(trade({ entry_time: '15:40', exit_reason: 'session_end' }), context())
  const { doc } = mergeTradeSnapshot(existing, incoming, { today: '2026-07-31' })
  assert.equal(doc.entry_time, '15:35')
  assert.equal(doc.entry_epoch_utc, utcEpochFromMarketTime('2026-07-31', '15:35'))
})

test('entryEpochUtcFor derives the instant for rows that lack the stored field', () => {
  assert.equal(entryEpochUtcFor({ date: '2026-07-31', entry_time: '15:35' }), 1785526500)
  assert.equal(entryEpochUtcFor({ date: '2026-07-31' }), null)
  assert.equal(entryEpochUtcFor({}), null)
})

test('every recorded session converts to an instant inside its own trading day', () => {
  // The regression this protects against is an off-by-one-day or off-by-hours
  // conversion that still looks like a timestamp. Checked by round-tripping.
  for (const [date, time] of [
    ['2026-07-28', '10:31'], ['2026-07-29', '19:48'], ['2026-07-30', '10:11'], ['2026-07-31', '15:35'],
  ]) {
    const utc = utcEpochFromMarketTime(date, time)
    const back = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date(utc * 1000))
    const p = Object.fromEntries(back.filter(x => x.type !== 'literal').map(x => [x.type, x.value]))
    assert.equal(`${p.year}-${p.month}-${p.day}`, date)
    assert.equal(`${p.hour}:${p.minute}`, time)
  }
})
