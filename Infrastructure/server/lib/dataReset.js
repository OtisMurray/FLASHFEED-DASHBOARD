// Scoped data reset — simulated-position history and the derived/cached rows
// computed from it or re-fetchable from an upstream API.
//
// THE ALLOWLIST IS THE WHOLE SAFETY MODEL. It is a literal defined here and is
// never merged with, extended by, or overridden from a request body. A reset
// endpoint that takes collection names from its caller is a database-drop
// endpoint wearing a costume, and no amount of confirming in the UI fixes that.
//
// What is deliberately NOT here, and why:
//
//   socials, articles, stocktwits_watcher_snapshots
//     Raw ingested observations. StockTwits messages cannot be re-fetched at
//     any price and RSS reaches back days, so clearing these destroys data no
//     later run can rebuild. They are not credentials, but they are not cache
//     either.
//
//   prediction_models, next_session_prediction_models
//     Trained artefacts. Rebuildable only by retraining, which is not instant.
//
//   users, apikeys, user_connections, app_settings, keywords, source_toggles,
//   source_favorites, rss_sources, source_status
//     Credentials, accounts and settings. Out of scope by definition.
//
// Everything below either recomputes on the next scheduler cycle or re-fetches
// from Finviz/chart-service.
export const RESETTABLE_COLLECTIONS = Object.freeze([
  {
    name: 'screener_position_history',
    label: 'Simulated position history',
    // Said plainly because it is the one entry that does not come back on its
    // own: history is written by the scheduler at the canonical parameters,
    // and a past session cannot be re-simulated once its bars and messages
    // have aged out.
    note: 'Not rebuildable — past sessions cannot be re-simulated.',
  },
  { name: 'ohlcv_bars', label: 'Cached intraday bars', note: 'Re-fetched from chart-service on demand.' },
  { name: 'screeners', label: 'Cached screener rows', note: 'Re-fetched from Finviz on the next cycle.' },
  { name: 'finviz_momentum_snapshots', label: 'Momentum snapshots', note: 'Recomputed on the next cycle.' },
  { name: 'momentum_snapshots', label: 'Momentum snapshots (legacy)', note: 'Recomputed on the next cycle.' },
  { name: 'prediction_signals', label: 'Prediction signals', note: 'Recomputed from bars and messages.' },
  { name: 'daily_prediction_snapshots', label: 'Daily prediction snapshots', note: 'Recomputed on the next cycle.' },
  { name: 'decision_map_points', label: 'Decision Map points', note: 'Recomputed from bars and messages.' },
  { name: 'active_ticker_context', label: 'Active ticker context', note: 'Recomputed on the next cycle.' },
  { name: 'correlations', label: 'Correlation rows', note: 'Recomputed on the next cycle.' },
  { name: 'short_interest_snapshots', label: 'Short-interest snapshots', note: 'Re-fetched from FINRA.' },
  { name: 'prediction_postmortem_reports', label: 'Prediction postmortems', note: 'Regenerated from history.' },
  { name: 'prediction_replay_reports', label: 'Prediction replays', note: 'Regenerated from history.' },
])

/** The exact string an admin has to type. Checked server-side, not only in the UI. */
export const RESET_CONFIRM_PHRASE = 'RESET'

/**
 * Row counts for every resettable collection that actually exists.
 *
 * Collections absent from this deployment are reported with `exists: false`
 * rather than skipped, so the dialog shows the same list every time instead of
 * a set that changes shape depending on which schedulers have run.
 */
export async function previewReset(db) {
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map(c => c.name))
  const collections = []
  for (const entry of RESETTABLE_COLLECTIONS) {
    const exists = existing.has(entry.name)
    collections.push({
      ...entry,
      exists,
      count: exists ? await db.collection(entry.name).countDocuments() : 0,
    })
  }
  return { collections, total_rows: collections.reduce((sum, c) => sum + c.count, 0) }
}

/**
 * Delete every document in the allowlisted collections.
 *
 * deleteMany({}) rather than drop(): dropping takes the indexes with it, and a
 * collection that reappears without its indexes turns the next scheduler cycle
 * into a collection scan. Emptying keeps the shape and only removes the rows.
 *
 * Failures are collected per collection instead of aborting the whole run — a
 * half-finished reset that reports which half finished is recoverable; one
 * that throws on the third collection and says nothing is not.
 */
export async function executeReset(db, { actor } = {}) {
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map(c => c.name))
  const results = []
  for (const entry of RESETTABLE_COLLECTIONS) {
    if (!existing.has(entry.name)) {
      results.push({ name: entry.name, label: entry.label, exists: false, deleted: 0 })
      continue
    }
    try {
      const before = await db.collection(entry.name).countDocuments()
      const res = await db.collection(entry.name).deleteMany({})
      results.push({ name: entry.name, label: entry.label, exists: true, deleted: res.deletedCount ?? before })
    } catch (err) {
      results.push({ name: entry.name, label: entry.label, exists: true, deleted: 0, error: String(err.message || err) })
    }
  }
  const deleted_total = results.reduce((sum, r) => sum + r.deleted, 0)
  const failed = results.filter(r => r.error)
  console.warn(
    `  Reset   →  ${actor || 'unknown admin'} cleared ${deleted_total} rows across `
    + `${results.filter(r => r.deleted > 0).length} collections`
    + (failed.length ? ` (${failed.length} failed)` : ''),
  )
  return { results, deleted_total, failed_count: failed.length }
}
