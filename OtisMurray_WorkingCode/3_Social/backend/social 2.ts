import { Hono } from 'hono'
import { ms } from '../../lib/helpers.ts'
import { log } from '../../lib/logger.ts'
import { openDb } from '../../db/index.ts'
import { fetchDs440 } from '../../lib/ds440-client.ts'
import { TICKER_COMPANY } from '../../lib/ticker-map.ts'

export const socialRoutes = new Hono()

socialRoutes.get('/api/social/posts', async (c) => {
  const t = ms()
  const ticker = c.req.query('ticker') ?? ''
  const window = c.req.query('window') ?? '60'
  const source = c.req.query('source') || c.req.query('platform') || ''
  const qs = new URLSearchParams({ window })
  if (ticker) qs.set('ticker', ticker)
  if (source && source !== 'all') qs.set('source', source)
  try {
    const raw = await fetchDs440(`/api/posts?${qs}`)
    const posts = Array.isArray(raw) ? raw : (raw.posts ?? raw.data ?? [])
    // Transform to match frontend SocialPost interface:
    // { id, platform, author, content, created_at, ticker, sentiment, url }
    const enriched = posts.map((p: any, i: number) => {
      const score: number = p.sentiment_score ?? 0
      return {
        id: p.id ?? p._id ?? `post-${i}-${Date.now()}`,
        platform: p.source ?? (p.subreddit ? 'reddit' : 'social'),
        author: p.author ?? p.user ?? 'anonymous',
        content: p.title ?? p.text ?? p.body ?? '',
        created_at: p.published_at ?? p.created_at ?? new Date().toISOString(),
        ticker: (p.tickers_mentioned ?? [])[0] ?? (ticker || null),
        sentiment: score,
        url: p.url ?? null,
        // Keep extra fields for richer display
        subreddit: p.subreddit ?? null,
        score: p.score ?? null,
        num_comments: p.num_comments ?? null,
      }
    })
    return c.json({ posts: enriched, ms: t() })
  } catch (e) {
    return c.json({ posts: [], error: 'DS440 service unavailable', ms: t() })
  }
})

socialRoutes.get('/api/social/alerts', async (c) => {
  const t = ms()
  try {
    const raw = await fetchDs440('/api/alerts')
    const alerts = Array.isArray(raw) ? raw : (raw.alerts ?? raw.data ?? [])
    return c.json({ alerts, ms: t() })
  } catch (e) {
    return c.json({ alerts: [], error: 'DS440 service unavailable', ms: t() })
  }
})

socialRoutes.get('/api/social/phrases', async (c) => {
  const t = ms()
  try {
    const raw = await fetchDs440('/api/phrases')
    const phrases = Array.isArray(raw) ? raw : (raw.phrases ?? raw.data ?? [])
    return c.json({ phrases, ms: t() })
  } catch (e) {
    return c.json({ phrases: [], error: 'DS440 service unavailable', ms: t() })
  }
})

// GET /api/social/tickers — active tickers from social data (for sidebar)
socialRoutes.get('/api/social/tickers', async (c) => {
  const t = ms()
  try {
    const data = await fetchDs440('/api/screener?window=1440', 10000).catch(() => null)
    const rows = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : [])
    const tickers = rows
      .filter((r: any) => {
        const tk = r.ticker || r.symbol
        return tk && tk.length >= 2 && (r.message_count ?? r.post_count ?? 0) > 0
      })
      .map((r: any) => ({
        ticker: r.ticker || r.symbol,
        count: r.message_count ?? r.post_count ?? 0,
        sentiment: r.avg_sentiment ?? r.sentiment ?? 0,
      }))
      .sort((a: any, b: any) => b.count - a.count)
      .slice(0, 30)
    return c.json({ tickers, ms: t() })
  } catch (e) {
    return c.json({ tickers: [], error: 'DS440 service unavailable', ms: t() })
  }
})

// GET /api/social/health — subreddit health (alias for frontend)
socialRoutes.get('/api/social/health', async (c) => {
  const t = ms()
  try {
    const raw = await fetchDs440('/api/subreddits/health')
    const subreddits = Array.isArray(raw) ? raw : (raw.subreddits ?? raw.health ?? raw.data ?? [])
    return c.json({ subreddits, ms: t() })
  } catch (e) {
    return c.json({ subreddits: [], error: 'DS440 service unavailable', ms: t() })
  }
})

socialRoutes.get('/api/social/subreddits', async (c) => {
  const t = ms()
  try {
    const raw = await fetchDs440('/api/subreddits/health')
    const subreddits = Array.isArray(raw) ? raw : (raw.subreddits ?? raw.health ?? raw.data ?? [])
    return c.json({ subreddits, ms: t() })
  } catch (e) {
    return c.json({ subreddits: [], error: 'DS440 service unavailable', ms: t() })
  }
})

socialRoutes.get('/api/social/ticker/:symbol', async (c) => {
  const t = ms()
  const sym = c.req.param('symbol').toUpperCase()
  try {
    // Fetch ticker row + recent posts in parallel
    const [tickerRaw, postsRaw] = await Promise.all([
      fetchDs440(`/api/ticker/${sym}`),
      fetchDs440(`/api/posts?ticker=${sym}&window=60`).catch(() => []),
    ])
    const posts = Array.isArray(postsRaw) ? postsRaw : (postsRaw.posts ?? [])
    // Normalise: DS440 returns a flat screener row; build a windows map from it
    const row = Array.isArray(tickerRaw) ? tickerRaw[0] : tickerRaw
    const windows: Record<string, any> = row?.windows ?? {}
    if (!Object.keys(windows).length && row?.avg_sentiment != null) {
      windows['60'] = {
        avg_sentiment: row.avg_sentiment,
        message_count: row.message_count ?? 0,
        bullish_count: row.bullish_count ?? 0,
        bearish_count: row.bearish_count ?? 0,
        neutral_count: row.neutral_count ?? 0,
      }
    }
    return c.json({ ticker: sym, row, windows, recentPosts: posts.slice(0, 20), ms: t() })
  } catch (e) {
    // Fallback: use local news articles for this ticker
    try {
      const db = openDb(false)
      if (!db) throw new Error('DB unavailable')
      const arts: any[] = db.query(
        `SELECT id, title, url, source, sentiment, ml_confidence, publish_date, fetched_date
         FROM articles WHERE ticker LIKE ? OR ticker LIKE ? OR ticker LIKE ? OR ticker = ?
         ORDER BY COALESCE(publish_date, fetched_date) DESC LIMIT 20`
      ).all(`${sym},%`, `%,${sym},%`, `%,${sym}`, sym) as any[]
      db.close()
      const recentPosts = arts.map(a => ({
        id: a.id, source: 'news', title: a.title, url: a.url,
        published_at: a.publish_date ? new Date(a.publish_date * 1000).toISOString() : null,
        sentiment_score: a.sentiment === 'positive' ? 0.6 : a.sentiment === 'negative' ? -0.6 : 0,
        tickers_mentioned: [sym],
      }))
      const sentiments = recentPosts.map(p => p.sentiment_score)
      const avg = sentiments.length ? sentiments.reduce((s, v) => s + v, 0) / sentiments.length : 0
      const windows: Record<string, any> = {}
      if (recentPosts.length > 0) {
        windows['news'] = {
          avg_sentiment: +avg.toFixed(4),
          message_count: recentPosts.length,
          bullish_count: sentiments.filter(s => s > 0.1).length,
          bearish_count: sentiments.filter(s => s < -0.1).length,
          neutral_count: sentiments.filter(s => Math.abs(s) <= 0.1).length,
        }
      }
      return c.json({ ticker: sym, row: null, windows, recentPosts, source: 'news_fallback', ms: t() })
    } catch (_e2) {
      return c.json({ ticker: sym, windows: {}, recentPosts: [], error: 'DS440 service unavailable', ms: t() })
    }
  }
})

socialRoutes.get('/api/social/ticker/:symbol/history', async (c) => {
  const t = ms()
  const sym = c.req.param('symbol').toUpperCase()
  const timeRange = c.req.query('timeRange') ?? '24hr'
  try {
    const raw = await fetchDs440(`/api/ticker/${sym}/history?timeRange=${timeRange}`)
    const history = Array.isArray(raw) ? raw : (raw.history ?? raw.data ?? raw)
    return c.json({ history, ms: t() })
  } catch (e) {
    return c.json({ history: [], error: 'DS440 service unavailable', ms: t() })
  }
})
