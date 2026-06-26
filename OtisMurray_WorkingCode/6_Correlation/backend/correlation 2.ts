import { Hono } from 'hono'
import { existsSync } from 'fs'
import { join } from 'path'
import { ms } from '../../lib/helpers.ts'
import { DB } from '../../lib/config.ts'
import { getCorrelationData } from '../../db/queries/correlation.ts'

export const correlationRoutes = new Hono()

// GET /api/correlation — accuracy stats + breakdown
correlationRoutes.get('/api/correlation', (c) => {
  const t = ms()
  try {
    const { stats, breakdown } = getCorrelationData()
    return c.json({ stats, breakdown, ms: t() })
  } catch (e) {
    return c.json({ error: String(e) }, 500)
  }
})

// POST /api/correlation/run — trigger the Python tracker
correlationRoutes.post('/api/correlation/run', async (c) => {
  const t = ms()
  const trackerPath = join(import.meta.dir, '..', '..', 'correlation_tracker.py')
  const script = existsSync(trackerPath)
    ? trackerPath
    : join(import.meta.dir, '..', '..', '..', 'correlation_tracker.py')
  if (!existsSync(script)) return c.json({ error: 'correlation_tracker.py not found' }, 404)
  try {
    const proc = Bun.spawn(['python3', script, DB], { stdout: 'pipe', stderr: 'pipe' })
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    const code = await proc.exited
    return c.json({ success: code === 0, output: stdout.trim(), error: stderr.trim(), ms: t() })
  } catch (e) {
    return c.json({ error: String(e) }, 500)
  }
})
