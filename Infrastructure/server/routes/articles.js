import express from 'express'
import mongoose from 'mongoose'
import Article from '../models/Article.js'
import { approvedNewsSourceMongoFilter } from '../sourceFilter.js'

const router = express.Router()
const MARKET_WINDOW_TIME_ZONE = process.env.MARKET_WINDOW_TIMEZONE || 'America/New_York'
const MARKET_WINDOW_CLOSE_HOUR = Number(process.env.MARKET_WINDOW_CLOSE_HOUR_ET || 17)
const VALID_TICKER_FIELD_REGEX = /(^|[,\s$])\$?[A-Z][A-Z0-9.-]{0,5}(?=$|[,\s])/
// The raw fields matched-only used to test in Mongo, in the same order.
const RAW_TICKER_FIELDS = ['ticker', 'tickers', 'tickers_mentioned', 'matched_mover_tickers']
// Bounds for the matched-only inference pass. It reads only the documents with
// no usable raw symbol, which is the minority of any window, so these are
// generous rather than tight — but they are hard limits, and the response says
// when one was hit rather than quietly returning a short answer.
const TICKER_INFERENCE_SCAN_LIMIT = Math.max(1000, Number(process.env.ARTICLE_TICKER_INFERENCE_SCAN_LIMIT) || 30000)
const TICKER_INFERENCE_MATCH_LIMIT = Math.max(100, Number(process.env.ARTICLE_TICKER_INFERENCE_MATCH_LIMIT) || 5000)
const TICKER_INFERENCE_SORT = { publish_date: -1, fetched_date: -1, detected_at: -1 }
const ARTICLE_LIST_PROJECTION = {
  content: 0,
  raw_content: 0,
  raw: 0,
  html: 0,
  embeddings: 0,
}

function normalizeUnixSeconds(value, fallback) {
  const n = Number(value || 0)
  const fb = Number(fallback || Math.floor(Date.now() / 1000))

  if (!n) return fb

  // milliseconds timestamp
  if (n > 1000000000000) return Math.floor(n / 1000)

  // normal unix seconds
  if (n > 1000000000) return n

  // broken/too-small timestamp, use fallback
  return fb
}

function easternParts(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: MARKET_WINDOW_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)

  return Object.fromEntries(
    parts
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, Number(part.value)])
  )
}

function easternLocalToUtc(year, month, day, hour, minute = 0, second = 0) {
  const target = Date.UTC(year, month - 1, day, hour, minute, second)
  let guess = target

  for (let i = 0; i < 4; i += 1) {
    const parts = easternParts(new Date(guess))
    const actual = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
    const diff = target - actual
    if (diff === 0) break
    guess += diff
  }

  return new Date(guess)
}

function shiftLocalDate(year, month, day, deltaDays) {
  const shifted = new Date(Date.UTC(year, month - 1, day + deltaDays))
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  }
}

function localWeekday(year, month, day) {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay()
}

function latestMarketCloseCutoff(now = new Date()) {
  let { year, month, day, hour } = easternParts(now)
  let weekday = localWeekday(year, month, day)

  if (weekday === 0) {
    ;({ year, month, day } = shiftLocalDate(year, month, day, -2))
  } else if (weekday === 6) {
    ;({ year, month, day } = shiftLocalDate(year, month, day, -1))
  } else if (hour < MARKET_WINDOW_CLOSE_HOUR) {
    ;({ year, month, day } = shiftLocalDate(year, month, day, -1))
    while ([0, 6].includes(localWeekday(year, month, day))) {
      ;({ year, month, day } = shiftLocalDate(year, month, day, -1))
    }
  }

  return easternLocalToUtc(year, month, day, MARKET_WINDOW_CLOSE_HOUR)
}

function calendarWindowStart(days = 1, now = new Date()) {
  const n = Math.max(1, Math.floor(Number(days) || 1))
  const { year, month, day } = easternParts(now)
  const shifted = shiftLocalDate(year, month, day, -(n - 1))
  return easternLocalToUtc(shifted.year, shifted.month, shifted.day, 0).getTime()
}

function articleWindowFilter(cutoffMs) {
  const cutoffSec = Math.floor(cutoffMs / 1000)
  const cutoffDate = new Date(cutoffMs)
  const ceilingMs = Date.now() + 5 * 60 * 1000
  const ceilingSec = Math.floor(ceilingMs / 1000)
  const ceilingDate = new Date(ceilingMs)
  const rangeFor = (field) => ({
    $or: [
      { [field]: { $type: 'date', $gte: cutoffDate, $lte: ceilingDate } },
      { [field]: { $type: 'int', $gte: cutoffSec, $lte: ceilingSec } },
      { [field]: { $type: 'long', $gte: cutoffSec, $lte: ceilingSec } },
      { [field]: { $type: 'double', $gte: cutoffSec, $lte: ceilingSec } },
    ],
  })
  const missingPublishDate = {
    $or: [
      { publish_date: { $exists: false } },
      { publish_date: null },
      { publish_date: '' },
    ],
  }
  return {
    $or: [
      {
        $and: [
          {
            $or: [
              { publish_time_trusted: true },
              {
                $and: [
                  { publish_time_trusted: { $exists: false } },
                  { article_kind: { $nin: ['public', 'unstructured'] } },
                  { category: { $nin: ['unstructured_public_title', 'public_news', 'public_market_news'] } },
                  { collector: { $ne: 'unstructured_news_title_only_v1' } },
                ],
              },
            ],
          },
          rangeFor('publish_date'),
        ],
      },
      {
        $and: [
          { $or: [{ publish_time_trusted: false }, missingPublishDate] },
          { $or: [rangeFor('first_seen_at'), rangeFor('createdAt')] },
        ],
      },
    ],
  }
}

function recentArticleFilter(days) {
  const n = Number(days || 0)
  const cutoffMs = Number.isFinite(n) && n > 0
    ? calendarWindowStart(n)
    : latestMarketCloseCutoff().getTime()

  return articleWindowFilter(cutoffMs)
}

function todayArticleFilter(now = new Date()) {
  const { year, month, day } = easternParts(now)
  const todayStartMs = easternLocalToUtc(year, month, day, 0).getTime()
  const tomorrow = shiftLocalDate(year, month, day, 1)
  const todayEndMs = easternLocalToUtc(tomorrow.year, tomorrow.month, tomorrow.day, 0).getTime() - 1
  const todayStartSec = Math.floor(todayStartMs / 1000)
  const todayEndSec = Math.floor(todayEndMs / 1000)
  const todayEndDate = new Date(todayEndMs)

  // Strict ET calendar-day filter: 12:00:00 AM through 11:59:59 PM ET.
  // No fallback to first_seen_at/createdAt — those can pull in old articles
  // that were merely re-fetched today.
  return {
    $or: [
      { publish_date: { $type: 'date', $gte: new Date(todayStartMs), $lte: todayEndDate } },
      { publish_date: { $type: 'int', $gte: todayStartSec, $lte: todayEndSec } },
      { publish_date: { $type: 'long', $gte: todayStartSec, $lte: todayEndSec } },
      { publish_date: { $type: 'double', $gte: todayStartSec, $lte: todayEndSec } },
    ],
  }
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function tickerCsvRegex(tickers) {
  const values = Array.from(new Set((tickers || [])
    .map(t => String(t || '').trim().toUpperCase())
    .filter(Boolean)))

  if (!values.length) return null
  return new RegExp(`(^|,\\s*)(${values.map(escapeRegExp).join('|')})(\\s*,|$)`, 'i')
}

async function loadPositiveMoverTickers(source = 'all') {
  const db = mongoose.connection.db
  if (!db) return []

  const filter = {
    $or: [
      { change_pct: { $gte: 0.01 } },
      { change_percent: { $gte: 0.01 } },
    ],
  }
  const sourceName = String(source || 'all').toLowerCase()
  if (sourceName === 'finviz') filter.quote_source = 'finviz_elite_screener'
  if (sourceName === 'tradingview') filter.quote_source = 'tradingview_numeric_screener'

  const rows = await db.collection('screeners')
    .find(filter, { projection: { ticker: 1 } })
    .limit(300)
    .toArray()

  return rows
    .map(row => String(row.ticker || '').trim().toUpperCase())
    .filter(Boolean)
}

function matchedTickers(articleTicker, moverTickers) {
  const wanted = new Set(moverTickers)
  const values = Array.isArray(articleTicker) ? articleTicker : String(articleTicker || '').split(',')
  return values
    .map(t => t.trim().toUpperCase())
    .filter(t => t && wanted.has(t))
}

const PUBLIC_ARTICLE_CATEGORIES = ['unstructured_public_title', 'public_news', 'public_market_news']
const LEGAL_SPAM_RE = /shareholder alert|stockholder alert|investor alert|securities fraud|securities class action|class action|lead plaintiff|substantial losses|losses in excess|secure counsel|your rights|deadline|rosen law|hagens berman|kirby mcinerney|robbins llp|pomerantz|bragar eagel|levi korsinsky|glancy prongay|the law offices|law firm|investor counsel/i
const FILING_CATEGORY_NAMES = new Set(['filings', 'sec_filing', 'sec filings', 'sec'])
const FILING_SOURCE_RE = /sec\s+edgar/i
const GENERIC_COMPANY_ALIASES = new Set([
  'inc', 'corp', 'corporation', 'company', 'holdings', 'group', 'limited', 'ltd',
  'plc', 'adr', 'common stock', 'class a', 'technologies', 'technology',
  'new york', 'san francisco', 'los angeles', 'las vegas', 'united states',
  'access newswire', 'access newswire inc', 'business wire', 'pr newswire',
  'globenewswire', 'globenewswire public companies', 'newsfile', 'ein presswire',
])
const BAD_ALIAS_EDGE_WORDS = new Set(['a', 'an', 'and', 'by', 'for', 'from', 'in', 'of', 'on', 'the', 'to', 'with'])
const TICKER_ALIAS_CACHE_MS = 60_000
let tickerAliasCache = { at: 0, rows: [] }

function isFundLikeCompanyName(company = '') {
  return /\b(etf|etn|fund|index|index fund)\b/i.test(String(company || ''))
}

function normalizeTickerSymbol(value) {
  const ticker = String(value || '').trim().replace(/^\$/, '').toUpperCase()
  if (!/^[A-Z][A-Z0-9.-]{0,5}$/.test(ticker)) return ''
  return ticker
}

function articleTickerValues(article = {}) {
  const values = new Set()
  const push = (value) => {
    if (Array.isArray(value)) return value.forEach(push)
    String(value || '').split(/[,\s]+/).forEach(part => {
      const ticker = normalizeTickerSymbol(part)
      if (ticker) values.add(ticker)
    })
  }
  push(article.ticker)
  push(article.tickers)
  push(article.matched_mover_tickers)
  push(article.tickers_mentioned)
  const text = `${article.title || ''} ${article.summary || ''} ${article.content || ''}`
  for (const match of text.matchAll(/\$([A-Za-z][A-Za-z0-9.-]{0,5})\b/g)) {
    const ticker = normalizeTickerSymbol(match[1])
    if (ticker) values.add(ticker)
  }
  return Array.from(values)
}

function storedArticleTickers(article = {}) {
  const values = new Set()
  const push = (value) => {
    if (Array.isArray(value)) return value.forEach(push)
    String(value || '').split(/[,\s]+/).forEach(part => {
      const ticker = normalizeTickerSymbol(part)
      if (ticker) values.add(ticker)
    })
  }
  push(article.ticker)
  push(article.tickers)
  push(article.matched_mover_tickers)
  push(article.tickers_mentioned)
  return Array.from(values)
}

function cashtagArticleTickers(article = {}) {
  const values = new Set()
  const text = `${article.title || ''} ${article.summary || ''} ${article.content || ''}`
  for (const match of text.matchAll(/\$([A-Za-z][A-Za-z0-9.-]{0,5})\b/g)) {
    const ticker = normalizeTickerSymbol(match[1])
    if (ticker) values.add(ticker)
  }
  return Array.from(values)
}

function normalizedText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function companyAliases(company = '') {
  const normalized = normalizedText(company)
  if (!normalized) return []
  const stripped = normalized
    .replace(/\b(incorporated|inc|corp|corporation|co|company|holdings|holding|group|plc|ltd|limited|adr|class a|common stock)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const aliases = new Set([normalized])
  const words = stripped.split(' ').filter(Boolean)
  if (words.length >= 2) aliases.add(stripped)
  const firstTwo = words.slice(0, 2).join(' ')
  if (words.length >= 3 && firstTwo.length >= 12 && !GENERIC_COMPANY_ALIASES.has(firstTwo)) {
    aliases.add(firstTwo)
  }
  return Array.from(aliases)
    .map(value => value.trim())
    .filter((value) => {
      const words = value.split(' ').filter(Boolean)
      return (
        value.length >= 5 &&
        words.length >= 2 &&
        !GENERIC_COMPANY_ALIASES.has(value) &&
        !BAD_ALIAS_EDGE_WORDS.has(words[0]) &&
        !BAD_ALIAS_EDGE_WORDS.has(words[words.length - 1]) &&
        words.every(word => word.length >= 2)
      )
    })
}

function textContainsAlias(haystack, alias) {
  if (!haystack || !alias) return false
  const escaped = escapeRegExp(alias)
  return new RegExp(`(^|\\s)${escaped}(\\s|$)`, 'i').test(haystack)
}

function aliasMongoRegex(alias) {
  const words = normalizedText(alias).split(' ').filter(Boolean)
  if (words.length < 2) return null
  return new RegExp(`\\b${words.map(escapeRegExp).join('[^A-Za-z0-9]+')}\\b`, 'i')
}

function articleAliasMongoFilters(aliasRows = []) {
  const aliases = Array.from(new Set(
    aliasRows.flatMap(row => Array.isArray(row.aliases) ? row.aliases : [])
  ))
  const clauses = []
  for (const alias of aliases) {
    const regex = aliasMongoRegex(alias)
    if (!regex) continue
    clauses.push(
      { title: { $regex: regex } },
      { headline: { $regex: regex } },
      { summary: { $regex: regex } },
      { content: { $regex: regex } },
      { bodyText: { $regex: regex } },
      { company: { $regex: regex } },
    )
  }
  return clauses
}

function textContainsExplicitTicker(text, ticker) {
  if (!text || !ticker) return false
  const escaped = escapeRegExp(ticker)
  return new RegExp(`(\\$${escaped}\\b|\\b(?:nasdaq|nyse|amex|otc|ticker|symbol)\\s*[:\\-]?\\s*${escaped}\\b|\\(${escaped}\\))`, 'i').test(text)
}

async function loadTickerAliasRows() {
  const db = mongoose.connection.db
  if (!db) return []
  if (Date.now() - tickerAliasCache.at < TICKER_ALIAS_CACHE_MS) return tickerAliasCache.rows

  const rows = await db.collection('screeners')
    .find(
      { ticker: { $exists: true, $nin: ['', null] }, company: { $exists: true, $nin: ['', null] } },
      { projection: { ticker: 1, company: 1, exchange: 1, quote_source: 1, finviz_status: 1 } }
    )
    .limit(12000)
    .toArray()
  const seen = new Set()
  const out = []
  for (const row of rows) {
    const ticker = normalizeTickerSymbol(row.ticker)
    if (!ticker || seen.has(ticker)) continue
    seen.add(ticker)
    if (isFundLikeCompanyName(row.company)) continue
    const aliases = companyAliases(row.company)
    if (!aliases.length) continue
    out.push({ ticker, company: row.company, aliases })
  }
  tickerAliasCache = { at: Date.now(), rows: out }
  return out
}

// A lookup keyed by the alias phrase itself, for the one place that has to test
// thousands of articles against thousands of aliases at once.
//
// inferArticleTickers walks every alias row per article and builds a RegExp for
// each — fine for the fifty rows of a page, hopeless for a whole window. Over a
// three-day window in production that shape took 22.9s, and 41.9s over seven
// days. Indexing the phrases and probing the article's own word n-grams instead
// makes the work proportional to the article's length rather than to the size
// of the alias table.
//
// The match this performs is the same one textContainsAlias performs: an alias
// is a whitespace-delimited phrase inside the normalised text. Aliases are
// always at least two words, so n-gram widths start at two.
export function buildAliasPhraseIndex(aliasRows = []) {
  const phrases = new Map()
  let maxWords = 2
  for (const row of aliasRows) {
    if (!row?.ticker || !Array.isArray(row.aliases)) continue
    for (const alias of row.aliases) {
      const words = String(alias).split(' ').filter(Boolean)
      if (words.length < 2) continue
      if (words.length > maxWords) maxWords = words.length
      if (!phrases.has(alias)) phrases.set(alias, row.ticker)
    }
  }
  return { phrases, maxWords }
}

// Whether an article would gain a ticker it does not already have. Used to
// decide which documents matched-only should additionally admit; the row's
// actual ticker is still resolved later by inferArticleTickers.
export function articleGainsInferredTicker(article = {}, index) {
  if (!index || !index.phrases.size) return false
  if (cashtagArticleTickers(article).length) return true
  const haystack = normalizedText(`${article.title || ''} ${article.summary || ''} ${article.company || ''}`)
  if (!haystack) return false
  const words = haystack.split(' ').filter(Boolean)
  for (let start = 0; start < words.length; start += 1) {
    for (let width = 2; width <= index.maxWords && start + width <= words.length; width += 1) {
      if (index.phrases.has(words.slice(start, start + width).join(' '))) return true
    }
  }
  return false
}

function buildTickerAliasContext(aliasRows = []) {
  const byTicker = new Map()
  for (const row of aliasRows) {
    if (!row?.ticker) continue
    byTicker.set(row.ticker, row)
  }
  return { rows: aliasRows, byTicker }
}

function inferArticleTickers(article = {}, aliasContext = []) {
  const aliasRows = Array.isArray(aliasContext) ? aliasContext : (aliasContext.rows || [])
  const aliasRowsByTicker = Array.isArray(aliasContext) ? null : aliasContext.byTicker
  const rawText = `${article.title || ''} ${article.summary || ''} ${article.company || ''}`
  const haystack = normalizedText(rawText)
  const cashtags = cashtagArticleTickers(article)
  if (cashtags.length) return { tickers: cashtags, method: 'explicit_cashtag', confidence: 1, rejected: [] }

  const stored = storedArticleTickers(article)
  if (stored.length) {
    if (!aliasRows.length) {
      return {
        tickers: stored,
        method: 'stored_ticker',
        confidence: 0.7,
        rejected: [],
      }
    }
    const corroborated = []
    const storedRows = aliasRowsByTicker
      ? stored.map(ticker => aliasRowsByTicker.get(ticker)).filter(Boolean)
      : aliasRows.filter(row => stored.includes(row.ticker))
    for (const row of storedRows) {
      if (row.aliases.some(alias => textContainsAlias(haystack, alias)) || textContainsExplicitTicker(rawText, row.ticker)) {
        corroborated.push(row.ticker)
      }
    }
    for (const ticker of stored) {
      if (!corroborated.includes(ticker) && textContainsExplicitTicker(rawText, ticker)) {
        corroborated.push(ticker)
      }
    }
    const unique = Array.from(new Set(corroborated))
    if (unique.length) {
      return {
        tickers: unique,
        method: unique.length === stored.length ? 'stored_verified' : 'stored_partially_verified',
        confidence: unique.length === stored.length ? 0.96 : 0.72,
        rejected: stored.filter(ticker => !unique.includes(ticker)),
      }
    }
    if (stored.length === 1 && stored[0]) {
      const source = String(article.source || article.collector || article.category || '').toLowerCase()
      const structured = lightweightArticleKind(article) === 'structured'
      const trustedStoredTicker = structured && /benzinga|tradingview|business wire|globenewswire|pr newswire|access newswire|reuters|dow jones|sec|edgar/.test(source)
      if (trustedStoredTicker) {
        return {
          tickers: stored,
          method: 'stored_single_trusted_source',
          confidence: 0.68,
          rejected: [],
        }
      }
    }
  }

  if (!haystack) return { tickers: [], method: 'none', confidence: 0 }
  const matches = []
  for (const row of aliasRows) {
    if (row.aliases.some(alias => textContainsAlias(haystack, alias))) {
      matches.push(row.ticker)
      if (matches.length >= 5) break
    }
  }
  return {
    tickers: Array.from(new Set(matches)),
    method: matches.length ? 'company_alias' : 'none',
    confidence: matches.length === 1 ? 0.82 : matches.length > 1 ? 0.55 : 0,
    rejected: stored,
  }
}

function sentimentScoreFromArticle(article = {}) {
  const direct = Number(article.sentiment_score ?? article.finbert_score ?? article.vader_score ?? article.gemini_sentiment)
  if (Number.isFinite(direct)) return Math.max(-1, Math.min(1, direct))
  const conf = Number(article.ml_confidence ?? article.sentiment_confidence ?? 0.5)
  const magnitude = Number.isFinite(conf) ? Math.max(0.1, Math.min(1, conf)) : 0.5
  const label = String(article.sentiment || '').toLowerCase()
  if (/bull|positive/.test(label)) return magnitude
  if (/bear|negative/.test(label)) return -magnitude
  return 0
}

function ruleBasedSentiment(article = {}) {
  const text = normalizedText(`${article.title || ''} ${article.summary || ''} ${article.content || ''}`)
  if (!text) return null

  const rules = [
    {
      sentiment: 'bearish',
      score: -0.7,
      reason: 'negative legal, listing, dilution, or outlook language',
      regex: /\b(negative outlook|outlooks to negative|downgrade|cuts guidance|bankruptcy|going concern|delisting|delist|halted|sec charges|subpoena|class action|lawsuit|securities fraud|investigating whether|shareholder alert|lead plaintiff|registered direct offering|public offering|atm offering|warrant exercise|reverse split)\b/i,
    },
    {
      sentiment: 'bullish',
      score: 0.62,
      reason: 'fresh business catalyst language',
      regex: /\b(launch|launches|agreement|partnership|partners with|contract|award|wins|approval|clearance|fda clearance|breakthrough|raises guidance|record revenue|acquires|acquisition|strategic investment|share repurchase|buyback|selected by|expands|collaboration)\b/i,
    },
    {
      sentiment: 'neutral',
      score: 0,
      reason: 'routine corporate update',
      regex: /\b(date for .*earnings|earnings conference call|regular quarterly common stock dividend|declares regular quarterly|monthly update|ratings? affirmed|senior leadership promotion|leadership transition)\b/i,
    },
  ]

  for (const rule of rules) {
    if (rule.regex.test(text)) return rule
  }
  return null
}

function correctedArticleSentiment(article = {}) {
  const original = String(article.sentiment || 'neutral').toLowerCase()
  const originalScore = sentimentScoreFromArticle(article)
  const rule = ruleBasedSentiment(article)
  if (!rule) {
    return {
      sentiment: original || 'neutral',
      score: originalScore,
      original,
      reason: article.sentiment_reason || '',
      ruleApplied: false,
    }
  }
  return {
    sentiment: rule.sentiment,
    score: rule.score,
    original,
    reason: rule.reason,
    ruleApplied: rule.sentiment !== original || Math.abs(rule.score - originalScore) >= 0.2,
  }
}

function legalSpamMongoFilter() {
  return {
    $nor: [
      { title: LEGAL_SPAM_RE },
      { content: LEGAL_SPAM_RE },
      { company: LEGAL_SPAM_RE },
      { source: LEGAL_SPAM_RE },
    ],
  }
}

function articleKindFilter(kind) {
  const requested = String(kind || '').toLowerCase()
  if (requested === 'filings' || requested === 'sec_filing' || requested === 'sec') {
    return filingKindFilter()
  }
  const publicFilter = {
    $or: [
      { article_kind: { $in: ['public', 'unstructured'] } },
      { category: { $in: PUBLIC_ARTICLE_CATEGORIES } },
      { collector: 'unstructured_news_title_only_v1' },
      { source: /unstructured/i },
    ],
  }
  if (requested === 'public' || requested === 'unstructured') return publicFilter
  if (requested !== 'structured') return null
  return {
    $or: [
      { article_kind: 'structured' },
      {
        $and: [
          { article_kind: { $nin: ['structured', 'public', 'unstructured'] } },
          { category: { $nin: PUBLIC_ARTICLE_CATEGORIES } },
          { collector: { $ne: 'unstructured_news_title_only_v1' } },
          { source: { $not: /unstructured/i } },
        ],
      },
    ],
  }
}

function filingKindFilter() {
  return {
    $or: [
      { source: FILING_SOURCE_RE },
      { source_type: 'filing' },
      { category: { $in: ['filings', 'sec_filing'] } },
    ],
  }
}

function shouldIncludeFilings(req, { source, category, articleKind }) {
  if (req.query.include_filings === '1' || req.query.include_filings === 'true') return true
  if (FILING_CATEGORY_NAMES.has(String(category || '').trim().toLowerCase())) return true
  if (FILING_CATEGORY_NAMES.has(String(articleKind || '').trim().toLowerCase())) return true
  return FILING_SOURCE_RE.test(String(source || ''))
}

function isExplicitFilingRequest({ source, category, articleKind }) {
  if (FILING_CATEGORY_NAMES.has(String(category || '').trim().toLowerCase())) return true
  if (FILING_CATEGORY_NAMES.has(String(articleKind || '').trim().toLowerCase())) return true
  return FILING_SOURCE_RE.test(String(source || ''))
}

function mergeFacetRow(rows, key, value, count) {
  if (!count) return rows
  const existing = rows.find(row => String(row[key] || '').toLowerCase() === String(value).toLowerCase())
  if (existing) existing.count = Math.max(Number(existing.count || 0), count)
  else rows.push({ [key]: value, count })
  return rows.sort((a, b) => Number(b.count || 0) - Number(a.count || 0))
}

function lightweightArticleKind(article = {}) {
  return article.article_kind || (PUBLIC_ARTICLE_CATEGORIES.includes(article.category) || article.collector === 'unstructured_news_title_only_v1' ? 'public' : 'structured')
}

function mapLightweightArticle(article = {}, moverTickers = []) {
  const fetchedSeconds = normalizeUnixSeconds(article.fetched_date || article.detected_at || article.feed_sort_time, Math.floor(Date.now() / 1000))
  const publishSeconds = normalizeUnixSeconds(article.publish_date || article.feed_sort_time, fetchedSeconds)
  const tickers = storedArticleTickers(article)
  const correctedSentiment = correctedArticleSentiment(article)
  return {
    ...article,
    id: article.article_id,
    ticker: tickers[0] || '',
    tickers,
    stored_ticker: article.ticker || '',
    original_tickers: articleTickerValues(article),
    ticker_match_method: tickers.length ? 'stored_ticker_lightweight' : 'none',
    ticker_match_confidence: tickers.length ? 0.8 : 0,
    ticker_match_verified: tickers.length > 0,
    sentiment: correctedSentiment.sentiment,
    sentiment_score: Number(correctedSentiment.score.toFixed(3)),
    sentiment_original: correctedSentiment.original,
    sentiment_rule_applied: correctedSentiment.ruleApplied,
    sentiment_reason: correctedSentiment.reason || article.sentiment_reason || '',
    publish_date: publishSeconds,
    fetched_date: fetchedSeconds,
    detected_at: normalizeUnixSeconds(article.detected_at, fetchedSeconds),
    article_kind: lightweightArticleKind(article),
    positive_mover_match: moverTickers.length ? matchedTickers(tickers, moverTickers).length > 0 : false,
    matched_mover_tickers: moverTickers.length ? matchedTickers(tickers, moverTickers) : tickers,
  }
}

function dateFilterFromRequest({ from, to, feed, today, recent_days, days, window_minutes }, { filingFacet = false } = {}) {
  if (from || to) {
    const dateRange = {}
    if (from) dateRange.$gte = Number(from)
    if (to) dateRange.$lte = Number(to)
    return { publish_date: dateRange }
  }

  const rollingMinutes = Number(window_minutes)
  if (Number.isFinite(rollingMinutes) && rollingMinutes > 0) {
    const boundedMinutes = Math.max(5, Math.min(7 * 24 * 60, Math.round(rollingMinutes)))
    return articleWindowFilter(Date.now() - boundedMinutes * 60 * 1000)
  }

  const todayOnly = feed === 'today' || today === '1' || today === 'true' || (!recent_days && !days)
  const requestedDays = filingFacet
    ? Math.max(7, Math.floor(Number(recent_days || days || 7) || 7))
    : Math.max(1, Math.floor(Number(recent_days || days || 3) || 3))

  return todayOnly && !filingFacet ? todayArticleFilter() : recentArticleFilter(requestedDays)
}

// GET /api/articles
// Query params: sentiment, source, ticker, ticker_only, from, to,
// window_minutes, recent_days, limit, skip, offset
router.get('/recent-lite', async (req, res) => {
  try {
    const {
      article_kind,
      mover_only,
      mover_source,
      recent_days,
      days,
      ticker_only,
      limit = 24,
    } = req.query
    const pageLimit = Math.max(1, Math.min(100, Number(limit || 24) || 24))
    const windowDays = Math.max(1, Math.min(10, Math.floor(Number(recent_days || days || 3) || 3)))
    const cutoffSec = Math.floor(Date.now() / 1000) - windowDays * 86_400
    const moverTickers = mover_only === '1' || mover_only === 'true'
      ? await loadPositiveMoverTickers(mover_source)
      : []
    const tickerOnly = ticker_only === '1' || ticker_only === 'true'
    const scanLimit = tickerOnly
      ? Math.max(pageLimit * 100, Math.floor(Number(process.env.ARTICLE_RECENT_LITE_TICKER_SCAN_LIMIT || 3000) || 3000))
      : Math.max(pageLimit * 20, 300)
    const rawRows = await Article.collection.find({
      suppress_from_main_news: { $ne: true },
      feed_sort_time: { $gte: cutoffSec },
    })
      .project(ARTICLE_LIST_PROJECTION)
      .sort({ feed_sort_time: -1 })
      .limit(scanLimit)
      // No .hint(): a hint is a hard requirement, so when feed_sort_time_desc
      // was missing this whole route returned BadValue and the Overview news
      // feed went blank, rather than merely running slower. With the index
      // ensured at startup the planner picks it on its own — explain confirms
      // hinted and unhinted produce the identical IXSCAN plan — so forcing it
      // bought nothing and only removed the ability to degrade gracefully.
      .maxTimeMS(8_000)
      .toArray()
    const requestedKind = String(article_kind || '').toLowerCase()
    const articles = rawRows
      .map(row => mapLightweightArticle(row, moverTickers))
      .filter(row => {
        if (requestedKind && requestedKind !== 'all' && row.article_kind !== requestedKind) return false
        if (tickerOnly && !row.tickers.length) return false
        if (moverTickers.length && !row.matched_mover_tickers.length) return false
        return true
      })
      .slice(0, pageLimit)
    const nowParts = easternParts(new Date())
    const responseWindowStart = new Date(calendarWindowStart(windowDays))
    res.json({
      articles,
      total: articles.length,
      raw_total: null,
      returned: articles.length,
      raw_scanned: rawRows.length,
      limit: pageLimit,
      facets_included: false,
      post_ticker_verification: false,
      lightweight: true,
      ticker_only: tickerOnly,
      window_days: windowDays,
      market_window_start: responseWindowStart.toISOString(),
      market_window_end: new Date().toISOString(),
      market_window_timezone: MARKET_WINDOW_TIME_ZONE,
      window_date: `${String(nowParts.year).padStart(4, '0')}-${String(nowParts.month).padStart(2, '0')}-${String(nowParts.day).padStart(2, '0')}`,
      mover_only: mover_only === '1' || mover_only === 'true',
      mover_source: mover_source || 'all',
      mover_ticker_count: moverTickers.length,
    })
  } catch (err) {
    console.error('GET /api/articles/recent-lite failed:', err)
    res.status(500).json({ error: 'Failed to load recent articles' })
  }
})

router.get('/', async (req, res) => {
  try {
    const {
      sentiment,
      source,
      category,
      search,
      article_kind,
      ticker,
      ticker_only,
      mover_only,
      mover_source,
      from,
      to,
      window_minutes,
      recent_days,
      days,
      today,
      feed,
      facets,
      limit = 100,
      skip = 0,
      offset = 0,
    } = req.query

    const pageSkip = Number(offset || skip || 0)
    const pageLimit = Math.max(1, Math.min(1000, Number(limit || 100) || 100))
    const explicitFilingRequest = isExplicitFilingRequest({ source, category, articleKind: article_kind })
    const includeFilings = shouldIncludeFilings(req, { source, category, articleKind: article_kind })
    const includeFacets = facets !== '0' && facets !== 'false'
    const lightweightList = !includeFacets && pageSkip === 0 && pageLimit <= 100

    const filter = includeFilings ? {} : { suppress_from_main_news: { $ne: true } }
    const tickerFilters = []
    const policyFilters = [approvedNewsSourceMongoFilter('source'), legalSpamMongoFilter()]
    let moverTickers = []
    const requestedTicker = normalizeTickerSymbol(ticker)
    let requestedTickerAliasRows = []
    let tickerInferenceScanned = 0
    let tickerInferenceRescued = 0
    let tickerInferenceTruncated = false

    if (sentiment) filter.sentiment = sentiment
    if (source) filter.source = source
    if (category) filter.category = category
    if (search) {
      const query = String(search).trim().slice(0, 100)
      if (query) filter.$and = [...(filter.$and || []), { $or: [
        { title: { $regex: escapeRegExp(query), $options: 'i' } },
        { company: { $regex: escapeRegExp(query), $options: 'i' } },
      ] }]
    }
    if (req.query.keywords_only === '1' || req.query.keywords_only === 'true') {
      filter.keyword_match = { $exists: true, $ne: [] }
    }
    const kindFilter = articleKindFilter(article_kind)
    if (kindFilter) filter.$and = [...(filter.$and || []), kindFilter]
    if (requestedTicker) {
      const aliasRows = await loadTickerAliasRows()
      requestedTickerAliasRows = aliasRows.filter(row => row.ticker === requestedTicker)
      tickerFilters.push({
        $or: [
          { ticker: { $regex: tickerCsvRegex([requestedTicker]) } },
          { tickers: requestedTicker },
          { tickers_mentioned: requestedTicker },
          { matched_mover_tickers: requestedTicker },
          ...articleAliasMongoFilters(requestedTickerAliasRows),
        ],
      })
    }
    // "Matched only" used to be answered entirely in Mongo, by requiring one of
    // the raw ticker fields to already hold a valid symbol. But the ticker is
    // worked out later, in mapArticle -> inferArticleTickers, which can also
    // recognise a company by name. So an approved newswire story whose raw
    // ticker field was empty at ingestion was dropped before inference ever ran
    // — "RBLX Investors Have Opportunity to Join Roblox Corporation Fraud
    // Investigation", raw ticker "", is a real example from production.
    //
    // The filter is therefore no longer applied here. Instead the request joins
    // the post-verification path below, which walks a bounded candidate set,
    // runs the same inference the response already uses, and keeps the rows
    // that actually resolve to a ticker. That is the same machinery a ticker or
    // mover query already uses, so matched-only now agrees with the ticker
    // shown on the row rather than second-guessing it.
    const tickerOnlyRequested = ticker_only === '1' || ticker_only === 'true'
    if (mover_only === '1' || mover_only === 'true') {
      moverTickers = await loadPositiveMoverTickers(mover_source)
      const moverRegex = tickerCsvRegex(moverTickers)
      tickerFilters.push(moverRegex ? {
        $or: [
          { ticker: { $regex: moverRegex } },
          { tickers: { $in: moverTickers } },
          { tickers_mentioned: { $in: moverTickers } },
          { matched_mover_tickers: { $in: moverTickers } },
        ],
      } : { ticker: '__NO_CURRENT_MOVER_TICKERS__' })
    }

    Object.assign(filter, dateFilterFromRequest(
      { from, to, feed, today, recent_days, days, window_minutes },
      { filingFacet: explicitFilingRequest && includeFilings }
    ))

    if (tickerOnlyRequested) {
      // Only the documents WITHOUT a usable raw symbol can gain anything from
      // inference, and there are far fewer of them than there are articles —
      // 5,379 against 24,797 over a three-day window in production. Resolving
      // just those, then handing Mongo an id list, keeps the page on its normal
      // paginated query: exact totals, no in-memory scan of the whole window,
      // and no truncated tail. Scanning everything instead cost 434ms at three
      // days and 654ms at seven, and still truncated.
      const aliasRows = await loadTickerAliasRows()
      const aliasPhraseIndex = buildAliasPhraseIndex(aliasRows)
      const rawSymbolFilter = {
        $or: RAW_TICKER_FIELDS.map(field => ({ [field]: { $regex: VALID_TICKER_FIELD_REGEX } })),
      }
      const inferenceCandidates = await Article.collection
        .find({ ...filter, $and: [...(filter.$and || []), ...policyFilters, { $nor: [rawSymbolFilter] }] })
        .project({ _id: 1, title: 1, summary: 1, company: 1, ticker: 1, source: 1, collector: 1, category: 1 })
        .sort(TICKER_INFERENCE_SORT)
        .limit(TICKER_INFERENCE_SCAN_LIMIT)
        .maxTimeMS(15_000)
        .toArray()
      const inferredIds = []
      for (const candidate of inferenceCandidates) {
        if (inferredIds.length >= TICKER_INFERENCE_MATCH_LIMIT) break
        if (articleGainsInferredTicker(candidate, aliasPhraseIndex)) inferredIds.push(candidate._id)
      }
      tickerInferenceScanned = inferenceCandidates.length
      tickerInferenceRescued = inferredIds.length
      tickerInferenceTruncated = inferenceCandidates.length >= TICKER_INFERENCE_SCAN_LIMIT
      // Additive by construction: everything the old raw-field test admitted is
      // still admitted, plus the rows inference just recognised.
      tickerFilters.push(inferredIds.length
        ? { $or: [rawSymbolFilter, { _id: { $in: inferredIds } }] }
        : rawSymbolFilter)
    }

    filter.$and = [...(filter.$and || []), ...policyFilters, ...tickerFilters]

    const sourceFacetFilter = { ...filter }
    const categoryFacetFilter = { ...filter }
    delete sourceFacetFilter.source
    delete categoryFacetFilter.category

    const filingFacetFilter = {
      ...(sentiment ? { sentiment } : {}),
      suppress_from_main_news: { $ne: '__never_exclude_filings_facet__' },
      ...dateFilterFromRequest({ from, to, feed, today, recent_days, days, window_minutes }, { filingFacet: true }),
      $and: [
        ...((filter.$and || []).filter(part => part !== kindFilter)),
        filingKindFilter(),
        approvedNewsSourceMongoFilter('source'),
      ],
    }

    const sortSpec = {
      main_feed_priority: -1,
      feed_sort_time: -1,
      publish_date: -1,
      fetched_date: -1,
      detected_at: -1
    }
    // Matched-only resolves its extra rows before the query rather than after
    // it, so it keeps the fast paginated path and does not join verification.
    const requirePostTickerVerification = Boolean(requestedTicker) || mover_only === '1' || mover_only === 'true'
    const needsTickerAliasRows = requirePostTickerVerification || !tickerOnlyRequested

    const [rawTotal, sourceRowsRaw, categoryRowsRaw, filingFacetCount, tickerAliasRows] = await Promise.all([
      lightweightList ? Promise.resolve(null) : Article.collection.countDocuments(filter),
      includeFacets ? Article.collection.aggregate([
        { $match: sourceFacetFilter },
        { $match: { source: { $exists: true, $nin: ['', null] } } },
        { $group: { _id: '$source', count: { $sum: 1 } } },
        { $project: { _id: 0, source: '$_id', count: 1 } },
        { $sort: { count: -1 } },
      ]).toArray() : Promise.resolve([]),
      includeFacets ? Article.collection.aggregate([
        { $match: categoryFacetFilter },
        { $match: { category: { $exists: true, $nin: ['', null] } } },
        { $group: { _id: '$category', count: { $sum: 1 } } },
        { $project: { _id: 0, category: '$_id', count: 1 } },
        { $sort: { count: -1 } },
      ]).toArray() : Promise.resolve([]),
      includeFacets ? Article.collection.countDocuments(filingFacetFilter) : Promise.resolve(0),
      needsTickerAliasRows ? loadTickerAliasRows() : Promise.resolve([]),
    ])

    const sourceRows = mergeFacetRow(sourceRowsRaw, 'source', 'SEC EDGAR', filingFacetCount)
    const categoryRows = mergeFacetRow(categoryRowsRaw, 'category', 'filings', filingFacetCount)
    const tickerAliasContext = buildTickerAliasContext(tickerAliasRows)

    const mapArticle = (a) => {
      const fetchedSeconds = normalizeUnixSeconds(
        a.fetched_date || a.detected_at,
        Math.floor(Date.now() / 1000)
      )

      const publishSeconds = normalizeUnixSeconds(a.publish_date, fetchedSeconds)
      const inferred = inferArticleTickers(a, tickerAliasContext)
      const normalizedTickers = inferred.tickers
      const primaryTicker = normalizedTickers[0] || ''
      const correctedSentiment = correctedArticleSentiment(a)

      return {
        ...a,
        id: a.article_id,
        ticker: primaryTicker,
        tickers: normalizedTickers,
        stored_ticker: a.ticker || '',
        original_tickers: articleTickerValues(a),
        ticker_match_method: a.ticker_match_method || inferred.method,
        ticker_match_confidence: a.ticker_match_confidence ?? inferred.confidence,
        ticker_match_rejected: inferred.rejected || [],
        ticker_match_verified: normalizedTickers.length > 0 && Number(inferred.confidence || 0) >= 0.55,
        sentiment: correctedSentiment.sentiment,
        sentiment_score: Number(correctedSentiment.score.toFixed(3)),
        sentiment_original: correctedSentiment.original,
        sentiment_rule_applied: correctedSentiment.ruleApplied,
        sentiment_reason: correctedSentiment.reason || a.sentiment_reason || '',
        publish_date: publishSeconds,
        fetched_date: fetchedSeconds,
        detected_at: normalizeUnixSeconds(a.detected_at, fetchedSeconds),
        article_kind: a.article_kind || (PUBLIC_ARTICLE_CATEGORIES.includes(a.category) || a.collector === 'unstructured_news_title_only_v1' ? 'public' : 'structured'),
        positive_mover_match: moverTickers.length ? matchedTickers(normalizedTickers, moverTickers).length > 0 : false,
        matched_mover_tickers: moverTickers.length ? matchedTickers(normalizedTickers, moverTickers) : normalizedTickers,
      }
    }

    const articlePassesTickerVerification = (article) => {
      const tickers = Array.isArray(article.tickers) ? article.tickers.map(normalizeTickerSymbol).filter(Boolean) : []
      if (!tickers.length) return false
      if (requestedTicker && !tickers.includes(requestedTicker)) return false
      if (moverTickers.length && !matchedTickers(tickers, moverTickers).length) return false
      return true
    }

    let responseArticles = []
    let total = rawTotal
    let rawScanned = 0
    let unverifiedFiltered = 0
    let totalMayBeTruncated = false

    if (requirePostTickerVerification) {
      const scanLimit = lightweightList
        ? Math.max(pageLimit * 40, Math.floor(Number(process.env.ARTICLE_LIGHTWEIGHT_SCAN_LIMIT || 1000) || 1000))
        : Math.max(1000, Math.floor(Number(process.env.ARTICLE_VERIFICATION_SCAN_LIMIT || 20000) || 20000))
      const candidateArticles = await Article.collection.find(filter)
        .project(ARTICLE_LIST_PROJECTION)
        .sort(sortSpec)
        .limit(scanLimit)
        .maxTimeMS(lightweightList ? 15_000 : 45_000)
        .toArray()
      rawScanned = candidateArticles.length
      totalMayBeTruncated = rawTotal == null ? candidateArticles.length >= scanLimit : rawTotal > scanLimit
      const verifiedArticles = candidateArticles
        .map(mapArticle)
        .filter(articlePassesTickerVerification)
        .sort((a, b) => Number(b.publish_date || b.fetched_date || b.detected_at || 0) - Number(a.publish_date || a.fetched_date || a.detected_at || 0))
      total = verifiedArticles.length
      unverifiedFiltered = rawScanned - verifiedArticles.length
      responseArticles = verifiedArticles.slice(pageSkip, pageSkip + pageLimit)
    } else {
      const pageArticles = await Article.collection.find(filter)
        .project(ARTICLE_LIST_PROJECTION)
        .sort(sortSpec)
        .skip(pageSkip)
        .limit(pageLimit)
        .maxTimeMS(lightweightList ? 15_000 : 45_000)
        .toArray()
      rawScanned = pageArticles.length
      responseArticles = pageArticles.map(mapArticle)
    }

    const responseRollingMinutes = Number.isFinite(Number(window_minutes)) && Number(window_minutes) > 0
      ? Math.max(5, Math.min(7 * 24 * 60, Math.round(Number(window_minutes))))
      : null
    const responseTodayOnly = responseRollingMinutes == null && !explicitFilingRequest && (feed === 'today' || today === '1' || today === 'true' || (!recent_days && !days))
    const responseParts = easternParts(new Date())
    const responseWindowDays = explicitFilingRequest
      ? Math.max(7, Math.floor(Number(recent_days || days || 7) || 7))
      : Math.max(1, Math.floor(Number(recent_days || days || 3) || 3))
    const responseWindowStart = responseRollingMinutes != null
      ? new Date(Date.now() - responseRollingMinutes * 60 * 1000)
      : responseTodayOnly
        ? easternLocalToUtc(responseParts.year, responseParts.month, responseParts.day, 0)
        : new Date(calendarWindowStart(responseWindowDays))
    const responseTomorrow = shiftLocalDate(responseParts.year, responseParts.month, responseParts.day, 1)
    const responseWindowEnd = responseTodayOnly
      ? new Date(easternLocalToUtc(responseTomorrow.year, responseTomorrow.month, responseTomorrow.day, 0).getTime() - 1)
      : new Date(Date.now())

    res.json({
      articles: responseArticles,
      total,
      raw_total: rawTotal,
      skip: pageSkip,
      offset: pageSkip,
      limit: pageLimit,
      returned: responseArticles.length,
      raw_scanned: rawScanned,
      unverified_filtered: unverifiedFiltered,
      total_may_be_truncated: totalMayBeTruncated,
      ticker_inference_scanned: tickerInferenceScanned,
      ticker_inference_rescued: tickerInferenceRescued,
      ticker_inference_truncated: tickerInferenceTruncated,
      post_ticker_verification: requirePostTickerVerification,
      facets_included: includeFacets,
      sources: sourceRows,
      categories: categoryRows,
      market_window_start: responseWindowStart.toISOString(),
      market_window_end: responseWindowEnd.toISOString(),
      market_window_timezone: MARKET_WINDOW_TIME_ZONE,
      window_mode: responseRollingMinutes != null ? 'rolling_minutes' : responseTodayOnly ? 'today' : 'calendar_days_et',
      window_minutes: responseRollingMinutes,
      window_days: responseTodayOnly ? 1 : responseWindowDays,
      window_date: responseTodayOnly
        ? `${String(responseParts.year).padStart(4, '0')}-${String(responseParts.month).padStart(2, '0')}-${String(responseParts.day).padStart(2, '0')}`
        : null,
      mover_only: mover_only === '1' || mover_only === 'true',
      mover_source: mover_source || 'all',
      mover_ticker_count: moverTickers.length,
    })
  } catch (err) {
    console.error('GET /api/articles failed:', err)
    res.status(500).json({ error: 'Failed to load articles' })
  }
})

// Exported for tests: matched-only is now decided by inference rather than by a
// Mongo filter, so the behaviour has to be assertable directly.
export { inferArticleTickers, buildTickerAliasContext, companyAliases }

export default router
