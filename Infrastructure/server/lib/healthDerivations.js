// Status derivations for /api/system/health.
//
// Extracted so the rules are testable without standing up the whole server:
// each of these turns raw job state into a word a reader will act on, and
// getting one wrong means a health page that reports a broken job as fine.

/**
 * Whether the price-basis audit is doing useful work.
 *
 * Reads lastSkipped, not just lastError. Every per-session failure inside the
 * audit — an unreachable chart-service, a missing bar, a failed update — is
 * caught locally and counted as skipped, so a cycle that checked nothing while
 * skipping work is the shape of trouble and still reports lastError: null.
 */
export function priceBasisAuditHealthy(status = {}) {
  if (status.lastError != null) return false
  return !(status.lastChecked === 0 && status.lastSkipped > 0)
}

/**
 * Short-interest estimator state.
 *
 * Hourly by design: FINRA publishes one short-volume file per trading day, so
 * the cycle keeps the intraday volume term moving rather than fetching new
 * source data. Two intervals of slack before calling it stale, because the
 * estimator only runs as part of a refresh cycle and a quiet dashboard
 * legitimately delays it past one.
 */
export function shortInterestStatus({ lastRunAt, lastError, ageSeconds, intervalSeconds }) {
  if (lastError) return 'error'
  if (lastRunAt == null) return 'not_run_since_boot'
  if (ageSeconds != null && intervalSeconds != null && ageSeconds > intervalSeconds * 2) return 'stale'
  return 'healthy'
}

/**
 * What the recorded rows say the RTH gate did.
 *
 * Observed, never configured. The exemption list lives on the chart-service,
 * which is where the gate is enforced; a second copy here could silently
 * disagree with the one actually binding, so this reports behaviour instead.
 *
 * rth_applied === false means the gate explicitly did not bind an exempt
 * ticker. null/undefined means a pre-gate row, which is NOT an exemption —
 * folding the two together would invent exemptions out of history.
 */
export function summariseRthRows(rows = []) {
  const bound = rows.filter(r => r.rth_applied === true).length
  const exempt = rows.filter(r => r.rth_applied === false).length
  return {
    rows_seen: rows.length,
    rule_versions_seen: Array.from(new Set(rows.map(r => r.rth_rule_version).filter(Boolean))),
    gate_bound_rows: bound,
    exempt_rows: exempt,
    pre_gate_or_unknown_rows: rows.length - bound - exempt,
    observed_exempt_tickers: Array.from(new Set(
      rows.filter(r => r.rth_applied === false && r.ticker).map(r => r.ticker),
    )).sort(),
  }
}
