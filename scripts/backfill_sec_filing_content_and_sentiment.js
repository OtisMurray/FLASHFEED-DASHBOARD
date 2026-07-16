#!/usr/bin/env node
const path = require('path')
const mongoose = require(path.join(__dirname, '..', 'Infrastructure', 'server', 'node_modules', 'mongoose'))

function argValue(name, fallback = '') {
  const direct = process.argv.find(arg => arg.startsWith(`--${name}=`))
  if (direct) return direct.slice(name.length + 3)
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] || fallback : fallback
}

function seconds(value) {
  if (!value) return 0
  if (value instanceof Date) return Math.floor(value.getTime() / 1000)
  const n = Number(value)
  if (Number.isFinite(n) && n > 0) return n > 1_000_000_000_000 ? Math.floor(n / 1000) : Math.floor(n)
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

function scoreFilingText(title, text, formType = '') {
  const input = `${title || ''} ${String(text || '').slice(0, 12000)}`.toLowerCase()
  const bullish = [
    /material agreement|contract|partnership|collaboration|award|acquisition completed|strategic/i,
    /raises? guidance|increases? outlook|record revenue|profitability|positive/i,
  ]
  const bearish = [
    /going concern|default|bankruptcy|delisting|material weakness|restatement/i,
    /offering|dilution|warrant|termination|resignation|investigation|subpoena/i,
  ]
  let score = 0
  for (const pattern of bullish) if (pattern.test(input)) score += 0.35
  for (const pattern of bearish) if (pattern.test(input)) score -= 0.35
  score = Math.max(-1, Math.min(1, score))
  const confidence = Math.min(0.85, 0.25 + Math.abs(score) * 0.55 + Math.min(0.05, String(text || '').length / 200000))
  const form = String(formType || title || '').toUpperCase()
  const impactWeight = String(text || '').length < 200 ? 0.03 : /8-K/.test(form) ? 0.75 : /10-Q|10-K/.test(form) ? 0.35 : /S-1|424B|FORM 4/.test(form) ? 0.2 : 0.25
  return {
    filingSentiment: Number(score.toFixed(3)),
    filingSentimentConfidence: Number(confidence.toFixed(3)),
    filingImpactWeight: Number(impactWeight.toFixed(3)),
    sentiment: score > 0.08 ? 'bullish' : score < -0.08 ? 'bearish' : 'neutral',
    mlConfidence: Number(confidence.toFixed(3)),
  }
}

async function fetchText(url, userAgent) {
  if (!url || !/^https?:\/\//i.test(url)) return { ok: false, text: '', finalUrl: url, error: 'missing_url' }
  const res = await fetch(url, {
    headers: {
      'User-Agent': userAgent,
      'Accept-Encoding': 'gzip, deflate, br',
      Accept: 'text/html,application/xhtml+xml,text/plain,*/*',
    },
  })
  if (!res.ok) return { ok: false, text: '', finalUrl: url, error: `HTTP ${res.status}` }
  const html = await res.text()
  return { ok: true, text: stripHtml(html), finalUrl: res.url || url, error: null }
}

async function main() {
  const recentDays = Math.max(1, Math.min(30, Number(argValue('recent-days', '7'))))
  const limit = Math.max(1, Math.min(500, Number(argValue('limit', '100'))))
  const dryRun = ['1', 'true', 'yes'].includes(String(argValue('dry-run', 'false')).toLowerCase())
  const mongoUri = process.env.MONGO_URI || 'mongodb://localhost:27017/feedflash'
  const userAgent = process.env.SEC_USER_AGENT || 'FeedFlash/1.0 otisemurray@icloud.com'
  const cutoff = Math.floor(Date.now() / 1000) - recentDays * 86400

  await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 8000 })
  const db = mongoose.connection.db
  const query = {
    $and: [
      {
        $or: [
          { source: { $regex: 'SEC|EDGAR', $options: 'i' } },
          { is_sec_filing: true },
          { isFiling: true },
          { event_type: 'sec_filing' },
          { category: 'filings' },
          { source_type: 'filing' },
        ],
      },
      {
        $or: [
          { publish_date: { $gte: cutoff } },
          { fetched_date: { $gte: cutoff } },
          { detected_at: { $gte: cutoff } },
        ],
      },
      {
        $or: [
          { contentText: { $exists: false } },
          { contentText: '' },
          { contentCharLength: { $lt: 200 } },
          { filingContentStatus: { $in: [null, '', 'missing', 'missing_or_weak'] } },
        ],
      },
    ],
  }

  const docs = await db.collection('articles').find(query).sort({ publish_date: -1, fetched_date: -1 }).limit(limit).toArray()
  const result = { dryRun, scanned: docs.length, updated: 0, failed: 0, rows: [] }
  for (const doc of docs) {
    const rawUrl = doc.primaryDocumentUrl || doc.primary_document_url || doc.secUrl || doc.sec_url || ''
    const fallbackUrl = /sec\.gov/i.test(String(doc.url || '')) ? doc.url : ''
    const url = rawUrl || fallbackUrl
    try {
      const fetched = /sec\.gov/i.test(String(url || ''))
        ? await fetchText(url, userAgent)
        : { ok: false, text: '', finalUrl: url || '', error: 'missing_primary_sec_url' }
      const contentText = fetched.text || ''
      const contentCharLength = contentText.length
      const score = contentCharLength >= 200
        ? scoreFilingText(doc.title, contentText, doc.formType || doc.form_type)
        : { filingSentiment: 0, filingSentimentConfidence: 0, filingImpactWeight: 0.03, sentiment: 'neutral', mlConfidence: 0 }
      const update = {
        is_sec_filing: true,
        isFiling: true,
        source_type: 'filing',
        contentText,
        contentCharLength,
        filingContentStatus: contentCharLength >= 200 ? 'content_extracted' : 'missing_or_weak',
        filingUsedInSentiment: contentCharLength >= 200,
        filingSentiment: score.filingSentiment,
        filingSentimentConfidence: score.filingSentimentConfidence,
        filingImpactWeight: score.filingImpactWeight,
        filingAgeHours: Number(((Date.now() / 1000 - seconds(doc.publish_date || doc.fetched_date || doc.detected_at)) / 3600).toFixed(2)),
        filingUsedInPrediction: false,
        filingSentimentModel: 'deterministic_sec_filing_v1',
        filingSentimentGeneratedAt: new Date(),
        sentiment: score.sentiment,
        ml_confidence: score.mlConfidence,
        sentiment_score: score.filingSentiment,
        primaryDocumentUrl: fetched.finalUrl || url,
        sec_backfill_error: fetched.error,
        sec_backfilled_at: new Date(),
      }
      if (!dryRun) await db.collection('articles').updateOne({ _id: doc._id }, { $set: update })
      result.updated += fetched.ok ? 1 : 0
      result.failed += fetched.ok ? 0 : 1
      result.rows.push({ id: String(doc._id), ticker: doc.ticker, title: doc.title, url, status: update.filingContentStatus, contentCharLength, error: fetched.error })
      await new Promise(resolve => setTimeout(resolve, 150))
    } catch (err) {
      result.failed += 1
      result.rows.push({ id: String(doc._id), ticker: doc.ticker, title: doc.title, url, error: String(err.message || err) })
    }
  }

  console.log(JSON.stringify(result, null, 2))
  await mongoose.disconnect()
}

main().catch(async err => {
  console.error(JSON.stringify({ ok: false, error: String(err.message || err) }, null, 2))
  try { await mongoose.disconnect() } catch (_) {}
  process.exit(1)
})
