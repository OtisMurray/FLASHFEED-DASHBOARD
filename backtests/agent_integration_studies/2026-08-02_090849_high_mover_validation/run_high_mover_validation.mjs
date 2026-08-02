import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import {
  classifyArticle,
  deduplicateEvents,
  scoreCatalystRankValidation,
} from '../../../Infrastructure/server/lib/catalystIntelligence.js'
import { allowedSource } from '../../../Infrastructure/server/sourceFilter.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SOURCE = path.resolve(HERE, '../2026-08-02_004947_catalyst_intelligence_v2')
const require = createRequire(import.meta.url)
const mongoose = require('../../../Infrastructure/server/node_modules/mongoose')

function parseCsv(text) {
  const rows = []
  let row = [], field = '', quoted = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i += 1 }
      else if (ch === '"') quoted = false
      else field += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') { row.push(field); field = '' }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = '' }
    else if (ch !== '\r') field += ch
  }
  if (field || row.length) { row.push(field); rows.push(row) }
  const headers = rows.shift() || []
  return rows.filter(values => values.some(Boolean)).map(values => Object.fromEntries(headers.map((key, index) => [key, values[index] ?? ''])))
}

function csv(rows) {
  if (!rows.length) return ''
  const columns = [...new Set(rows.flatMap(Object.keys))]
  const esc = value => {
    if (value == null) return ''
    const text = String(value)
    return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
  }
  return [columns.join(','), ...rows.map(row => columns.map(column => esc(row[column])).join(','))].join('\n') + '\n'
}

const n = value => Number.isFinite(Number(value)) ? Number(value) : null
const round = (value, digits = 6) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
function median(values) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}
function percentile(values, probability) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const index = (sorted.length - 1) * probability
  const lower = Math.floor(index), upper = Math.ceil(index)
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower)
}
function seeded(seed = 0x43a71e) {
  let state = seed >>> 0
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296 }
}
function validationScore(row) {
  return scoreCatalystRankValidation(row.direct, {
    aiDirection: row.ai_direction,
    signalSec: row.signal_sec,
  })
}

function dateBounds(date) {
  // Study dates are in daylight time (UTC-4). These bounds are explicit and frozen.
  return {
    open: Date.parse(`${date}T13:30:00Z`) / 1000,
    close: Date.parse(`${date}T20:00:00Z`) / 1000,
  }
}

function ids(value) { return String(value || '').split('|').filter(Boolean) }
function selectFirstPerTickerDate(rows) {
  const selected = new Map()
  for (const row of rows) {
    const key = `${row.ticker}|${row.date}`
    const current = selected.get(key)
    if (!current || row.signal_sec < current.signal_sec) selected.set(key, row)
  }
  return [...selected.values()]
}

function rankRows(rows, weight) {
  return [...rows].sort((a, b) => {
    const scoreA = a.ai_rank_score + weight * a.catalyst_validation_score
    const scoreB = b.ai_rank_score + weight * b.catalyst_validation_score
    return scoreB - scoreA || a.ai_rank - b.ai_rank || a.ticker.localeCompare(b.ticker)
  })
}

function metricsForSelection(selected, universe, k, weight, date, label = 'daily') {
  const picked = selected.slice(0, Math.min(k, selected.length))
  const high10 = universe.filter(row => row.mfe_pct >= 10)
  const high20 = universe.filter(row => row.mfe_pct >= 20)
  const quintileCutoff = percentile(universe.map(row => row.mfe_pct), 0.80)
  const topQuintile = universe.filter(row => row.mfe_pct >= quintileCutoff)
  const selectedMfe = picked.map(row => row.mfe_pct)
  const selectedClose = picked.map(row => row.close_return_pct)
  const totalPositiveMfe = universe.reduce((sum, row) => sum + Math.max(0, row.mfe_pct), 0)
  const capturedPositiveMfe = picked.reduce((sum, row) => sum + Math.max(0, row.mfe_pct), 0)
  return {
    label, date, weight, k,
    universe_count: universe.length,
    selected_count: picked.length,
    direct_catalyst_count: picked.filter(row => row.direct.length).length,
    high10_available: high10.length,
    high20_available: high20.length,
    high10_precision_pct: picked.length ? picked.filter(row => row.mfe_pct >= 10).length / picked.length * 100 : null,
    high10_recall_pct: high10.length ? picked.filter(row => row.mfe_pct >= 10).length / high10.length * 100 : null,
    high20_precision_pct: picked.length ? picked.filter(row => row.mfe_pct >= 20).length / picked.length * 100 : null,
    high20_recall_pct: high20.length ? picked.filter(row => row.mfe_pct >= 20).length / high20.length * 100 : null,
    top_quintile_recall_pct: topQuintile.length ? picked.filter(row => row.mfe_pct >= quintileCutoff).length / topQuintile.length * 100 : null,
    mean_mfe_pct: mean(selectedMfe),
    median_mfe_pct: median(selectedMfe),
    mean_close_return_pct: mean(selectedClose),
    median_close_return_pct: median(selectedClose),
    worst_close_return_pct: selectedClose.length ? Math.min(...selectedClose) : null,
    positive_mfe_capture_pct: totalPositiveMfe ? capturedPositiveMfe / totalPositiveMfe * 100 : null,
    selected_tickers: picked.map(row => row.ticker).join('|'),
  }
}

function balancedDevelopmentScore(metric) {
  return (metric.high10_precision_pct || 0) * 0.30 +
    (metric.high10_recall_pct || 0) * 0.20 +
    (metric.top_quintile_recall_pct || 0) * 0.20 +
    (metric.mean_mfe_pct || 0) * 0.20 +
    (metric.mean_close_return_pct || 0) * 0.10
}

const positionRows = parseCsv(await fs.readFile(path.join(SOURCE, 'frozen_entry_research_results.csv'), 'utf8'))
const prepared = positionRows.map(row => ({
  ticker: String(row.ticker || '').toUpperCase(),
  date: row.date,
  signal_sec: n(row.signal_sec),
  ai_direction: row.ai_direction,
  ai_rank: n(row.ai_rank) ?? 999,
  ai_rank_score: n(row.ai_rank_score) ?? 0,
  finalized: String(row.finalized).toLowerCase() === 'true',
  direct: [],
})).filter(row => row.ticker && /^2026-07-(29|30|31)$/.test(row.date) && row.signal_sec != null)

const deduped = selectFirstPerTickerDate(prepared)
const tickers = [...new Set(deduped.map(row => row.ticker))]
const minimumMinute = Math.min(...deduped.map(row => dateBounds(row.date).open))
const maximumMinute = Math.max(...deduped.map(row => dateBounds(row.date).close))

await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/feedflash', { serverSelectionTimeoutMS: 5000 })
let bars
let causalArticles
try {
  bars = await mongoose.connection.db.collection('ohlcv_bars').find({
    ticker: { $in: tickers },
    source: 'yahoo_chart_ohlcv',
    providerIntervalSec: 60,
    minute: { $gte: minimumMinute, $lte: maximumMinute },
  }, { projection: { _id: 0, ticker: 1, minute: 1, open: 1, high: 1, low: 1, close: 1, source: 1, providerIntervalSec: 1 } }).sort({ ticker: 1, minute: 1 }).toArray()
  const minimumSignal = Math.min(...deduped.map(row => row.signal_sec)) - 72 * 3600
  const maximumSignal = Math.max(...deduped.map(row => row.signal_sec))
  const minimumDate = new Date(minimumSignal * 1000)
  const maximumDate = new Date(maximumSignal * 1000)
  const numericFields = ['publish_date', 'publish_sec', 'event_sec', 'first_seen_at', 'detected_at', 'fetched_at']
  const dateFields = ['publish_date', 'first_seen_at', 'detected_at', 'fetched_at', 'createdAt']
  causalArticles = await mongoose.connection.db.collection('articles').find({
    $or: [
      ...numericFields.map(field => ({ [field]: { $gte: minimumSignal, $lte: maximumSignal } })),
      ...dateFields.map(field => ({ [field]: { $gte: minimumDate, $lte: maximumDate } })),
    ],
  }, { projection: {
    _id: 1, source: 1, title: 1, headline: 1, summary: 1, content: 1, bodyText: 1,
    url: 1, link: 1, ticker: 1, tickers: 1, tickers_mentioned: 1, matched_mover_tickers: 1,
    symbol: 1, symbols: 1, publish_date: 1, publish_sec: 1, event_sec: 1, first_seen_at: 1,
    detected_at: 1, fetched_at: 1, createdAt: 1, publish_time_trusted: 1, article_kind: 1,
    category: 1, collector: 1, event_type: 1, sentiment: 1,
  } }).toArray()
} finally {
  await mongoose.disconnect()
}

const candidateUniverse = new Set(tickers)
const classified = causalArticles.map(article => classifyArticle(article, {
  universe: candidateUniverse,
  sourceAllowed: allowedSource,
})).filter(event => !event.rejected && event.directness === 'direct' && event.tickers.length)
const deduplication = deduplicateEvents(classified)
const eventsByTicker = new Map()
for (const event of deduplication.events) {
  for (const ticker of event.tickers) {
    if (!eventsByTicker.has(ticker)) eventsByTicker.set(ticker, [])
    eventsByTicker.get(ticker).push(event)
  }
}
for (const row of deduped) {
  const start = row.signal_sec - 72 * 3600
  row.direct = (eventsByTicker.get(row.ticker) || []).filter(event => event.detected_sec >= start && event.detected_sec <= row.signal_sec)
}

const barsByTicker = new Map()
for (const bar of bars) {
  if (![bar.minute, bar.open, bar.high, bar.low, bar.close].every(value => Number.isFinite(Number(value)))) continue
  if (!barsByTicker.has(bar.ticker)) barsByTicker.set(bar.ticker, [])
  barsByTicker.get(bar.ticker).push({ minute: n(bar.minute), open: n(bar.open), high: n(bar.high), low: n(bar.low), close: n(bar.close) })
}

const coverage = []
const outcomes = []
const badBarAudit = []
for (const row of deduped) {
  const bounds = dateBounds(row.date)
  if (row.signal_sec >= bounds.close) {
    coverage.push({ ticker: row.ticker, date: row.date, signal_sec: row.signal_sec, status: 'excluded', reason: 'signal_at_or_after_regular_close' })
    continue
  }
  const start = Math.max(row.signal_sec, bounds.open)
  const available = (barsByTicker.get(row.ticker) || []).filter(bar => bar.minute >= start && bar.minute <= bounds.close)
  const duplicateMinutes = available.length - new Set(available.map(bar => bar.minute)).size
  const invalidOhlc = available.filter(bar => bar.high < Math.max(bar.open, bar.close) || bar.low > Math.min(bar.open, bar.close) || bar.low <= 0).length
  const gapsOverOneMinute = available.slice(1).filter((bar, index) => bar.minute - available[index].minute > 60).length
  const maxRangePct = available.length
    ? Math.max(...available.map(bar => bar.open > 0 ? (bar.high - bar.low) / bar.open * 100 : 0))
    : null
  badBarAudit.push({
    ticker: row.ticker, date: row.date, observed_bars: available.length, duplicate_minutes: duplicateMinutes,
    invalid_ohlc_rows: invalidOhlc, gaps_over_one_minute: gapsOverOneMinute, max_single_bar_range_pct: maxRangePct,
    status: duplicateMinutes || invalidOhlc ? 'fail' : gapsOverOneMinute ? 'review_sparse_or_halted' : 'pass',
  })
  if (available.length < 10) {
    coverage.push({ ticker: row.ticker, date: row.date, signal_sec: row.signal_sec, status: 'excluded', reason: available.length ? 'fewer_than_10_real_one_minute_bars' : 'no_real_one_minute_bars', observed_bars: available.length })
    continue
  }
  const entry = available[0].open
  if (!(entry > 0)) {
    coverage.push({ ticker: row.ticker, date: row.date, signal_sec: row.signal_sec, status: 'excluded', reason: 'invalid_regular_session_entry_open', observed_bars: available.length })
    continue
  }
  const bearish = /bear|down/i.test(String(row.ai_direction || ''))
  const mfe = bearish
    ? (entry - Math.min(...available.map(bar => bar.low))) / entry * 100
    : (Math.max(...available.map(bar => bar.high)) - entry) / entry * 100
  const closeReturn = bearish
    ? (entry - available.at(-1).close) / entry * 100
    : (available.at(-1).close - entry) / entry * 100
  const enriched = { ...row, entry_minute: available[0].minute, entry_price: entry, final_minute: available.at(-1).minute, final_close: available.at(-1).close, observed_bars: available.length, mfe_pct: mfe, close_return_pct: closeReturn }
  enriched.catalyst_validation_score = validationScore(enriched)
  outcomes.push(enriched)
  coverage.push({ ticker: row.ticker, date: row.date, signal_sec: row.signal_sec, status: 'included', reason: row.signal_sec < bounds.open ? 'premarket_signal_entered_at_regular_open' : 'regular_session_signal', observed_bars: available.length, entry_minute: enriched.entry_minute, final_minute: enriched.final_minute })
}

const dates = ['2026-07-29', '2026-07-30', '2026-07-31']
const weights = [0, 0.10, 0.20, 0.30, 0.40]
const ks = [3, 5, 10]
const dailyMetrics = []
for (const date of dates) {
  const universe = outcomes.filter(row => row.date === date)
  for (const weight of weights) {
    const ranked = rankRows(universe, weight)
    for (const k of ks) dailyMetrics.push(metricsForSelection(ranked, universe, k, weight, date))
  }
}

// Select on top-5 only: development nominates two, validation freezes one, test is read once.
const development = dailyMetrics.filter(row => row.date === dates[0] && row.k === 5 && row.weight > 0)
  .map(row => ({ ...row, balanced_score: balancedDevelopmentScore(row) }))
  .sort((a, b) => b.balanced_score - a.balanced_score || a.weight - b.weight)
const nominees = development.slice(0, 2).map(row => row.weight)
const validation = dailyMetrics.filter(row => row.date === dates[1] && row.k === 5 && nominees.includes(row.weight))
  .map(row => ({ ...row, balanced_score: balancedDevelopmentScore(row) }))
  .sort((a, b) => b.balanced_score - a.balanced_score || a.weight - b.weight)
const frozenWeight = validation[0]?.weight ?? nominees[0] ?? 0

const comparisons = []
for (const date of dates) {
  for (const k of ks) {
    const baseline = dailyMetrics.find(row => row.date === date && row.k === k && row.weight === 0)
    const assisted = dailyMetrics.find(row => row.date === date && row.k === k && row.weight === frozenWeight)
    comparisons.push({
      date,
      split: date === dates[0] ? 'development' : date === dates[1] ? 'retrospective_review_1' : 'retrospective_review_2',
      k,
      frozen_weight: frozenWeight,
      baseline_mean_mfe_pct: baseline.mean_mfe_pct,
      assisted_mean_mfe_pct: assisted.mean_mfe_pct,
      delta_mean_mfe_pct: assisted.mean_mfe_pct - baseline.mean_mfe_pct,
      baseline_high10_precision_pct: baseline.high10_precision_pct,
      assisted_high10_precision_pct: assisted.high10_precision_pct,
      delta_high10_precision_pct: assisted.high10_precision_pct - baseline.high10_precision_pct,
      baseline_high10_recall_pct: baseline.high10_recall_pct,
      assisted_high10_recall_pct: assisted.high10_recall_pct,
      delta_high10_recall_pct: assisted.high10_recall_pct - baseline.high10_recall_pct,
      baseline_top_quintile_recall_pct: baseline.top_quintile_recall_pct,
      assisted_top_quintile_recall_pct: assisted.top_quintile_recall_pct,
      delta_top_quintile_recall_pct: assisted.top_quintile_recall_pct - baseline.top_quintile_recall_pct,
      baseline_close_return_pct: baseline.mean_close_return_pct,
      assisted_close_return_pct: assisted.mean_close_return_pct,
      delta_close_return_pct: assisted.mean_close_return_pct - baseline.mean_close_return_pct,
      baseline_tickers: baseline.selected_tickers,
      assisted_tickers: assisted.selected_tickers,
    })
  }
}

const highMoverRows = outcomes.map(row => ({
  ticker: row.ticker, date: row.date, signal_sec: row.signal_sec, ai_direction: row.ai_direction,
  ai_rank_score: row.ai_rank_score, catalyst_validation_score: row.catalyst_validation_score,
  direct_catalyst_count: row.direct.length, direct_categories: [...new Set(row.direct.map(event => event.category))].join('|'),
  direct_directions: [...new Set(row.direct.map(event => event.direction))].join('|'),
  direct_catalyst_titles: row.direct.map(event => event.title).join(' | '),
  newest_catalyst_age_hours: row.direct.length ? Math.min(...row.direct.map(event => (row.signal_sec - event.detected_sec) / 3600)) : null,
  entry_minute: row.entry_minute, entry_price: row.entry_price, final_minute: row.final_minute,
  final_close: row.final_close, observed_bars: row.observed_bars, mfe_pct: row.mfe_pct, close_return_pct: row.close_return_pct,
  high10: row.mfe_pct >= 10, high20: row.mfe_pct >= 20,
}))

const rankingAttribution = []
const leaveOnePromotedOut = []
for (const date of dates) {
  const universe = outcomes.filter(row => row.date === date)
  const baseline = rankRows(universe, 0).slice(0, 5)
  const assisted = rankRows(universe, frozenWeight).slice(0, 5)
  const baselineSet = new Set(baseline.map(row => row.ticker))
  const assistedSet = new Set(assisted.map(row => row.ticker))
  for (const row of baseline) {
    if (!assistedSet.has(row.ticker)) rankingAttribution.push({ date, change: 'removed', ticker: row.ticker, ai_rank_score: row.ai_rank_score, catalyst_validation_score: row.catalyst_validation_score, mfe_pct: row.mfe_pct, close_return_pct: row.close_return_pct })
  }
  for (const row of assisted) {
    if (!baselineSet.has(row.ticker)) {
      rankingAttribution.push({ date, change: 'promoted', ticker: row.ticker, ai_rank_score: row.ai_rank_score, catalyst_validation_score: row.catalyst_validation_score, mfe_pct: row.mfe_pct, close_return_pct: row.close_return_pct })
      const reduced = universe.filter(candidate => candidate.ticker !== row.ticker)
      const baselineReduced = metricsForSelection(rankRows(reduced, 0), reduced, 5, 0, date, 'leave_one_promoted_out')
      const assistedReduced = metricsForSelection(rankRows(reduced, frozenWeight), reduced, 5, frozenWeight, date, 'leave_one_promoted_out')
      leaveOnePromotedOut.push({
        date, omitted_promoted_ticker: row.ticker,
        delta_mean_mfe_pct: assistedReduced.mean_mfe_pct - baselineReduced.mean_mfe_pct,
        delta_high10_precision_pct: assistedReduced.high10_precision_pct - baselineReduced.high10_precision_pct,
        delta_close_return_pct: assistedReduced.mean_close_return_pct - baselineReduced.mean_close_return_pct,
        baseline_tickers: baselineReduced.selected_tickers, assisted_tickers: assistedReduced.selected_tickers,
      })
    }
  }
}

const evidenceTimingAudit = outcomes.flatMap(row => row.direct.map(event => ({
  ticker: row.ticker, date: row.date, signal_sec: row.signal_sec, event_detected_sec: event.detected_sec,
  event_age_hours: (row.signal_sec - event.detected_sec) / 3600, causal_before_signal: event.detected_sec <= row.signal_sec,
  category: event.category, subtype: event.subtype, direction: event.direction, confidence: event.confidence,
  title: event.title, source_names: event.source_names.join('|'), source_urls: event.source_urls.join('|'),
})))

const frozenTop5 = comparisons.filter(row => row.k === 5)
const bootstrap = []
const random = seeded()
for (let iteration = 0; iteration < 5000; iteration += 1) {
  const sampled = Array.from({ length: dates.length }, () => frozenTop5[Math.floor(random() * frozenTop5.length)])
  bootstrap.push({ iteration, delta_mean_mfe_pct: mean(sampled.map(row => row.delta_mean_mfe_pct)), delta_close_return_pct: mean(sampled.map(row => row.delta_close_return_pct)), delta_high10_precision_pct: mean(sampled.map(row => row.delta_high10_precision_pct)) })
}
const bootstrapSummary = [{
  metric: 'top5_delta_mean_mfe_pct', mean: mean(bootstrap.map(row => row.delta_mean_mfe_pct)), lower_95: percentile(bootstrap.map(row => row.delta_mean_mfe_pct), 0.025), upper_95: percentile(bootstrap.map(row => row.delta_mean_mfe_pct), 0.975),
}, {
  metric: 'top5_delta_close_return_pct', mean: mean(bootstrap.map(row => row.delta_close_return_pct)), lower_95: percentile(bootstrap.map(row => row.delta_close_return_pct), 0.025), upper_95: percentile(bootstrap.map(row => row.delta_close_return_pct), 0.975),
}, {
  metric: 'top5_delta_high10_precision_pct', mean: mean(bootstrap.map(row => row.delta_high10_precision_pct)), lower_95: percentile(bootstrap.map(row => row.delta_high10_precision_pct), 0.025), upper_95: percentile(bootstrap.map(row => row.delta_high10_precision_pct), 0.975),
}]

const july30Top5 = comparisons.find(row => row.split === 'retrospective_review_1' && row.k === 5)
const july31Top5 = comparisons.find(row => row.split === 'retrospective_review_2' && row.k === 5)
const improvedJuly30 = july30Top5.delta_mean_mfe_pct > 0 || july30Top5.delta_high10_precision_pct > 0 || july30Top5.delta_top_quintile_recall_pct > 0
const improvedJuly31 = july31Top5.delta_mean_mfe_pct > 0 || july31Top5.delta_high10_precision_pct > 0 || july31Top5.delta_top_quintile_recall_pct > 0
const noMaterialDownside = july30Top5.delta_close_return_pct >= -1 && july31Top5.delta_close_return_pct >= -1
const verdict = improvedJuly30 && improvedJuly31 && noMaterialDownside
  ? 'exploratory_incremental_signal_promising_requires_frozen_forward_validation'
  : 'not_yet_demonstrated_keep_explanatory_and_collect_more_data'

const summary = {
  analysis_data_cutoff: new Date(maximumMinute * 1000).toISOString(),
  source_commit: '2593eb6a8747bd7caa6a4dd03afb5063b1984f26',
  purpose: 'incremental catalyst validation layered on existing AI ranking for high-mover capture',
  methodology: { frozen_dates: dates, original_rows: prepared.length, unique_ticker_dates: deduped.length, analyzable_unique_ticker_dates: outcomes.length, source: 'yahoo_chart_ohlcv', interval_seconds: 60, causal_articles_reviewed: causalArticles.length, classified_direct_events: classified.length, deduplicated_direct_events: deduplication.events.length, high_mover_thresholds_pct: [10, 20], weights, top_k: ks, classifier_version: '2.1.0', scorer_is_signed: true },
  selection: { development_nominees: nominees, frozen_weight: frozenWeight },
  retrospective_july30_top5: july30Top5,
  retrospective_july31_top5: july31Top5,
  bootstrap_top5: bootstrapSummary,
  leave_one_promoted_out: leaveOnePromotedOut,
  verdict,
  production_change_supported: false,
  limitations: ['Only three market dates are available.', 'The target is observed regular-session MFE, not realized execution return.', 'Catalyst labels are deterministic and do not yet have independent human precision labels.', 'Stored OHLC coverage limits the analyzable candidate universe.', 'Results are observational and do not prove catalysts caused movement.', 'Classifier coverage rules were expanded after reviewing missed movers, so every date in this rerun is retrospective and none is an untouched forward test.'],
}

const display = value => value == null ? 'n/a' : Number(value).toFixed(2)
const report = `# High-Mover Catalyst Validation Study\n\n## Question\n\nCan the StonkWise-inspired Catalyst Intelligence layer improve FlashFeed by validating and reranking the existing AI system's highest-upside targets, rather than replacing the current strategy?\n\n## Verdict\n\n**${verdict.replaceAll('_', ' ')}.**\n\nThis is a local shadow-ranking result only. It does not support a production policy change.\n\n## Data and method\n\n- ${prepared.length} causal frozen AI observations were collapsed to ${deduped.length} first ticker/date observations.\n- ${outcomes.length} unique ticker/date candidates had at least ten real one-minute regular-session OHLC bars after the usable signal.\n- Premarket suggestions were measured from the first regular-session open; after-close suggestions were excluded.\n- The target is maximum favorable excursion after the signal, which directly tests whether a candidate became a major mover.\n- The existing AI score remains the base. Catalyst evidence contributes a bounded signed adjustment: aligned evidence can promote, opposing evidence can caution, and watch candidates are no longer falsely treated as contradictions.\n- The frozen catalyst weight was ${frozenWeight}.\n\n## Retrospective top-5 sensitivity\n\n| Review date | AI MFE | Assisted MFE | MFE delta | AI 10% precision | Assisted 10% precision | Close-return delta |\n|---|---:|---:|---:|---:|---:|---:|\n| July 30 | ${display(july30Top5.baseline_mean_mfe_pct)}% | ${display(july30Top5.assisted_mean_mfe_pct)}% | ${display(july30Top5.delta_mean_mfe_pct)} pp | ${display(july30Top5.baseline_high10_precision_pct)}% | ${display(july30Top5.assisted_high10_precision_pct)}% | ${display(july30Top5.delta_close_return_pct)} pp |\n| July 31 | ${display(july31Top5.baseline_mean_mfe_pct)}% | ${display(july31Top5.assisted_mean_mfe_pct)}% | ${display(july31Top5.delta_mean_mfe_pct)} pp | ${display(july31Top5.baseline_high10_precision_pct)}% | ${display(july31Top5.assisted_high10_precision_pct)}% | ${display(july31Top5.delta_close_return_pct)} pp |\n\n## Interpretation\n\nThe intended role is narrow: FlashFeed AI discovers candidates; catalyst intelligence adds evidence-aware validation for candidates already near the top. It is not an entry gate and does not replace AI scoring. Market-wide events are excluded from the bonus because they did not distinguish candidates in the earlier study.\n\nThe expanded rules recovered genuine causal clinical-development, supplier-agreement, and plural partnership language. However, those rules were added after reviewing missed movers. Therefore neither review date is an untouched test. These numbers demonstrate mechanism and retrospective plausibility only. The large July 30 improvement is concentrated in GCTK, so \`leave_one_promoted_out.csv\` must be read alongside the headline result. A frozen forward session is required before claiming predictive improvement.\n\n## Safety\n\nNo ranking, threshold, entry, exit, position, deployment, or production policy was changed by this study.\n`

await fs.writeFile(path.join(HERE, 'candidate_outcomes.csv'), csv(highMoverRows))
await fs.writeFile(path.join(HERE, 'coverage_audit.csv'), csv(coverage))
await fs.writeFile(path.join(HERE, 'bad_bar_audit.csv'), csv(badBarAudit))
await fs.writeFile(path.join(HERE, 'evidence_timing_audit.csv'), csv(evidenceTimingAudit))
await fs.writeFile(path.join(HERE, 'ranking_change_attribution.csv'), csv(rankingAttribution))
await fs.writeFile(path.join(HERE, 'leave_one_promoted_out.csv'), csv(leaveOnePromotedOut))
await fs.writeFile(path.join(HERE, 'ranking_metrics.csv'), csv(dailyMetrics.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === 'number' ? round(value) : value])))))
await fs.writeFile(path.join(HERE, 'frozen_weight_comparison.csv'), csv(comparisons.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === 'number' ? round(value) : value])))))
await fs.writeFile(path.join(HERE, 'bootstrap_summary.csv'), csv(bootstrapSummary.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === 'number' ? round(value) : value])))))
await fs.writeFile(path.join(HERE, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
await fs.writeFile(path.join(HERE, 'HIGH_MOVER_VALIDATION_REPORT.md'), report)

const inventory = (await fs.readdir(HERE)).filter(name => !['LOCAL_FILE_INVENTORY.txt', 'SHA256SUMS.txt'].includes(name)).sort()
await fs.writeFile(path.join(HERE, 'LOCAL_FILE_INVENTORY.txt'), inventory.join('\n') + '\n')
const hashes = []
for (const name of inventory) {
  const content = await fs.readFile(path.join(HERE, name))
  hashes.push(`${crypto.createHash('sha256').update(content).digest('hex')}  ${name}`)
}
await fs.writeFile(path.join(HERE, 'SHA256SUMS.txt'), hashes.join('\n') + '\n')
console.log(JSON.stringify(summary, null, 2))
