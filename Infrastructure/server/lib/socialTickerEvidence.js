// Whether a social row is real evidence for the ticker it is stamped with.
//
// The collectors write `ticker`, `symbol` and `cashtag` onto every row from the
// search term they used, not from anything the platform said. So a Bluesky
// search for "$CAN" returns every post containing the word "can" — Bluesky's
// index strips the "$" — and all of them arrive stamped ticker="CAN". Measured
// against production on 2026-08-05: of 49,464 rows stamped CAN, only 481 (1.0%)
// mentioned $CAN at all. The rest were ordinary English:
//
//   "can someone please not let zverev win wimbledon too, thanks"
//
// Two things count as evidence that a row is about the ticker:
//
//   1. Provenance. StockTwits is read through its per-symbol stream endpoint,
//      so every message returned is one StockTwits itself filed under that
//      symbol. That is the platform's own attribution, and it holds even when
//      the post body never spells the ticker out.
//
//   2. The post says so. A $TICKER cashtag for that exact ticker in the row's
//      own text. This is what a full-text search collector has to clear,
//      because its stamped ticker is only ever the query echoed back.
//
// `cashtag` is deliberately NOT evidence: fetch_social_to_mongo.py writes
// `cashtag = f"${ticker}"` on every platform including Bluesky, so trusting it
// would re-admit exactly the rows this gate exists to remove.

// Collectors whose stamped ticker comes from the platform's own symbol filing
// rather than from a text query. Matched against the row's `collector` field.
export const TRUSTED_COLLECTOR_REGEX = 'symbol_stream$'

// Aggregation stages that narrow an already-built `_ticker_candidates` array to
// the candidates the row actually evidences. Append these after whichever
// candidate builder a pipeline uses — they only read `_ticker_candidates`, so
// they compose with all three of the (divergent) builders in this codebase.
export function socialTickerEvidenceStages() {
  return [
    {
      $addFields: {
        _evidence_text: {
          $concat: [
            { $toString: { $ifNull: ['$text', ''] } }, ' ',
            { $toString: { $ifNull: ['$content', ''] } }, ' ',
            { $toString: { $ifNull: ['$title', ''] } },
          ],
        },
        // Platform-attributed rows are trusted wholesale; nothing else is.
        _platform_attributed: {
          $regexMatch: {
            input: { $toString: { $ifNull: ['$collector', ''] } },
            regex: TRUSTED_COLLECTOR_REGEX,
          },
        },
      },
    },
    {
      $addFields: {
        _ticker_candidates: {
          $filter: {
            input: { $ifNull: ['$_ticker_candidates', []] },
            as: 'candidate',
            cond: {
              $or: [
                '$_platform_attributed',
                {
                  $regexMatch: {
                    input: '$_evidence_text',
                    // Candidates are already constrained to ^[A-Z][A-Z0-9.-]{0,5}$,
                    // so "." is the only regex metacharacter that can reach here;
                    // escape it so $BRK.A cannot match "$BRKXA".
                    regex: {
                      $concat: [
                        '\\$',
                        { $replaceAll: { input: '$$candidate', find: '.', replacement: '\\.' } },
                        '\\b',
                      ],
                    },
                    options: 'i',
                  },
                },
              ],
            },
          },
        },
      },
    },
  ]
}

// Same decision as the aggregation above, in plain JS, for tests and for any
// read-time code holding a row in memory rather than in a pipeline.
export function tickerCandidatesWithEvidence(row = {}, candidates = []) {
  const text = [row.text, row.content, row.title]
    .map(v => (v == null ? '' : String(v)))
    .join(' ')
  const platformAttributed = new RegExp(TRUSTED_COLLECTOR_REGEX)
    .test(String(row.collector || ''))
  if (platformAttributed) return [...candidates]
  return candidates.filter(candidate => {
    const escaped = String(candidate).replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')
    return new RegExp(`\\$${escaped}\\b`, 'i').test(text)
  })
}
