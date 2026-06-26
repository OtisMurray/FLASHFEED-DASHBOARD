import { Hono } from 'hono'
import { ms } from '../../lib/helpers.ts'
import { log } from '../../lib/logger.ts'

export const pricesRoutes = new Hono()

// ─── Live price cache ──────────────────────────────────────────────────────────
// Successful quotes cached for 60s; failures cached for 5 min to stop hammering Yahoo.
const priceCache = new Map<string, { price: number; change: number; changePct: number; volume: number | null; avg_volume: number | null; market_cap: string | null; pe_ratio: number | null; week_52_high: number | null; week_52_low: number | null; earnings_date: string | null; ts: number }>()
const PRICE_TTL = 60_000   // ms — re-fetch successful quotes after 60s
const PRICE_FAIL_TTL = 300_000  // ms — don't retry a failed batch for 5 min
let priceFetchFailedAt = 0    // timestamp of last Yahoo batch failure

export async function fetchLivePrices(tickers: string[]): Promise<Map<string, { price: number; change: number; changePct: number; volume: number | null; avg_volume: number | null; market_cap: string | null; pe_ratio: number | null; week_52_high: number | null; week_52_low: number | null; earnings_date: string | null }>> {
  const result = new Map<string, { price: number; change: number; changePct: number; volume: number | null; avg_volume: number | null; market_cap: string | null; pe_ratio: number | null; week_52_high: number | null; week_52_low: number | null; earnings_date: string | null }>()
  const now = Date.now()

  const toFetch = tickers.filter(t => {
    const cached = priceCache.get(t)
    if (cached && now - cached.ts < PRICE_TTL) {
      result.set(t, {
        price: cached.price, change: cached.change, changePct: cached.changePct,
        volume: cached.volume, avg_volume: cached.avg_volume, market_cap: cached.market_cap,
        pe_ratio: cached.pe_ratio, week_52_high: cached.week_52_high, week_52_low: cached.week_52_low,
        earnings_date: cached.earnings_date
      })
      return false
    }
    return true
  })

  if (!toFetch.length) return result

  // If the last fetch attempt failed recently, skip — don't hammer Yahoo during an outage
  if (priceFetchFailedAt > 0 && now - priceFetchFailedAt < PRICE_FAIL_TTL) return result

  const symbols = toFetch.join('|')
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'application/json',
  }

  let lastErr = ''

  try {
    const url = `https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=${encodeURIComponent(symbols)}&requestMethod=itv`
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) })
    if (!res.ok) throw new Error(`CNBC status ${res.status}`)

    const json: any = await res.json()
    const quotes: any[] = json?.FormattedQuoteResult?.FormattedQuote ?? []

    for (const q of quotes) {
      const sym = q?.symbol
      if (!sym) continue
      const entry = {
        price: parseFloat((q.last || '0').replace(/,/g, '')) || 0,
        change: parseFloat((q.change || '0').replace(/,/g, '')) || 0,
        changePct: parseFloat((q.change_pct || '0').replace('%', '')) || 0,
        volume: parseInt((q.volume || '0').replace(/,/g, '')) || null,
        avg_volume: q.tendayavgvol || null,
        market_cap: q.mktcapView || null,
        pe_ratio: parseFloat(q.pe) || null,
        week_52_high: parseFloat(q.yrhiprice) || null,
        week_52_low: parseFloat(q.yrloprice) || null,
        earnings_date: null,
        ts: now,
      }
      priceCache.set(sym, entry)
      const { ts, ...liveData } = entry
      result.set(sym, liveData)
    }
    priceFetchFailedAt = 0  // clear failure flag on success
    return result
  } catch (e) {
    lastErr = String(e).slice(0, 80)
  }

  // Both hosts failed — back off for PRICE_FAIL_TTL before trying again
  priceFetchFailedAt = now
  log('WARN', 'Live price fetch failed (backing off 5 min)', { reason: lastErr })
  return result
}

// GET /api/prices?tickers=AAPL,TSLA,GOOG — batch live quotes (60s cache)
pricesRoutes.get('/api/prices', async (c) => {
  const t = ms()
  const raw = c.req.query('tickers') ?? ''
  const tickers = raw.split(',').map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, 50)
  if (!tickers.length) return c.json({ prices: {}, ms: t() })

  const map = await fetchLivePrices(tickers)
  const prices: Record<string, { price: number; change: number; changePct: number }> = {}
  for (const [sym, data] of map) prices[sym] = data

  return c.json({ prices, ms: t() })
})
