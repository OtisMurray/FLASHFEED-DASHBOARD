#!/usr/bin/env node
const path = require('path')
const SEC_TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json'

function argValue(name, fallback = '') {
  const direct = process.argv.find(arg => arg.startsWith(`--${name}=`))
  if (direct) return direct.slice(name.length + 3)
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] || fallback : fallback
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`)
}

function secHeaders() {
  const contact = process.env.SEC_CONTACT_EMAIL || 'otismurray@icloud.com'
  return {
    'User-Agent': process.env.SEC_USER_AGENT || `FeedFlash/1.0 ${contact}`,
    From: contact,
    Accept: 'application/json,text/html,application/xhtml+xml,text/plain,*/*',
  }
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: secHeaders() })
  if (!res.ok) throw new Error(`${url} returned ${res.status}`)
  return res.json()
}

async function fetchText(url) {
  const res = await fetch(url, { headers: secHeaders() })
  if (!res.ok) throw new Error(`${url} returned ${res.status}`)
  return res.text()
}

function cikPadded(cik) {
  return String(cik || '').replace(/\D/g, '').padStart(10, '0')
}

function cikPlain(cik) {
  return String(Number(String(cik || '').replace(/\D/g, '')) || '').trim()
}

function noHyphen(accession) {
  return String(accession || '').replace(/-/g, '')
}

function iso(value) {
  if (!value) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

function mountain(value) {
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) return null
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Denver',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'short',
  }).format(new Date(ms))
}

function stripHtml(value) {
  return String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

function filingImpactWeight(formType = '', contentStatus = 'missing') {
  if (contentStatus !== 'content_extracted') return 0.03
  const form = String(formType || '').toUpperCase()
  if (form === '8-K') return 0.75
  if (form === '10-Q' || form === '10-K') return 0.35
  if (form.startsWith('S-') || form === 'F-1') return 0.45
  if (form === '4' || form === '144') return 0.08
  if (form.includes('13D') || form.includes('13G')) return 0.2
  if (form === '425' || form.includes('14A')) return 0.25
  return 0.25
}

function scoreFilingText(row, text) {
  const form = String(row.formType || '').toUpperCase()
  const content = String(text || '').toLowerCase()
  const positive = [
    /\brais(?:e|es|ed|ing)\b.*\bguidance\b/,
    /\bapproval\b/,
    /\bfda\b.*\bapprov/,
    /\brecord revenue\b/,
    /\bexceeds? expectations\b/,
    /\bprofitable\b/,
    /\bstrategic (?:partnership|agreement|acquisition)\b/,
    /\bcontract award\b/,
  ]
  const negative = [
    /\bgoing concern\b/,
    /\bmaterial weakness\b/,
    /\brestatement\b/,
    /\bdelist(?:ing|ed)?\b/,
    /\bbankruptcy\b/,
    /\bdefault\b/,
    /\btermination\b/,
    /\binvestigation\b/,
    /\bsecurities fraud\b/,
    /\blower(?:s|ed|ing)?\b.*\bguidance\b/,
  ]
  let score = 0
  for (const pattern of positive) if (pattern.test(content)) score += 0.18
  for (const pattern of negative) if (pattern.test(content)) score -= 0.2

  // Ownership/admin filings are only meaningful if parsed deeply. Until then,
  // keep their sentiment near neutral even with full XML content.
  if (form === '4' || form === '144') score *= 0.2
  if (form.includes('13D') || form.includes('13G')) score *= 0.35
  return Math.max(-0.9, Math.min(0.9, Number(score.toFixed(3))))
}

function sentimentLabel(score) {
  if (score > 0.08) return 'bullish'
  if (score < -0.08) return 'bearish'
  return 'neutral'
}

function rowsFromRecent(recent = {}, cik) {
  const forms = recent.form || []
  return forms.map((form, index) => {
    const accessionNumber = recent.accessionNumber?.[index] || null
    const primaryDocument = recent.primaryDocument?.[index] || null
    const filingDate = recent.filingDate?.[index] || null
    const reportDate = recent.reportDate?.[index] || null
    const acceptedAt = recent.acceptanceDateTime?.[index] || null
    const base = `https://www.sec.gov/Archives/edgar/data/${cikPlain(cik)}/${noHyphen(accessionNumber)}`
    return {
      formType: form || null,
      accessionNumber,
      filingDate,
      reportDate,
      acceptedAtRaw: acceptedAt,
      acceptedAtUtc: iso(acceptedAt),
      acceptedAtMountain: mountain(acceptedAt),
      primaryDocument,
      filingUrl: accessionNumber ? `${base}/${accessionNumber}-index.html` : null,
      primaryDocumentUrl: accessionNumber && primaryDocument ? `${base}/${primaryDocument}` : null,
    }
  })
}

async function main() {
  const tickers = argValue('tickers', 'S,VRDN,GME')
    .split(',')
    .map(t => t.trim().toUpperCase())
    .filter(Boolean)
  const recentDays = Number(argValue('recent-days', '30'))
  const limit = Math.max(1, Math.min(100, Number(argValue('limit', '20'))))
  const fetchContent = hasFlag('fetch-content')
  const store = hasFlag('store')
  const sinceMs = Number.isFinite(recentDays) && recentDays > 0 ? Date.now() - recentDays * 86_400_000 : 0
  let mongoose = null
  let db = null
  if (store) {
    mongoose = require(path.join(__dirname, '..', 'Infrastructure', 'server', 'node_modules', 'mongoose'))
    const mongoUri = process.env.MONGO_URI || 'mongodb://localhost:27017/feedflash'
    await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 8000 })
    db = mongoose.connection.db
  }

  const mapPayload = await fetchJson(SEC_TICKERS_URL)
  const byTicker = new Map()
  for (const row of Object.values(mapPayload || {})) {
    const ticker = String(row.ticker || '').toUpperCase()
    if (ticker) byTicker.set(ticker, row)
  }

  const output = {
    ok: true,
    generatedAtUtc: new Date().toISOString(),
    source: 'SEC official company_tickers + submissions API',
    recentDays,
    fetchContent,
    store,
    tickers: [],
  }

  for (const ticker of tickers) {
    const meta = byTicker.get(ticker)
    if (!meta) {
      output.tickers.push({ ticker, foundInSecTickerMap: false, filings: [] })
      continue
    }
    const cik = cikPadded(meta.cik_str)
    const submissions = await fetchJson(`https://data.sec.gov/submissions/CIK${cik}.json`)
    let filings = rowsFromRecent(submissions.filings?.recent || {}, cik)
      .filter(row => {
        const ms = Date.parse(row.acceptedAtRaw || row.filingDate || '')
        return sinceMs ? Number.isFinite(ms) && ms >= sinceMs : true
      })
      .slice(0, limit)

    if (fetchContent || store) {
      filings = await Promise.all(filings.map(async row => {
        if (!row.primaryDocumentUrl) return { ...row, contentStatus: 'missing_primary_document_url', contentCharLength: 0 }
        try {
          const raw = await fetchText(row.primaryDocumentUrl)
          const text = stripHtml(raw)
          const contentStatus = text.length >= 200 ? 'content_extracted' : 'missing_or_weak'
          const filingSentiment = scoreFilingText(row, text)
          const impactWeight = filingImpactWeight(row.formType, contentStatus)
          return {
            ...row,
            contentStatus,
            contentCharLength: text.length,
            filingSentiment,
            filingImpactWeight: impactWeight,
            filingUsedInSentiment: contentStatus === 'content_extracted' && impactWeight >= 0.2,
            contentSample: text.slice(0, 240),
            contentText: text,
          }
        } catch (err) {
          return { ...row, contentStatus: 'fetch_failed', contentCharLength: 0, error: String(err.message || err) }
        }
      }))
    }

    let stored = 0
    if (store && db) {
      const now = new Date()
      const ops = filings.map(row => {
        const acceptedAt = row.acceptedAtUtc ? new Date(row.acceptedAtUtc) : null
        const score = Number(row.filingSentiment || 0)
        const contentText = String(row.contentText || '')
        return {
          updateOne: {
            filter: {
              source: 'SEC EDGAR',
              accessionNumber: row.accessionNumber,
              ticker,
            },
            update: {
              $set: {
                article_id: `sec:${ticker}:${row.accessionNumber}`,
                ticker,
                tickers: [ticker],
                companyName: submissions.name || meta.title || null,
                cik,
                title: `${ticker}: SEC ${row.formType || 'filing'} ${row.accessionNumber}`,
                source: 'SEC EDGAR',
                source_type: 'filing',
                category: 'filings',
                event_type: 'sec_filing',
                is_sec_filing: true,
                isFiling: true,
                accessionNumber: row.accessionNumber,
                formType: row.formType,
                filingDate: row.filingDate,
                reportDate: row.reportDate,
                acceptedAt,
                fetchedAt: now,
                publish_date: acceptedAt,
                fetched_date: now,
                detected_at: now,
                url: row.filingUrl,
                secUrl: row.filingUrl,
                primaryDocumentUrl: row.primaryDocumentUrl,
                contentText,
                contentCharLength: row.contentCharLength || contentText.length,
                content_status: row.contentStatus,
                filingContentStatus: row.contentStatus,
                filingSentiment: score,
                filingSentimentConfidence: Math.min(0.75, Math.abs(score) + 0.25),
                filingImpactWeight: row.filingImpactWeight || filingImpactWeight(row.formType, row.contentStatus),
                filingUsedInSentiment: Boolean(row.filingUsedInSentiment),
                sentiment: sentimentLabel(score),
                sentiment_score: score,
                ml_confidence: Math.min(0.75, Math.abs(score) + 0.25),
                updated_at: now,
              },
              $setOnInsert: { created_at: now },
            },
            upsert: true,
          },
        }
      })
      if (ops.length) {
        const result = await db.collection('articles').bulkWrite(ops, { ordered: false })
        stored = Number(result.upsertedCount || 0) + Number(result.modifiedCount || 0)
      }
    }

    filings = filings.map(({ contentText, ...row }) => row)

    output.tickers.push({
      ticker,
      foundInSecTickerMap: true,
      cik,
      companyName: submissions.name || meta.title || null,
      stored,
      filings,
    })
  }

  console.log(JSON.stringify(output, null, 2))
  if (mongoose) await mongoose.disconnect()
}

main().catch(err => {
  console.error(JSON.stringify({ ok: false, error: String(err.message || err) }, null, 2))
  process.exit(1)
})
