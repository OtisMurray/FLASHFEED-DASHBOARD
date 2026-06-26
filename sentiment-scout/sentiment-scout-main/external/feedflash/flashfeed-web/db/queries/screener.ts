import { openDb } from '../index.ts'
import { log } from '../../lib/logger.ts'
import { TICKER_COMPANY, TICKER_BLACKLIST } from '../../lib/ticker-map.ts'

// ─── News sentiment cache (avoids re-scanning 5k rows on every screener refresh) ─
const newsSentimentCache: { data: Map<string, { sum: number; total: number; bullish: number; bearish: number; neutral: number }> | null; ts: number } = { data: null, ts: 0 }
const NEWS_SENT_TTL = 30_000  // 30s — matches screener auto-refresh minimum

export function getNewsSentimentMap(): Map<string, { sum: number; total: number; bullish: number; bearish: number; neutral: number }> {
  const now = Date.now()
  if (newsSentimentCache.data && now - newsSentimentCache.ts < NEWS_SENT_TTL) {
    return newsSentimentCache.data
  }
  const newsMap = new Map<string, { sum: number; total: number; bullish: number; bearish: number; neutral: number }>()

  const addToMap = (ticker: string, sentiment: string) => {
    if (!newsMap.has(ticker)) newsMap.set(ticker, { sum: 0, total: 0, bullish: 0, bearish: 0, neutral: 0 })
    const n = newsMap.get(ticker)!
    n.total++
    const s = sentiment === 'bullish' ? 0.6 : sentiment === 'bearish' ? -0.6 : 0
    n.sum += s
    if (s > 0.1) n.bullish++; else if (s < -0.1) n.bearish++; else n.neutral++
  }

  try {
    const db = openDb(false)
    if (db) {
      const cutoff = Math.floor(now / 1000) - 7 * 24 * 3600

      // Pass 1: articles with pre-extracted tickers
      const tagged: any[] = db.query(
        `SELECT ticker, sentiment FROM articles
         WHERE ticker IS NOT NULL AND length(ticker) > 0
           AND fetched_date > ?
         ORDER BY fetched_date DESC LIMIT 5000`
      ).all(cutoff) as any[]
      for (const a of tagged) {
        const tickers = (a.ticker as string).split(',').map((s: string) => s.trim()).filter(Boolean)
        for (const ticker of tickers) addToMap(ticker, a.sentiment ?? 'neutral')
      }

      // Pass 2: scan titles of untagged articles for known ticker symbols & company names
      const untagged: any[] = db.query(
        `SELECT title, sentiment FROM articles
         WHERE (ticker IS NULL OR length(ticker) = 0)
           AND fetched_date > ?
         ORDER BY fetched_date DESC LIMIT 3000`
      ).all(cutoff) as any[]

      // Build company-name-to-ticker reverse map for faster title matching
      const companyToTicker = new Map<string, string>()
      for (const [sym, company] of TICKER_COMPANY) {
        if (sym.length >= 2 && company.length >= 4 && !TICKER_BLACKLIST.has(sym)) {
          companyToTicker.set(company.toUpperCase(), sym)
        }
      }

      for (const a of untagged) {
        const titleUpper = (a.title ?? '').toUpperCase()
        if (!titleUpper) continue
        const matched = new Set<string>()

        // Check company names in title (high confidence)
        for (const [companyUpper, sym] of companyToTicker) {
          if (matched.size >= 3) break
          if (titleUpper.includes(companyUpper)) matched.add(sym)
        }

        // Check ticker symbols as whole words (only 3+ char to avoid false positives)
        if (matched.size === 0) {
          for (const [sym] of TICKER_COMPANY) {
            if (sym.length < 3 || TICKER_BLACKLIST.has(sym)) continue
            if (matched.size >= 3) break
            if (new RegExp(`\\b${sym}\\b`).test(titleUpper)) matched.add(sym)
          }
        }

        for (const ticker of matched) addToMap(ticker, a.sentiment ?? 'neutral')
      }

      db.close()
    }
  } catch (e) {
    log('WARN', 'News sentiment cache build failed', { error: String(e) })
  }
  newsSentimentCache.data = newsMap
  newsSentimentCache.ts = now
  log('DEBUG', 'News sentiment cache refreshed', { tickers: newsMap.size })
  return newsMap
}
