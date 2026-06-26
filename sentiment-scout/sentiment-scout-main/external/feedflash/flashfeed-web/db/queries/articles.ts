import { existsSync } from 'fs'
import { DB } from '../../lib/config.ts'
import { log } from '../../lib/logger.ts'
import { openDb } from '../index.ts'
import { dictionarySentiment } from '../../lib/classifier.ts'
import { Database } from 'bun:sqlite'

/** Score all articles with NULL sentiment using dictionary classifier (runs at startup, instant) */
export function stampNullSentiment() {
  if (!existsSync(DB)) return
  const db = new Database(DB)
  try {
    const rows = db.query(
      `SELECT id, title, content FROM articles WHERE sentiment IS NULL LIMIT 2000`
    ).all() as { id: string; title: string; content: string | null }[]
    if (!rows.length) return
    const now = Math.floor(Date.now() / 1000)
    const stmt = db.prepare(
      `UPDATE articles SET sentiment=?, sentiment_at=? WHERE id=?`
    )
    db.transaction(() => {
      for (const row of rows) {
        const label = dictionarySentiment(row.title, row.content ?? '')
        stmt.run(label, now, row.id)
      }
    })()
    log('INFO', 'Dictionary sentiment stamped on existing articles', { count: rows.length })
  } catch (e) {
    log('WARN', 'stampNullSentiment failed', { reason: String(e) })
  } finally {
    db.close()
  }
}

export function getArticles(params: {
  limit: number
  offset: number
  source?: string | null
  category?: string | null
  search?: string | null
  sentiment?: string | null
  keywords_only?: boolean
  activeKws?: Set<string>
}): { articles: any[]; total: number } {
  const d = openDb()
  if (!d) return { articles: [], total: 0 }

  const { limit, offset, source, category, search, sentiment, keywords_only, activeKws } = params

  try {
    const conds: string[] = []
    const p: Record<string, any> = {}

    if (source) { conds.push('source = $source'); p.$source = source }
    if (category) { conds.push('category = $category'); p.$category = category }
    if (search) { conds.push('(title LIKE $search OR content LIKE $search)'); p.$search = `%${search}%` }
    if (sentiment === 'unanalyzed') {
      conds.push('sentiment IS NULL')
    } else if (sentiment) {
      conds.push('sentiment = $sentiment')
      p.$sentiment = sentiment
    }
    if (keywords_only && activeKws && activeKws.size > 0) {
      const kws = [...activeKws]
      const kwConds = kws.map((_, i) => `title LIKE $kw${i}`).join(' OR ')
      conds.push(`(${kwConds})`)
      kws.forEach((kw, i) => { p[`$kw${i}`] = `%${kw}%` })
    }

    const where = conds.length ? ' WHERE ' + conds.join(' AND ') : ''

    const articles = d.query(
      `SELECT id, title, content, url, source, category, publish_date, fetched_date, ticker, company, sentiment, sentiment_at
       FROM articles${where}
       ORDER BY COALESCE(publish_date, fetched_date) DESC
       LIMIT $limit OFFSET $offset`
    ).all({ ...p, $limit: limit, $offset: offset })

    const { count } = d.query(
      `SELECT COUNT(*) as count FROM articles${where}`
    ).get({ ...p }) as { count: number }

    return { articles, total: count }
  } finally {
    d.close()
  }
}

export function getStats(): { total: number; sources: any[]; categories: any[]; recency: any; sentiment: any } {
  const d = openDb()
  if (!d) return { total: 0, sources: [], categories: [], recency: null, sentiment: null }

  try {
    const { total } = d.query('SELECT COUNT(*) as total FROM articles').get({}) as { total: number }
    const sources = d.query(
      'SELECT source, COUNT(*) as count, MAX(fetched_date) as last_fetched FROM articles GROUP BY source ORDER BY count DESC'
    ).all({})
    const categories = d.query(
      "SELECT COALESCE(category, 'uncategorized') as category, COUNT(*) as count FROM articles GROUP BY category ORDER BY count DESC"
    ).all({})
    const recency = d.query(
      'SELECT MAX(fetched_date) as last_fetch, MIN(publish_date) as oldest, MAX(publish_date) as newest FROM articles'
    ).get({})

    let sentiment: any = null
    try {
      sentiment = d.query(
        `SELECT
           COUNT(*) FILTER (WHERE sentiment = 'bullish')  as bullish,
           COUNT(*) FILTER (WHERE sentiment = 'bearish')  as bearish,
           COUNT(*) FILTER (WHERE sentiment = 'neutral')  as neutral,
           COUNT(*) FILTER (WHERE sentiment IS NULL)      as unanalyzed
         FROM articles`
      ).get({})
    } catch { /* sentiment columns not yet migrated */ }

    return { total, sources, categories, recency, sentiment }
  } finally {
    d.close()
  }
}
