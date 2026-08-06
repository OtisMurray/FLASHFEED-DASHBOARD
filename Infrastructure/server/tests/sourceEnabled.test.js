import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import {
  sourceKey,
  buildSourceToggleState,
  isSourceEnabled,
  disabledSourceNames,
  sourceToggleAudit,
  collectorGate,
  socialPlatformGate,
  SOURCE_COLLECTORS,
} from '../lib/sourceEnabled.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REGISTRY = JSON.parse(
  readFileSync(path.join(HERE, '../../../config/professor_source_registry.json'), 'utf8'),
)

const off = (...names) => buildSourceToggleState(names.map(source => ({ source, enabled: false })))

// ── The default must cost nothing ───────────────────────────────────────────
// These four are the reason it is safe to wire this into a live ingestion path.

test('no stored toggles disables nothing', () => {
  const state = buildSourceToggleState([])
  assert.equal(isSourceEnabled(state, 'Reddit'), true)
  assert.equal(isSourceEnabled(state, 'PR Newswire'), true)
  assert.deepEqual(disabledSourceNames(state), [])
})

test('an empty gate skips no script and adds no env', () => {
  const gate = collectorGate(buildSourceToggleState([]))
  assert.equal(gate.skipScripts.size, 0)
  assert.deepEqual(gate.extraEnv, {})
  assert.deepEqual(gate.unmapped, [])
})

test('an empty gate produces no social match stage', () => {
  assert.equal(socialPlatformGate(buildSourceToggleState([])), null)
})

test('rows that only enable are still a no-op', () => {
  const state = buildSourceToggleState(REGISTRY.map(e => ({ source: e.source, enabled: true })))
  assert.deepEqual(disabledSourceNames(state), [])
  assert.equal(collectorGate(state).skipScripts.size, 0)
  assert.equal(socialPlatformGate(state), null)
})

// ── Absence and malformed rows must not disable ─────────────────────────────

test('a source with no row is enabled', () => {
  const state = off('Reddit')
  assert.equal(isSourceEnabled(state, 'Bluesky'), true)
  assert.equal(isSourceEnabled(state, 'PR Newswire'), true)
})

test('a row missing `enabled` reads as enabled, not as off', () => {
  const state = buildSourceToggleState([{ source: 'Reddit' }, { source: 'Bluesky', enabled: null }])
  assert.equal(isSourceEnabled(state, 'Reddit'), true)
  assert.equal(isSourceEnabled(state, 'Bluesky'), true)
})

test('an unnamed row is dropped rather than keyed to empty', () => {
  const state = buildSourceToggleState([{ enabled: false }, { source: '   ', enabled: false }])
  assert.equal(state.size, 0)
  assert.equal(isSourceEnabled(state, ''), true)
})

// ── Key normalization ───────────────────────────────────────────────────────

test('display-name drift resolves to one key', () => {
  assert.equal(sourceKey('BusinessWire'), sourceKey('Business Wire'))
  assert.equal(sourceKey('X/Twitter'), 'xtwitter')
  assert.equal(sourceKey('  PR Newswire  '), 'prnewswire')
})

test('no two registry sources collapse onto the same key', () => {
  const byKey = new Map()
  for (const entry of REGISTRY) {
    const key = sourceKey(entry.source)
    assert.equal(byKey.get(key), undefined, `${entry.source} collides with ${byKey.get(key)} on key "${key}"`)
    byKey.set(key, entry.source)
  }
})

test('sources that differ only by a suffix stay distinct', () => {
  assert.notEqual(sourceKey('PR Newswire'), sourceKey('PR Newswire Financial'))
  assert.notEqual(sourceKey('Finviz News'), sourceKey('Finviz News Flow'))
  assert.notEqual(sourceKey('TradingView News'), sourceKey('TradingView News Flow'))
})

test('a toggle stored under one spelling answers for the other', () => {
  const state = buildSourceToggleState([{ source: 'Business Wire', enabled: false }])
  assert.equal(isSourceEnabled(state, 'BusinessWire'), false)
})

// ── The gate resolves to the collector that actually writes the rows ────────

test('disabling a script-backed source skips exactly that spawn', () => {
  const gate = collectorGate(off('Benzinga'))
  assert.ok(gate.skipScripts.has('1_News/pipeline/fetch_benzinga_to_mongo.py'))
  assert.equal(gate.skipScripts.size, 1)
  // Benzinga also has an RSS feed entry, so both writers must be covered.
  assert.equal(gate.extraEnv.RSS_DISABLED_SOURCES, 'Benzinga')
})

test('disabling a social platform sets its collector env and nothing else', () => {
  const gate = collectorGate(off('Reddit'))
  assert.deepEqual(gate.extraEnv, { SOCIAL_INCLUDE_REDDIT: 'false' })
  assert.equal(gate.skipScripts.size, 0, 'the social collector still runs for the other platforms')
})

test('disabling GlobeNewswire stops all three of its desk feeds', () => {
  const feeds = collectorGate(off('GlobeNewswire Public Companies')).extraEnv.RSS_DISABLED_SOURCES.split(',')
  assert.deepEqual(feeds.sort(), ['GlobeNewswire Earnings', 'GlobeNewswire M&A', 'GlobeNewswire Public Companies'])
})

test('BusinessWire disables both spellings the feed list uses', () => {
  const feeds = collectorGate(off('BusinessWire')).extraEnv.RSS_DISABLED_SOURCES.split(',')
  assert.ok(feeds.includes('Business Wire'))
  assert.ok(feeds.includes('BusinessWire'))
})

test('several disabled sources merge into one denylist without duplicates', () => {
  const gate = collectorGate(off('PR Newswire', 'PR Newswire Financial', 'FDA', 'Reddit', 'Bluesky'))
  const feeds = gate.extraEnv.RSS_DISABLED_SOURCES.split(',')
  assert.equal(new Set(feeds).size, feeds.length)
  assert.ok(feeds.includes('PR Newswire'))
  assert.ok(feeds.includes('FDA Recalls'))
  assert.deepEqual(gate.extraEnv.SOCIAL_INCLUDE_REDDIT, 'false')
  assert.deepEqual(gate.extraEnv.SOCIAL_INCLUDE_BLUESKY, 'false')
})

test('the unstructured collector gets a denylist, not a rewritten allowlist', () => {
  const gate = collectorGate(off('Finviz News Flow'))
  assert.equal(gate.extraEnv.UNSTRUCTURED_DISABLED_SOURCES, 'Finviz News Flow')
  assert.equal(gate.extraEnv.UNSTRUCTURED_SOURCE_FILTER, undefined)
})

test('a source with no collector is reported, not silently dropped', () => {
  assert.deepEqual(collectorGate(off('Some Source Nobody Mapped')).unmapped, ['Some Source Nobody Mapped'])
  // SEC EDGAR is mapped-with-no-writer, which is a different thing from unmapped.
  assert.deepEqual(collectorGate(off('SEC EDGAR')).unmapped, [])
})

// ── Read path ───────────────────────────────────────────────────────────────

test('the social gate excludes only the disabled platform', () => {
  const stage = socialPlatformGate(off('Reddit'))
  // Gates the canonical _norm_platform socialTimeStages() produces, so the
  // stored spelling ("reddit", a blank platform with a reddit collector) is
  // already resolved before this stage sees it.
  assert.deepEqual(stage, { $match: { _norm_platform: { $nin: ['Reddit'] } } })
})

test('X/Twitter gates the normalized name, not the registry display name', () => {
  const stage = socialPlatformGate(off('X/Twitter'))
  assert.deepEqual(stage.$match._norm_platform.$nin, ['Grok/X'])
})

test('disabling a news source produces no social stage', () => {
  assert.equal(socialPlatformGate(off('PR Newswire')), null)
})

test('two disabled platforms are both excluded', () => {
  const nin = socialPlatformGate(off('Reddit', 'X/Twitter')).$match._norm_platform.$nin
  assert.deepEqual(nin.sort(), ['Grok/X', 'Reddit'])
})

test('every gated platform is one socialTimeStages() can actually produce', () => {
  // The $switch in socialTimeStages() is the only writer of _norm_platform.
  // A value outside its vocabulary would gate nothing and fail silently.
  const PRODUCED = new Set(['ApeWisdom Summary', 'StockTwits', 'Bluesky', 'Reddit', 'Grok/X'])
  for (const [source, entry] of Object.entries(SOURCE_COLLECTORS)) {
    if (!entry.platform) continue
    assert.ok(PRODUCED.has(entry.platform), `${source} gates "${entry.platform}", which _norm_platform never equals`)
  }
})

// ── Audit ───────────────────────────────────────────────────────────────────

test('audit metadata round-trips actor and timestamp', () => {
  const state = buildSourceToggleState([
    { source: 'Reddit', enabled: false, updated_at: 1754400000, updated_by: 'aman' },
  ])
  assert.deepEqual(sourceToggleAudit(state, 'Reddit'), {
    enabled: false, updated_at: 1754400000, updated_by: 'aman',
  })
  assert.equal(sourceToggleAudit(state, 'Bluesky'), null, 'never-touched sources have no audit row')
})

// ── The map must stay in step with the registry ─────────────────────────────

test('every registry source is mapped', () => {
  const unmapped = REGISTRY.map(e => e.source).filter(s => !(s in SOURCE_COLLECTORS))
  assert.deepEqual(unmapped, [], 'a registry source with no mapping cannot be switched off')
})

test('every mapping refers to a registry source', () => {
  const known = new Set(REGISTRY.map(e => e.source))
  const stray = Object.keys(SOURCE_COLLECTORS).filter(s => !known.has(s))
  assert.deepEqual(stray, [], 'a mapping with no registry entry can never be reached by the UI')
})

test('every social registry entry carries a platform, and only those do', () => {
  for (const entry of REGISTRY) {
    const mapped = SOURCE_COLLECTORS[entry.source]
    if (entry.collection === 'socials') {
      assert.ok(mapped.platform, `${entry.source} is a social source and needs a platform for the read gate`)
      assert.ok(mapped.env, `${entry.source} is a social source and needs a collector env switch`)
    } else {
      assert.equal(mapped.platform, undefined, `${entry.source} is not social and must not gate the socials read path`)
    }
  }
})
