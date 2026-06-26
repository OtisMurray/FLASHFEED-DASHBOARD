import { join } from 'path'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { openDb } from '../db/index.ts'
import { log } from '../lib/logger.ts'
import { TICKER_COMPANY, FINVIZ_DATA } from '../lib/ticker-map.ts'
import { ROOT } from '../lib/config.ts'
import { readCfg } from '../lib/config.ts'

const HEARTBEAT_DIR = join(ROOT, 'data', 'workers')

function writeHeartbeat(lastCount: number, errors: number) {
  try {
    if (!existsSync(HEARTBEAT_DIR)) mkdirSync(HEARTBEAT_DIR, { recursive: true })
    writeFileSync(
      join(HEARTBEAT_DIR, 'sentiment.heartbeat.json'),
      JSON.stringify({ ts: Date.now(), lastCount, errors, pid: process.pid }),
      'utf-8'
    )
  } catch { /* ignore */ }
}

/** Port of the Python sentiment microservice (sentiment_service/service.py) */
function sentimentPort(): number {
  const cfg = readCfg()
  return cfg.sentiment?.service_port ?? 5001
}

export async function scorePendingArticles(batchSize = 50): Promise<number> {
  const port = sentimentPort()

  // Check service is alive before pulling a batch
  try {
    const health = await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(3000) })
    const hj = await health.json() as any
    if (!hj.ok) {
      log('WARN', 'FinBERT service unhealthy — skipping batch', { error: hj.error ?? 'unknown' })
      return 0
    }
  } catch (e) {
    log('DEBUG', 'FinBERT service not reachable', { reason: String(e).slice(0, 80) })
    return 0
  }

  const db = openDb()
  if (!db) return 0

  // Articles table is created by the C++ binary on first fetch — skip silently if not yet exists
  const tableExists = db.query(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='articles'`).get()
  if (!tableExists) { db.close(); return 0 }

  // Fetch current labels too so we can log upgrades
  let pending: any[]
  try {
    pending = db.query(
      `SELECT id, title, sentiment AS old_sentiment, content FROM articles
       WHERE sentiment IS NULL OR ml_confidence IS NULL
       ORDER BY COALESCE(publish_date, fetched_date) DESC
       LIMIT ?`
    ).all(batchSize)
  } finally { db.close() }

  if (!pending.length) {
    log('DEBUG', 'FinBERT worker: no unscored articles in batch')
    return 0
  }

  log('INFO', `FinBERT scoring batch`, { count: pending.length, port })

  const resp = await fetch(`http://localhost:${port}/analyze-articles`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ articles: pending.map(a => ({ id: a.id, title: a.title, content: (a.content ?? '').slice(0, 800) })) }),
    signal: AbortSignal.timeout(120_000),
  })

  if (!resp.ok) {
    log('WARN', 'FinBERT /analyze-articles failed', { status: resp.status })
    return 0
  }

  const results = ((await resp.json()) as any).results ?? []
  const now = Math.floor(Date.now() / 1000)

  // Build lookup of old labels
  const oldLabelMap = new Map(pending.map((a: any) => [a.id, a.old_sentiment as string | null]))

  const dw = openDb(true)
  if (!dw) return 0

  let scored = 0
  let upgraded = 0
  let unchanged = 0
  const upgradedItems: string[] = []

  try {
    for (const res of results) {
      if (!res.id || !res.sentiment) continue
      const primaryTicker: string | null = (res.tickers as string[] | undefined)?.[0] ?? null
      const company: string | null =
        (res.company as string | undefined) ??
        (primaryTicker ? (TICKER_COMPANY.get(primaryTicker) ?? null) : null)
      const oldLabel = oldLabelMap.get(res.id) ?? null
      const conf = res.confidence != null ? Math.round(res.confidence * 100) : null

      dw.run(
        'UPDATE articles SET sentiment=?, ml_confidence=?, sentiment_at=?, ticker=COALESCE(ticker,?), company=COALESCE(company,?) WHERE id=?',
        [res.sentiment, res.confidence ?? null, now, primaryTicker, company, res.id]
      )
      scored++

      if (oldLabel && oldLabel !== res.sentiment) {
        upgraded++
        // Find title for logging
        const title = pending.find((a: any) => a.id === res.id)?.title ?? res.id
        upgradedItems.push(`  ${oldLabel}→${res.sentiment} (${conf}%) "${title.slice(0, 60)}"`)
      } else {
        unchanged++
      }
    }
  } finally { dw.close() }

  // Summary log
  log('INFO', 'FinBERT batch complete', { scored, upgraded, unchanged })
  if (upgradedItems.length) {
    log('INFO', 'FinBERT label upgrades:\n' + upgradedItems.join('\n'))
  }

  return scored
}

export function startSentimentWorker(intervalMs = 30_000) {
  let running = false
  let errors = 0
  setInterval(async () => {
    if (running) return          // skip if previous batch still processing
    running = true
    try {
      const scored = await scorePendingArticles(50)
      writeHeartbeat(scored, errors)
    } catch (e) {
      errors++
      log('WARN', 'Background sentiment worker error', { reason: String(e).slice(0, 120) })
      writeHeartbeat(0, errors)
    } finally {
      running = false
    }
  }, intervalMs)
  log('INFO', `Background sentiment worker started (every ${intervalMs / 1000}s)`)
}

// Standalone entrypoint (when run directly: bun run workers/sentiment-worker.ts)
if (import.meta.main) {
  log('INFO', 'Sentiment worker starting in standalone mode')
  startSentimentWorker(30_000)
}
