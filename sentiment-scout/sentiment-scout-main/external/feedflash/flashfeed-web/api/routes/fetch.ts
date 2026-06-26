import { Hono } from 'hono'
import { existsSync } from 'fs'
import { join } from 'path'
import { streamSSE } from 'hono/streaming'
import { BIN, DB, CFG, ROOT } from '../../lib/config.ts'
import { ms, cli } from '../../lib/helpers.ts'
import { log } from '../../lib/logger.ts'
import { openDb } from '../../db/index.ts'
import { migrateSentimentSchema } from '../../db/migrations.ts'
import { TICKER_COMPANY } from '../../lib/ticker-map.ts'
import { dictionarySentiment } from '../../lib/classifier.ts'
import { readCfg } from '../../lib/config.ts'

export const fetchRoutes = new Hono()

/** Minimal XML tag extractor — avoids needing an XML parser dependency */
function xmlText(xml: string, tag: string): string {
  // Try <tag>…</tag>
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i')
  const m = xml.match(re)
  if (!m) return ''
  // Strip CDATA wrappers
  return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim()
}

/** Extract href from <link … href="…"/> (Atom feeds) */
function atomLink(entry: string): string {
  const m = entry.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i)
    ?? entry.match(/<link[^>]*href=["']([^"']+)["'][^>]*rel=["']alternate["']/i)
    ?? entry.match(/<link[^>]*href=["']([^"']+)["']/i)
  return m ? m[1] : ''
}

/** Parse RSS/Atom XML into article objects */
function parseRssFeed(xml: string, sourceName: string, category: string): Array<{
  id: string; title: string; content: string; url: string; source: string; category: string; publish_date: number | null; fetched_date: number
}> {
  const now = Math.floor(Date.now() / 1000)
  const articles: any[] = []

  // Split into items (RSS) or entries (Atom)
  const itemRegex = /<(?:item|entry)[\s>]([\s\S]*?)<\/(?:item|entry)>/gi
  let match
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1]
    const title = xmlText(block, 'title')
    if (!title) continue

    const url = xmlText(block, 'link') || atomLink(block) || xmlText(block, 'guid')
    const content = xmlText(block, 'description') || xmlText(block, 'summary') || xmlText(block, 'content')
    const pubStr = xmlText(block, 'pubDate') || xmlText(block, 'published') || xmlText(block, 'updated') || xmlText(block, 'dc:date')
    let pubDate: number | null = null
    if (pubStr) {
      const d = new Date(pubStr)
      if (!isNaN(d.getTime())) pubDate = Math.floor(d.getTime() / 1000)
    }

    // Deterministic ID from URL or title
    const raw = url || `${sourceName}::${title}`
    // Simple hash — Bun has crypto, but a quick string hash works for dedup
    let hash = 0
    for (let i = 0; i < raw.length; i++) { hash = ((hash << 5) - hash + raw.charCodeAt(i)) | 0 }
    const id = `rss-${Math.abs(hash).toString(36)}-${pubDate ?? now}`

    // Strip HTML tags from content for clean text
    const cleanContent = content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1000)

    articles.push({ id, title, content: cleanContent, url, source: sourceName, category, publish_date: pubDate, fetched_date: now })
  }

  return articles
}

/** Fetch all configured RSS feeds and insert into SQLite (Bun-native, no C++ needed) */
async function bunFetchFeeds(): Promise<{ new_articles: number; duplicates: number; errors: number; total: number; ms: number }> {
  const elapsed = ms()
  const cfg = readCfg()
  const feeds: { name: string; url: string; category: string }[] = cfg.sources?.rss_feeds ?? []
  if (!feeds.length) return { new_articles: 0, duplicates: 0, errors: 0, total: 0, ms: elapsed() }

  // Ensure articles table exists
  migrateSentimentSchema()

  let newCount = 0
  let dupeCount = 0
  let errCount = 0

  const db = openDb(true)
  if (!db) return { new_articles: 0, duplicates: 0, errors: errCount, total: 0, ms: elapsed() }

  const insertStmt = db.prepare(
    `INSERT OR IGNORE INTO articles (id, title, content, url, source, category, publish_date, fetched_date)
     VALUES ($id, $title, $content, $url, $source, $category, $publish_date, $fetched_date)`
  )

  // Fetch feeds in parallel (max 5 concurrent)
  const batchSize = 5
  for (let i = 0; i < feeds.length; i += batchSize) {
    const batch = feeds.slice(i, i + batchSize)
    const results = await Promise.allSettled(
      batch.map(async (feed) => {
        try {
          const res = await fetch(feed.url, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
              'Accept': 'application/rss+xml, application/xml, application/atom+xml, text/xml, */*',
            },
            signal: AbortSignal.timeout(15000),
          })
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const xml = await res.text()
          return parseRssFeed(xml, feed.name, feed.category)
        } catch (e) {
          log('WARN', `RSS fetch failed: ${feed.name}`, { url: feed.url, error: String(e).slice(0, 100) })
          errCount++
          return []
        }
      })
    )

    // Insert articles from this batch
    for (const r of results) {
      if (r.status !== 'fulfilled') { errCount++; continue }
      for (const art of r.value) {
        try {
          const info = insertStmt.run({
            $id: art.id,
            $title: art.title,
            $content: art.content,
            $url: art.url,
            $source: art.source,
            $category: art.category,
            $publish_date: art.publish_date,
            $fetched_date: art.fetched_date,
          })
          if (info.changes > 0) newCount++; else dupeCount++
        } catch { dupeCount++ }
      }
    }
  }

  // Now extract tickers from new articles
  if (newCount > 0) {
    try {
      const untagged = db.query(
        `SELECT id, title, content FROM articles WHERE ticker IS NULL ORDER BY fetched_date DESC LIMIT 500`
      ).all() as { id: string; title: string; content: string | null }[]
      const tickerStmt = db.prepare(`UPDATE articles SET ticker=$ticker, company=$company WHERE id=$id`)
      for (const art of untagged) {
        const text = (art.title + ' ' + (art.content ?? '')).toUpperCase()
        const found: string[] = []
        // Quick scan: check if any known ticker symbol appears as a whole word
        for (const [sym] of TICKER_COMPANY) {
          if (sym.length < 2) continue // skip single-letter tickers
          const re = new RegExp(`\\b${sym}\\b`)
          if (re.test(text)) found.push(sym)
          if (found.length >= 5) break
        }
        if (found.length > 0) {
          tickerStmt.run({ $ticker: found.join(','), $company: TICKER_COMPANY.get(found[0]) ?? null, $id: art.id })
        }
        // Also stamp sentiment
        const label = dictionarySentiment(art.title, art.content ?? '')
        db.run(`UPDATE articles SET sentiment=$s, sentiment_at=$t WHERE id=$id AND sentiment IS NULL`,
          { $s: label, $t: Math.floor(Date.now() / 1000), $id: art.id })
      }
    } catch (e) {
      log('WARN', 'Ticker extraction failed', { error: String(e) })
    }
  }

  const { total } = db.query('SELECT COUNT(*) as total FROM articles').get({}) as { total: number }
  db.close()

  return { new_articles: newCount, duplicates: dupeCount, errors: errCount, total, ms: elapsed() }
}

// POST /api/fetch — run --fetch command (uses C++ binary if available, Bun-native fallback otherwise)
fetchRoutes.post('/api/fetch', async (c) => {
  log('INFO', 'Fetch triggered via dashboard')

  // Import scorePendingArticles lazily to avoid circular deps
  const { scorePendingArticles } = await import('../../workers/sentiment-worker.ts')

  // If the C++ binary exists, use it (original behavior)
  if (existsSync(BIN)) {
    const r = await cli(['--fetch'])
    const match = (re: RegExp) => { const m = r.out.match(re); return m ? +m[1] : null }

    const newArts = match(/New articles:\s+(\d+)/)
    const dupes = match(/Duplicates:\s+(\d+)/)
    const errors = match(/Errors:\s+(\d+)/)
    const total = match(/Total in DB:\s+(\d+)/)

    if (r.code === 0) {
      log('INFO', 'Fetch complete (C++ binary)', { new_articles: newArts, duplicates: dupes, errors, total, ms: r.ms })
      migrateSentimentSchema()
      if ((newArts ?? 0) > 0) {
        scorePendingArticles(200)
          .then(n => { if (n > 0) log('INFO', 'Post-fetch sentiment scoring complete', { scored: n }) })
          .catch(e => log('WARN', 'Post-fetch sentiment scoring skipped', { reason: String(e) }))
      }
    } else {
      log('ERROR', 'Fetch failed', { code: r.code, ms: r.ms })
    }

    return c.json({
      success: r.code === 0,
      new_articles: newArts,
      duplicates: dupes,
      errors,
      total,
      output: r.out,
      stderr: r.err,
      ms: r.ms,
    })
  }

  // Bun-native RSS fallback
  log('INFO', 'Using Bun-native RSS fetcher (C++ binary not available)')
  try {
    const result = await bunFetchFeeds()
    log('INFO', 'Bun RSS fetch complete', result)

    // Fire-and-forget sentiment scoring
    if (result.new_articles > 0) {
      scorePendingArticles(200)
        .then(n => { if (n > 0) log('INFO', 'Post-fetch sentiment scoring complete', { scored: n }) })
        .catch(e => log('WARN', 'Post-fetch sentiment scoring skipped', { reason: String(e) }))
    }

    return c.json({
      success: true,
      new_articles: result.new_articles,
      duplicates: result.duplicates,
      errors: result.errors,
      total: result.total,
      output: `Bun RSS fetcher: ${result.new_articles} new, ${result.duplicates} dupes, ${result.errors} errors`,
      stderr: '',
      ms: result.ms,
    })
  } catch (e) {
    log('ERROR', 'Bun RSS fetch failed', { error: String(e) })
    return c.json({ success: false, error: String(e), ms: 0 }, 500)
  }
})

// POST /api/clear — delete ALL articles from the database
fetchRoutes.post('/api/clear', (c) => {
  const t = ms()
  const d = openDb(true)
  if (!d) {
    log('WARN', 'Clear requested but database not found')
    return c.json({ error: 'Database not found' }, 404)
  }
  try {
    const { count } = d.query('SELECT COUNT(*) as count FROM articles').get({}) as { count: number }
    d.query('DELETE FROM articles').run()
    log('INFO', 'All articles cleared from database', { deleted: count })
    return c.json({ success: true, deleted: count, ms: t() })
  } catch (e) {
    log('ERROR', 'Clear failed', { error: String(e) })
    return c.json({ error: String(e) }, 500)
  } finally {
    d.close()
  }
})

// POST /api/cleanup — run --cleanup <days>
fetchRoutes.post('/api/cleanup', async (c) => {
  const { days = 30 } = await c.req.json()
  log('INFO', 'Cleanup triggered', { days: +days })
  const r = await cli(['--cleanup', String(+days)])
  if (r.code === 0) {
    log('INFO', 'Cleanup complete', { days: +days, ms: r.ms })
  } else {
    log('ERROR', 'Cleanup failed', { days: +days, code: r.code })
  }
  return c.json({ success: r.code === 0, output: r.out, ms: r.ms, days: +days })
})

// GET /api/watch?interval=30 — SSE stream from --watch command
// interval: polling cadence in seconds (default 60, min 10, max 3600)
fetchRoutes.get('/api/watch', (c) => {
  const rawInterval = parseInt(c.req.query('interval') ?? '60', 10)
  const intervalSec = Math.max(10, Math.min(3600, isNaN(rawInterval) ? 60 : rawInterval))
  return streamSSE(c, async (stream) => {
    log('INFO', 'Watch mode SSE client connected', { ip: c.req.header('x-forwarded-for') ?? 'local', intervalSec })

    await stream.writeSSE({
      event: 'start',
      data: JSON.stringify({ message: 'Watch mode starting…', ts: Date.now() }),
    })

    if (!existsSync(BIN)) {
      log('ERROR', 'Watch mode: binary not found')
      await stream.writeSSE({
        event: 'error',
        data: JSON.stringify({ message: `Binary not found at ${BIN}` }),
      })
      return
    }

    const proc = Bun.spawn([BIN, '--config', CFG, '--watch', String(intervalSec)], {
      cwd: ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    })

    // Kill the subprocess when the client disconnects
    c.req.raw.signal.addEventListener('abort', () => {
      log('INFO', 'Watch mode SSE client disconnected — killing subprocess')
      proc.kill()
    })

    const decoder = new TextDecoder()
    const reader = proc.stdout.getReader()
    let lineCount = 0

    // Import scorePendingArticles lazily
    const { scorePendingArticles } = await import('../../workers/sentiment-worker.ts')

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const text = decoder.decode(value)
        for (const line of text.split('\n')) {
          const trimmed = line.trim()
          if (trimmed) {
            lineCount++
            log('DEBUG', `[watch] ${trimmed}`)
            await stream.writeSSE({
              event: 'line',
              data: JSON.stringify({ text: trimmed, ts: Date.now() }),
            })

            // Detect when fetch cycle completes and new articles are pulled
            const newArtsMatch = trimmed.match(/(\d+)\s+new article/)
            if (newArtsMatch) {
              const count = parseInt(newArtsMatch[1], 10)
              if (count > 0) {
                // Instantly score new articles
                scorePendingArticles(200)
                  .then(n => { if (n > 0) log('INFO', 'Watch-mode sentiment scoring complete', { scored: n }) })
                  .catch(e => log('WARN', 'Watch-mode sentiment scoring failed', { reason: String(e) }))
              }

              // Run correlation tracking sequentially after fetch completes
              const trackerPath = join(import.meta.dir, '..', '..', 'correlation_tracker.py')
              const script = existsSync(trackerPath) ? trackerPath : join(import.meta.dir, '..', '..', '..', 'correlation_tracker.py')
              if (existsSync(script)) {
                log('DEBUG', 'Watch-mode triggering correlation tracker')
                Bun.spawn(['python3', script, DB]).exited.catch(() => {})
              }
            }
          }
        }
      }
    } catch (_) {
      // Stream closed by client disconnect — normal
    }

    log('INFO', 'Watch mode subprocess ended', { lines_streamed: lineCount })
    await stream.writeSSE({
      event: 'end',
      data: JSON.stringify({ message: 'Watch mode ended', ts: Date.now() }),
    })
  })
})
