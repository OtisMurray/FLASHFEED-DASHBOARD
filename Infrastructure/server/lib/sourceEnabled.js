// THE source-enabled check. One definition, consulted by every path that either
// collects from a source or reads its rows back.
//
// WHY THIS EXISTS. Before this module the only source a dashboard toggle could
// actually switch off was a custom RSS feed, because `rss_sources.enabled` was
// the one flag any collector read (1_News/pipeline/fetch_rss_to_mongo.py:530).
// Every fixed source — the newswires, the broker feeds, StockTwits, Reddit,
// Bluesky — had no off switch at all. Adding a per-worker one would have meant
// four collectors each deciding for themselves what "off" means, which is how a
// source ends up disabled for ingestion but still ranked.
//
// SO: a toggle is stored once, and this module maps it to (a) which collector
// must not run, and (b) which rows must not count. Nothing else may re-derive
// either answer.
//
// SAFETY PROPERTY — read this before changing anything here. With no toggle
// rows stored, `disabledSourceNames()` is empty, `collectorGate()` skips no
// script and sets no env, and `socialPlatformGate()` returns null. Every call
// site is therefore a no-op until an admin actually disables something. That is
// deliberate: it is what makes wiring this into a live ingestion path safe.
//
// DISABLE, NOT DELETE. A disabled source keeps every row it ever wrote. Turning
// it back on resumes collection against the same history — which is the whole
// point for Reddit and Bluesky, whose archives are not re-fetchable.

export const SOURCE_TOGGLE_COLLECTION = 'source_toggles'

/**
 * Stable key for a source name. Display names drift ("BusinessWire" vs
 * "Business Wire", "X/Twitter" vs "X / Twitter") and are what the registry, the
 * feed lists, the UI and the Mongo rows all carry independently, so the stored
 * key is normalized rather than the name itself.
 *
 * Separators are removed, not collapsed to underscores: collapsing keeps
 * "businesswire" and "business_wire" apart, which is the one case this has to
 * unify. `source` is stored next to the key so the readable name survives.
 * Verified non-colliding across the whole registry — see the test.
 */
export function sourceKey(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '')
}

/**
 * Collector wiring per registry source.
 *
 * Every entry was traced to the code that actually writes the rows — see the
 * `writer` note. A source with no writer in this service is listed with
 * `writer: null` rather than omitted, because omitting it would make it
 * indistinguishable from a source someone forgot to map.
 *
 *   script       spawned per refresh cycle; disabling skips the spawn outright
 *   env          collector runs, but this env var turns one platform off inside it
 *   rssFeeds     feed names inside fetch_rss_to_mongo.py's feed list
 *   unstructured source names inside fetch_unstructured_news_titles_to_mongo.py
 */
export const SOURCE_COLLECTORS = Object.freeze({
  'Finviz Elite Screener': {
    script: '2_Screener/pipeline/fetch_finviz_elite_to_mongo.py',
    writer: 'fetch_finviz_elite_to_mongo.py -> screeners',
  },
  'TradingView Numeric Screener': {
    script: '2_Screener/pipeline/fetch_tradingview_screener_to_mongo.py',
    writer: 'fetch_tradingview_screener_to_mongo.py -> screeners',
  },
  'TradingView News Flow': {
    script: '1_News/pipeline/fetch_tradingview_to_mongo.py',
    writer: 'fetch_tradingview_to_mongo.py -> articles (source "TradingView News Flow")',
  },
  'Benzinga': {
    script: '1_News/pipeline/fetch_benzinga_to_mongo.py',
    rssFeeds: ['Benzinga'],
    writer: 'fetch_benzinga_to_mongo.py, plus a "Benzinga" entry in RSS_FEEDS',
  },
  'Interactive Brokers News': {
    script: '1_News/pipeline/fetch_ibkr_news_to_mongo.py',
    writer: 'fetch_ibkr_news_to_mongo.py -> articles',
  },
  'Schwab News': {
    script: '2_Screener/pipeline/fetch_schwab_signals_to_mongo.py',
    writer: 'fetch_schwab_signals_to_mongo.py',
  },
  'Finviz News Flow': {
    unstructured: ['Finviz News Flow'],
    writer: 'fetch_unstructured_news_titles_to_mongo.py (config/unstructured_news_sources.json)',
  },
  // No active writer: the name survives only as a category label in the
  // unstructured collector. Mapped anyway so the toggle covers it if a writer
  // is ever added under that name.
  'Finviz News': {
    unstructured: ['Finviz News'],
    writer: null,
  },
  'TradingView News': {
    rssFeeds: ['TradingView News'],
    writer: 'fetch_rss_to_mongo.py via RSS_FEEDS',
  },
  'PR Newswire': {
    rssFeeds: ['PR Newswire'],
    writer: 'fetch_rss_to_mongo.py (prnewswire://newsroom collector)',
  },
  'PR Newswire Financial': {
    rssFeeds: ['PR Newswire Financial'],
    writer: 'fetch_rss_to_mongo.py via RSS_FEEDS',
  },
  // One toggle, three feeds: the registry lists the parent publisher and the
  // feed list splits it by desk. Disabling the publisher must stop all three.
  'GlobeNewswire Public Companies': {
    rssFeeds: ['GlobeNewswire Public Companies', 'GlobeNewswire Earnings', 'GlobeNewswire M&A'],
    writer: 'fetch_rss_to_mongo.py (globenewswire://search collector)',
  },
  'ACCESS Newswire': {
    rssFeeds: ['ACCESS Newswire'],
    writer: 'fetch_rss_to_mongo.py (accessnewswire://newsroom collector)',
  },
  'BusinessWire': {
    rssFeeds: ['Business Wire', 'BusinessWire'],
    writer: 'fetch_rss_to_mongo.py via RSS_FEEDS',
  },
  'FDA': {
    rssFeeds: ['FDA Press Releases', 'FDA Recalls', 'FDA Drug Approvals', 'FDA MedWatch Safety Alerts'],
    writer: 'fetch_rss_to_mongo.py via RSS_FEEDS',
  },
  'StockTwits': {
    env: { SOCIAL_INCLUDE_STOCKTWITS: 'false' },
    platform: 'StockTwits',
    writer: 'fetch_social_to_mongo.py::_fetch_ticker -> socials',
  },
  'Reddit': {
    env: { SOCIAL_INCLUDE_REDDIT: 'false' },
    platform: 'Reddit',
    writer: 'fetch_social_to_mongo.py::_fetch_reddit_ticker -> socials',
  },
  'Bluesky': {
    env: { SOCIAL_INCLUDE_BLUESKY: 'false' },
    platform: 'Bluesky',
    writer: 'fetch_social_to_mongo.py::_fetch_bluesky_ticker -> socials',
  },
  'X/Twitter': {
    env: { SOCIAL_INCLUDE_X: 'false' },
    // socialTimeStages() normalizes every X/Twitter spelling to "Grok/X", so
    // that — not the registry's display name — is what the read gate matches.
    platform: 'Grok/X',
    writer: 'fetch_social_to_mongo.py::_fetch_x_ticker -> socials',
  },
  // Rows exist in `articles` from an earlier import; nothing in this service
  // collects them today. The toggle still gates the read path.
  'SEC EDGAR': { writer: null },
  'Dow Jones Newswires': { writer: null },
})

function collectorFor(name) {
  const direct = SOURCE_COLLECTORS[name]
  if (direct) return direct
  const key = sourceKey(name)
  for (const [source, entry] of Object.entries(SOURCE_COLLECTORS)) {
    if (sourceKey(source) === key) return entry
  }
  return null
}

/** Normalizes stored toggle rows into a keyed lookup. */
export function buildSourceToggleState(rows = []) {
  const state = new Map()
  for (const row of rows || []) {
    const key = sourceKey(row?.key || row?.source || row?.name)
    if (!key) continue
    state.set(key, {
      key,
      source: String(row?.source || row?.name || key),
      // Absent/garbage `enabled` reads as enabled. A malformed row must not be
      // able to silently switch a working source off.
      enabled: row?.enabled !== false,
      updated_at: row?.updated_at ?? null,
      updated_by: row?.updated_by ?? null,
    })
  }
  return state
}

/** A source with no stored row is enabled. Absence is not a disable. */
export function isSourceEnabled(state, name) {
  const key = sourceKey(name)
  if (!key) return true
  const row = state instanceof Map ? state.get(key) : null
  return row ? row.enabled !== false : true
}

/** Display names of every source currently switched off. */
export function disabledSourceNames(state) {
  if (!(state instanceof Map)) return []
  return Array.from(state.values()).filter(r => r.enabled === false).map(r => r.source)
}

/** Audit metadata for one source, or null when it has never been touched. */
export function sourceToggleAudit(state, name) {
  const row = state instanceof Map ? state.get(sourceKey(name)) : null
  if (!row) return null
  return { enabled: row.enabled, updated_at: row.updated_at, updated_by: row.updated_by }
}

/**
 * What the refresh cycle must do differently this run.
 *
 * Returns the set of collector scripts to skip and the env additions that turn
 * off in-collector sources. Both are empty when nothing is disabled, so the
 * caller's behaviour is unchanged by default.
 */
export function collectorGate(state) {
  const skipScripts = new Set()
  const extraEnv = {}
  const rssDisabled = []
  const unstructuredDisabled = []
  const unmapped = []

  for (const name of disabledSourceNames(state)) {
    const collector = collectorFor(name)
    if (!collector) { unmapped.push(name); continue }
    if (collector.script) skipScripts.add(collector.script)
    if (collector.env) Object.assign(extraEnv, collector.env)
    if (collector.rssFeeds) rssDisabled.push(...collector.rssFeeds)
    if (collector.unstructured) unstructuredDisabled.push(...collector.unstructured)
  }

  // Denylists rather than allowlists: an empty value means "block nothing", so
  // a collector that has not been taught to read the variable behaves exactly
  // as it does today, and a source added to the feed list later is collected
  // unless someone disables it.
  if (rssDisabled.length) extraEnv.RSS_DISABLED_SOURCES = Array.from(new Set(rssDisabled)).join(',')
  if (unstructuredDisabled.length) {
    extraEnv.UNSTRUCTURED_DISABLED_SOURCES = Array.from(new Set(unstructuredDisabled)).join(',')
  }

  return { skipScripts, extraEnv, unmapped }
}

/**
 * `$match` stage excluding disabled social platforms, or null when none are.
 *
 * Matches `_norm_platform`, not the raw `platform` field. socialTimeStages()
 * already resolves every stored spelling — "reddit" vs "Reddit", "bsky" vs
 * "bluesky", the collector field when platform is blank — into one canonical
 * value, so gating on it reuses that work instead of writing a second, weaker
 * copy of it here. It therefore MUST be spread after socialTimeStages().
 *
 * Returning null rather than a match-everything stage is load-bearing: an
 * always-present stage would change every social aggregation's plan even with
 * nothing disabled, and the point of this module is that the default costs
 * nothing.
 */
export function socialPlatformGate(state) {
  const platforms = []
  for (const name of disabledSourceNames(state)) {
    const collector = collectorFor(name)
    if (collector?.platform) platforms.push(collector.platform)
  }
  if (!platforms.length) return null
  return { $match: { _norm_platform: { $nin: Array.from(new Set(platforms)) } } }
}

/** Source names the ingestion gate cannot act on — surfaced, never swallowed. */
export function unmappedDisabledSources(state) {
  return collectorGate(state).unmapped
}
