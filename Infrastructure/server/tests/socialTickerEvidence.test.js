import test from 'node:test'
import assert from 'node:assert/strict'
import { tickerCandidatesWithEvidence, TRUSTED_COLLECTOR_REGEX } from '../lib/socialTickerEvidence.js'

// CAN is the real-world case: Canaan Inc is a genuinely traded ticker in this
// app (25 rows in screener_position_history at ~$0.23), and "can" is one of the
// most common words in English. Production had 49,464 rows stamped CAN of which
// only 481 mentioned $CAN. These tests pin both directions — the real ones must
// survive, the word must not.

const BLUESKY = 'bluesky_public_search_cashtag'
const STOCKTWITS = 'stocktwits_public_symbol_stream'

test('bare "can" in ordinary prose does not become ticker CAN', () => {
  const row = { collector: BLUESKY, ticker: 'CAN', symbol: 'CAN', cashtag: '$CAN', text: 'Can this keep running?' }
  assert.deepEqual(tickerCandidatesWithEvidence(row, ['CAN']), [])
})

test('a real production bare-word row is suppressed', () => {
  const row = { collector: BLUESKY, ticker: 'CAN', cashtag: '$CAN', text: 'can someone please not let zverev win wimbledon too, thanks' }
  assert.deepEqual(tickerCandidatesWithEvidence(row, ['CAN']), [])
})

test('an explicit cashtag resolves to CAN', () => {
  const row = { collector: BLUESKY, ticker: 'CAN', text: 'Watching $CAN after earnings' }
  assert.deepEqual(tickerCandidatesWithEvidence(row, ['CAN']), ['CAN'])
})

test('a verified platform symbol field resolves to CAN even with no cashtag in the body', () => {
  // StockTwits' per-symbol stream is the platform's own attribution, so the
  // post body does not have to spell the ticker out.
  const row = { collector: STOCKTWITS, ticker: 'CAN', symbol: 'CAN', text: 'is it going to sustain?' }
  assert.deepEqual(tickerCandidatesWithEvidence(row, ['CAN']), ['CAN'])
})

test('a real production cashtag row survives', () => {
  const row = { collector: STOCKTWITS, ticker: 'CAN', text: '$CAN above .34 we see a squeeze to .5' }
  assert.deepEqual(tickerCandidatesWithEvidence(row, ['CAN']), ['CAN'])
})

test('lowercase company text with no evidence yields no ticker', () => {
  const row = { collector: BLUESKY, ticker: 'CAN', text: 'canaan is a bitcoin miner, apparently' }
  assert.deepEqual(tickerCandidatesWithEvidence(row, ['CAN']), [])
})

test('a multi-symbol cashtag post keeps every valid symbol, deduplicated', () => {
  const row = { collector: BLUESKY, ticker: 'CAN', text: 'basket today: $CAN $AAPL $CAN and $TSLA' }
  const out = tickerCandidatesWithEvidence(row, ['CAN', 'AAPL', 'TSLA'])
  assert.deepEqual(out, ['CAN', 'AAPL', 'TSLA'])
  assert.equal(new Set(out).size, out.length, 'no duplicates')
})

test('a cashtag for a different ticker does not evidence this one', () => {
  const row = { collector: BLUESKY, ticker: 'CAN', text: 'all in on $AAPL today' }
  assert.deepEqual(tickerCandidatesWithEvidence(row, ['CAN']), [])
})

test('the cashtag field alone is never evidence', () => {
  // fetch_social_to_mongo.py writes cashtag = "$" + ticker on every platform,
  // Bluesky included. If this ever starts passing, the gate has been defeated.
  const row = { collector: BLUESKY, ticker: 'CAN', cashtag: '$CAN', text: 'nothing to do with markets' }
  assert.deepEqual(tickerCandidatesWithEvidence(row, ['CAN']), [])
})

test('matching is case-insensitive on the cashtag but the symbol stays canonical', () => {
  const row = { collector: BLUESKY, ticker: 'CAN', text: 'grabbing some $can here' }
  assert.deepEqual(tickerCandidatesWithEvidence(row, ['CAN']), ['CAN'])
})

test('a cashtag embedded in a longer symbol does not count', () => {
  const row = { collector: BLUESKY, ticker: 'CAN', text: 'looking at $CANA not the other one' }
  assert.deepEqual(tickerCandidatesWithEvidence(row, ['CAN']), [])
})

test('evidence is read from content and title, not only text', () => {
  assert.deepEqual(tickerCandidatesWithEvidence({ collector: BLUESKY, content: 'up on $CAN' }, ['CAN']), ['CAN'])
  assert.deepEqual(tickerCandidatesWithEvidence({ collector: BLUESKY, title: 'the $CAN squeeze' }, ['CAN']), ['CAN'])
})

test('only symbol_stream provenance is trusted, not any collector containing the word', () => {
  assert.match(STOCKTWITS, new RegExp(TRUSTED_COLLECTOR_REGEX))
  assert.doesNotMatch(BLUESKY, new RegExp(TRUSTED_COLLECTOR_REGEX))
  assert.doesNotMatch('node_bluesky', new RegExp(TRUSTED_COLLECTOR_REGEX))
  // A collector that merely mentions a symbol stream mid-name is not trusted.
  assert.doesNotMatch('symbol_stream_scraper_v2', new RegExp(TRUSTED_COLLECTOR_REGEX))
})

test('a missing collector is untrusted — evidence must come from the text', () => {
  assert.deepEqual(tickerCandidatesWithEvidence({ ticker: 'CAN', text: 'can we go' }, ['CAN']), [])
  assert.deepEqual(tickerCandidatesWithEvidence({ ticker: 'CAN', text: 'go $CAN' }, ['CAN']), ['CAN'])
})

test('a dot in a symbol is escaped rather than matching any character', () => {
  const row = { collector: BLUESKY, ticker: 'BRK.A', text: 'holding $BRKXA' }
  assert.deepEqual(tickerCandidatesWithEvidence(row, ['BRK.A']), [])
  assert.deepEqual(tickerCandidatesWithEvidence({ collector: BLUESKY, text: 'holding $BRK.A' }, ['BRK.A']), ['BRK.A'])
})
