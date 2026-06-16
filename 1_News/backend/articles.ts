import { Hono } from 'hono'
import { ms, activeKeywords } from '../../lib/helpers.ts'
import { log } from '../../lib/logger.ts'
import { openDb } from '../../db/index.ts'
import { getStats } from '../../db/queries/articles.ts'

export const articlesRoutes = new Hono()

// GET /api/articles — direct SQLite read (fastest path)
articlesRoutes.get('/api/articles', (c) => {
  const t = ms()
  const limit = Math.min(+(c.req.query('limit') ?? 50), 500)
  const offset = +(c.req.query('offset') ?? 0)
  const source = c.req.query('source') ?? null
  const category = c.req.query('category') ?? null
  const search = c.req.query('search') ?? null
  const sentiment = c.req.query('sentiment') ?? null  // bullish|bearish|neutral|unanalyzed
  const keywords_only = c.req.query('keywords_only') === '1'

  const d = openDb()
  if (!d) {
    log('WARN', 'Articles requested but database not found')
    return c.json({ articles: [], total: 0, ms: t(), error: 'Database not found. Add a feed and run Fetch.' })
  }

  try {
    const conds: string[] = []
    const params: Record<string, any> = {}

    if (source) { conds.push('source = $source'); params.$source = source }
    if (category) { conds.push('category = $category'); params.$category = category }
    if (search) { conds.push('(title LIKE $search OR content LIKE $search)'); params.$search = `%${search}%` }
    if (sentiment === 'unanalyzed') {
      conds.push('sentiment IS NULL')
    } else if (sentiment) {
      conds.push('sentiment = $sentiment')
      params.$sentiment = sentiment
    }
    if (keywords_only) {
      const kws = [...activeKeywords()]
      if (kws.length > 0) {
        // Build OR-chain from in-memory Set — each param is a positional named bind
        const kwConds = kws.map((_, i) => `title LIKE $kw${i}`).join(' OR ')
        conds.push(`(${kwConds})`)
        kws.forEach((kw, i) => { params[`$kw${i}`] = `%${kw}%` })
      }
    }

    const where = conds.length ? ' WHERE ' + conds.join(' AND ') : ''

    const articles = d.query(
      `SELECT id, title, content, url, source, category, publish_date, fetched_date, ticker, company, sentiment, sentiment_at
       FROM articles${where}
       ORDER BY COALESCE(publish_date, fetched_date) DESC
       LIMIT $limit OFFSET $offset`
    ).all({ ...params, $limit: limit, $offset: offset })

    const { count } = d.query(
      `SELECT COUNT(*) as count FROM articles${where}`
    ).get({ ...params }) as { count: number }

    const duration = t()
    log('DEBUG', 'Articles query', { count, limit, offset, source, category, sentiment, ms: duration })
    return c.json({ articles, total: count, limit, offset, ms: duration })
  } finally {
    d.close()
  }
})

// GET /api/stats — DB statistics (direct SQLite read)
articlesRoutes.get('/api/stats', (c) => {
  const t = ms()
  const { total, sources, categories, recency, sentiment } = getStats()
  return c.json({ total, sources, categories, recency, sentiment: sentiment, ms: t() })
})
