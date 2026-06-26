import { Hono } from 'hono'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { BIN, DB, CFG, ROOT } from '../../lib/config.ts'
import { ms } from '../../lib/helpers.ts'
import { openDb } from '../../db/index.ts'
import { isMarketOpen } from '../../lib/helpers.ts'

export const statusRoutes = new Hono()

// GET /api/status — server health + binary/db availability
statusRoutes.get('/api/status', (c) => {
  const t = ms()
  const binaryOk = existsSync(BIN)
  const dbOk = existsSync(DB)
  const cfgOk = existsSync(CFG)

  let articleCount = 0
  if (dbOk) {
    const d = openDb()
    if (d) {
      try {
        const row = d.query('SELECT COUNT(*) as total FROM articles').get({}) as any
        articleCount = row?.total ?? 0
      } catch { /* table may not exist yet */ } finally {
        d.close()
      }
    }
  }

  return c.json({
    ok: true,
    binary: { path: BIN, exists: binaryOk },
    database: { path: DB, exists: dbOk, articles: articleCount },
    config: { path: CFG, exists: cfgOk },
    root: ROOT,
    ms: t(),
  })
})

// GET /api/market/status
statusRoutes.get('/api/market/status', (c) => {
  return c.json(isMarketOpen())
})

// GET /api/workers/health — check worker heartbeat files
statusRoutes.get('/api/workers/health', (c) => {
  const HEARTBEAT_DIR = join(ROOT, 'data', 'workers')
  const STALE_THRESHOLD_MS = 90_000  // 90 seconds

  const now = Date.now()

  function readHeartbeat(name: string): { ok: boolean; lastRun: string | null; pid: number | null } {
    const filePath = join(HEARTBEAT_DIR, `${name}.heartbeat.json`)
    if (!existsSync(filePath)) return { ok: false, lastRun: null, pid: null }
    try {
      const data = JSON.parse(readFileSync(filePath, 'utf-8'))
      const age = now - (data.ts ?? 0)
      return {
        ok: age < STALE_THRESHOLD_MS,
        lastRun: data.ts ? new Date(data.ts).toISOString() : null,
        pid: data.pid ?? null,
      }
    } catch {
      return { ok: false, lastRun: null, pid: null }
    }
  }

  return c.json({
    sentiment: readHeartbeat('sentiment'),
    correlation: readHeartbeat('correlation'),
  })
})
