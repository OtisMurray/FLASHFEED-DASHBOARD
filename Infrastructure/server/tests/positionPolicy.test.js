import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizeTrade, tradeKey } from '../lib/positionHistory.js'
import {
  BASELINE_POSITION_POLICY_ID,
  CANONICAL_STOP_PCT,
  CANONICAL_THRESHOLD,
  POSITION_PARAM_LIMITS,
  POSITION_POLICY_ID,
  POSITION_TIER_PARAMS,
  positionPolicySnapshot,
  positionTierFor,
  resolvePositionParams,
} from '../lib/positionPolicy.js'

// The migration hazard this whole layer had to avoid: _id embeds the parameter
// set, so introducing a policy dimension could have re-keyed every stored row —
// orphaning recorded history and re-inserting today's open positions as
// duplicates. The baseline policy MUST reproduce the pre-existing key exactly.
test('seeding the baseline policy leaves existing history keys byte-identical', () => {
  const trade = { ticker: 'GVH', date: '2026-07-30', entry_epoch: 1785406320, threshold: 0.10, stopPct: 5 }
  const legacy = 'GVH|2026-07-30|1785406320|0.1000|5.00'
  assert.equal(tradeKey(trade), legacy)
  assert.equal(tradeKey({ ...trade, policyId: BASELINE_POSITION_POLICY_ID }), legacy)
  assert.equal(tradeKey({ ...trade, policyId: POSITION_POLICY_ID }), legacy)
  assert.equal(POSITION_POLICY_ID, BASELINE_POSITION_POLICY_ID)
})

test('a non-baseline policy separates its history instead of colliding', () => {
  const trade = { ticker: 'GVH', date: '2026-07-30', entry_epoch: 1785406320, threshold: 0.10, stopPct: 5 }
  const baseline = tradeKey({ ...trade, policyId: BASELINE_POSITION_POLICY_ID })
  const tuned = tradeKey({ ...trade, policyId: 'tier_tuned_v2' })
  assert.notEqual(tuned, baseline)
  assert.equal(tuned, `${baseline}|tier_tuned_v2`)
})

test('recording tier and policy provenance does not alter the row identity', () => {
  const trade = { entry_epoch: 1785406320, entry_price: 1.015, exit_price: 1.17, peak_price: 1.24, exit_reason: 'price_trailing_stop' }
  const context = { ticker: 'GVH', date: '2026-07-30', threshold: 0.10, stopPct: 5 }
  const bare = normalizeTrade(trade, context)
  const stamped = normalizeTrade(trade, { ...context, policyId: POSITION_POLICY_ID, marketCapTier: 'Nano' })
  assert.equal(stamped._id, bare._id)
  assert.equal(stamped.position_policy_id, BASELINE_POSITION_POLICY_ID)
  assert.equal(stamped.market_cap_tier, 'Nano')
})

// Phase 1 is structural. If this fails, tier-specific values were introduced
// without the backtest the evidence demands — see lib/positionPolicy.js, where
// the existing 2026-07-15 tier sweep is recorded as negative on 4 of 5 tiers.
test('Phase 1 seeds every tier identically, so tiering changes no trade', () => {
  const distinct = new Set(Object.values(POSITION_TIER_PARAMS).map(p => `${p.threshold}|${p.stopPct}`))
  assert.equal(distinct.size, 1)
  for (const params of Object.values(POSITION_TIER_PARAMS)) {
    assert.equal(params.threshold, CANONICAL_THRESHOLD)
    assert.equal(params.stopPct, CANONICAL_STOP_PCT)
  }
  assert.equal(positionPolicySnapshot().tier_values_differentiated, false)
})

test('tiers come from the shared policy helper, including the micro-into-nano fold', () => {
  assert.equal(positionTierFor({ market_cap: 300e9 }), 'Mega')
  assert.equal(positionTierFor({ market_cap: 50e9 }), 'Large')
  assert.equal(positionTierFor({ market_cap: 5e9 }), 'Mid')
  assert.equal(positionTierFor({ market_cap: 500e6 }), 'Small')
  // predictionMarketCapTier folds 'micro' into 'Nano' — there is no separate
  // micro tier to seed, and this layer must not invent one.
  assert.equal(positionTierFor({ market_cap: 50e6 }), 'Nano')
  assert.equal(positionTierFor({ market_cap_tier: 'micro' }), 'Nano')
})

test('a row with no usable market cap falls back rather than being dropped', () => {
  for (const row of [{}, { market_cap: null }, { market_cap: 0 }, { market_cap: 'n/a' }]) {
    const resolved = resolvePositionParams(row)
    assert.equal(resolved.tier, 'Unknown')
    assert.equal(resolved.threshold, CANONICAL_THRESHOLD)
    assert.equal(resolved.stopPct, CANONICAL_STOP_PCT)
  }
})

test('an explicit override still applies to every tier, as the sliders always did', () => {
  const mega = resolvePositionParams({ market_cap: 300e9 }, { threshold: 0.3, stopPct: 12 })
  const nano = resolvePositionParams({ market_cap: 5e6 }, { threshold: 0.3, stopPct: 12 })
  assert.equal(mega.threshold, 0.3)
  assert.equal(nano.threshold, 0.3)
  assert.equal(mega.stopPct, 12)
  assert.equal(nano.stopPct, 12)
  assert.equal(mega.isPolicyDefault, false)
})

test('overrides are clamped to the shared limits every screener now uses', () => {
  const low = resolvePositionParams({ market_cap: 5e9 }, { threshold: -5, stopPct: -5 })
  const high = resolvePositionParams({ market_cap: 5e9 }, { threshold: 99, stopPct: 99 })
  assert.equal(low.threshold, POSITION_PARAM_LIMITS.thresholdMin)
  assert.equal(low.stopPct, POSITION_PARAM_LIMITS.stopPctMin)
  assert.equal(high.threshold, POSITION_PARAM_LIMITS.thresholdMax)
  assert.equal(high.stopPct, POSITION_PARAM_LIMITS.stopPctMax)
})

// Every value the Positions and Exit sliders can emit must survive the shared
// limits unchanged, or unifying the floors would have silently moved a setting.
test('the unified clamp floors admit every value the UI sliders can send', () => {
  const clamp = (v, min, max) => Math.max(min, Math.min(max, Number(v)))
  const { thresholdMin, thresholdMax, stopPctMin, stopPctMax } = POSITION_PARAM_LIMITS
  for (let v = 0.05; v <= 1.0001; v += 0.05) {
    const t = Number(v.toFixed(2))
    assert.equal(clamp(t, thresholdMin, thresholdMax), t)
  }
  for (let s = 1; s <= 30; s += 1) assert.equal(clamp(s, stopPctMin, stopPctMax), s)
  for (const s of [5, 10, 15, 20, 25, 30]) assert.equal(clamp(s, stopPctMin, stopPctMax), s)
})
