import { join } from 'path'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { log } from '../lib/logger.ts'
import { DB, ROOT } from '../lib/config.ts'

const HEARTBEAT_DIR = join(ROOT, 'data', 'workers')

function writeHeartbeat(lastCount: number, errors: number) {
  try {
    if (!existsSync(HEARTBEAT_DIR)) mkdirSync(HEARTBEAT_DIR, { recursive: true })
    writeFileSync(
      join(HEARTBEAT_DIR, 'correlation.heartbeat.json'),
      JSON.stringify({ ts: Date.now(), lastCount, errors, pid: process.pid }),
      'utf-8'
    )
  } catch { /* ignore */ }
}

export function startCorrelationWorker(intervalMs = 30_000) {
  let running = false
  let errors = 0
  setInterval(async () => {
    if (running) return
    running = true
    try {
      const trackerPath = join(import.meta.dir, '..', 'correlation_tracker.py')
      const script = existsSync(trackerPath) ? trackerPath : join(import.meta.dir, '..', '..', 'correlation_tracker.py')
      if (existsSync(script)) {
        const proc = Bun.spawn(['python3', script, DB], { stdout: 'pipe', stderr: 'pipe' })
        const code = await proc.exited
        if (code === 0) {
          log('DEBUG', 'Background correlation run complete')
          writeHeartbeat(1, errors)
        } else {
          log('WARN', 'Background correlation run failed', { code })
          errors++
          writeHeartbeat(0, errors)
        }
      } else {
        writeHeartbeat(0, errors)
      }
    } catch (e) {
      errors++
      log('WARN', 'Background correlation worker error', { reason: String(e).slice(0, 120) })
      writeHeartbeat(0, errors)
    } finally {
      running = false
    }
  }, intervalMs)
  log('INFO', `Background correlation worker started (every ${intervalMs / 1000}s)`)
}

// Standalone entrypoint (when run directly: bun run workers/correlation-worker.ts)
if (import.meta.main) {
  log('INFO', 'Correlation worker starting in standalone mode')
  startCorrelationWorker(30_000)
}
