import test from 'node:test'
import assert from 'node:assert/strict'
import { priceBasisAuditHealthy, shortInterestStatus, summariseRthRows } from '../lib/healthDerivations.js'

// A health page is only worth having if it says "broken" when something is.
// These pin the three judgements that are easy to get quietly wrong.

test('price basis: a clean run is healthy', () => {
  assert.equal(priceBasisAuditHealthy({ lastError: null, lastChecked: 9, lastFlagged: 1, lastSkipped: 0 }), true)
})

test('price basis: an errored run is not healthy', () => {
  assert.equal(priceBasisAuditHealthy({ lastError: 'boom', lastChecked: 9, lastSkipped: 0 }), false)
})

test('price basis: checked nothing while skipping work is NOT healthy', () => {
  // The real failure mode: per-session failures are caught and counted as
  // skipped, so this cycle did no work and still reports lastError: null.
  assert.equal(priceBasisAuditHealthy({ lastError: null, lastChecked: 0, lastSkipped: 25 }), false)
})

test('price basis: a run with nothing to do is healthy, not degraded', () => {
  assert.equal(priceBasisAuditHealthy({ lastError: null, lastChecked: 0, lastSkipped: 0 }), true)
})

test('short interest: never run since boot is reported as such, not as an error', () => {
  assert.equal(shortInterestStatus({ lastRunAt: null, lastError: null, ageSeconds: null, intervalSeconds: 3600 }), 'not_run_since_boot')
})

test('short interest: an error dominates', () => {
  assert.equal(shortInterestStatus({ lastRunAt: '2026-08-05T10:00:00Z', lastError: 'traceback', ageSeconds: 10, intervalSeconds: 3600 }), 'error')
})

test('short interest: within two intervals is healthy', () => {
  assert.equal(shortInterestStatus({ lastRunAt: 'x', lastError: null, ageSeconds: 3600, intervalSeconds: 3600 }), 'healthy')
  assert.equal(shortInterestStatus({ lastRunAt: 'x', lastError: null, ageSeconds: 7200, intervalSeconds: 3600 }), 'healthy')
})

test('short interest: beyond two intervals is stale', () => {
  assert.equal(shortInterestStatus({ lastRunAt: 'x', lastError: null, ageSeconds: 7201, intervalSeconds: 3600 }), 'stale')
})

test('rth: a pre-gate row is not counted as an exemption', () => {
  // The distinction that matters. null means the row predates the gate; only an
  // explicit false means the gate declined to bind an exempt ticker.
  const out = summariseRthRows([
    { ticker: 'AAA', rth_applied: null },
    { ticker: 'BBB' },
    { ticker: 'CCC', rth_applied: true, rth_rule_version: 'rth_v1_0930_1600_et' },
    { ticker: 'MSFT', rth_applied: false, rth_rule_version: 'rth_v1_0930_1600_et' },
  ])
  assert.equal(out.rows_seen, 4)
  assert.equal(out.gate_bound_rows, 1)
  assert.equal(out.exempt_rows, 1)
  assert.equal(out.pre_gate_or_unknown_rows, 2)
  assert.deepEqual(out.observed_exempt_tickers, ['MSFT'])
})

test('rth: matches what production actually returns', () => {
  // Shape verified against the live collection on 2026-08-05: one rule version,
  // MSFT the only ticker the gate declined to bind. MSFT is a member of the
  // chart-service's RTH_EXEMPT_TICKERS, which is the cross-check that the
  // observed view tracks the configured one without duplicating it.
  const rows = [
    ...Array.from({ length: 69 }, (_, i) => ({ ticker: `T${i}`, rth_applied: true, rth_rule_version: 'rth_v1_0930_1600_et' })),
    { ticker: 'MSFT', rth_applied: false, rth_rule_version: 'rth_v1_0930_1600_et' },
    ...Array.from({ length: 539 }, (_, i) => ({ ticker: `P${i}` })),
  ]
  const out = summariseRthRows(rows)
  assert.equal(out.rows_seen, 609)
  assert.equal(out.gate_bound_rows, 69)
  assert.equal(out.exempt_rows, 1)
  assert.equal(out.pre_gate_or_unknown_rows, 539)
  assert.deepEqual(out.rule_versions_seen, ['rth_v1_0930_1600_et'])
  assert.deepEqual(out.observed_exempt_tickers, ['MSFT'])
})

test('rth: no rows yields zeros rather than throwing', () => {
  const out = summariseRthRows([])
  assert.equal(out.rows_seen, 0)
  assert.deepEqual(out.observed_exempt_tickers, [])
  assert.deepEqual(out.rule_versions_seen, [])
})
