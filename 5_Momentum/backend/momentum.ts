import { Hono } from 'hono'
import { ms, parseHumanNumber, isMarketOpen } from '../../lib/helpers.ts'
import { log } from '../../lib/logger.ts'
import { openDb } from '../../db/index.ts'
import { getNewsSentimentMap } from '../../db/queries/screener.ts'
import { fetchDs440 } from '../../lib/ds440-client.ts'
import { TICKER_COMPANY, FINVIZ_DATA, TICKER_BLACKLIST } from '../../lib/ticker-map.ts'
import { fetchLivePrices } from './prices.ts'

export const momentumRoutes = new Hono()

const CATALYST_KEYWORDS = [
  'contract', 'fda', 'earnings', 'merger', 'acquisition',
  'data center', 'offering', 'split', 'partnership', 'guidance',
]

const momentumCache: { data: any | null; ts: number } = { data: null, ts: 0 }
const MOMENTUM_TTL = 60_000 // 60s cache

const trendingCache: { data: any[] | null; ts: number } = { data: null, ts: 0 }
const TRENDING_TTL = 120_000 // 2min cache

async function fetchSocialTrending(): Promise<any[]> {
  const now = Date.now()
  if (trendingCache.data && now - trendingCache.ts < TRENDING_TTL) return trendingCache.data

  const trending: any[] = []

  try {
    // Try DS440 screener for social volume
    const data = await fetchDs440('/api/screener?window=1440', 10000).catch(() => null)  // last 24h
    const rows = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : [])

    if (rows.length > 0) {
      for (const r of rows) {
        const tk = r.ticker || r.symbol
        if (!tk || tk.length < 2) continue
        const msgCount = r.message_count ?? r.post_count ?? 0
        const avgSent = r.avg_sentiment ?? r.sentiment ?? 0
        const bullish = r.bullish_count ?? 0
        const bearish = r.bearish_count ?? 0
        if (msgCount < 2) continue // need at least 2 mentions to trend
        trending.push({
          ticker: tk,
          company: TICKER_COMPANY.get(tk) ?? null,
          sector: FINVIZ_DATA.get(tk)?.sector ?? null,
          social_message_count: msgCount,
          social_sentiment: avgSent,
          social_bullish: bullish,
          social_bearish: bearish,
          social_neutral: (r.neutral_count ?? Math.max(0, msgCount - bullish - bearish)),
          buzz_score: msgCount * (1 + Math.abs(avgSent)), // higher buzz = more posts × stronger sentiment
        })
      }
    }

    // StockTwits trending symbols + per-ticker streams
    try {
      // Fetch trending symbols from StockTwits
      const stResp = await fetch('https://api.stocktwits.com/api/2/trending/symbols.json', {
        signal: AbortSignal.timeout(8000),
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
      }).catch(() => null)

      if (stResp && stResp.ok) {
        const stData = await stResp.json().catch(() => null)
        const symbols = stData?.symbols ?? []

        // For each trending symbol, fetch its stream to get posts & sentiment
        // Filter out crypto (.X suffix) and blacklisted tickers
        const stTickers = symbols.map((s: any) => s.symbol).filter((sym: string) =>
          sym && !sym.includes('.') && sym.length >= 2 && !TICKER_BLACKLIST.has(sym)
        ).slice(0, 15)
        const stResults = await Promise.allSettled(
          stTickers.map(async (sym: string) => {
            try {
              const streamResp = await fetch(`https://api.stocktwits.com/api/2/streams/symbol/${sym}.json`, {
                signal: AbortSignal.timeout(5000),
                headers: {
                  'Accept': 'application/json',
                  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                },
              })
              if (!streamResp.ok) return null
              const streamData = await streamResp.json()
              const msgs = streamData?.messages ?? []
              let bullish = 0, bearish = 0, neutral = 0
              const posts: any[] = []
              for (const m of msgs.slice(0, 30)) {
                const sent = m.entities?.sentiment?.basic
                if (sent === 'Bullish') bullish++
                else if (sent === 'Bearish') bearish++
                else neutral++
                if (posts.length < 8) {
                  posts.push({
                    title: (m.body || '').slice(0, 300),
                    source: 'stocktwits',
                    url: `https://stocktwits.com/message/${m.id}`,
                    sentiment_score: sent === 'Bullish' ? 0.5 : sent === 'Bearish' ? -0.5 : 0,
                    published_at: m.created_at || null,
                    author: m.user?.username || null,
                    score: m.likes?.total ?? null,
                    comments: m.conversation?.replies ?? null,
                  })
                }
              }
              const total = bullish + bearish + neutral
              const avgSent = total > 0 ? +((bullish * 0.5 - bearish * 0.5) / total).toFixed(4) : 0
              return {
                ticker: sym,
                company: TICKER_COMPANY.get(sym) ?? streamData?.symbol?.title ?? null,
                sector: FINVIZ_DATA.get(sym)?.sector ?? null,
                social_message_count: total,
                social_sentiment: avgSent,
                social_bullish: bullish,
                social_bearish: bearish,
                social_neutral: neutral,
                buzz_score: total * (1 + Math.abs(avgSent)),
                social_posts: posts,
                source: 'stocktwits',
              }
            } catch { return null }
          })
        )
        for (const r of stResults) {
          if (r.status === 'fulfilled' && r.value) {
            // Merge with existing trending data — if ticker already exists, combine counts
            const existing = trending.find(t => t.ticker === r.value!.ticker)
            if (existing) {
              existing.social_message_count += r.value.social_message_count
              existing.social_bullish += r.value.social_bullish
              existing.social_bearish += r.value.social_bearish
              existing.social_neutral += r.value.social_neutral
              existing.buzz_score += r.value.buzz_score
              // Append StockTwits posts
              existing.social_posts = [...(existing.social_posts ?? []), ...(r.value.social_posts ?? [])].slice(0, 10)
              // Recalculate average sentiment
              const totSent = existing.social_bullish * 0.5 - existing.social_bearish * 0.5
              const totCount = existing.social_bullish + existing.social_bearish + existing.social_neutral
              existing.social_sentiment = totCount > 0 ? +(totSent / totCount).toFixed(4) : 0
            } else {
              trending.push(r.value)
            }
          }
        }
        log('INFO', `StockTwits: fetched ${stTickers.length} trending symbols, got ${stResults.filter(r => r.status === 'fulfilled' && r.value).length} streams`)
      }
    } catch (e) {
      log('DEBUG', 'StockTwits trending fetch failed', { error: String(e) })
    }

    // Fallback: scan local articles from last 48h for buzz
    if (trending.length === 0) {
      try {
        const db = openDb(false)
        if (db) {
          try {
            const tblCheck = db.query(`SELECT name FROM sqlite_master WHERE type='table' AND name='articles'`).get()
            if (tblCheck) {
              const cutoff = Math.floor(now / 1000) - 48 * 3600
              const arts: any[] = db.query(
                `SELECT ticker, sentiment FROM articles WHERE ticker IS NOT NULL AND length(ticker) > 0 AND fetched_date > ? ORDER BY fetched_date DESC LIMIT 3000`
              ).all(cutoff) as any[]
              const tickerBuzz = new Map<string, { total: number; bullish: number; bearish: number; neutral: number; sentSum: number }>()
              for (const a of arts) {
                for (const tk of (a.ticker as string).split(',').map((s: string) => s.trim()).filter(Boolean)) {
                  if (tk.length < 2 || !TICKER_COMPANY.has(tk) || TICKER_BLACKLIST.has(tk)) continue
                  if (!tickerBuzz.has(tk)) tickerBuzz.set(tk, { total: 0, bullish: 0, bearish: 0, neutral: 0, sentSum: 0 })
                  const b = tickerBuzz.get(tk)!
                  b.total++
                  if (a.sentiment === 'bullish') { b.bullish++; b.sentSum += 0.5 }
                  else if (a.sentiment === 'bearish') { b.bearish++; b.sentSum -= 0.5 }
                  else { b.neutral++ }
                }
              }
              for (const [tk, b] of tickerBuzz) {
                if (b.total < 3) continue
                const avgSent = b.sentSum / b.total
                trending.push({
                  ticker: tk,
                  company: TICKER_COMPANY.get(tk) ?? null,
                  sector: FINVIZ_DATA.get(tk)?.sector ?? null,
                  social_message_count: b.total,
                  social_sentiment: +avgSent.toFixed(4),
                  social_bullish: b.bullish,
                  social_bearish: b.bearish,
                  social_neutral: b.neutral,
                  buzz_score: b.total * (1 + Math.abs(avgSent)),
                  source: 'news_fallback',
                })
              }
            }
          } finally { db.close() }
        }
      } catch (e) {
        log('DEBUG', 'Trending: article fallback failed', { error: String(e) })
      }
    }

    // Also try to fetch individual posts for top trending tickers
    const topTrending = trending.sort((a, b) => b.buzz_score - a.buzz_score).slice(0, 20)
    const postResults = await Promise.allSettled(
      topTrending.slice(0, 10).map(async (t) => {
        try {
          const postsData = await fetchDs440(`/api/posts?ticker=${t.ticker}&window=1440`, 5000).catch(() => null)
          const posts = Array.isArray(postsData) ? postsData : (postsData?.posts ?? [])
          return { ticker: t.ticker, posts: posts.slice(0, 8) }
        } catch { return { ticker: t.ticker, posts: [] } }
      })
    )
    const postMap = new Map<string, any[]>()
    for (const r of postResults) {
      if (r.status === 'fulfilled' && r.value.posts.length > 0) {
        postMap.set(r.value.ticker, r.value.posts.map((p: any) => ({
          title: p.title || p.text || '',
          source: p.source || p.subreddit || 'social',
          url: p.url || '',
          sentiment_score: p.sentiment_score ?? 0,
          published_at: p.published_at || p.created_at || null,
          author: p.author || null,
          score: p.score ?? null,
          comments: p.num_comments ?? null,
        })))
      }
    }
    for (const t of topTrending) {
      const ds440Posts = postMap.get(t.ticker)
      if (ds440Posts && ds440Posts.length > 0) {
        // Merge DS440 posts with any existing StockTwits posts
        const existing = t.social_posts ?? []
        const merged: any[] = []
        let ei = 0, di = 0
        while (merged.length < 10 && (ei < existing.length || di < ds440Posts.length)) {
          if (ei < existing.length) merged.push(existing[ei++])
          if (di < ds440Posts.length && merged.length < 10) merged.push(ds440Posts[di++])
        }
        t.social_posts = merged
      }
      // If no posts from either source, leave whatever was already there (StockTwits data)
    }

    trendingCache.data = topTrending
    trendingCache.ts = now
    return topTrending
  } catch (e) {
    log('DEBUG', 'Social trending fetch failed', { error: String(e) })
    return trending
  }
}

function applyMomentumFilters(tickers: any[], minVolume: number, minRvol: number, limit: number, sentiment = '', maxPrice: number = 0): any[] {
  return tickers
    .filter(t => {
      if (t.volume_num <= minVolume || t.rvol < minRvol) return false
      if (maxPrice > 0 && t.price > maxPrice) return false
      if (sentiment === 'bullish' && (t.combined_sentiment ?? 0) <= 0.05) return false
      if (sentiment === 'bearish' && (t.combined_sentiment ?? 0) >= -0.05) return false
      return true
    })
    .sort((a, b) => (b.change_pct ?? 0) - (a.change_pct ?? 0))
    .slice(0, limit)
}

// Trending endpoint
momentumRoutes.get('/api/momentum/trending', async (c) => {
  const t = ms()
  const sentimentFilter = c.req.query('sentiment') ?? '' // bullish | bearish | ''
  const limit = Math.min(parseInt(c.req.query('limit') ?? '15'), 30)
  const maxPrice = parseFloat(c.req.query('max_price') ?? '0')
  const market = isMarketOpen()

  try {
    let trending = await fetchSocialTrending()

    // Apply filters — same filters as the main momentum section
    if (sentimentFilter === 'bullish') trending = trending.filter(t => (t.social_sentiment ?? 0) > 0.05)
    else if (sentimentFilter === 'bearish') trending = trending.filter(t => (t.social_sentiment ?? 0) < -0.05)
    if (maxPrice > 0) {
      trending = trending.filter(t => {
        const fv = FINVIZ_DATA.get(t.ticker)
        const price = fv?.price ?? 0
        return price > 0 && price <= maxPrice
      })
    }

    trending = trending.slice(0, limit)

    // Enrich with live prices (batch in groups of 50)
    const trendSyms = trending.map(t => t.ticker).filter(Boolean)
    for (let i = 0; i < trendSyms.length; i += 50) {
      const batch = trendSyms.slice(i, i + 50)
      const priceMap = await fetchLivePrices(batch)
      for (const [sym, live] of priceMap) {
        const row = trending.find(t => t.ticker === sym)
        if (row) {
          row.price = live.price ?? null
          row.change = live.change ?? null
          row.change_pct = live.changePct ?? null
          row.volume = live.volume ?? null
          row.avg_volume = live.avg_volume ?? null
          const vol = typeof live.volume === 'number' ? live.volume : 0
          const avgVol = parseHumanNumber(live.avg_volume)
          row.volume_num = vol
          row.rvol = avgVol > 0 ? +(vol / avgVol).toFixed(2) : 0
        }
      }
    }

    // Normalize fields for frontend MomentumRow: { ticker, company, price, change_pct, volume, sentiment, article_count }
    const normalized = trending.map((t: any) => ({
      ...t,
      sentiment: t.social_sentiment ?? 0,
      article_count: t.social_message_count ?? 0,
    }))
    return c.json({ tickers: normalized, market, updated: new Date().toISOString(), ms: t() })
  } catch (e) {
    log('WARN', 'Trending endpoint failed', { error: String(e) })
    return c.json({ tickers: [], market, error: String(e), ms: t() }, 500)
  }
})

momentumRoutes.get('/api/momentum', async (c) => {
  const t = ms()
  const minVolume = parseInt(c.req.query('min_volume') ?? '100000')
  const minRvol = parseFloat(c.req.query('min_rvol') ?? c.req.query('min_rel_vol') ?? '1')
  const limit = Math.min(parseInt(c.req.query('limit') ?? '10'), 25)
  const sentimentFilter = c.req.query('sentiment') ?? '' // bullish | bearish | ''
  const maxPrice = parseFloat(c.req.query('max_price') ?? '0')

  const now = Date.now()
  const market = isMarketOpen()

  if (momentumCache.data && now - momentumCache.ts < MOMENTUM_TTL) {
    const filtered = applyMomentumFilters(momentumCache.data.tickers, minVolume, minRvol, limit, sentimentFilter, maxPrice)
    return c.json({ tickers: filtered, updated: momentumCache.data.updated, market, cached: true, ms: t() })
  }

  try {
    // 1. Build ticker universe: DS440 screener > article tickers + liquid list
    let screenerRows: any[] = []
    try {
      const data = await fetchDs440('/api/screener?window=60')
      if (Array.isArray(data.data) && data.data.length > 0) screenerRows = data.data
    } catch { /* fall through */ }

    if (!screenerRows.length) {
      // Always start with known liquid tickers
      const liquidTickers = [
        'SPY','QQQ','IWM','DIA',
        'AAPL','MSFT','GOOGL','AMZN','NVDA','META','TSLA','AMD','INTC','CRM','PLTR','SMCI','AVGO','MU','MRVL',
        'JPM','BAC','GS','MS','V','MA','WFC',
        'JNJ','UNH','PFE','MRNA','ABBV','LLY',
        'XOM','CVX','OXY','SLB',
        'GME','AMC','SOFI','RIVN','LCID','NIO','MARA','RIOT','COIN','HOOD',
        'F','SNAP','UBER','SQ','ROKU','DKNG','RBLX','NFLX','DIS','PYPL','BABA','BA','CAT','DE',
      ]
      const allTickers = new Set(liquidTickers)

      // Add penny stocks/small caps from FINVIZ_DATA if price filter is used
      if (maxPrice > 0) {
        for (const [tk, fv] of FINVIZ_DATA.entries()) {
          if (fv.price !== undefined && fv.price <= maxPrice && fv.volume !== undefined && fv.volume >= minVolume) {
            allTickers.add(tk)
          }
        }
      }

      // Add article tickers (filtered for quality)
      try {
        const db = openDb(false)
        if (db) {
          try {
            const tblCheck = db.query(`SELECT name FROM sqlite_master WHERE type='table' AND name='articles'`).get()
            if (tblCheck) {
              const cutoff = Math.floor(now / 1000) - 7 * 24 * 3600
              const arts: any[] = db.query(
                `SELECT ticker FROM articles WHERE ticker IS NOT NULL AND length(ticker) > 0 AND fetched_date > ? ORDER BY fetched_date DESC LIMIT 2000`
              ).all(cutoff) as any[]
              // Count how many articles mention each ticker to rank relevance
              const tickerCounts = new Map<string, number>()
              for (const a of arts) {
                for (const tk of (a.ticker as string).split(',').map((s: string) => s.trim()).filter(Boolean)) {
                  if (tk.length >= 2 && !TICKER_BLACKLIST.has(tk) && TICKER_COMPANY.has(tk)) {
                    tickerCounts.set(tk, (tickerCounts.get(tk) ?? 0) + 1)
                  }
                }
              }
              // Add top mentioned tickers (most newsworthy = most likely to have momentum)
              const sorted = [...tickerCounts.entries()].sort((a, b) => b[1] - a[1])
              for (const [tk] of sorted.slice(0, 150)) {
                allTickers.add(tk)
              }
            }
          } finally { db.close() }
        }
      } catch (e) {
        log('DEBUG', 'Momentum: articles scan failed', { error: String(e) })
      }

      screenerRows = Array.from(allTickers).map(tk => ({ ticker: tk }))
      log('INFO', `Momentum: scanning ${screenerRows.length} tickers (${liquidTickers.length} liquid + article tickers)`)
    }

    // 2. Enrich with live prices — batch in groups of 50 (CNBC limit)
    const allTickerSyms = screenerRows.map((r: any) => r.ticker).filter(Boolean)
    const priceMap = new Map<string, any>()
    for (let i = 0; i < allTickerSyms.length; i += 50) {
      const batch = allTickerSyms.slice(i, i + 50)
      const batchMap = await fetchLivePrices(batch)
      for (const [k, v] of batchMap) priceMap.set(k, v)
    }

    const enriched = screenerRows.map((r: any) => {
      const live = priceMap.get(r.ticker)
      if (live) {
        r.price = live.price ?? r.price
        r.change = live.change ?? r.change
        r.change_pct = live.changePct ?? r.change_pct
        r.volume = live.volume ?? r.volume
        r.avg_volume = live.avg_volume ?? r.avg_volume
        r.market_cap = live.market_cap ?? r.market_cap
      }
      const fv = FINVIZ_DATA.get(r.ticker)
      if (fv) {
        r.sector = r.sector ?? fv.sector
        r.industry = r.industry ?? fv.industry
      }
      r.company = r.company ?? TICKER_COMPANY.get(r.ticker) ?? null
      // Compute relative volume
      const vol = typeof r.volume === 'number' ? r.volume : parseInt(String(r.volume || '0').replace(/,/g, ''))
      const avgVol = parseHumanNumber(r.avg_volume)
      r.volume_num = vol || 0
      r.avg_volume_num = avgVol || 0
      r.rvol = avgVol > 0 ? +(vol / avgVol).toFixed(2) : 0
      return r
    })

    // 3. Pull recent headlines per ticker from SQLite (if articles table exists)
    const headlinesMap = new Map<string, { title: string; url: string; source: string; date: number; sentiment: string | null }[]>()
    try {
      const db2 = openDb(false)
      if (db2) {
        try {
          const tblCheck = db2.query(`SELECT name FROM sqlite_master WHERE type='table' AND name='articles'`).get()
          if (tblCheck) {
            const cutoff = Math.floor(now / 1000) - 3 * 24 * 3600 // last 3 days
            const arts: any[] = db2.query(
              `SELECT ticker, title, url, source, COALESCE(publish_date, fetched_date) as date, sentiment
               FROM articles WHERE ticker IS NOT NULL AND length(ticker) > 0 AND fetched_date > ?
               ORDER BY date DESC LIMIT 2000`
            ).all(cutoff) as any[]
            for (const a of arts) {
              for (const tk of (a.ticker as string).split(',').map((s: string) => s.trim()).filter(Boolean)) {
                if (!headlinesMap.has(tk)) headlinesMap.set(tk, [])
                const arr = headlinesMap.get(tk)!
                if (arr.length < 10) {
                  arr.push({ title: a.title, url: a.url, source: a.source, date: a.date, sentiment: a.sentiment })
                }
              }
            }
          }
        } finally { db2.close() }
      }
    } catch (e) {
      log('DEBUG', 'Momentum: headlines query failed', { error: String(e) })
    }

    // 4. Classify catalysts in headlines
    for (const [_tk, headlines] of headlinesMap) {
      for (const h of headlines) {
        const lower = h.title.toLowerCase()
        const catalysts = CATALYST_KEYWORDS.filter(kw => lower.includes(kw))
        ;(h as any).catalysts = catalysts
      }
    }

    // 5. Attach headlines to enriched rows
    for (const r of enriched) {
      r.headlines = headlinesMap.get(r.ticker) ?? []
      r.catalyst_count = r.headlines.filter((h: any) => h.catalysts?.length > 0).length
    }

    // 6. Enrich with news sentiment from SQLite
    try {
      const newsMap = getNewsSentimentMap()
      for (const r of enriched) {
        const n = newsMap.get(r.ticker)
        if (n && n.total > 0) {
          r.news_sentiment = +(n.sum / n.total).toFixed(4)
          r.news_article_count = n.total
          r.news_bullish = n.bullish
          r.news_bearish = n.bearish
          r.news_neutral = n.neutral
        } else {
          r.news_sentiment = 0
          r.news_article_count = 0
          r.news_bullish = 0
          r.news_bearish = 0
          r.news_neutral = 0
        }
      }
    } catch (e) {
      log('DEBUG', 'Momentum: news sentiment enrichment failed', { error: String(e) })
    }

    // 7. Enrich with social sentiment from DS440 (batch — non-blocking)
    try {
      const socialTickers = enriched.slice(0, 30).map((r: any) => r.ticker)
      const socialResults = await Promise.allSettled(
        socialTickers.map(async (sym: string) => {
          try {
            const [tickerData, postsData] = await Promise.all([
              fetchDs440(`/api/ticker/${sym}`, 5000).catch(() => null),
              fetchDs440(`/api/posts?ticker=${sym}&window=60`, 5000).catch(() => []),
            ])
            const row = Array.isArray(tickerData) ? tickerData?.[0] : tickerData
            const posts = Array.isArray(postsData) ? postsData : (postsData?.posts ?? [])
            return {
              ticker: sym,
              social_sentiment: row?.avg_sentiment ?? null,
              social_message_count: row?.message_count ?? 0,
              social_bullish: row?.bullish_count ?? 0,
              social_bearish: row?.bearish_count ?? 0,
              social_neutral: row?.neutral_count ?? 0,
              social_posts: posts.slice(0, 8).map((p: any) => ({
                title: p.title || p.text || '',
                source: p.source || p.subreddit || 'social',
                url: p.url || '',
                sentiment_score: p.sentiment_score ?? 0,
                published_at: p.published_at || p.created_at || null,
                author: p.author || null,
                score: p.score ?? null,
                comments: p.num_comments ?? null,
              })),
            }
          } catch { return { ticker: sym, social_sentiment: null, social_message_count: 0, social_bullish: 0, social_bearish: 0, social_neutral: 0, social_posts: [] } }
        })
      )
      for (const res of socialResults) {
        if (res.status !== 'fulfilled') continue
        const sd = res.value
        const row = enriched.find((r: any) => r.ticker === sd.ticker)
        if (row) {
          row.social_sentiment = sd.social_sentiment
          row.social_message_count = sd.social_message_count
          row.social_bullish = sd.social_bullish
          row.social_bearish = sd.social_bearish
          row.social_neutral = sd.social_neutral
          row.social_posts = sd.social_posts
        }
      }
    } catch (e) {
      log('DEBUG', 'Momentum: social enrichment failed (DS440 may be offline)', { error: String(e) })
    }

    // 7b. StockTwits enrichment — merge with DS440 data (not just fallback)
    try {
      const topTickers = enriched.slice(0, 20)
      const stResults = await Promise.allSettled(
        topTickers.map(async (r: any) => {
          try {
            const resp = await fetch(`https://api.stocktwits.com/api/2/streams/symbol/${r.ticker}.json`, {
              signal: AbortSignal.timeout(5000),
              headers: {
                'Accept': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              },
            })
            if (!resp.ok) return null
            const data = await resp.json()
            const msgs = data?.messages ?? []
            let bullish = 0, bearish = 0, neutral = 0
            const posts: any[] = []
            for (const m of msgs.slice(0, 20)) {
              const sent = m.entities?.sentiment?.basic
              if (sent === 'Bullish') bullish++
              else if (sent === 'Bearish') bearish++
              else neutral++
              if (posts.length < 6) {
                posts.push({
                  title: (m.body || '').slice(0, 300),
                  source: 'stocktwits',
                  url: `https://stocktwits.com/message/${m.id}`,
                  sentiment_score: sent === 'Bullish' ? 0.5 : sent === 'Bearish' ? -0.5 : 0,
                  published_at: m.created_at || null,
                  author: m.user?.username || null,
                  score: m.likes?.total ?? null,
                  comments: m.conversation?.replies ?? null,
                })
              }
            }
            const total = bullish + bearish + neutral
            return {
              ticker: r.ticker,
              st_sentiment: total > 0 ? +((bullish * 0.5 - bearish * 0.5) / total).toFixed(4) : null,
              st_count: total,
              st_bullish: bullish,
              st_bearish: bearish,
              st_neutral: neutral,
              st_posts: posts,
            }
          } catch { return null }
        })
      )
      for (const res of stResults) {
        if (res.status !== 'fulfilled' || !res.value) continue
        const sd = res.value
        const row = enriched.find((r: any) => r.ticker === sd.ticker)
        if (row && sd.st_count > 0) {
          // Merge: combine DS440 (Bluesky/Reddit) + StockTwits counts
          row.social_message_count = (row.social_message_count ?? 0) + sd.st_count
          row.social_bullish = (row.social_bullish ?? 0) + sd.st_bullish
          row.social_bearish = (row.social_bearish ?? 0) + sd.st_bearish
          row.social_neutral = (row.social_neutral ?? 0) + sd.st_neutral
          // Merge posts — interleave DS440 and StockTwits, up to 10
          const existingPosts = row.social_posts ?? []
          const merged: any[] = []
          let ei = 0, si = 0
          while (merged.length < 10 && (ei < existingPosts.length || si < sd.st_posts.length)) {
            if (ei < existingPosts.length) merged.push(existingPosts[ei++])
            if (si < sd.st_posts.length && merged.length < 10) merged.push(sd.st_posts[si++])
          }
          row.social_posts = merged
          // Recalculate average sentiment across all sources
          const totalSent = (row.social_bullish * 0.5) - (row.social_bearish * 0.5)
          const totalCount = row.social_bullish + row.social_bearish + row.social_neutral
          row.social_sentiment = totalCount > 0 ? +(totalSent / totalCount).toFixed(4) : row.social_sentiment
          row.social_source = row.social_source ? `${row.social_source}+stocktwits` : 'stocktwits'
        }
      }
      log('INFO', `StockTwits: enriched ${stResults.filter(r => r.status === 'fulfilled' && r.value && r.value.st_count > 0).length}/${topTickers.length} momentum tickers`)
    } catch (e) {
      log('DEBUG', 'Momentum: StockTwits enrichment failed', { error: String(e) })
    }

    // 8. Fallback: populate social column from local articles when DS440 has no posts
    for (const r of enriched) {
      if ((!r.social_posts || r.social_posts.length === 0) && r.headlines && r.headlines.length > 0) {
        r.social_posts = r.headlines.slice(0, 6).map((h: any) => ({
          title: h.title,
          source: h.source || 'news',
          url: h.url || '',
          sentiment_score: h.sentiment === 'bullish' ? 0.5 : h.sentiment === 'bearish' ? -0.5 : 0,
          published_at: h.date ? new Date(h.date * 1000).toISOString() : null,
          author: null,
          score: null,
          comments: null,
        }))
        r.social_source = 'news_fallback'
        // Also fill social sentiment from news if empty
        if (!r.social_message_count) {
          r.social_message_count = r.news_article_count ?? 0
          r.social_sentiment = r.news_sentiment ?? 0
          r.social_bullish = r.news_bullish ?? 0
          r.social_bearish = r.news_bearish ?? 0
          r.social_neutral = r.news_neutral ?? 0
        }
      }
    }

    // 9. Compute combined sentiment score for filtering
    for (const r of enriched) {
      const ns = r.news_sentiment ?? 0
      const ss = r.social_sentiment ?? 0
      const hasNews = (r.news_article_count ?? 0) > 0
      const hasSocial = (r.social_message_count ?? 0) > 0
      if (hasNews && hasSocial) r.combined_sentiment = (ns + ss) / 2
      else if (hasNews) r.combined_sentiment = ns
      else if (hasSocial) r.combined_sentiment = ss
      else r.combined_sentiment = 0
    }

    // Normalize fields for frontend MomentumRow: { ticker, company, price, change_pct, volume, sentiment, article_count }
    for (const r of enriched) {
      r.sentiment = r.combined_sentiment ?? 0
      r.article_count = r.news_article_count ?? 0
    }

    // Cache the full enriched data
    momentumCache.data = { tickers: enriched, updated: new Date().toISOString() }
    momentumCache.ts = now

    const filtered = applyMomentumFilters(enriched, minVolume, minRvol, limit, sentimentFilter)
    return c.json({ tickers: filtered, updated: momentumCache.data.updated, market, cached: false, ms: t() })
  } catch (e) {
    log('WARN', 'Momentum scanner failed', { error: String(e) })
    return c.json({ tickers: [], updated: null, market, error: String(e), ms: t() }, 500)
  }
})

// GET /api/momentum/:ticker/details — headlines + social posts for expanded card
momentumRoutes.get('/api/momentum/:ticker/details', async (c) => {
  const t = ms()
  const ticker = c.req.param('ticker').toUpperCase()
  const now = Date.now()

  // 1. Headlines from SQLite
  const headlines: any[] = []
  try {
    const db = openDb(false)
    if (db) {
      try {
        const tblCheck = db.query(`SELECT name FROM sqlite_master WHERE type='table' AND name='articles'`).get()
        if (tblCheck) {
          const cutoff = Math.floor(now / 1000) - 3 * 24 * 3600
          const arts: any[] = db.query(
            `SELECT title, url, source, sentiment, COALESCE(publish_date, fetched_date) as date
             FROM articles WHERE (ticker LIKE $t1 OR ticker LIKE $t2 OR ticker LIKE $t3 OR ticker = $t4)
             AND fetched_date > $cutoff
             ORDER BY date DESC LIMIT 10`
          ).all({ $t1: `${ticker},%`, $t2: `%,${ticker},%`, $t3: `%,${ticker}`, $t4: ticker, $cutoff: cutoff }) as any[]
          for (const a of arts) {
            const lower = a.title?.toLowerCase() ?? ''
            const catalysts = CATALYST_KEYWORDS.filter(kw => lower.includes(kw))
            headlines.push({
              title: a.title,
              source: a.source ?? 'news',
              sentiment: a.sentiment ?? null,
              time: a.date ? new Date(a.date * 1000).toISOString() : null,
              catalyst: catalysts.length > 0 ? catalysts.join(', ') : undefined,
            })
          }
        }
      } finally { db.close() }
    }
  } catch (e) {
    log('DEBUG', 'Momentum details: headlines failed', { ticker, error: String(e) })
  }

  // 2. Social posts from DS440 + StockTwits
  const posts: any[] = []
  try {
    const [ds440Posts, stResp] = await Promise.allSettled([
      fetchDs440(`/api/posts?ticker=${ticker}&window=1440`, 5000).catch(() => []),
      fetch(`https://api.stocktwits.com/api/2/streams/symbol/${ticker}.json`, {
        signal: AbortSignal.timeout(5000),
        headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
      }).then(r => r.ok ? r.json() : null).catch(() => null),
    ])

    // DS440 posts
    if (ds440Posts.status === 'fulfilled') {
      const raw = ds440Posts.value
      const arr = Array.isArray(raw) ? raw : (raw?.posts ?? [])
      for (const p of arr.slice(0, 6)) {
        posts.push({
          content: p.title ?? p.text ?? '',
          platform: p.source ?? (p.subreddit ? 'reddit' : 'social'),
          author: p.author ?? 'anonymous',
          sentiment: p.sentiment_score ?? 0,
        })
      }
    }

    // StockTwits posts
    if (stResp.status === 'fulfilled' && stResp.value) {
      const msgs = stResp.value?.messages ?? []
      for (const m of msgs.slice(0, 6)) {
        const sent = m.entities?.sentiment?.basic
        posts.push({
          content: (m.body || '').slice(0, 300),
          platform: 'stocktwits',
          author: m.user?.username || 'anonymous',
          sentiment: sent === 'Bullish' ? 0.5 : sent === 'Bearish' ? -0.5 : 0,
        })
      }
    }
  } catch (e) {
    log('DEBUG', 'Momentum details: social posts failed', { ticker, error: String(e) })
  }

  // Interleave DS440 and StockTwits posts
  return c.json({ ticker, headlines, posts: posts.slice(0, 10), ms: t() })
})

// GET /api/charts/:ticker — OHLCV + RSI + MACD + Bollinger from Yahoo Finance
function calcEMA(data: number[], period: number): (number | null)[] {
  const result: (number | null)[] = Array(data.length).fill(null)
  if (data.length < period) return result
  const k = 2 / (period + 1)
  let seed = 0
  for (let i = 0; i < period; i++) seed += data[i]
  result[period - 1] = seed / period
  for (let i = period; i < data.length; i++) {
    result[i] = data[i] * k + (result[i - 1] as number) * (1 - k)
  }
  return result
}

function calcRSI(closes: number[], period = 14): (number | null)[] {
  const rsi: (number | null)[] = Array(closes.length).fill(null)
  if (closes.length < period + 1) return rsi
  let avgGain = 0, avgLoss = 0
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1]
    if (d > 0) avgGain += d; else avgLoss -= d
  }
  avgGain /= period; avgLoss /= period
  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1]
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
  }
  return rsi
}

function calcBollinger(closes: number[], period = 20, mult = 2) {
  const upper: (number | null)[] = Array(closes.length).fill(null)
  const middle: (number | null)[] = Array(closes.length).fill(null)
  const lower: (number | null)[] = Array(closes.length).fill(null)
  for (let i = period - 1; i < closes.length; i++) {
    const slice = closes.slice(i - period + 1, i + 1)
    const mean = slice.reduce((a, b) => a + b, 0) / period
    const std = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period)
    middle[i] = mean; upper[i] = mean + mult * std; lower[i] = mean - mult * std
  }
  return { upper, middle, lower }
}

function calcMACD(closes: number[]) {
  const ema12 = calcEMA(closes, 12)
  const ema26 = calcEMA(closes, 26)
  const macdLine = ema12.map((v, i) => v != null && ema26[i] != null ? v - (ema26[i] as number) : null)
  const macdValues = macdLine.filter((v): v is number => v != null)
  const signalShort = calcEMA(macdValues, 9)
  const offset = macdLine.length - signalShort.length
  const signal: (number | null)[] = [...Array(offset).fill(null), ...signalShort]
  const hist = macdLine.map((v, i) => v != null && signal[i] != null ? v - (signal[i] as number) : null)
  return { macd: macdLine, signal, hist }
}

momentumRoutes.get('/api/charts/:ticker', async (c) => {
  const t = ms()
  const ticker = c.req.param('ticker').toUpperCase()
  const range = c.req.query('range') ?? '3mo'
  const interval = c.req.query('interval') ?? '1d'

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=${interval}&range=${range}&includePrePost=false`
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(10000),
    })
    const json: any = await res.json()
    const result = json?.chart?.result?.[0]
    if (!result) return c.json({ error: 'No data found for ticker', ticker, ms: t() }, 404)

    const timestamps: number[] = result.timestamp ?? []
    const q = result.indicators?.quote?.[0] ?? {}
    const opens: number[] = q.open ?? []
    const highs: number[] = q.high ?? []
    const lows: number[] = q.low ?? []
    const closes: number[] = q.close ?? []
    const volumes: number[] = q.volume ?? []

    const valid = timestamps
      .map((ts, i) => ({ ts, o: opens[i], h: highs[i], l: lows[i], c: closes[i], v: volumes[i] }))
      .filter(d => d.c != null && d.o != null)

    const cleanCloses = valid.map(d => d.c)
    const rsi = calcRSI(cleanCloses)
    const bb = calcBollinger(cleanCloses)
    const macd = calcMACD(cleanCloses)

    // News sentiment per day from our SQLite
    let newsSentiment: any[] = []
    const db = openDb()
    if (db) {
      try {
        newsSentiment = db.query(
          `SELECT DATE(datetime(COALESCE(publish_date, fetched_date), 'unixepoch')) as date,
                  AVG(CASE sentiment WHEN 'bullish' THEN 1 WHEN 'bearish' THEN -1 ELSE 0 END) as avg_sent,
                  COUNT(*) as count
           FROM articles
           WHERE (ticker LIKE $t OR title LIKE $t)
             AND COALESCE(publish_date, fetched_date) IS NOT NULL
           GROUP BY date ORDER BY date ASC`
        ).all({ $t: `%${ticker}%` }) as any[]
      } finally {
        db.close()
      }
    }

    return c.json({
      ticker,
      candles: valid.map((d, i) => ({
        time: d.ts, open: d.o, high: d.h, low: d.l, close: d.c, volume: d.v,
        rsi: rsi[i],
        bb_upper: bb.upper[i],
        bb_middle: bb.middle[i],
        bb_lower: bb.lower[i],
        macd: macd.macd[i],
        macd_signal: macd.signal[i],
        macd_hist: macd.hist[i],
      })),
      news_sentiment: newsSentiment,
      meta: result.meta ?? {},
      ms: t(),
    })
  } catch (e) {
    log('WARN', 'Chart fetch failed', { ticker, error: String(e) })
    return c.json({ error: String(e), ticker, ms: t() }, 500)
  }
})
