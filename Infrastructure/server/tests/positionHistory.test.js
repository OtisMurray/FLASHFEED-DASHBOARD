import test from 'node:test'
import assert from 'node:assert/strict'

import {
  classifyRow,
  ensurePositionHistoryIndexes,
  isFinalTrade,
  mergeTradeSnapshot,
  normalizeTrade,
  persistPositionSnapshot,
  prunePositionHistory,
  rowsFromPositionsBatch,
  supersedeMissingTrades,
  tradeKey,
  POSITION_HISTORY_COLLECTION,
} from '../lib/positionHistory.js'

const TODAY = '2026-07-28'
const YESTERDAY = '2026-07-27'

function baseContext(overrides = {}) {
  return {
    ticker: 'TEST',
    company: 'Test Corp',
    date: TODAY,
    currentPrice: 11,
    threshold: 0.1,
    stopPct: 5,
    corrExitThreshold: null,
    corrStatus: 'ok',
    observedAt: new Date('2026-07-28T15:00:00Z'),
    ...overrides,
  }
}

function holdingTrade(overrides = {}) {
  return {
    entry_price: 10,
    entry_time: '10:30',
    entry_epoch: 1_785_000_000,
    entry_corr: 0.42,
    exit_price: 11,
    exit_time: '16:00',
    exit_reason: 'session_end',
    exit_corr: 0.31,
    peak_price: 12,
    status: 'Holding',
    ...overrides,
  }
}

// ── keying ───────────────────────────────────────────────────────────────────

test('the parameter set is part of the trade identity', () => {
  const same = { ticker: 'TEST', date: TODAY, entry_epoch: 1_785_000_000, threshold: 0.1, stopPct: 5 }
  // 0.1 and 0.10 are the same parameter set and must not fork the history
  assert.equal(tradeKey(same), tradeKey({ ...same, threshold: 0.10 }))
  assert.equal(tradeKey(same), tradeKey({ ...same, stopPct: 5.0 }))
  // a different threshold produces a different trade set, so a different row
  assert.notEqual(tradeKey(same), tradeKey({ ...same, threshold: 0.3 }))
  assert.notEqual(tradeKey(same), tradeKey({ ...same, stopPct: 20 }))
})

test('unkeyable trades are rejected rather than stored half-formed', () => {
  const valid = { ticker: 'TEST', date: TODAY, entry_epoch: 1_785_000_000, threshold: 0.1, stopPct: 5 }
  assert.equal(tradeKey({ ...valid, ticker: '' }), null)
  assert.equal(tradeKey({ ...valid, ticker: 'not a ticker' }), null)
  assert.equal(tradeKey({ ...valid, date: '07/28/2026' }), null)
  assert.equal(tradeKey({ ...valid, entry_epoch: 0 }), null)
  assert.equal(normalizeTrade(holdingTrade(), baseContext({ date: 'nope' })), null)
  assert.equal(normalizeTrade(holdingTrade({ entry_price: 0 }), baseContext()), null)
  assert.equal(normalizeTrade(holdingTrade(), baseContext({ threshold: null })), null)
})

// ── normalization ────────────────────────────────────────────────────────────

test('every stored row stamps the parameters it was simulated under', () => {
  const row = normalizeTrade(holdingTrade(), baseContext({ corrExitThreshold: -0.2 }))
  assert.equal(row.threshold, 0.1)
  assert.equal(row.stop_pct, 5)
  assert.equal(row.corr_exit_threshold, -0.2)
})

test('AI candidate provenance survives normalization into recorded history', () => {
  const row = normalizeTrade(holdingTrade(), baseContext({
    candidateSource: 'ai_suggestion',
    aiRank: 3,
    aiRankScore: 71.4,
    aiDirection: 'bullish',
    aiProbabilityUp: 0.67,
    aiEntryReady: true,
    aiModel: 'validated-threshold-model',
  }))
  assert.equal(row.candidate_source, 'ai_suggestion')
  assert.equal(row.ai_rank, 3)
  assert.equal(row.ai_rank_score, 71.4)
  assert.equal(row.ai_direction, 'bullish')
  assert.equal(row.ai_probability_up, 0.67)
  assert.equal(row.ai_entry_ready, true)
  assert.equal(row.ai_model, 'validated-threshold-model')
})

test('an open position marks to the live price and is not realized', () => {
  const row = normalizeTrade(holdingTrade(), baseContext())
  assert.equal(row.pnl_is_realized, false)
  assert.equal(row.pnl_pct, 10)               // entry 10 -> mark 11
  assert.equal(row.stop_price, 11.4)          // peak 12 x (1 - 5%)
  assert.equal(row.exit_price, null)          // session_end is not a fill
  assert.equal(row.exit_time, null)
  assert.equal(row.session_end_price, 11)     // ...but the mark is kept to settle the session later
  assert.equal(row.exit_is_session_end, true)
})

test('a risk exit is realized and frozen at its fill, not at the live price', () => {
  const row = normalizeTrade(
    holdingTrade({ exit_reason: 'price_trailing_stop', exit_price: 11.4, status: 'Stopped Out' }),
    baseContext({ currentPrice: 9 }),         // price kept falling after the fill
  )
  assert.equal(row.pnl_is_realized, true)
  assert.equal(row.pnl_pct, 14)               // measured to 11.4, NOT to 9
  assert.equal(row.exit_price, 11.4)
  assert.equal(row.exit_is_session_end, false)
})

// ── open / closed classification ─────────────────────────────────────────────

test('session_end is open today and a closed position once the session is over', () => {
  const open = normalizeTrade(holdingTrade(), baseContext())
  assert.equal(classifyRow(open, { today: TODAY }), 'open')
  assert.equal(isFinalTrade(open, { today: TODAY }), false)

  const settled = normalizeTrade(holdingTrade(), baseContext({ date: YESTERDAY }))
  assert.equal(classifyRow(settled, { today: TODAY }), 'closed_earlier')
  assert.equal(isFinalTrade(settled, { today: TODAY }), true)
})

test('a risk exit is closed the moment it fills', () => {
  const stopped = normalizeTrade(holdingTrade({ exit_reason: 'price_trailing_stop', status: 'Stopped Out' }), baseContext())
  assert.equal(classifyRow(stopped, { today: TODAY }), 'closed_today')
  assert.equal(isFinalTrade(stopped, { today: TODAY }), true)
  const corrBreak = normalizeTrade(holdingTrade({ exit_reason: 'correlation_break', status: 'Stopped Out' }), baseContext({ date: YESTERDAY }))
  assert.equal(classifyRow(corrBreak, { today: TODAY }), 'closed_earlier')
})

// ── merge: open once, update while held, freeze on close ─────────────────────

test('a position opens once, updates while held, then closes and cannot reopen', () => {
  const first = normalizeTrade(holdingTrade(), baseContext())
  const opened = mergeTradeSnapshot(null, first, { today: TODAY })
  assert.equal(opened.reason, 'inserted')
  assert.equal(opened.doc.snapshots, 1)
  assert.equal(opened.doc.finalized, false)

  // still held, price moved up: peak and mark advance, entry does not
  const later = normalizeTrade(holdingTrade({ peak_price: 13, exit_price: 12.5 }), baseContext({ currentPrice: 12.5 }))
  const held = mergeTradeSnapshot(opened.doc, later, { today: TODAY })
  assert.equal(held.reason, 'updated')
  assert.equal(held.doc.snapshots, 2)
  assert.equal(held.doc.entry_price, 10)
  assert.equal(held.doc.peak_price, 13)
  assert.equal(held.doc.stop_price, 12.35)
  assert.equal(held.doc.pnl_pct, 25)
  assert.equal(held.doc.finalized, false)

  // the stop trips
  const stop = normalizeTrade(
    holdingTrade({ peak_price: 13, exit_reason: 'price_trailing_stop', exit_price: 12.35, exit_time: '14:05', status: 'Stopped Out' }),
    baseContext({ currentPrice: 12 }),
  )
  const closed = mergeTradeSnapshot(held.doc, stop, { today: TODAY })
  assert.equal(closed.reason, 'closed')
  assert.equal(closed.doc.finalized, true)
  assert.equal(closed.doc.exit_price, 12.35)
  assert.equal(closed.doc.pnl_pct, 23.5)

  // a later cycle re-simulating the same session must not resurrect it
  const resurrect = normalizeTrade(holdingTrade({ peak_price: 20 }), baseContext({ currentPrice: 19 }))
  const frozen = mergeTradeSnapshot(closed.doc, resurrect, { today: TODAY })
  assert.equal(frozen.changed, false)
  assert.equal(frozen.reason, 'already_final')
  assert.equal(frozen.doc.exit_price, 12.35)
  assert.equal(frozen.doc.pnl_pct, 23.5)
  assert.equal(frozen.doc.snapshots, 3)
})

test('a settled past session is frozen even without a risk exit', () => {
  const settled = { ...normalizeTrade(holdingTrade(), baseContext({ date: YESTERDAY })), finalized: true, snapshots: 4 }
  const reSim = normalizeTrade(holdingTrade({ peak_price: 99 }), baseContext({ date: YESTERDAY, currentPrice: 98 }))
  const merged = mergeTradeSnapshot(settled, reSim, { today: TODAY })
  assert.equal(merged.changed, false)
  assert.equal(merged.doc.peak_price, 12)
})

test('the tracked peak ratchets and a regression is flagged, not silently applied', () => {
  const opened = mergeTradeSnapshot(null, normalizeTrade(holdingTrade({ peak_price: 15 }), baseContext()), { today: TODAY })
  // a truncated bar fetch reports a lower high than we already recorded
  const truncated = normalizeTrade(holdingTrade({ peak_price: 11 }), baseContext())
  const merged = mergeTradeSnapshot(opened.doc, truncated, { today: TODAY })
  assert.equal(merged.doc.peak_price, 15)       // high-water mark kept — the stop does not loosen
  assert.equal(merged.doc.peak_regressed, true)
})

test('a changed entry fill is recorded as drift instead of rewriting history', () => {
  const opened = mergeTradeSnapshot(null, normalizeTrade(holdingTrade(), baseContext()), { today: TODAY })
  const drifted = normalizeTrade(holdingTrade({ entry_price: 10.25 }), baseContext())
  const merged = mergeTradeSnapshot(opened.doc, drifted, { today: TODAY })
  assert.equal(merged.doc.entry_price, 10)
  assert.equal(merged.doc.entry_price_drift, 10.25)
})

// ── batch flattening ─────────────────────────────────────────────────────────

test('flattening counts non-ok coverage instead of dropping it silently', () => {
  const { rows, coverage } = rowsFromPositionsBatch({
    AAA: { status: 'ok', date: TODAY, current_price: 11, trades: [holdingTrade()] },
    BBB: { status: 'warming', date: null, trades: [] },
    CCC: { status: 'no_bars', trades: [] },
    DDD: { status: 'error', trades: [] },
    EEE: { status: 'ok', date: TODAY, current_price: 5, trades: [holdingTrade({ entry_epoch: 1_785_000_600 }), holdingTrade({ entry_epoch: 1_785_001_200 })] },
  }, { threshold: 0.1, stopPct: 5, companies: new Map([['AAA', 'Alpha']]) })

  assert.equal(rows.length, 3)                 // 1 from AAA + 2 from EEE
  assert.equal(coverage.ok, 2)
  assert.equal(coverage.warming, 1)
  assert.equal(coverage.no_bars, 1)
  assert.equal(coverage.error, 1)
  assert.equal(rows[0].company, 'Alpha')
  assert.equal(new Set(rows.map(row => row._id)).size, 3)
})

// ── persistence (fake collection) ────────────────────────────────────────────

function fakeDb() {
  const docs = new Map()
  const indexes = []
  const coll = {
    createIndex: async spec => { indexes.push(spec); return 'ok' },
    find: query => ({
      toArray: async () => {
        const wanted = query?._id?.$in
        return [...docs.values()].filter(doc => !wanted || wanted.includes(doc._id))
      },
    }),
    updateOne: async (filter, update, options) => {
      const existing = docs.get(filter._id)
      // Real MongoDB refuses an update that touches the immutable _id path even
      // when the value is unchanged, while an upsert-insert builds the document
      // from the query and is fine. Reproducing that asymmetry here is the point:
      // without it, a broken $set passes in test and silently fails in prod.
      if (existing && Object.prototype.hasOwnProperty.call(update.$set || {}, '_id')) {
        throw new Error("Performing an update on the path '_id' would modify the immutable field '_id'")
      }
      // ...and it rejects a field claimed by both operators. This bites on the
      // SECOND cycle only: created_at is written by $setOnInsert, then read back
      // as part of the stored document and merged into the next $set.
      for (const key of Object.keys(update.$setOnInsert || {})) {
        if (Object.prototype.hasOwnProperty.call(update.$set || {}, key)) {
          throw new Error(`Updating the path '${key}' would create a conflict at '${key}'`)
        }
      }
      if (!existing && !options?.upsert) return { matchedCount: 0 }
      // On an upsert-insert Mongo seeds the new document from the QUERY, which
      // is the only place _id comes from now that $set no longer carries it.
      docs.set(filter._id, {
        ...(existing || { _id: filter._id }),
        ...(existing ? {} : update.$setOnInsert),
        ...update.$set,
      })
      return { matchedCount: existing ? 1 : 0, upsertedCount: existing ? 0 : 1 }
    },
    distinct: async field => [...new Set([...docs.values()].map(doc => doc[field]))],
    deleteMany: async filter => {
      const lt = filter?.date?.$lt
      let deleted = 0
      for (const [id, doc] of docs) {
        if (lt && String(doc.date) < String(lt)) { docs.delete(id); deleted += 1 }
      }
      return { deletedCount: deleted }
    },
    countDocuments: async () => docs.size,
  }
  return { db: { collection: () => coll }, docs, indexes }
}

test('the documented indexes are created', async () => {
  const { db, indexes } = fakeDb()
  await ensurePositionHistoryIndexes(db)
  assert.deepEqual(indexes, [{ date: -1, status: 1 }, { ticker: 1, date: -1 }, { updated_at: -1 }])
})

test('persisting is idempotent and never rewrites a finalized trade', async () => {
  const { db, docs } = fakeDb()
  const open = normalizeTrade(holdingTrade(), baseContext())

  const first = await persistPositionSnapshot(db, [open], { today: TODAY })
  assert.deepEqual([first.inserted, first.updated, first.skipped_final], [1, 0, 0])
  assert.equal(docs.size, 1)
  assert.equal([...docs.values()][0].status, 'open')

  const second = await persistPositionSnapshot(db, [open], { today: TODAY })
  assert.deepEqual([second.inserted, second.updated], [0, 1])
  assert.equal(second.failed, 0, second.last_error || 'update must not fail')
  assert.equal(docs.size, 1)                   // same key, still one row

  const stopped = normalizeTrade(
    holdingTrade({ exit_reason: 'price_trailing_stop', exit_price: 11.4, status: 'Stopped Out' }),
    baseContext(),
  )
  const third = await persistPositionSnapshot(db, [stopped], { today: TODAY })
  assert.equal(third.closed, 1)
  assert.equal([...docs.values()][0].status, 'closed_today')

  // re-running the open sim afterwards must be refused
  const fourth = await persistPositionSnapshot(db, [open], { today: TODAY })
  assert.deepEqual([fourth.inserted, fourth.updated, fourth.skipped_final], [0, 0, 1])
  assert.equal([...docs.values()][0].exit_price, 11.4)
})

test('retention keeps the newest N recorded dates, not N calendar days', async () => {
  const { db, docs } = fakeDb()
  const dates = ['2026-07-20', '2026-07-21', '2026-07-24', '2026-07-27', TODAY]
  for (const date of dates) {
    docs.set(`T|${date}`, { _id: `T|${date}`, ticker: 'T', date })
  }
  const noop = await prunePositionHistory(db, { retentionDays: 10 })
  assert.equal(noop.deleted, 0)                // fewer dates than the retention target

  const pruned = await prunePositionHistory(db, { retentionDays: 3 })
  assert.equal(pruned.deleted, 2)              // 07-20 and 07-21 fall away
  assert.equal(pruned.cutoff_date, '2026-07-24')
  assert.deepEqual([...docs.values()].map(doc => doc.date).sort(), ['2026-07-24', '2026-07-27', TODAY])
})

// ── frontier drift: withdraw trades a later sim no longer produces ───────────
// Entries are causal with respect to MESSAGES but not BARS: the price grid is
// forward-filled to the session end, so a rolling window near the data frontier
// mixes real bars with flat filler and the entry crossing walks forward as bars
// arrive. Observed live: 23 stored "open" rows for one ticker in one afternoon
// at exact 5-minute scheduler intervals, while the sim only ever claimed one.

function fakeSupersedeDb() {
  const docs = new Map()
  const coll = {
    updateMany: async (filter, update) => {
      let modified = 0
      for (const [, doc] of docs) {
        if (doc.ticker !== filter.ticker || doc.date !== filter.date) continue
        if (doc.threshold !== filter.threshold || doc.stop_pct !== filter.stop_pct) continue
        if (filter.entry_epoch.$nin.includes(doc.entry_epoch)) continue
        if (doc.superseded === true) continue
        Object.assign(doc, update.$set)
        modified += 1
      }
      return { modifiedCount: modified }
    },
  }
  return { db: { collection: () => coll }, docs }
}

test('a later simulation withdraws the phantom entries it no longer produces', async () => {
  const { db, docs } = fakeSupersedeDb()
  // three cycles each recorded an entry at the then-current frontier
  for (const epoch of [1785000000, 1785000300, 1785000600]) {
    docs.set(epoch, { _id: `S|${epoch}`, ticker: 'SOFI', date: TODAY, threshold: 0.1, stop_pct: 5, entry_epoch: epoch })
  }
  // the newest sim only produces the last one
  const n = await supersedeMissingTrades(db, {
    ticker: 'SOFI', date: TODAY, threshold: 0.1, stopPct: 5, keepEpochs: [1785000600], now: new Date(),
  })
  assert.equal(n, 2)
  assert.equal(docs.get(1785000000).superseded, true)
  assert.equal(docs.get(1785000300).superseded, true)
  assert.equal(docs.get(1785000600).superseded, undefined)   // the surviving trade is untouched
  // withdrawal is not deletion — the audit trail stays
  assert.equal(docs.size, 3)
  // and it is idempotent
  assert.equal(await supersedeMissingTrades(db, {
    ticker: 'SOFI', date: TODAY, threshold: 0.1, stopPct: 5, keepEpochs: [1785000600], now: new Date(),
  }), 0)
})

test('withdrawal is scoped to the exact session and parameter set simulated', async () => {
  const { db, docs } = fakeSupersedeDb()
  docs.set('other-date', { _id: 'a', ticker: 'SOFI', date: YESTERDAY, threshold: 0.1, stop_pct: 5, entry_epoch: 1 })
  docs.set('other-param', { _id: 'b', ticker: 'SOFI', date: TODAY, threshold: 0.3, stop_pct: 5, entry_epoch: 2 })
  docs.set('other-ticker', { _id: 'c', ticker: 'NVDA', date: TODAY, threshold: 0.1, stop_pct: 5, entry_epoch: 3 })
  const n = await supersedeMissingTrades(db, {
    ticker: 'SOFI', date: TODAY, threshold: 0.1, stopPct: 5, keepEpochs: [], now: new Date(),
  })
  assert.equal(n, 0)                                    // nothing in scope, so nothing withdrawn
  assert.ok([...docs.values()].every(d => d.superseded === undefined))
})
