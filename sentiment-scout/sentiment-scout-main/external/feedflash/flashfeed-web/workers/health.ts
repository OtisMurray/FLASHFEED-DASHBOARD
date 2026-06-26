import { join } from 'path'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { ROOT } from '../lib/config.ts'

const HEARTBEAT_DIR = join(ROOT, 'data', 'workers')

export function writeWorkerHeartbeat(name: string, lastCount: number, errors: number) {
  try {
    if (!existsSync(HEARTBEAT_DIR)) mkdirSync(HEARTBEAT_DIR, { recursive: true })
    writeFileSync(
      join(HEARTBEAT_DIR, `${name}.heartbeat.json`),
      JSON.stringify({ ts: Date.now(), lastCount, errors, pid: process.pid }),
      'utf-8'
    )
  } catch { /* ignore */ }
}
