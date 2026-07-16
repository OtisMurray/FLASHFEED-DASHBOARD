#!/usr/bin/env node

const path = require('path')
let mongoose
try {
  mongoose = require(path.join(__dirname, '..', 'Infrastructure', 'server', 'node_modules', 'mongoose'))
} catch (_) {
  mongoose = require(path.join('/app', 'node_modules', 'mongoose'))
}

const GENERIC_COMPANY_ALIASES = new Set([
  'inc', 'corp', 'corporation', 'company', 'holdings', 'group', 'limited', 'ltd',
  'plc', 'adr', 'common stock', 'class a', 'technologies', 'technology',
])
const BAD_ALIAS_EDGE_WORDS = new Set(['a', 'an', 'and', 'by', 'for', 'from', 'in', 'of', 'on', 'the', 'to', 'with'])

function isFundLikeCompanyName(company = '') {
  return /\b(etf|etn|fund|index|index fund)\b/i.test(String(company || ''))
}

function argValue(name, fallback = '') {
  const prefix = `--${name}=`
  const inline = process.argv.find(arg => arg.startsWith(prefix))
  if (inline) return inline.slice(prefix.length)
  const index = process.argv.indexOf(`--${name}`)
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1]
  return fallback
}

function normalizeTicker(value) {
  const ticker = String(value || '').trim().replace(/^\$/, '').toUpperCase()
  return /^[A-Z][A-Z0-9.-]{0,5}$/.test(ticker) ? ticker : ''
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
  if (words.length >= 2) aliases.add(words.slice(0, 2).join(' '))
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

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function textContainsAlias(haystack, alias) {
  if (!haystack || !alias) return false
  return new RegExp(`(^|\\s)${escapeRegExp(alias)}(\\s|$)`, 'i').test(haystack)
}

function articleTickerValues(article = {}) {
  const values = new Set()
  const push = (value) => {
    if (Array.isArray(value)) return value.forEach(push)
    String(value || '').split(/[,\s]+/).forEach(part => {
      const ticker = normalizeTicker(part)
      if (ticker) values.add(ticker)
    })
  }
  push(article.ticker)
  push(article.tickers)
  push(article.matched_mover_tickers)
  push(article.tickers_mentioned)
  const text = `${article.title || ''} ${article.summary || ''} ${article.content || ''}`
  for (const match of text.matchAll(/\$([A-Za-z][A-Za-z0-9.-]{0,5})\b/g)) {
    const ticker = normalizeTicker(match[1])
    if (ticker) values.add(ticker)
  }
  return Array.from(values)
}

async function loadAliases(db) {
  const rows = await db.collection('screeners')
    .find(
      { ticker: { $exists: true, $nin: ['', null] }, company: { $exists: true, $nin: ['', null] } },
      { projection: { ticker: 1, company: 1, quote_source: 1, finviz_status: 1 } }
    )
    .limit(12000)
    .toArray()
  const seen = new Set()
  const out = []
  for (const row of rows) {
    const ticker = normalizeTicker(row.ticker)
    if (!ticker || seen.has(ticker)) continue
    if (isFundLikeCompanyName(row.company)) continue
    const aliases = companyAliases(row.company)
    if (!aliases.length) continue
    seen.add(ticker)
    out.push({ ticker, company: row.company, aliases })
  }
  return out
}

function infer(article, aliasRows) {
  const direct = articleTickerValues(article)
  if (direct.length) return { tickers: direct, method: 'stored_or_cashtag', confidence: 1 }
  const haystack = normalizedText(`${article.title || ''} ${article.summary || ''} ${article.company || ''}`)
  if (!haystack) return { tickers: [], method: 'none', confidence: 0 }
  const matches = []
  for (const row of aliasRows) {
    if (row.aliases.some(alias => textContainsAlias(haystack, alias))) {
      matches.push(row.ticker)
      if (matches.length >= 3) break
    }
  }
  return {
    tickers: Array.from(new Set(matches)),
    method: matches.length ? 'company_alias' : 'none',
    confidence: matches.length === 1 ? 0.82 : matches.length > 1 ? 0.55 : 0,
  }
}

async function main() {
  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI || argValue('mongo', 'mongodb://localhost:27017/feedflash')
  const recentDays = Math.max(1, Math.min(30, Number(argValue('recent-days', '3'))))
  const limit = Math.max(1, Math.min(5000, Number(argValue('limit', '1000'))))
  const dryRun = ['1', 'true', 'yes'].includes(String(argValue('dry-run', 'false')).toLowerCase())
  const sinceSec = Math.floor(Date.now() / 1000) - recentDays * 86400

  await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 10000 })
  const db = mongoose.connection.db
  const aliasRows = await loadAliases(db)
  const articles = await db.collection('articles')
    .find({
      $and: [
        {
          $or: [
            { publish_date: { $gte: sinceSec } },
            { fetched_date: { $gte: sinceSec } },
            { detected_at: { $gte: sinceSec } },
            { createdAt: { $gte: new Date(sinceSec * 1000) } },
          ],
        },
        {
          $or: [
            { ticker: { $exists: false } },
            { ticker: null },
            { ticker: '' },
            { tickers: { $exists: false } },
            { tickers: { $size: 0 } },
          ],
        },
      ],
    }, { projection: { title: 1, summary: 1, content: 1, company: 1, ticker: 1, tickers: 1, tickers_mentioned: 1, matched_mover_tickers: 1, source: 1 } })
    .sort({ fetched_date: -1, detected_at: -1, publish_date: -1 })
    .limit(limit)
    .toArray()

  const ops = []
  const examples = []
  let matched = 0
  for (const article of articles) {
    const result = infer(article, aliasRows)
    if (!result.tickers.length || result.confidence < 0.8) continue
    matched += 1
    examples.push({ title: article.title, source: article.source, tickers: result.tickers, method: result.method })
    ops.push({
      updateOne: {
        filter: { _id: article._id },
        update: {
          $set: {
            ticker: result.tickers.join(','),
            tickers: result.tickers,
            tickers_mentioned: result.tickers,
            ticker_match_method: result.method,
            ticker_match_confidence: result.confidence,
            ticker_match_updated_at: new Date(),
          },
        },
      },
    })
  }

  let writeResult = null
  if (!dryRun && ops.length) {
    writeResult = await db.collection('articles').bulkWrite(ops, { ordered: false })
  }
  await mongoose.disconnect()

  console.log(JSON.stringify({
    ok: true,
    dry_run: dryRun,
    recent_days: recentDays,
    scanned: articles.length,
    aliases: aliasRows.length,
    matched,
    modified: writeResult?.modifiedCount || 0,
    examples: examples.slice(0, 12),
  }, null, 2))
}

main().catch(async err => {
  console.error(JSON.stringify({ ok: false, error: String(err.message || err) }, null, 2))
  try { await mongoose.disconnect() } catch (_) {}
  process.exit(1)
})
