// Position-simulation parameter policy: which entry correlation threshold and
// which trailing stop % the Positions sim runs a given ticker under.
//
// PHASE 1 — STRUCTURE ONLY, ZERO BEHAVIOUR CHANGE. Every tier is seeded at the
// SAME values the whole system already used (0.10 / 5%), so this module changes
// nothing about which trades fire today. It exists so that tier-specific values
// become a data change in one place later, instead of a refactor.
//
// PHASE 2 IS DELIBERATELY NOT DONE, AND THE EVIDENCE SAYS BE CAREFUL. Real
// tier-differentiated values already exist in the codebase
// (predictionThresholdPolicy.PREDICTION_THRESHOLD_POLICY.submittedBaseline, the
// 2026-07-15 tier sweep: Mega 240m/C0.10/3%, Large 480m/C0.10/2%, Mid
// 60m/C0.30/2%, Small 240m/C0.10/2%, Nano 60m/C0.10/5%). They have been
// backtested TWICE and lose money on 4 of 5 tiers:
//
//   aman_threshold_summary.md      — "the exact submitted set fails as a total
//                                     policy because Nano generated almost half
//                                     the trades and was strongly negative"
//   backtests/message_density_thresholds/outputs_v12_final_confirmation_mongo_ohlc/
//   strategy_summary.csv (group tier_exact, larger sample):
//       Mega  n=34  win 35.3%  meanNet -0.2128%  PF 0.86  maxDD -18.08
//       Large n= 4  win 50.0%  meanNet -0.6608%  PF 0.38  maxDD  -4.26
//       Mid   n=19  win 63.2%  meanNet +0.8809%  PF 2.35  maxDD  -3.45   <- only positive tier
//       Small n= 6  win 16.7%  meanNet -1.4288%  PF 0.12  maxDD  -9.76
//       Nano  n=39  win 23.1%  meanNet -1.4219%  PF 0.41  maxDD -60.87
//
// The promoted v11/v12 profile went the other way: UNIFORM windowMinutes 120 /
// thresholdC 0.38 for every tier, with tier-specificity confined to
// minTrailing60Messages. So populating this table with the submittedBaseline
// numbers would be shipping a policy that was measured and rejected. Any real
// tier values need a v11/v12-grade backtest with a frozen OOS window first.
//
// CONFIDENTIALITY BOUNDARY: as with the screeners this serves, nothing here may
// read from or import anything under ~/dev/research-students.

import { predictionMarketCapTier } from './predictionThresholdPolicy.js'

// The canonical parameters the recorded history was written at. Same env vars
// the scheduler and the route already read, so there is exactly one source.
export const CANONICAL_THRESHOLD = Number(process.env.POSITION_HISTORY_THRESHOLD || 0.10)
export const CANONICAL_STOP_PCT = Number(process.env.POSITION_HISTORY_STOP_PCT || 5)

// Identifies the parameter SET, not the two numbers. Stamped on every recorded
// row so a row stays interpretable after this table changes. The baseline id is
// special-cased in tradeKey so seeding it cannot re-key existing history — see
// lib/positionHistory.js:tradeKey.
export const BASELINE_POSITION_POLICY_ID = 'global_uniform_v1'
export const POSITION_POLICY_ID = BASELINE_POSITION_POLICY_ID

// Shared clamp limits. These used to differ per route (threshold floors of
// 0.05 / 0.10 / 0.01 and stop floors of 1 / 5), which meant the same query
// string meant different things depending on which screener answered it. Set to
// the widest floor any route previously allowed, so no request the UI can send
// is clamped differently than it was before: the Positions sliders reach
// threshold 0.05 and stop 1%, and a stricter floor would have silently moved
// them.
export const POSITION_PARAM_LIMITS = Object.freeze({
  thresholdMin: 0.01,
  thresholdMax: 1,
  stopPctMin: 1,
  stopPctMax: 30,
})

// Tier -> parameters. Keys are exactly the tiers predictionMarketCapTier can
// return; no tier boundary is defined here or anywhere else in this file. Note
// that the policy layer has FIVE tiers plus Unknown, not six: predictionMarket
// CapTier folds 'micro' into 'Nano', so there is no separate micro tier to seed.
//
// Unknown gets the global fallback rather than an exclusion, matching v11's
// tierRules.Unknown rationale ("missing market cap cannot be tiered honestly,
// so use the optimized global gate while preserving the missing-cap label").
export const POSITION_TIER_PARAMS = Object.freeze({
  Mega: Object.freeze({ threshold: CANONICAL_THRESHOLD, stopPct: CANONICAL_STOP_PCT }),
  Large: Object.freeze({ threshold: CANONICAL_THRESHOLD, stopPct: CANONICAL_STOP_PCT }),
  Mid: Object.freeze({ threshold: CANONICAL_THRESHOLD, stopPct: CANONICAL_STOP_PCT }),
  Small: Object.freeze({ threshold: CANONICAL_THRESHOLD, stopPct: CANONICAL_STOP_PCT }),
  Nano: Object.freeze({ threshold: CANONICAL_THRESHOLD, stopPct: CANONICAL_STOP_PCT }),
  Unknown: Object.freeze({ threshold: CANONICAL_THRESHOLD, stopPct: CANONICAL_STOP_PCT }),
})

/**
 * Tier for a normalized screener row. Delegates entirely — this file must never
 * grow its own market-cap cutoffs, which is how the codebase ended up with two
 * copies of marketCapBucket in the first place.
 */
export function positionTierFor(row = {}) {
  const tier = predictionMarketCapTier(row)
  return Object.prototype.hasOwnProperty.call(POSITION_TIER_PARAMS, tier) ? tier : 'Unknown'
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

/**
 * Effective parameters for one row.
 *
 * An explicit caller override (the Positions sliders) still applies to EVERY
 * tier, exactly as it does today — the sliders are a global what-if, not a
 * per-tier editor. With the table seeded uniformly the two paths return the
 * same numbers, which is what makes Phase 1 a no-op.
 *
 * Returns { tier, threshold, stopPct, policyId, isPolicyDefault }.
 */
export function resolvePositionParams(row = {}, { threshold, stopPct } = {}) {
  const tier = positionTierFor(row)
  const base = POSITION_TIER_PARAMS[tier]
  const { thresholdMin, thresholdMax, stopPctMin, stopPctMax } = POSITION_PARAM_LIMITS
  const hasThresholdOverride = threshold != null && threshold !== ''
  const hasStopOverride = stopPct != null && stopPct !== ''
  return {
    tier,
    threshold: hasThresholdOverride
      ? clampNumber(threshold, thresholdMin, thresholdMax, base.threshold)
      : base.threshold,
    stopPct: hasStopOverride
      ? clampNumber(stopPct, stopPctMin, stopPctMax, base.stopPct)
      : base.stopPct,
    policyId: POSITION_POLICY_ID,
    isPolicyDefault: !hasThresholdOverride && !hasStopOverride,
  }
}

/**
 * The policy as served to clients: what each tier would run at, and the fact
 * that every tier is currently identical. Surfaced so the Positions page can
 * say "tier-aware plumbing, uniform values" rather than implying tuning that
 * has not happened.
 */
export function positionPolicySnapshot() {
  return {
    policy_id: POSITION_POLICY_ID,
    canonical: { threshold: CANONICAL_THRESHOLD, stop_pct: CANONICAL_STOP_PCT },
    tiers: Object.fromEntries(
      Object.entries(POSITION_TIER_PARAMS).map(([tier, p]) => [tier, { threshold: p.threshold, stop_pct: p.stopPct }]),
    ),
    tier_values_differentiated: new Set(
      Object.values(POSITION_TIER_PARAMS).map(p => `${p.threshold}|${p.stopPct}`),
    ).size > 1,
    note:
      'Tier-aware plumbing seeded uniformly at the canonical parameters — every tier currently runs identical ' +
      'values, so tiering changes no trade today. Tier-specific values are deferred pending a v11/v12-grade ' +
      'backtest; the existing 2026-07-15 tier sweep was backtested twice and is negative on 4 of 5 tiers.',
  }
}
