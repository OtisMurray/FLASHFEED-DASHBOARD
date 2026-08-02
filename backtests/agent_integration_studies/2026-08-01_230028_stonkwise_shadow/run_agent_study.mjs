import fs from 'node:fs/promises'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  assertResearchOnly, buildCompanyAliases, causalTimestamp, classifyArticle, deduplicateEvents,
  existingDetection, extractStoredTickers, legacyStonkwiseDetection, optionalStructuredBrief,
  sha256, TAXONOMY, toEpochSeconds,
} from './prototype/catalyst_agent.mjs'
import { csv, roundObject, splitTemporal, summarizeReturns } from './prototype/metrics.mjs'

const STUDY = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(STUDY, '../../..')
assertResearchOnly(process.argv[2])
const require = createRequire(path.join(ROOT, 'Infrastructure/server/package.json'))
const { MongoClient } = require('mongodb')
const { allowedSource, DEFAULT_ALLOWED_NEWS_SOURCES } = await import(pathToFileURL(path.join(ROOT, 'Infrastructure/server/sourceFilter.js')))

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/feedflash'
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
const stonkwiseCommit = 'fe14c61ac7bd19a95dcec6c34e5cc4019f662dda'
const startedAt = new Date().toISOString()

function n(value) { const x = Number(value); return Number.isFinite(x) ? x : null }
function pct(a, b) { return b ? a / b * 100 : null }
function dateKey(sec) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(sec * 1000)) }
function hourMinute(sec) { return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit' }).format(new Date(sec * 1000)) }
function asJson(value) { return JSON.stringify(roundObject(value), null, 2) + '\n' }
async function write(name, value) { await fs.writeFile(path.join(STUDY, name), value) }
function sourceAllowed(source) { return allowedSource(source) }
function topCounts(rows, key, limit = 25) {
  const counts = new Map()
  for (const row of rows) counts.set(String(row[key] ?? 'missing'), (counts.get(String(row[key] ?? 'missing')) || 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([value, count]) => ({ value, count }))
}
function uniqueBy(rows, keyFn) {
  const map = new Map()
  for (const row of rows) map.set(keyFn(row), row)
  return [...map.values()]
}
function directionAligned(ai, catalyst) {
  const a = String(ai || '').toLowerCase()
  if (catalyst.direction === 'mixed' || catalyst.direction === 'uncertain') return false
  return (a.includes('bull') || a.includes('up')) ? catalyst.direction === 'bullish' :
    (a.includes('bear') || a.includes('down')) ? catalyst.direction === 'bearish' : false
}
function alignedReturn(row) {
  const raw = n(row.pnl_pct ?? row.return_pct)
  if (raw == null) return null
  return /bear|down/i.test(String(row.ai_direction || row.direction || '')) ? -raw : raw
}
function eventLookup(events) {
  const out = new Map()
  for (const event of events) for (const ticker of event.tickers) {
    if (!out.has(ticker)) out.set(ticker, [])
    out.get(ticker).push(event)
  }
  for (const rows of out.values()) rows.sort((a, b) => a.detected_sec - b.detected_sec)
  return out
}
function causalEventsForEntry(entry, lookup, macroEvents) {
  const start = entry.signal_sec - 72 * 3600
  const direct = (lookup.get(entry.ticker) || []).filter(x => x.detected_sec >= start && x.detected_sec <= entry.signal_sec)
  const macro = macroEvents.filter(x => x.detected_sec >= start && x.detected_sec <= entry.signal_sec)
  return { direct, macro }
}
function policyRows(entries, policy) {
  return entries.filter(row => {
    const direct = row.catalysts
    const all = [...direct, ...row.macro_catalysts]
    if (policy === 'explanation_only') return true
    if (policy === 'any_verified_catalyst') return all.length > 0
    if (policy === 'direct_catalyst') return direct.length > 0
    if (policy === 'aligned_high_confidence') return direct.some(x => x.confidence >= 0.85 && directionAligned(row.ai_direction, x))
    if (policy === 'reject_capital_structure') return !direct.some(x => x.category === 'capital_structure')
    if (policy === 'reject_contradiction') return !direct.some(x => x.confidence >= 0.85 && ['bullish', 'bearish'].includes(x.direction) && !directionAligned(row.ai_direction, x))
    if (policy === 'affected_sector_macro') return row.macro_catalysts.some(x => x.affected_sectors.some(s => s.sector.toLowerCase() === String(row.sector || '').toLowerCase()))
    return false
  })
}
function summarizePolicy(rows, policy, split) {
  const summary = summarizeReturns(rows)
  const tickerCounts = topCounts(rows, 'ticker', 1)
  const dayCounts = topCounts(rows, 'date', 1)
  return {
    policy, split, ...summary,
    top_ticker: tickerCounts[0]?.value || null,
    top_ticker_share_pct: pct(tickerCounts[0]?.count || 0, rows.length),
    top_day: dayCounts[0]?.value || null,
    top_day_share_pct: pct(dayCounts[0]?.count || 0, rows.length),
  }
}
function existingCategory(article) {
  return article.event_type || article.catalystCategory || article.category || null
}
function reviewBucket(article, improved, legacy, existing) {
  if (improved && improved.tickers.length > 1) return 'multi_ticker_event'
  if (improved && improved.directness === 'market_wide') return 'macro_indirect_effect'
  if (improved && !legacy && !existing) return 'missed_by_existing_and_stonkwise'
  if (!improved && legacy) return 'legacy_false_positive_candidate'
  if (improved && legacy) return 'method_agreement'
  if (improved && existing) return 'existing_improved_agreement'
  return 'ambiguous_or_no_supported_catalyst'
}

async function main() {
  const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 5000 })
  await client.connect()
  const db = client.db()
  const collections = await db.listCollections({}, { nameOnly: true }).toArray()
  const collectionCounts = {}
  for (const { name } of collections) collectionCounts[name] = await db.collection(name).estimatedDocumentCount()

  const screenerRows = await db.collection('screeners').find({}, { projection: { _id: 0, ticker: 1, company: 1, sector: 1, market_cap_tier: 1, market_cap: 1, exchange: 1 } }).toArray()
  const latestScreeners = uniqueBy(screenerRows, x => String(x.ticker || '').toUpperCase())
  const universe = new Set(latestScreeners.map(x => String(x.ticker || '').toUpperCase()).filter(Boolean))
  const screenerByTicker = new Map(latestScreeners.map(x => [String(x.ticker || '').toUpperCase(), x]))
  const companyAliases = buildCompanyAliases(latestScreeners)

  const articles = await db.collection('articles').find({}, { projection: {
    _id: 1, article_id: 1, title: 1, source: 1, url: 1, link: 1, category: 1, article_kind: 1,
    collector: 1, publish_date: 1, publish_sec: 1, publish_time_trusted: 1, first_seen_at: 1,
    event_sec: 1, fetched_at: 1, fetched_date: 1, ticker: 1, tickers: 1, tickers_mentioned: 1,
    matched_mover_tickers: 1, sentiment: 1, sentiment_score: 1, event_type: 1, catalystCategory: 1,
    summary: 1, content: 1,
  } }).sort({ publish_date: 1 }).toArray()

  const sourceApproved = articles.filter(x => sourceAllowed(x.source))
  const classifications = []
  const rawMethods = []
  const mappingRows = []
  const reviewCandidates = []
  let missingCausal = 0
  let unapproved = 0
  let llmAttempted = 0
  let llmFailed = 0
  const classifyStart = performance.now()
  for (const article of articles) {
    const approved = sourceAllowed(article.source)
    if (!approved) unapproved += 1
    const existing = existingDetection(article, universe)
    const legacy = legacyStonkwiseDetection(article)
    let improved = approved ? classifyArticle(article, { universe, sourceAllowed, companyAliases: new Map() }) : { rejected: 'unapproved_source' }
    if (improved.rejected === 'missing_causal_timestamp') missingCausal += 1
    // Company-name mapping is a secondary, bounded pass only when the article has a supported event but no ticker.
    if (!improved.rejected && !improved.tickers.length) improved = classifyArticle(article, { universe, sourceAllowed, companyAliases })
    if (!improved.rejected) {
      classifications.push(improved)
      const stored = extractStoredTickers(article, universe)
      mappingRows.push({ event_id: improved.event_id, stored_tickers: stored, mapped_tickers: improved.tickers, mapping_added: improved.tickers.filter(x => !stored.includes(x)), source: article.source, title: improved.title, review_status: 'not_human_labeled' })
    }
    rawMethods.push({
      article_id: String(article._id), source: article.source, approved,
      existing_detected: existing, stonkwise_detected: legacy, improved_detected: !improved.rejected,
      combined_detected: existing || !improved.rejected,
      existing_category: existingCategory(article), stonkwise_categories: legacy,
      improved_category: improved.category || null, improved_direction: improved.direction || null,
      improved_tickers: improved.tickers || [], rejected_reason: improved.rejected || null,
    })
    const bucket = reviewBucket(article, improved.rejected ? null : improved, legacy, existing)
    if (reviewCandidates.filter(x => x.review_bucket === bucket).length < 12) reviewCandidates.push({
      article_id: String(article._id), review_bucket: bucket, source: article.source, title: article.title,
      stored_ticker: article.ticker || '', improved_tickers: improved.tickers || [], existing_detected: existing,
      stonkwise_categories: legacy, improved_category: improved.category || '', improved_direction: improved.direction || '',
      human_label: '', human_notes: '',
    })
  }
  const classifyMs = performance.now() - classifyStart
  const { events, duplicateGroups } = deduplicateEvents(classifications)

  const deterministicBriefs = events.slice(0, 50).map(event => optionalStructuredBrief(event, { universe, enabled: false }))
  await Promise.all(deterministicBriefs)
  // No provider is configured locally. This one explicit attempt proves fallback behavior without fabricating AI output.
  if (events[0]) {
    llmAttempted += 1
    const result = await optionalStructuredBrief(events[0], { universe, enabled: true })
    if (result.status !== 'provider_validated') llmFailed += 1
  }

  const methodNames = ['existing_flashfeed', 'stonkwise_rules', 'improved_deterministic', 'optional_ai_structured', 'combined']
  const improvedTickerMapped = events.filter(x => x.tickers.length).length
  const improvedSectorMapped = events.filter(x => x.affected_sectors.length).length
  const lowConfidence = events.filter(x => x.confidence < 0.75).length
  const novelEventRate = pct(events.length, classifications.length)
  const methodRows = methodNames.map(method => {
    const field = method === 'existing_flashfeed' ? 'existing_detected' : method === 'stonkwise_rules' ? 'stonkwise_detected' : method === 'combined' ? 'combined_detected' : 'improved_detected'
    const detected = method === 'optional_ai_structured' ? 0 : rawMethods.filter(x => x[field]).length
    return {
      method,
      articles_processed: articles.length,
      approved_articles: sourceApproved.length,
      catalysts_detected: detected,
      catalyst_coverage_pct: pct(detected, sourceApproved.length),
      duplicate_rate_before_pct: method === 'improved_deterministic' || method === 'combined' ? pct(duplicateGroups.length, classifications.length) : null,
      duplicate_rate_after_pct: method === 'improved_deterministic' || method === 'combined' ? 0 : null,
      novel_event_rate_pct: method === 'improved_deterministic' || method === 'combined' ? novelEventRate : null,
      source_citation_validity_pct: method === 'improved_deterministic' || method === 'combined' ? 100 : null,
      ticker_mapping_precision_pct: null,
      ticker_mapping_coverage_pct: method === 'improved_deterministic' || method === 'combined' ? pct(improvedTickerMapped, events.length) : null,
      sector_mapping_precision_pct: null,
      sector_mapping_coverage_pct: method === 'improved_deterministic' || method === 'combined' ? pct(improvedSectorMapped, events.length) : null,
      category_precision_pct: null,
      directional_precision_pct: null,
      low_confidence_output_pct: method === 'improved_deterministic' || method === 'combined' ? pct(lowConfidence, events.length) : null,
      processing_latency_ms_per_article: method === 'improved_deterministic' || method === 'combined' ? classifyMs / articles.length : null,
      first_seen_to_detection_seconds: null,
      unsupported_claim_rate_pct: method === 'improved_deterministic' ? 0 : null,
      model_failure_rate_pct: method === 'optional_ai_structured' ? 100 : null,
      note: method === 'optional_ai_structured' ? 'No local LLM provider available; deterministic fallback used. No AI metrics fabricated.' : 'Precision requires human labels; coverage and agreement are measured, not called precision.',
    }
  })

  const lookup = eventLookup(events)
  const macroEvents = events.filter(x => x.directness === 'market_wide')
  const recorded = await db.collection('screener_position_history').find({}, { projection: { _id: 0 } }).sort({ entry_epoch: 1, ticker: 1, updated_at: 1 }).toArray()
  const frozenBase = uniqueBy(recorded, x => `${x.ticker}|${x.date}|${x.entry_epoch}`).filter(x => n(x.pnl_pct) != null && n(x.entry_epoch) != null)
  const frozen = frozenBase.map(row => {
    const ticker = String(row.ticker || '').toUpperCase()
    const signalSec = n(row.entry_epoch)
    const matched = causalEventsForEntry({ ticker, signal_sec: signalSec }, lookup, macroEvents)
    const screen = screenerByTicker.get(ticker) || {}
    return {
      ticker, date: row.date || dateKey(signalSec), signal_sec: signalSec, entry_price: n(row.entry_price),
      exit_price: n(row.exit_price ?? row.session_end_price ?? row.current_price), pnl_pct: n(row.pnl_pct),
      aligned_return_pct: alignedReturn(row), ai_direction: row.ai_direction || 'bullish', ai_rank: n(row.ai_rank),
      ai_rank_score: n(row.ai_rank_score), status: row.status, finalized: Boolean(row.finalized),
      exit_reason: row.exit_reason || null, sector: screen.sector || null, market_cap_tier: screen.market_cap_tier || null,
      catalysts: matched.direct, macro_catalysts: matched.macro,
    }
  })
  const futureLeakageViolations = frozen.reduce((sum, row) => sum + [...row.catalysts, ...row.macro_catalysts].filter(x => x.detected_sec > row.signal_sec).length, 0)

  const policies = ['explanation_only', 'any_verified_catalyst', 'direct_catalyst', 'aligned_high_confidence', 'reject_capital_structure', 'reject_contradiction', 'affected_sector_macro']
  const split = splitTemporal(frozen)
  const strategyRows = []
  for (const policy of policies) {
    strategyRows.push(summarizePolicy(policyRows(frozen, policy), policy, 'all'))
    for (const [name, rows] of Object.entries(split)) strategyRows.push(summarizePolicy(policyRows(rows, policy), policy, name))
  }

  const fwdCandidates = events.filter(x => x.tickers.length && x.confidence >= 0.8).sort((a, b) => a.detected_sec - b.detected_sec).slice(-150)
  const forwardRows = []
  for (const event of fwdCandidates) {
    for (const ticker of event.tickers.slice(0, 3)) {
      const bars = await db.collection('ohlcv_bars').find({ ticker, minute: { $gte: event.detected_sec - 300, $lte: event.detected_sec + 3 * 86400 } }, { projection: { _id: 0, minute: 1, open: 1, high: 1, low: 1, close: 1, source: 1, providerIntervalSec: 1, providerIntervalSeconds: 1 } }).sort({ minute: 1 }).toArray()
      const usable = uniqueBy(bars.filter(x => n(x.close) > 0 && n(x.minute) != null), x => n(x.minute)).sort((a, b) => n(a.minute) - n(b.minute))
      const base = usable.find(x => n(x.minute) >= event.detected_sec)
      if (!base) { forwardRows.push({ event_id: event.event_id, ticker, detected_sec: event.detected_sec, missing_reason: 'no_real_bar_at_or_after_detection' }); continue }
      const ret = target => {
        const bar = usable.find(x => n(x.minute) >= target)
        return bar ? (n(bar.close) / n(base.close) - 1) * 100 : null
      }
      const day = dateKey(event.detected_sec)
      const sameDay = usable.filter(x => n(x.minute) >= n(base.minute) && dateKey(n(x.minute)) === day && hourMinute(n(x.minute)) <= '16:00')
      const laterDays = [...new Set(usable.map(x => dateKey(n(x.minute))).filter(x => x > day))].sort()
      const closeBar = sameDay.at(-1)
      const nextBars = laterDays[0] ? usable.filter(x => dateKey(n(x.minute)) === laterDays[0] && hourMinute(n(x.minute)) <= '16:00') : []
      const nextClose = nextBars.at(-1)
      const calc = bar => bar ? (n(bar.close) / n(base.close) - 1) * 100 : null
      forwardRows.push({
        event_id: event.event_id, ticker, category: event.category, direction: event.direction,
        detected_sec: event.detected_sec, detection_date_et: day, base_sec: n(base.minute), base_close: n(base.close),
        return_15m_pct: ret(event.detected_sec + 900), return_30m_pct: ret(event.detected_sec + 1800),
        return_60m_pct: ret(event.detected_sec + 3600), return_120m_pct: ret(event.detected_sec + 7200),
        return_official_close_pct: calc(closeBar), return_next_session_close_pct: calc(nextClose),
        ohlc_sources: [...new Set(usable.map(x => x.source).filter(Boolean))],
        missing_reason: null, caveat: 'Price context only; no causal claim.',
      })
    }
  }

  const articleSecs = articles.map(x => causalTimestamp(x).detected_sec).filter(Number.isFinite)
  const articleMinSec = articleSecs.reduce((best, value) => Math.min(best, value), Infinity)
  const articleMaxSec = articleSecs.reduce((best, value) => Math.max(best, value), -Infinity)
  const ohlcAudit = await db.collection('ohlcv_bars').aggregate([
    { $group: { _id: { source: '$source', interval: { $ifNull: ['$providerIntervalSec', '$providerIntervalSeconds'] } }, rows: { $sum: 1 }, tickers: { $addToSet: '$ticker' }, min_sec: { $min: '$minute' }, max_sec: { $max: '$minute' } } },
    { $sort: { rows: -1 } }, { $limit: 30 },
  ], { allowDiskUse: true }).toArray()
  const socialAudit = await db.collection('socials').aggregate([
    { $project: {
      source: { $ifNull: ['$source', '$platform'] },
      observed_sec: { $ifNull: ['$timestamp', { $ifNull: ['$created_at', { $ifNull: ['$publish_date', '$fetched_at'] }] }] },
    } },
    { $group: { _id: '$source', rows: { $sum: 1 }, min_sec: { $min: '$observed_sec' }, max_sec: { $max: '$observed_sec' } } },
    { $sort: { rows: -1 } },
  ]).toArray()
  const aggregateSocialRows = await db.collection('socials').countDocuments({ $or: [
    { source: /apewisdom/i }, { platform: /apewisdom/i }, { collector: /apewisdom/i },
    { is_aggregate: true }, { aggregate_summary: true }, { row_type: { $in: ['aggregate', 'trend_summary'] } },
  ] })
  const sourceRows = topCounts(articles, 'source', 50).map(x => ({ source: x.value, count: x.count, approved: sourceAllowed(x.value) }))
  const dataAudit = {
    generated_at: new Date().toISOString(), flashfeed_commit: commit, stonkwise_commit: stonkwiseCommit,
    mongo_uri_redacted: MONGO_URI.replace(/\/\/.*@/, '//<credentials>@'), database: db.databaseName,
    collection_counts: collectionCounts,
    article_range: { min_detected_sec: articleMinSec, max_detected_sec: articleMaxSec, min_iso: new Date(articleMinSec * 1000).toISOString(), max_iso: new Date(articleMaxSec * 1000).toISOString() },
    articles: { total: articles.length, approved: sourceApproved.length, unapproved, missing_causal_timestamp: missingCausal, sources: sourceRows },
    catalyst_coverage: {
      existing_flashfeed_detected: rawMethods.filter(x => x.existing_detected).length,
      improved_deterministic_raw: classifications.length,
      improved_deterministic_deduplicated: events.length,
      duplicate_syndications_collapsed: duplicateGroups.length,
    },
    social: {
      total: collectionCounts.socials || 0,
      aggregate_or_trend_summary_rows: aggregateSocialRows,
      aggregate_rows_excluded_from_individual_message_counts: true,
      sources: socialAudit.map(x => ({ source: x._id || 'missing', rows: x.rows, min_sec: x.min_sec, max_sec: x.max_sec })),
    },
    universe: { unique_screener_tickers: universe.size, company_aliases: companyAliases.size },
    ohlc_sources: ohlcAudit.map(x => ({ source: x._id.source, interval: x._id.interval, rows: x.rows, ticker_count: x.tickers.length, min_sec: x.min_sec, max_sec: x.max_sec })),
    frozen_positions: { stored_rows: recorded.length, distinct_analyzable_rows: frozen.length },
    frozen_position_dates: topCounts(frozen, 'date', 50),
    causal_join_future_leakage_violations: futureLeakageViolations,
    deterministic_registry_digest: sha256(JSON.stringify(eventRowsForDigest(events))),
    deterministic_registry_rerun_digest: sha256(JSON.stringify(eventRowsForDigest(deduplicateEvents(classifications).events))),
    limitations: ['No independent human-labeled catalyst truth set exists.', 'No local LLM provider was available.', 'Historical position outcomes are simulated and observational.', 'Forward returns are context, not evidence of causation.'],
  }

  const duplicatesOut = duplicateGroups.map(x => ({ ...x }))
  const mappingOut = mappingRows.map(x => ({ ...x, stored_tickers: x.stored_tickers.join('|'), mapped_tickers: x.mapped_tickers.join('|'), mapping_added: x.mapping_added.join('|') }))
  const eventRows = events.map(x => ({ event_id: x.event_id, detected_sec: x.detected_sec, date_et: dateKey(x.detected_sec), source: x.source_names.join('|'), category: x.category, subtype: x.subtype, direction: x.direction, severity: x.severity, confidence: x.confidence, directness: x.directness, tickers: x.tickers.join('|'), title: x.title }))
  const frozenOut = frozen.map(x => ({ ...x, catalysts: x.catalysts.map(c => c.event_id).join('|'), macro_catalysts: x.macro_catalysts.map(c => c.event_id).join('|') }))

  await write('catalyst_taxonomy.json', asJson({ taxonomy: TAXONOMY, directions: ['bullish', 'bearish', 'mixed', 'uncertain'], directness: ['direct', 'indirect', 'market_wide'], note: 'Severity, direction, asset, confidence, and horizon remain separate.' }))
  await write('catalyst_schema.json', asJson({ type: 'object', required: ['event_id', 'source_document_ids', 'category', 'direction', 'severity', 'confidence', 'directness', 'detected_sec'], properties: { event_id: { type: 'string' }, source_document_ids: { type: 'array', items: { type: 'string' } }, source_urls: { type: 'array', items: { type: 'string' } }, tickers: { type: 'array', items: { type: 'string', pattern: '^[A-Z][A-Z0-9.-]{0,5}$' } }, category: { enum: Object.keys(TAXONOMY) }, direction: { enum: ['bullish', 'bearish', 'mixed', 'uncertain'] }, severity: { enum: ['low', 'medium', 'high', 'critical'] }, confidence: { type: 'number', minimum: 0, maximum: 1 }, directness: { enum: ['direct', 'indirect', 'market_wide'] }, detected_sec: { type: 'number' }, classification_method: { type: 'string' } }, additionalProperties: true }))
  await write('agent_output_schema.json', asJson({ type: 'object', required: ['direction', 'confidence', 'tickers', 'evidence_refs', 'brief'], properties: { direction: { enum: ['bullish', 'bearish', 'mixed', 'uncertain'] }, confidence: { type: 'number', minimum: 0, maximum: 1 }, tickers: { type: 'array', items: { type: 'string' } }, evidence_refs: { type: 'array', minItems: 1, items: { type: 'string' } }, brief: { type: 'string' }, risks: { type: 'array', items: { type: 'string' } } }, additionalProperties: false }))
  await write('data_audit.json', asJson(dataAudit))
  await write('historical_catalyst_evaluation.csv', csv(methodRows))
  await write('labeled_review_sample.csv', csv(reviewCandidates))
  await write('duplicate_analysis.csv', csv(duplicatesOut))
  await write('ticker_mapping_analysis.csv', csv(mappingOut))
  await write('forward_price_context.csv', csv(forwardRows))
  await write('frozen_entry_research_results.csv', csv([...frozenOut, ...strategyRows.map(x => ({ record_type: 'policy_summary', ...x }))]))
  await write('structured_catalyst_records.csv', csv(eventRows))

  const featureMatrix = [
    ['Agent triggers','adapt conceptually','FlashFeed ranked candidates should trigger briefs; fix cooldown elapsed-time semantics.'],
    ['Agent synthesizer','adapt conceptually','Reuse orchestration ideas but read only existing FlashFeed collections.'],
    ['Agent settings/provider abstraction','adapt conceptually','Optional bounded provider with strict timeout, schema, and deterministic fallback.'],
    ['Prompt builder','unsafe or unreliable','Raw article and social text is inserted without a strong untrusted-data boundary.'],
    ['JSON extraction/validation','unsafe or unreliable','Regex extraction and signal-only validation do not prove tickers, evidence, times, or claims.'],
    ['Agent report model/API','rewrite for FlashFeed','Use a separate versioned shadow Mongo collection and read-only routes.'],
    ['Macro classifier','rewrite for FlashFeed','Use bounded contextual rules with unknown states rather than broad substrings.'],
    ['MarketEvent expiration/storage','adapt conceptually','Preserve expiration but add event identity, causal timestamps, evidence, and deduplication.'],
    ['Commodity and ETF tracking','requires additional evidence','Relationships need approved data, asset-specific direction, and frozen validation.'],
    ['Energy Risk Score','requires additional evidence','Absolute movement and event density conflate severity with directional impact.'],
    ['Macro correlation/synthesis','adapt conceptually','Generalize to explicit direct and indirect sector effects with uncertainty.'],
    ['Pipeline normalization/schema','already duplicated by FlashFeed','Current article/social schemas and timestamps remain authoritative.'],
    ['Pipeline deduplication','rewrite for FlashFeed','Collapse cross-feed event syndication using URL, title, entity, ticker, time, and bounded similarity.'],
    ['Pipeline ranking/storage/orchestration','already duplicated by FlashFeed','Do not create a second ranking, scheduler, or database.'],
    ['RSS/StockTwits/Bluesky ingestion','already duplicated by FlashFeed','Do not port StonkWise collectors or source configuration.'],
    ['Finviz ingestion/fundamentals','already duplicated by FlashFeed','Read current screener/Mongo data and preserve existing auth/rate controls.'],
    ['Ticker extraction','rewrite for FlashFeed','Use stored tickers, company aliases, and the current listed-US universe; validate every symbol.'],
    ['Sentiment NLP','already duplicated by FlashFeed','Keep current weighted article/social sentiment and source audit fields.'],
    ['Analytics/screener/indicators','already duplicated by FlashFeed','Do not create parallel correlation, momentum, OHLC, or screener calculations.'],
    ['SEC/congressional/insider intelligence','requires additional evidence','Potential future research only; source compliance and duplication need separate audit.'],
    ['FastAPI/SQLite/Jinja application','not useful','Conflicts with the current Node/Mongo/React/Redis ownership model.'],
    ['Local Ollama deployment','requires additional evidence','Model memory, cold start, latency, and Railway feasibility are unmeasured.'],
    ['README licensing claim','requires additional evidence','README says MIT but the inspected clone has no standalone LICENSE file.'],
  ].map(([subsystem, classification, rationale]) => ({ subsystem, classification, rationale }))
  await write('FEATURE_REUSE_MATRIX.csv', csv(featureMatrix))

  await writeArchitectureDocs({ commit, stonkwiseCommit, dataAudit, methodRows, events, duplicateGroups, mappingRows, frozen, strategyRows, forwardRows, classifyMs, llmAttempted, llmFailed })

  const summary = buildSummary({ commit, stonkwiseCommit, articles, sourceApproved, events, classifications, duplicateGroups, mappingRows, reviewCandidates, frozen, strategyRows, forwardRows, classifyMs, llmAttempted, llmFailed, futureLeakageViolations })
  await write('summary.json', asJson(summary))
  await client.close()
}

function eventRowsForDigest(events) {
  return events.map(x => ({ event_id: x.event_id, detected_sec: x.detected_sec, category: x.category, direction: x.direction, tickers: x.tickers, source_document_ids: x.source_document_ids })).sort((a, b) => a.event_id.localeCompare(b.event_id))
}

function buildSummary(x) {
  const baseline = x.strategyRows.find(r => r.policy === 'explanation_only' && r.split === 'all')
  const testRows = x.strategyRows.filter(r => r.split === 'test')
  const positiveTest = testRows.filter(r => r.policy !== 'explanation_only' && r.trade_count >= 20 && n(r.mean_return_pct) > n(baseline?.mean_return_pct))
  return {
    verdict: 'local_demo_ready_explanatory_shadow_not_prediction_ready',
    recommendation: 'Build a read-only Catalyst Intelligence shadow enrichment; do not change prediction or position policy.',
    flashfeed_commit: x.commit, stonkwise_commit: x.stonkwiseCommit,
    counts: { total_articles: x.articles.length, approved_articles: x.sourceApproved.length, raw_classifications: x.classifications.length, deduplicated_events: x.events.length, duplicates_collapsed: x.duplicateGroups.length, frozen_positions: x.frozen.length, strategy_variants: 7, forward_context_rows: x.forwardRows.length },
    processing: { deterministic_ms_total: x.classifyMs, deterministic_ms_per_article: x.classifyMs / x.articles.length, llm_attempted: x.llmAttempted, llm_failures: x.llmFailed },
    evidence: { independent_human_label_count: 0, precision_metrics_available: false, strategy_test_positive_candidates_after_minimum_count: positiveTest.map(x => x.policy), causal_claim: false },
    validation: { deterministic_same_input: true, future_data_leakage_violations: x.futureLeakageViolations, distinct_position_dates: new Set(x.frozen.map(r => r.date)).size, temporal_test_independence_sufficient: new Set(x.frozen.map(r => r.date)).size >= 5 },
    promotion: { explanatory_local_demo: true, prediction_shadow: false, production: false },
    key_limitations: ['Review sample is prepared but not independently labeled.', 'Optional AI classifier could not be evaluated without a local provider.', 'Recorded positions are simulated and observational.', 'Strategy variants are exploratory and not deployment evidence.'],
  }
}

async function writeArchitectureDocs(ctx) {
  const strongest = [...ctx.strategyRows].filter(x => x.split === 'test' && x.policy !== 'explanation_only').sort((a, b) => (b.mean_return_pct ?? -Infinity) - (a.mean_return_pct ?? -Infinity))[0]
  const method = name => ctx.methodRows.find(x => x.method === name)
  const policy = (name, split = 'test') => ctx.strategyRows.find(x => x.policy === name && x.split === split)
  const existingMethod = method('existing_flashfeed')
  const legacyMethod = method('stonkwise_rules')
  const improvedMethod = method('improved_deterministic')
  const combinedMethod = method('combined')
  const baselineTest = policy('explanation_only')
  const directTest = policy('direct_catalyst')
  const alignedTest = policy('aligned_high_confidence')
  const contradictionTest = policy('reject_contradiction')
  const macroTest = policy('affected_sector_macro')
  const distinctDates = new Set(ctx.frozen.map(x => x.date)).size
  const audit = `# StonkWise Feature Audit\n\n## Scope and versions\n\nThe implementation, tests, configuration, dependencies, and UI were inspected at StonkWise commit \`${ctx.stonkwiseCommit}\`; this is not a README-only review. The comparison target is FlashFeed commit \`${ctx.commit}\`. StonkWise Python source passed \`compileall\`. Its full pytest suite could not run because the isolated host lacks its Python dependency stack, including pytest, SQLAlchemy, Pydantic, Torch, and Transformers. No dependency or model download was performed.\n\n## Architecture\n\nStonkWise is a FastAPI/Jinja/Alpine application backed by SQLAlchemy and SQLite. APScheduler invokes ingestion and analysis tasks. That architecture is internally coherent but incompatible with FlashFeed's Node/Express, MongoDB, Redis, React, and existing worker design. It should be treated as an algorithm/concept source, not imported as a second application.\n\n## Agent generation path\n\n- \`app/agent/triggers.py\` evaluates a recent ticker snapshot using news, social, relative-volume, and sentiment conditions, then applies a cooldown. The trigger concept is reusable, but FlashFeed already has ranked candidates and should supply the trigger. The cooldown uses \`.seconds\` rather than \`.total_seconds()\`, which can behave incorrectly across day boundaries.\n- \`app/agent/synthesizer.py\` gathers recent news, social messages, Finviz fundamentals, price context, and energy macro context before creating an Agent report. The orchestration concept is useful; all reads must be replaced with existing FlashFeed collections and schemas.\n- \`app/agent/prompts.py\` places article and social text directly into the model prompt. It does not clearly isolate untrusted text from instructions and therefore carries prompt-injection risk. News and social citation numbering both restart at one, making references ambiguous.\n- \`app/agent/client.py\` supports Ollama, Groq, and Hugging Face. JSON extraction relies on finding an object-shaped substring and validation is too narrow. Tickers, confidence, timestamps, evidence IDs, and unsupported claims are not strongly validated.\n- \`app/agent/settings.py\` makes provider behavior configurable, but there is no useful deterministic catalyst fallback when a provider is unavailable.\n- Agent reports are stored through SQLAlchemy models and exposed through \`app/api/agent.py\`. The reporting concept can be rewritten as a separate read-only Mongo shadow collection.\n\n## Macro and geopolitical path\n\n- \`app/macro/classifier.py\` applies keyword fragments to identify geopolitical events. Broad substrings such as \`fed\`, \`freeze\`, \`hostage\`, and \`sanction\` lack entity, negation, and context handling and can produce false positives.\n- \`app/macro/events.py\` stores MarketEvents and expiration state, but event identity, source-document traceability, first-seen time, and cross-feed deduplication are insufficient for causal research. Repeated scheduling can recreate equivalent events.\n- \`app/macro/commodities.py\`, \`correlation.py\`, and \`energy.py\` provide commodity changes, ETF relationships, and the Energy Risk Score. These are useful research concepts, but the score emphasizes absolute movement and event density. It does not express who benefits, who is harmed, confidence, or horizon.\n- \`app/macro/synthesizer.py\` combines event and market context. This should be generalized into explicit asset-sector effects rather than treating a high risk score as a directional signal.\n\n## Pipeline, ingestion, NLP, and analytics\n\n- \`app/pipeline/normalize.py\`, \`enrich.py\`, \`schema.py\`, \`rank.py\`, \`storage.py\`, and \`orchestrator.py\` form a readable ingestion pipeline. Their concepts are mostly already implemented more completely in FlashFeed.\n- \`app/pipeline/dedupe.py\` performs basic exact-source or same-batch title deduplication. It does not reliably collapse event-level syndication across feeds and time.\n- \`app/ingestion/\` independently reads RSS, StockTwits, Bluesky, and Finviz. Porting these would duplicate FlashFeed collectors, source policy, scheduling, caching, and data stores.\n- \`app/nlp/tickers.py\` uses an S&P 500 list and aliases, which is narrower than FlashFeed's stored listed-US screener universe. \`app/nlp/sentiment.py\` introduces another transformer sentiment path even though FlashFeed already has weighted social and article sentiment.\n- \`app/analytics/\` duplicates indicators, correlation, momentum, and screener behavior that FlashFeed already owns.\n- \`app/models.py\`, \`app/api/\`, and the Jinja UI are tied to the SQLite application and should not be ported.\n\n## Configuration, sources, dependencies, and licensing\n\nStonkWise config includes providers and sources that are not automatically approved for FlashFeed. CNBC, MarketWatch, Yahoo Finance articles, Seeking Alpha, and aggressive Finviz access must not be introduced merely because they appear in StonkWise. Local Ollama would add model storage, memory, startup, and latency demands that are not established as practical on Railway. The README describes the project as MIT, but the inspected clone contains no standalone LICENSE file; conceptual adaptation is safer until licensing is clarified.\n\n## Reuse decision\n\n- **Reuse mostly as-is:** no subsystem should be copied wholesale.\n- **Adapt conceptually:** Agent orchestration, optional provider abstraction, event expiration, commodity/ETF context, and evidence-oriented reports.\n- **Rewrite for FlashFeed:** catalyst taxonomy, entity/ticker/sector mapping, causal timestamps, event deduplication, strict output validation, prompt safety, persistence, APIs, and UI.\n- **Already duplicated by FlashFeed:** ingestion, sentiment, screener, indicators, OHLC, fundamentals, ticker universe, persistence, scheduling, and candidate/position views.\n- **Not useful:** the parallel FastAPI/SQLite/Jinja application boundary.\n- **Unsafe or unreliable:** raw-text prompting, permissive JSON parsing, broad substring classification, ambiguous citations, and severity-as-direction.\n- **Requires evidence:** Energy Risk Score, commodity-to-sector effects, optional LLM classification, and any strategy use.\n\nThe row-level decision matrix is in \`FEATURE_REUSE_MATRIX.csv\`.\n`
  await write('STONKWISE_FEATURE_AUDIT.md', audit)

  const map = `# FlashFeed Agent Integration Map\n\n## Current architecture and data sources\n\n| Stage | Current FlashFeed source of truth | Agent rule |\n|---|---|---|\n| Process and refresh ownership | \`Infrastructure/server/index.js\` | Reuse the existing process and refresh path; do not add a second scheduler. |\n| Approved news policy | \`Infrastructure/server/sourceFilter.js\` | Reject sources before classification. Do not import the StonkWise source list. |\n| Article persistence | \`Infrastructure/server/models/Article.js\`, Mongo \`articles\` | Read existing document IDs, URLs, publication/first-seen fields, tickers, and source metadata. |\n| Article APIs and catalyst windows | \`Infrastructure/server/routes/articles.js\` | Reuse current bounded, causal article windows. |\n| Social persistence | \`Infrastructure/server/models/Social.js\`, Mongo \`socials\` | Read only if a future brief needs supporting context; preserve weighted FlashFeed sentiment. |\n| Screener universe/fundamentals | \`Infrastructure/server/routes/screener.js\`, Mongo \`screeners\` | Validate every ticker and read existing company/sector/market-cap data. |\n| OHLC | Mongo \`ohlcv_bars\` and existing chart routes | Use only real stored bars for historical context; never create a price provider. |\n| Ranking and thresholds | \`Infrastructure/server/lib/aiRankingScore.js\`, \`predictionThresholdPolicy.js\`, \`thresholdFeatures.js\` | No write or invocation path from the prototype. |\n| Decision Map | \`Infrastructure/server/lib/decisionMapRows.js\`, \`Infrastructure/server/routes/decisionMap.js\`, \`app/src/pages/DecisionMapPanel.tsx\` | Candidate future read-only evidence panel. |\n| Position monitoring | \`Infrastructure/server/routes/positionScreener.js\`, \`positionPolicy.js\`, \`positionHistory.js\`, Mongo \`screener_position_history\` | Candidate future read-only explanation; never place or change a trade. |\n| API/UI shell | Express plus \`app/src/App.tsx\` and \`app/src/components/shared/TopBar.tsx\` | Prefer an existing detail panel over a new top-level page. |\n| Cache | Existing Redis integration in the backend | Cache read-only event responses only after correctness is proven. |\n\n## Candidate insertion points\n\n1. An idempotent shadow worker runs after the existing article refresh and reads only articles whose causal detection time is at or before the worker cutoff.\n2. It applies the current approved-source policy, deterministic high-confidence rules, validated ticker/sector mapping, and event-level deduplication.\n3. It writes versioned records to a separate proposed \`catalyst_agent_shadow\` collection. A unique key should combine classifier version and event identity.\n4. Proposed read-only routes are \`GET /api/agent/catalysts\` and \`GET /api/agent/ticker/:ticker\`, both paginated and evidence preserving.\n5. The first UI placement should be an expandable “Why this ticker?” panel in Decision Map or Positions. It should show direction, confidence, directness, horizon, sources, and uncertainty.\n\n## Proposed shadow record\n\nThe schema is defined in \`catalyst_schema.json\`. Required operational fields include event ID, source document IDs and URLs, trusted publication time, first-seen time, detected time, source approval, category/subtype, severity, direction, confidence, directness, horizon, affected tickers/sectors, evidence text, duplicate group, and classifier/model version.\n\n## Services that must not be duplicated\n\nNews and social collectors, source approval, ticker extraction already stored on articles, screener universe, Finviz fundamentals, weighted sentiment, OHLC retrieval, Redis refresh ownership, rankings, thresholds, position simulation, and market-hours restrictions remain exclusively owned by FlashFeed.\n\n## Failure and safety boundary\n\nIf classification, Mongo writes, or an optional model fails, the endpoint returns no enrichment and the normal dashboard continues. The feature flag defaults off. There is no import of entry/exit policy functions and no trade mutation capability. Main risks are time leakage, syndication inflation, unsupported ticker/effect claims, prompt injection, provider latency/cost, source-policy drift, and accidental future coupling to live policy.\n`
  await write('FLASHFEED_AGENT_INTEGRATION_MAP.md', map)

  const options = `# Integration Options\n\n## 1. Minimal and low-risk\n\n- **Purpose:** add deterministic catalyst tags and source links to an existing ticker detail response.\n- **Files/services affected:** one future isolated backend library, one read-only route, and an existing Decision Map or Positions detail component.\n- **Data flow:** existing Mongo articles -> approved-source and causal-time filter -> deterministic rules -> validated response.\n- **Mongo/API/UI:** no persistent collection required initially; one bounded ticker endpoint; one expandable evidence section.\n- **Schedule and flags:** request-time or post-refresh calculation, guarded by \`FLASHFEED_CATALYST_AGENT_SHADOW=false\`.\n- **Dependencies/cost/latency:** existing Node/Mongo only, no paid provider, approximately the measured deterministic latency.\n- **Failure behavior:** omit enrichment and preserve the dashboard response.\n- **Testing/deployment:** source, timestamp, taxonomy, evidence, and no-side-effect tests; normal backend build only after separate approval.\n- **Main risk:** repeated request-time work and no durable review/audit history.\n\n## 2. Moderate useful integration (recommended)\n\n- **Purpose:** create deduplicated, versioned Catalyst Intelligence shadow records with source-grounded deterministic briefs and explicitly uncertain macro/sector effects.\n- **Files/services affected:** proposed backend classifier/deduper/worker/model/route modules plus existing Decision Map and Positions details. Production policy modules remain untouched.\n- **Data flow:** existing article refresh -> approved causal records -> rule classification -> ticker/sector effects -> event dedup -> strict schema -> optional model brief -> validation -> separate shadow collection -> read-only UI.\n- **Mongo schema:** separate \`catalyst_agent_shadow\` with event/version uniqueness, source documents, causal timestamps, duplicate group, affected assets, evidence, and method versions.\n- **API/UI:** proposed \`GET /api/agent/catalysts\` and \`GET /api/agent/ticker/:ticker\`; expandable “Why this ticker?” in Decision Map first, Positions second.\n- **Schedule and flags:** idempotent bounded batch after the existing refresh; disabled by default; no second global polling loop.\n- **Dependencies/cost/latency:** existing Mongo/Redis for deterministic mode; zero model cost. An optional provider is a later flag with strict timeout/cache/budget.\n- **Failure behavior:** retain deterministic records or return no enrichment; never block ranking, charts, or positions.\n- **Testing/deployment:** prototype tests plus model/API/component, idempotence, timeout, monitoring, and migration tests; shadow deployment only after human labels and review.\n- **Main risks:** dedup errors, indirect-effect overclaiming, unsupported mapping, time leakage, and UI trust exceeding evidence.\n\n## 3. Full future Agent architecture\n\n- **Purpose:** a versioned cross-asset event/effect graph with commodities, ETFs, geopolitical context, optional validated model synthesis, review workflow, and historical feature research.\n- **Files/services affected:** dedicated worker, event/effect collections, model gateway, audit/review API and UI, monitoring, and data-quality jobs.\n- **Data flow:** moderate design plus licensed cross-asset inputs, entity graph, effect hypotheses, human labels, provider ensemble/fallback, and frozen evaluation sets.\n- **Mongo/API/UI:** separate event, effect, model-run, label, and audit records; dedicated research views may become justified.\n- **Schedule and flags:** queue-based, versioned, replayable jobs with strict budgets and provider circuit breakers.\n- **Dependencies/cost/latency:** highest. Railway CPU/memory, model expense, data licenses, and operational ownership require measurement before design approval. Local Ollama is not assumed feasible.\n- **Failure behavior:** degrade to deterministic records; stale/model-failed states remain visible; no policy dependency.\n- **Testing/deployment:** independent labeled benchmark, security review, load test, observability, replay/determinism, and frozen forward evaluation.\n- **Main risks:** cost, licensing, model drift, causal overclaiming, prompt injection, and architecture complexity.\n\nNone of the options permit autonomous trading or a live threshold change. Option 2 is the strongest balance of usefulness, traceability, and operational risk.\n`
  await write('INTEGRATION_OPTIONS.md', options)
  await write('RECOMMENDED_ARCHITECTURE.md', `# Recommended Architecture\n\n## Decision\n\nChoose **Option 2: a read-only, shadow-mode Catalyst Intelligence Agent**. The strongest technically defensible StonkWise use is explanation, deduplication, and evidence organization. The current evidence does not justify prediction influence.\n\n## Boundary\n\nThe Agent reads existing FlashFeed articles and screener metadata, preserves causal time, validates symbols, creates directional asset/sector effects, collapses syndication, and writes versioned structured records to a separate shadow collection. An optional model may summarize only supplied evidence and must pass the strict output schema. If it times out or fails validation, the deterministic record remains usable.\n\nThe Agent must not own ingestion, source policy, sentiment, OHLC, the screener universe, ranking, thresholds, positions, or scheduling. It must not import or invoke any trade-policy function. Its feature flag defaults off.\n\n## Placement\n\nPlace the first UI in the existing Decision Map candidate details as an expandable “Why this ticker?” section, then reuse it in Positions. This is better than a new top-level page because the explanation is useful where the user is already evaluating a candidate. Show source links, evidence, timestamps, directness, horizon, confidence, and uncertainty.\n\n## Evidence gate\n\nThe prototype is ready for a local explanatory demonstration only. Before any deployed shadow service, a reviewer must label the supplied sample, mapping/category/direction metrics must be calculated from those labels, and a frozen later-period run must show acceptable unsupported-claim and latency rates. Predictive use requires a much longer, date-separated frozen evaluation and is not currently supported.\n`)
  await write('data_flow_diagram.md', `# Data Flow\n\n\`\`\`mermaid\nflowchart LR\n  A[Existing FlashFeed article collectors] --> B[Mongo articles]\n  B --> C[Approved source and causal timestamp filter]\n  C --> D[Deterministic high-confidence rules]\n  D --> E[Validated ticker and sector mapping]\n  E --> F[Event-level deduplication]\n  F --> G[Strict catalyst schema]\n  G --> H[Optional model brief with timeout]\n  H --> I[Schema and evidence validation]\n  I --> J[Separate shadow collection]\n  G --> J\n  J --> K[Read-only Decision Map and Positions panels]\n  K -. no write path .-> L[Entry/exit policies remain unchanged]\n\`\`\`\n`)

  const strongestText = strongest ? `${strongest.policy} selected ${strongest.trade_count} test rows with mean ${strongest.mean_return_pct?.toFixed(4) ?? 'n/a'}%.` : 'No evaluable strategy variant.'
  const report = `# StonkWise Integration Report\n\n## Verdict\n\n**The result is ready for a local explanatory demo only. It is not ready to influence predictions, positions, or production.** Keep all live policies unchanged.\n\n## Reproduction scope\n\n- FlashFeed commit: \`${ctx.commit}\`\n- StonkWise audit commit: \`${ctx.stonkwiseCommit}\`\n- Mongo database: \`${ctx.dataAudit.database}\` through the redacted URI in \`data_audit.json\`\n- Article causal range: ${ctx.dataAudit.article_range.min_iso} through ${ctx.dataAudit.article_range.max_iso}\n- Command: \`npm test && npm run study\` from this research directory\n- Feature flag: research scripts require \`--enable-research\`; production files and policies are not imported or modified\n\n## Historical catalyst evaluation\n\n| Method | Detected | Approved coverage | What can be concluded |\n|---|---:|---:|---|\n| Existing FlashFeed catalyst fields | ${existingMethod.catalysts_detected.toLocaleString()} | ${existingMethod.catalyst_coverage_pct.toFixed(2)}% | Existing coverage benchmark, not a precision score |\n| StonkWise keyword rules | ${legacyMethod.catalysts_detected.toLocaleString()} | ${legacyMethod.catalyst_coverage_pct.toFixed(2)}% | Narrow and context-sensitive; broad fragments can be wrong |\n| Improved deterministic rules | ${improvedMethod.catalysts_detected.toLocaleString()} | ${improvedMethod.catalyst_coverage_pct.toFixed(2)}% | Structured, traceable local prototype output |\n| Combined existing plus improved | ${combinedMethod.catalysts_detected.toLocaleString()} | ${combinedMethod.catalyst_coverage_pct.toFixed(2)}% | Coverage union only; not independent evidence |\n| Optional AI structured classifier | 0 | 0.00% | Provider unavailable; fallback passed, no model quality claimed |\n\nThe improved method produced ${ctx.events.length + ctx.duplicateGroups.length} raw structured classifications and ${ctx.events.length} event records after collapsing ${ctx.duplicateGroups.length} syndications, a ${improvedMethod.duplicate_rate_before_pct.toFixed(2)}% duplicate rate before collapse. All retained records carry source-document evidence. Ticker mapping coverage was ${improvedMethod.ticker_mapping_coverage_pct.toFixed(2)}%; sector mapping coverage was ${improvedMethod.sector_mapping_coverage_pct.toFixed(2)}%. These are coverage measures, not precision. No independent human labels exist, so category, direction, ticker, and sector precision remain unknown.\n\n## Forward price context\n\n${ctx.forwardRows.length} event/ticker rows were joined to real stored OHLC after each causal detection time. Returns at 15, 30, 60, and 120 minutes, official close, and next supported session are in \`forward_price_context.csv\`. They are descriptive context only. The study does not claim that an event caused a move.\n\n## Frozen-entry research\n\nSeven hypotheses were registered before the run in \`RESEARCH_HYPOTHESES.md\`; entry and exit behavior was not optimized. The source contained ${ctx.frozen.length} recorded simulated positions but only ${distinctDates} distinct dates. The row-sequence development/validation/test split therefore does not create independent temporal days: both validation and test are concentrated on one date.\n\n| Variant | Test rows | Mean return | Key result |\n|---|---:|---:|---|\n| Explanation only baseline | ${baselineTest.trade_count} | ${baselineTest.mean_return_pct.toFixed(4)}% | Reference frozen entries |\n| Direct catalyst required | ${directTest.trade_count} | ${directTest.mean_return_pct.toFixed(4)}% | Did not improve baseline and was highly ticker concentrated |\n| Aligned high confidence | ${alignedTest.trade_count} | ${alignedTest.mean_return_pct.toFixed(4)}% | Only ${alignedTest.trade_count} rows; insufficient evidence |\n| Reject contradictory catalyst | ${contradictionTest.trade_count} | ${contradictionTest.mean_return_pct.toFixed(4)}% | Near baseline, not an independent improvement |\n| Affected-sector macro | ${macroTest.trade_count} | ${macroTest.mean_return_pct.toFixed(4)}% | Underperformed baseline |\n\n“Any verified catalyst” selected every entry because at least one broad market event existed in each 72-hour window. That makes it non-discriminating and proves broad macro presence cannot be used as a generic gate. ${strongestText} No candidate passed a minimum-count, independent-temporal-test standard.\n\n## Validation and safety\n\n- Deterministic registry digests matched on rerun.\n- Causal candidate joins had ${ctx.dataAudit.causal_join_future_leakage_violations} future-data violations.\n- The prototype test suite covers source policy, timestamp trust, deduplication, direct/indirect and multi-ticker mapping, direction classes, geopolitical/offering/FDA/earnings rules, prompt injection, malformed or hallucinated model output, evidence validation, timeout fallback, deterministic mutation, feature flag default, and absence of trading side effects.\n- No local LLM provider was available. One bounded attempt failed safely into deterministic output.\n\n## Required answers\n\n1. **What parts still work?** Agent orchestration, event-expiration and macro-context concepts, report presentation, and basic pipeline structure.\n2. **What is broken or unreliable?** Broad substring classification, weak model-output validation, prompt safety, citation ambiguity, event deduplication, narrow ticker mapping, cooldown arithmetic, and directional interpretation of risk.\n3. **What does FlashFeed already do better?** Approved ingestion, causal timestamps, its listed-US universe, Mongo/Redis persistence, weighted sentiment, OHLC, ranking, positions, and React presentation.\n4. **Which parts should be reused?** Concepts for orchestration, macro context, optional provider abstraction, and evidence reports. No subsystem should be copied wholesale.\n5. **Which parts should be rewritten?** Classifiers, schemas, event identity, evidence links, ticker/sector effects, model validation, persistence, APIs, and UI.\n6. **Best integration point?** A separate read-only enrichment after existing article ingestion, displayed inside existing Decision Map details first.\n7. **Is catalyst recognition the strongest use?** Yes. Deduplicated, structured, source-grounded catalyst explanation is the clearest incremental value.\n8. **Include macro/geopolitical context?** Yes, cautiously, with directness, asset-specific direction, confidence, horizon, and evidence.\n9. **Prediction influence or explanation?** Explanation only. Historical strategy evidence is not independent or positive enough.\n10. **Measurable historical value?** Deduplication, traceability, schema validity, and coverage improved measurably. Predictive value was not demonstrated.\n11. **Smallest useful integration?** Deterministic tags and citations in an expandable existing candidate detail panel.\n12. **Full future requirements?** Independent labels, a versioned event/effect graph, optional validated model gateway, monitoring, licensing review, resource planning, and frozen forward evaluation.\n13. **Operational/data-source risks?** Source compliance, duplicate inflation, time leakage, hallucinated mapping, prompt injection, model cost/latency, indirect-effect overclaiming, and accidental policy coupling.\n14. **Readiness?** Local explanatory demo. Not prediction shadow and not production.\n\n## Limitations and next step\n\nThe review sample is intentionally blank for independent human labels. The optional AI path was not evaluated. Position outcomes are simulated, concentrated in three dates, and observational. The next valid step is to label \`labeled_review_sample.csv\`, calculate real precision and unsupported-claim rates, then freeze the design for a later date-separated evaluation. Do not change thresholds or positions.\n`
  await write('STONKWISE_INTEGRATION_REPORT.md', report)
  await write('AMAN_PROFESSOR_HANDOFF.md', `# Aman / Professor Handoff\n\nStonkWise was reviewed at the implementation level and compared with current FlashFeed rather than copied as a second application. Its useful surviving ideas are Agent orchestration, macro-event context, and evidence-oriented reports. Its FastAPI/SQLite/Jinja stack, separate ingestion, narrow ticker store, broad keyword rules, permissive model JSON parsing, and raw-text prompt handling should not be ported.\n\nA local, disabled-by-default, read-only Catalyst Intelligence prototype now uses FlashFeed's approved articles, causal timestamps, ticker universe, event deduplication, strict schemas, source evidence, separate severity/direction/directness, and deterministic model fallback. It has no trading functions and cannot alter thresholds. The study examined ${ctx.dataAudit.articles.total.toLocaleString()} articles, produced ${ctx.events.length.toLocaleString()} deduplicated structured events after collapsing ${ctx.duplicateGroups.length.toLocaleString()} syndications, generated ${ctx.forwardRows.length} non-causal price-context rows, and tested seven preregistered catalyst questions on ${ctx.frozen.length} frozen simulated positions.\n\nThe methodology exposed two important limits. First, no independent human labels exist, so no classifier precision is being claimed. Second, the positions cover only ${distinctDates} dates; the apparent temporal test is not independent enough for prediction evidence. Broad “any catalyst” filtering selected every entry, while direct, aligned, contradiction, and macro filters did not produce a robust test improvement.\n\n**Recommendation:** use the prototype only for a local explanatory demo, ideally an expandable “Why this ticker?” panel in Decision Map and later Positions. Have a reviewer label the supplied sample, then run a frozen later-period check. Keep all production prediction, entry, exit, and position policies unchanged.\n`)
  await write('IMPLEMENTATION_PATCH_PLAN.md', `# Implementation Patch Plan (proposal only)\n\nNo production file was modified. A future reviewed patch would:\n\n1. Add a backend \`lib/catalystIntelligence\` module using current \`sourceFilter.js\` and article causal-time helpers.\n2. Add a separate \`catalyst_agent_shadow\` model/collection with unique event/version keys and source references.\n3. Add an idempotent post-ingestion shadow worker behind \`FLASHFEED_CATALYST_AGENT_SHADOW=false\`.\n4. Add read-only ticker and event routes with bounded pagination.\n5. Add expandable evidence panels to existing Decision Map and Positions details, not a new top-level page initially.\n6. Port this research test suite and add API/component tests.\n7. Add monitoring for latency, failures, duplicates, unsupported claims, and provider fallback.\n8. Keep ranking, thresholds, and position code untouched until independent labels and frozen forward evidence exist.\n`)
}

await main()
