import test from 'node:test'
import assert from 'node:assert/strict'
import { MongoClient } from 'mongodb'

import { socialTickerCandidateStages } from '../routes/screener.js'

// Regression cover for the 3x message-count inflation.
//
// socialTickerCandidateStages derives _ticker_candidates by concatenating
// ticker, symbol, cashtag and tickers_mentioned. On a StockTwits document those
// all normalise to the same string ("AAPL", "AAPL", "$AAPL" -> "AAPL"), so
// without a dedupe the downstream $unwind emitted one row per repetition and
// `count: {$sum: 1}` scored a single real message three times. Measured over
// 5,000 production-shaped documents before the fix: 15,000 emitted rows, x3 on
// 100% of them.
//
// These assertions need a real MongoDB because the defect and its fix both live
// in server-evaluated aggregation operators ($setUnion over $map/$filter) — a
// hand-rolled JS stand-in would be testing a reimplementation, not the pipeline
// that actually runs. When no Mongo is reachable the test skips rather than
// failing, matching how the rest of this suite avoids external dependencies.

const URI = process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://localhost:27017'
const DB = 'feedflash_social_candidate_probe'
const COLL = 'socials_probe'

async function withCollection(docs, fn) {
  let client
  try {
    client = await MongoClient.connect(URI, { serverSelectionTimeoutMS: 1500 })
    await client.db(DB).command({ ping: 1 })
  } catch {
    try { await client?.close() } catch { /* nothing to close */ }
    return null                       // no Mongo here — caller skips
  }
  const coll = client.db(DB).collection(COLL)
  try {
    await coll.deleteMany({})
    if (docs.length) await coll.insertMany(docs)
    return await fn(coll)
  } finally {
    await client.db(DB).dropDatabase().catch(() => {})
    await client.close()
  }
}

// The counting shape the real pipeline uses: unwind the candidates, then sum.
function countStages() {
  return [
    ...socialTickerCandidateStages(),
    { $unwind: '$_ticker_candidates' },
    { $group: { _id: '$_ticker_candidates', count: { $sum: 1 } } },
    { $sort: { _id: 1 } },
  ]
}

// Every one of the 314,388 documents in the production collection carries a
// `collector`, and socialTickerCandidateStages now requires the row to evidence
// its ticker — either through that provenance or through a $TICKER in the text.
// These fixtures therefore name their collector, as real documents do; without
// it they would describe a document shape that does not occur.
const STOCKTWITS_COLLECTOR = 'stocktwits_public_symbol_stream'

test('one real message counts once, not once per ticker alias', async t => {
  // The exact production shape: ticker, symbol and cashtag all say AAPL.
  const docs = [
    { id: 'm1', collector: STOCKTWITS_COLLECTOR, ticker: 'AAPL', symbol: 'AAPL', cashtag: '$AAPL', platform: 'StockTwits' },
    { id: 'm2', collector: STOCKTWITS_COLLECTOR, ticker: 'AAPL', symbol: 'AAPL', cashtag: '$AAPL', platform: 'StockTwits' },
    { id: 'm3', collector: STOCKTWITS_COLLECTOR, ticker: 'AAPL', symbol: 'AAPL', cashtag: '$AAPL', platform: 'StockTwits' },
  ]
  const rows = await withCollection(docs, coll => coll.aggregate(countStages()).toArray())
  if (rows === null) return t.skip('no MongoDB reachable')
  assert.deepEqual(rows, [{ _id: 'AAPL', count: 3 }])   // 3 messages, not 9
})

test('a message genuinely mentioning several tickers still counts once for each', async t => {
  const docs = [
    { id: 'm1', collector: STOCKTWITS_COLLECTOR, ticker: 'AAPL', symbol: 'AAPL', cashtag: '$AAPL', tickers_mentioned: ['MSFT', 'NVDA'] },
  ]
  const rows = await withCollection(docs, coll => coll.aggregate(countStages()).toArray())
  if (rows === null) return t.skip('no MongoDB reachable')
  // Deduping must not collapse DISTINCT tickers — one each, not one total.
  assert.deepEqual(rows, [
    { _id: 'AAPL', count: 1 },
    { _id: 'MSFT', count: 1 },
    { _id: 'NVDA', count: 1 },
  ])
})

test('duplicates within a single field are collapsed too', async t => {
  const docs = [
    { id: 'm1', collector: STOCKTWITS_COLLECTOR, ticker: 'TSLA', symbol: 'tsla', cashtag: '$TSLA', tickers_mentioned: 'TSLA,TSLA, $TSLA' },
  ]
  const rows = await withCollection(docs, coll => coll.aggregate(countStages()).toArray())
  if (rows === null) return t.skip('no MongoDB reachable')
  assert.deepEqual(rows, [{ _id: 'TSLA', count: 1 }])
})

test('cashtags recovered from free text are deduped as well', async t => {
  const docs = [
    // No ticker/symbol/cashtag fields, so the pipeline falls back to text scraping.
    { id: 'm1', text: '$GME to the moon, $GME again, and $AMC', content: '$GME', title: '' },
  ]
  const rows = await withCollection(docs, coll => coll.aggregate(countStages()).toArray())
  if (rows === null) return t.skip('no MongoDB reachable')
  assert.deepEqual(rows, [{ _id: 'AMC', count: 1 }, { _id: 'GME', count: 1 }])
})
