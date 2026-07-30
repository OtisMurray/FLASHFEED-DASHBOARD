import test from 'node:test'
import assert from 'node:assert/strict'

import { liveGroupFor, recordedPositionRow, tradeIdentity } from '../routes/positionScreener.js'
import { classifyRow } from '../lib/positionHistory.js'

// REGRESSION: the same trade rendered twice, under both "Closed today" and
// "Closed earlier".
//
// The live simulator covers the most recent session that HAS BARS, which stops
// being today the moment the clock rolls past midnight ET. Between 00:00 and the
// next premarket open, todayKeyET() has already advanced while the chart-service
// still returns yesterday. The route used to hardcode those rows as
// 'closed_today', while recorded history correctly served the same session as
// 'closed_earlier' — so on production at 01:10 ET, 5 trades appeared in both
// groups and the header claimed 21 rows for 16 distinct trades.
//
// Note the bug was on the LIVE side. The history query was already strictly
// `date < today` and never needed changing.

const TODAY = '2026-07-29'
const YESTERDAY = '2026-07-28'

test('a live risk exit in TODAY session is closed_today', () => {
  assert.equal(liveGroupFor(TODAY, true, TODAY), 'closed_today')
})

test('a live position still running in TODAY session is open', () => {
  assert.equal(liveGroupFor(TODAY, false, TODAY), 'open')
})

test('a live row from a PAST session is closed_earlier however it ended', () => {
  // This is the whole fix: after midnight the simulator still returns yesterday.
  assert.equal(liveGroupFor(YESTERDAY, true, TODAY), 'closed_earlier')
  // A session_end row on a past date is a real flatten at the close, not an
  // open position — matching isFinalTrade/classifyRow.
  assert.equal(liveGroupFor(YESTERDAY, false, TODAY), 'closed_earlier')
})

test('live grouping agrees with recorded grouping for the same trade', () => {
  // The two sources must never disagree about which group a trade belongs to,
  // or it renders twice again by a different route.
  for (const [date, riskExit] of [[TODAY, true], [YESTERDAY, true], [YESTERDAY, false]]) {
    const recorded = classifyRow(
      { date, exit_reason: riskExit ? 'price_trailing_stop' : 'session_end' },
      { today: TODAY },
    )
    assert.equal(liveGroupFor(date, riskExit, TODAY), recorded, `${date} riskExit=${riskExit}`)
  }
})

test('an unparseable or future session is treated as today, never as settled', () => {
  // Conservative direction: calling a live position "closed earlier" would
  // assert a settlement that never happened.
  assert.equal(liveGroupFor('2026-07-30', false, TODAY), 'open')
  assert.equal(liveGroupFor('nonsense', true, TODAY), 'closed_today')
  assert.equal(liveGroupFor(null, false, TODAY), 'open')
  assert.equal(liveGroupFor(YESTERDAY, true, null), 'closed_today')
})

test('trade identity survives the round trip through history', () => {
  // A live row and its recorded counterpart describe one trade. Identity has to
  // match across provenance or the dedupe cannot fire.
  const live = { ticker: 'biya', date: YESTERDAY, entry_epoch: 1785300000, provenance: 'live' }
  const recorded = { ticker: 'BIYA', date: YESTERDAY, entry_epoch: 1785300000, provenance: 'recorded' }
  assert.equal(tradeIdentity(live), tradeIdentity(recorded))
})

test('two entries on the same ticker and session stay distinct', () => {
  // BIYA legitimately entered three times on 2026-07-28. Collapsing them would
  // under-count real trades, which is the opposite failure.
  const a = { ticker: 'BIYA', date: YESTERDAY, entry_epoch: 1785300000 }
  const b = { ticker: 'BIYA', date: YESTERDAY, entry_epoch: 1785306000 }
  assert.notEqual(tradeIdentity(a), tradeIdentity(b))
})

test('the production overlap scenario collapses to distinct trades', () => {
  // Reproduces the shape observed live at 01:10 ET on 2026-07-29: the simulator
  // returned the 2026-07-28 session, and history already held those same trades.
  const entries = [1785300000, 1785306000, 1785312000]
  const live = entries.map(epoch => ({
    ticker: 'BIYA', date: YESTERDAY, entry_epoch: epoch, provenance: 'live',
    group: liveGroupFor(YESTERDAY, true, TODAY),
  }))
  const history = entries.map(epoch => ({
    ticker: 'BIYA', date: YESTERDAY, entry_epoch: epoch, provenance: 'recorded',
    group: classifyRow({ date: YESTERDAY, exit_reason: 'price_trailing_stop' }, { today: TODAY }),
  }))

  const recordedIds = new Set(history.map(tradeIdentity))
  const keptLive = live.filter(r => !recordedIds.has(tradeIdentity(r)))
  const all = [...keptLive, ...history]

  assert.equal(keptLive.length, 0, 'every live row is superseded by its recorded twin')
  assert.equal(all.length, 3, 'three distinct trades, not six rows')
  const ids = all.map(tradeIdentity)
  assert.equal(new Set(ids).size, ids.length, 'no duplicate identities survive')

  // And the two groups are mutually exclusive.
  const todayIds = all.filter(r => r.group === 'closed_today').map(tradeIdentity)
  const earlierIds = new Set(all.filter(r => r.group === 'closed_earlier').map(tradeIdentity))
  assert.equal(todayIds.filter(id => earlierIds.has(id)).length, 0)
})

test('a live row with no recorded counterpart survives', () => {
  // Scheduler-was-down case: the live sim is then the only description of the
  // trade that exists, so dropping it would lose the position entirely.
  const live = { ticker: 'INLF', date: YESTERDAY, entry_epoch: 1785399999, provenance: 'live' }
  const recordedIds = new Set([tradeIdentity({ ticker: 'BIYA', date: YESTERDAY, entry_epoch: 1 })])
  assert.equal(recordedIds.has(tradeIdentity(live)), false)
})

test('a finalized same-day recorded row can backstop a vanished live candidate', () => {
  // If a ticker exits and then falls out of the next AI candidate batch, the
  // recorded same-day exit must still render under Closed today.
  const doc = {
    ticker: 'GCTK',
    company: 'GlucoTrack Inc',
    date: TODAY,
    finalized: true,
    entry_epoch: 1785321840,
    entry_time: '10:44',
    entry_price: 0.37,
    exit_reason: 'price_trailing_stop',
    exit_time: '11:37',
    exit_price: 0.38,
    pnl_pct: 4.64,
    pnl_is_realized: true,
    threshold: 0.1,
    stop_pct: 5,
  }
  const recorded = recordedPositionRow(doc, { today: TODAY, companyByTicker: new Map() })
  const liveTwin = { ticker: 'gctk', date: TODAY, entry_epoch: 1785321840, provenance: 'live' }

  assert.equal(recorded.group, 'closed_today')
  assert.equal(recorded.pnl_is_realized, true)
  assert.equal(tradeIdentity(recorded), tradeIdentity(liveTwin))
})
