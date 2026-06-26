import { Hono } from 'hono'
import { ms } from '../../lib/helpers.ts'
import { log } from '../../lib/logger.ts'
import { openDb } from '../../db/index.ts'
import { getReports, saveReport } from '../../db/queries/sentiment.ts'
import { TICKER_COMPANY } from '../../lib/ticker-map.ts'
import { readCfg } from '../../lib/config.ts'

export const sentimentRoutes = new Hono()

/** Port of the Python sentiment microservice (sentiment_service/service.py) */
function sentimentPort(): number {
  const cfg = readCfg()
  return cfg.sentiment?.service_port ?? 5001
}

// GET /api/sentiment/status — check if Python service is running
sentimentRoutes.get('/api/sentiment/status', async (c) => {
  const t = ms()
  const port = sentimentPort()
  try {
    const res = await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(2000) })
    const data = await res.json() as any
    return c.json({ ok: data.ok === true, port, ms: t() })
  } catch {
    return c.json({ ok: false, port, ms: t(), error: `Service not running on port ${port}. Start it with: cd sentiment_service && python service.py` })
  }
})

// POST /api/sentiment/analyze-asset — score all DB articles for a ticker, aggregate result
sentimentRoutes.post('/api/sentiment/analyze-asset', async (c) => {
  const t = ms()
  const body = await c.req.json()
  const asset = (body.asset ?? '').trim()
  const limit = Math.min(+(body.limit ?? 30), 100)
  const port = sentimentPort()

  if (!asset) return c.json({ error: 'asset (ticker) is required' }, 400)

  // Fetch articles from our DB that mention this ticker
  const db = openDb()
  if (!db) return c.json({ error: 'Database not found' }, 404)

  let articles: any[]
  try {
    articles = db.query(
      `SELECT id, title, content FROM articles
       WHERE ticker LIKE $t OR title LIKE $t
       ORDER BY COALESCE(publish_date, fetched_date) DESC
       LIMIT $limit`
    ).all({ $t: `%${asset}%`, $limit: limit })
  } finally {
    db.close()
  }

  if (!articles.length) {
    return c.json({ error: `No articles found for ticker "${asset}". Fetch feeds first.` }, 404)
  }

  log('INFO', 'Analyze asset requested', { asset, articles: articles.length })

  let results: any[] = []
  try {
    const res = await fetch(`http://localhost:${port}/analyze-articles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ articles }),
      signal: AbortSignal.timeout(120_000),
    })
    const data = await res.json() as any
    if (!res.ok) return c.json(data, res.status as any)
    results = data.results ?? []
  } catch (e) {
    const msg = String(e)
    if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
      return c.json({ error: `Sentiment service not running on port ${port}. Start it with: cd sentiment_service && python3 service.py` }, 503)
    }
    return c.json({ error: msg }, 500)
  }

  // Aggregate: majority vote + average confidence
  const counts: Record<string, number> = { bullish: 0, bearish: 0, neutral: 0 }
  let totalConf = 0, confCount = 0
  for (const r of results) {
    if (r.sentiment) counts[r.sentiment] = (counts[r.sentiment] ?? 0) + 1
    if (r.confidence != null) { totalConf += r.confidence; confCount++ }
  }
  const overall = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'neutral'
  const avgConf = confCount ? +(totalConf / confCount).toFixed(4) : null

  // Store aggregate in asset_reports
  saveReport(asset, overall, counts)

  log('INFO', 'Asset analysis complete', { asset, overall, counts, ms: t() })
  return c.json({ asset, sentiment: overall, confidence: avgConf, counts, articles_analyzed: results.length, ms: t() })
})

// GET /api/sentiment/reports — list stored asset reports
sentimentRoutes.get('/api/sentiment/reports', (c) => {
  const t = ms()
  const asset = c.req.query('asset') ?? null
  const date = c.req.query('date') ?? null
  const limit = Math.min(+(c.req.query('limit') ?? 50), 200)

  try {
    const reports = getReports({ asset, date, limit })
    return c.json({ reports, ms: t() })
  } catch (e) {
    return c.json({ reports: [], ms: t(), error: String(e) })
  }
})

// POST /api/sentiment/analyze-articles — batch-analyze articles already in the DB
sentimentRoutes.post('/api/sentiment/analyze-articles', async (c) => {
  const t = ms()
  const body = await c.req.json()

  const ids = (body.ids as string[] | undefined) ?? null
  const limit = Math.min(+(body.limit ?? 50), 200)
  const port = sentimentPort()

  const db = openDb()
  if (!db) return c.json({ error: 'Database not found' }, 404)

  let articles: any[]
  try {
    if (ids?.length) {
      const placeholders = ids.map((_, i) => `$id${i}`).join(',')
      const params: Record<string, string> = {}
      ids.forEach((id, i) => { params[`$id${i}`] = id })
      articles = db.query(
        `SELECT id, title, content FROM articles WHERE id IN (${placeholders})`
      ).all(params)
    } else {
      articles = db.query(
        `SELECT id, title, content FROM articles WHERE sentiment IS NULL ORDER BY COALESCE(publish_date, fetched_date) DESC LIMIT $limit`
      ).all({ $limit: limit })
    }
  } finally {
    db.close()
  }

  if (!articles.length) {
    return c.json({ analyzed: 0, results: [], ms: t() })
  }

  log('INFO', 'Batch article analysis requested', { count: articles.length })

  let results: any[] = []
  try {
    const res = await fetch(`http://localhost:${port}/analyze-articles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ articles }),
      signal: AbortSignal.timeout(300_000),
    })
    const data = await res.json() as any
    if (!res.ok) return c.json(data, res.status as any)
    results = data.results ?? []
  } catch (e) {
    const msg = String(e)
    if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
      return c.json({ error: `Sentiment service not running on port ${port}. Start it with: cd sentiment_service && python3 service.py` }, 503)
    }
    return c.json({ error: msg }, 500)
  }

  // Write results back to the articles table (sentiment + confidence + ticker + company)
  let updated = 0
  const dw = openDb(true)
  if (dw) {
    try {
      const now = Math.floor(Date.now() / 1000)
      for (const r of results) {
        if (r.id && r.sentiment) {
          const primaryTicker: string | null = (r.tickers as string[] | undefined)?.[0] ?? null
          const company: string | null =
            (r.company as string | undefined) ??
            (primaryTicker ? (TICKER_COMPANY.get(primaryTicker) ?? null) : null)
          dw.run(
            'UPDATE articles SET sentiment = ?, ml_confidence = ?, sentiment_at = ?, ticker = COALESCE(ticker, ?), company = COALESCE(company, ?) WHERE id = ?',
            [r.sentiment, r.confidence ?? null, now, primaryTicker, company, r.id]
          )
          updated++
        }
      }
    } finally {
      dw.close()
    }
  }

  log('INFO', 'Batch article analysis complete', { analyzed: updated, total: results.length, ms: t() })
  return c.json({ analyzed: updated, total: results.length, results, ms: t() })
})

// POST /api/sentiment/quick-analyze — fast rule-based analysis (DS440 engine, no FinBERT)
sentimentRoutes.post('/api/sentiment/quick-analyze', async (c) => {
  const t = ms()
  const body = await c.req.json()
  const limit = Math.min(+(body.limit ?? 50), 500)
  const port = sentimentPort()

  const db = openDb()
  if (!db) return c.json({ error: 'Database not found' }, 404)

  let articles: any[]
  try {
    articles = db.query(
      `SELECT id, title, content FROM articles
       WHERE sentiment IS NULL
       ORDER BY COALESCE(publish_date, fetched_date) DESC
       LIMIT $limit`
    ).all({ $limit: limit })
  } finally {
    db.close()
  }

  if (!articles.length) return c.json({ analyzed: 0, results: [], ms: t() })

  log('INFO', 'Quick analyze requested', { count: articles.length })

  let results: any[] = []
  try {
    const res = await fetch(`http://localhost:${port}/quick-sentiment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ articles }),
      signal: AbortSignal.timeout(30_000),
    })
    const data = await res.json() as any
    if (!res.ok) return c.json(data, res.status as any)
    results = data.results ?? []
  } catch (e) {
    const msg = String(e)
    if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
      return c.json({ error: `Sentiment service not running on port ${port}. Start it with: cd sentiment_service && python3 service.py` }, 503)
    }
    return c.json({ error: msg }, 500)
  }

  let updated = 0
  const dw = openDb(true)
  if (dw) {
    try {
      const now = Math.floor(Date.now() / 1000)
      for (const r of results) {
        if (r.id && r.sentiment) {
          dw.run(
            'UPDATE articles SET sentiment = ?, ml_confidence = ?, sentiment_at = ? WHERE id = ?',
            [r.sentiment, r.confidence ?? null, now, r.id]
          )
          updated++
        }
      }
    } finally {
      dw.close()
    }
  }

  log('INFO', 'Quick analyze complete', { analyzed: updated, total: results.length, ms: t() })
  return c.json({ analyzed: updated, total: results.length, results, ms: t() })
})

// POST /api/sentiment/extract-tickers — extract ticker symbols and store in DB
sentimentRoutes.post('/api/sentiment/extract-tickers', async (c) => {
  const t = ms()
  const body = await c.req.json()
  const limit = Math.min(+(body.limit ?? 200), 1000)
  const port = sentimentPort()

  const db = openDb()
  if (!db) return c.json({ error: 'Database not found' }, 404)

  let articles: any[]
  try {
    articles = db.query(
      `SELECT id, title, content FROM articles
       WHERE (ticker IS NULL OR ticker = '')
       ORDER BY COALESCE(publish_date, fetched_date) DESC
       LIMIT $limit`
    ).all({ $limit: limit })
  } finally {
    db.close()
  }

  if (!articles.length) return c.json({ updated: 0, total_tickers_found: 0, articles_processed: 0, ms: t() })

  log('INFO', 'Extract tickers requested', { count: articles.length })

  let results: any[] = []
  try {
    const res = await fetch(`http://localhost:${port}/extract-tickers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ articles }),
      signal: AbortSignal.timeout(30_000),
    })
    const data = await res.json() as any
    if (!res.ok) return c.json(data, res.status as any)
    results = data.results ?? []
  } catch (e) {
    const msg = String(e)
    if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
      return c.json({ error: `Sentiment service not running on port ${port}. Start it with: cd sentiment_service && python3 service.py` }, 503)
    }
    return c.json({ error: msg }, 500)
  }

  let updated = 0
  const dw = openDb(true)
  if (dw) {
    try {
      for (const r of results) {
        if (r.id) {
          const val = r.tickers?.length ? r.tickers.join(',') : '-'
          dw.run('UPDATE articles SET ticker = ? WHERE id = ?', [val, r.id])
          if (r.tickers?.length) updated++
        }
      }
    } finally {
      dw.close()
    }
  }

  const totalTickers = results.reduce((n: number, r: any) => n + (r.tickers?.length ?? 0), 0)
  log('INFO', 'Ticker extraction complete', { updated, totalTickers, total: results.length, ms: t() })
  return c.json({ updated, total_tickers_found: totalTickers, articles_processed: results.length, ms: t() })
})
