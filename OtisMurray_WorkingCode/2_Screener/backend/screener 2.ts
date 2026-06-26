import { Hono } from 'hono'
import { ms } from '../../lib/helpers.ts'
import { log } from '../../lib/logger.ts'
import { openDb } from '../../db/index.ts'
import { getNewsSentimentMap } from '../../db/queries/screener.ts'
import { fetchDs440 } from '../../lib/ds440-client.ts'
import { TICKER_COMPANY, FINVIZ_DATA } from '../../lib/ticker-map.ts'
import { fetchLivePrices } from './prices.ts'

export const screenerRoutes = new Hono()

screenerRoutes.get('/api/screener', async (c) => {
  const t = ms()
  const window = c.req.query('window') ?? '60'
  let rows: any[] = []
  let source = ''
  let lastSync = ''

  try {
    const data = await fetchDs440(`/api/screener?window=${window}`)
    if (Array.isArray(data.data) && data.data.length > 0) {
      rows = data.data
      source = data.source ?? ''
      lastSync = data.lastSync ?? new Date().toISOString()
    } else {
      throw new Error('Empty screener from DS440')
    }
  } catch (_e) {
    // Fallback: build news screener from local SQLite articles with ticker data
    try {
      const db = openDb(false)
      if (!db) throw new Error('DB unavailable')
      const cutoff = Math.floor(Date.now() / 1000) - 7 * 24 * 3600  // last 7 days
      const arts: any[] = db.query(
        `SELECT ticker, sentiment, title FROM articles
         WHERE ticker IS NOT NULL AND length(ticker) > 0
           AND fetched_date > ?
         ORDER BY fetched_date DESC LIMIT 2000`
      ).all(cutoff) as any[]
      db.close()
      const map = new Map<string, any>()
      for (const a of arts) {
        // ticker column may have comma-separated tickers
        const tickers = (a.ticker as string).split(',').map((s: string) => s.trim()).filter(Boolean)
        for (const ticker of tickers) {
          if (!map.has(ticker)) map.set(ticker, { ticker, message_count: 0, bullish_count: 0, bearish_count: 0, neutral_count: 0, _sum: 0, source: 'news' })
          const r = map.get(ticker)!
          r.message_count++
          const s = a.sentiment === 'bullish' ? 0.6 : a.sentiment === 'bearish' ? -0.6 : 0
          r._sum += s
          if (s > 0.1) r.bullish_count++; else if (s < -0.1) r.bearish_count++; else r.neutral_count++
        }
      }
      // FIX: assign to outer `rows` — not a new local variable
      rows = Array.from(map.values())
        .map(r => {
          const newsSent = r.message_count ? +(r._sum / r.message_count).toFixed(4) : 0
          const company = TICKER_COMPANY.get(r.ticker) ?? null
          return {
            ticker: r.ticker,
            company,
            structured_sentiment: newsSent,
            social_sentiment: newsSent,
            news_article_count: r.message_count,
            avg_sentiment: newsSent,
            message_density: r.message_count,
            bullish_count: r.bullish_count,
            bearish_count: r.bearish_count,
            neutral_count: r.neutral_count,
            source: 'news',
          }
        })
        .filter(r => r.news_article_count >= 1)
        .sort((a, b) => b.news_article_count - a.news_article_count)
      log('INFO', `Screener news fallback: ${rows.length} tickers from ${arts.length} articles`)
      lastSync = new Date().toISOString()
    } catch (e2) {
      log('WARN', 'Screener fallback failed', { error: String(e2) })
      return c.json({ data: [], lastSync: null, error: 'Screener data unavailable', ms: t() })
    }
  }

  // Inject news sentiment from local SQLite (cached for 30s — no duplicate scans on concurrent requests)
  if (rows.length > 0) {
    try {
      const newsMap = getNewsSentimentMap()
      for (const r of rows) {
        const n = newsMap.get(r.ticker)
        if (n && n.total > 0) {
          r.structured_sentiment = +(n.sum / n.total).toFixed(4)
          r.news_article_count = n.total
          r.news_bullish_count = n.bullish
          r.news_bearish_count = n.bearish
          r.news_neutral_count = n.neutral
          // Add 'news' to sources array if not already present
          if (!r.sources) r.sources = []
          if (Array.isArray(r.sources) && !r.sources.includes('news')) r.sources.push('news')
        }
      }
    } catch (e3) {
      log('WARN', 'News sentiment enrichment failed', { error: String(e3) })
    }
  }

  // Inject fundamental/technical data via Yahoo Finance & Finviz map
  if (rows.length > 0) {
    const toFetch = rows.slice(0, 50).map((r: any) => r.ticker)
    const map = await fetchLivePrices(toFetch)
    for (const r of rows) {
      const live = map.get(r.ticker)
      const fv = FINVIZ_DATA.get(r.ticker)

      // Inject standard fields
      if (live) {
        if (!r.price) r.price = live.price
        if (!r.change) r.change = live.change
        if (!r.change_pct) r.change_pct = live.changePct
        if (!r.volume) r.volume = live.volume
        if (!r.avg_volume) r.avg_volume = live.avg_volume
        if (!r.market_cap) r.market_cap = live.market_cap
        if (!r.pe_ratio) r.pe_ratio = live.pe_ratio
        if (!r.week_52_high) r.week_52_high = live.week_52_high
        if (!r.week_52_low) r.week_52_low = live.week_52_low
        if (!r.earnings_date) r.earnings_date = live.earnings_date
      }
      if (fv) {
        if (!r.sector) r.sector = fv.sector
        if (!r.industry) r.industry = fv.industry
      }
    }
  }

  return c.json({ data: rows, lastSync, source, ms: t() })
})
