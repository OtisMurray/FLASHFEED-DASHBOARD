import { existsSync } from 'fs'
import { BIN, CFG, ROOT } from './config.ts'
import { log } from './logger.ts'
import { openDb } from '../db/index.ts'

/** High-resolution timer that returns elapsed ms when called */
export function ms() {
  const t = performance.now()
  return () => Math.round(performance.now() - t)
}

/** Spawn the feedflash binary with given args and capture output */
export async function cli(args: string[], timeoutMs = 120_000) {
  const elapsed = ms()
  if (!existsSync(BIN)) {
    log('ERROR', 'Binary not found', { path: BIN })
    return { out: '', err: `C++ binary not built (optional). To build: cmake -B build && make -C build from the project root.`, code: 1, ms: 0 }
  }
  log('INFO', `Spawning CLI`, { args })
  const p = Bun.spawn([BIN, '--config', CFG, ...args], {
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const kill = setTimeout(() => { log('WARN', 'CLI timeout, killing process', { args }); p.kill() }, timeoutMs)
  try {
    const [out, err, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ])
    clearTimeout(kill)
    const duration = elapsed()
    if (code === 0) {
      log('INFO', `CLI completed`, { args, ms: duration })
    } else {
      log('WARN', `CLI exited with code ${code}`, { args, ms: duration, stderr: err.slice(0, 200) })
    }
    return { out, err, code, ms: duration }
  } catch (e) {
    clearTimeout(kill)
    log('ERROR', 'CLI spawn error', { args, error: String(e) })
    return { out: '', err: String(e), code: -1, ms: elapsed() }
  }
}

/** Parse human-readable numbers like "107.64M", "1.2B", "500K", or plain integers */
export function parseHumanNumber(val: unknown): number {
  if (typeof val === 'number') return val
  if (!val) return 0
  const s = String(val).replace(/,/g, '').trim().toUpperCase()
  const m = s.match(/^([\d.]+)\s*([KMBT]?)$/)
  if (!m) return parseInt(s) || 0
  const num = parseFloat(m[1])
  const suffix = m[2]
  if (suffix === 'K') return Math.round(num * 1_000)
  if (suffix === 'M') return Math.round(num * 1_000_000)
  if (suffix === 'B') return Math.round(num * 1_000_000_000)
  if (suffix === 'T') return Math.round(num * 1_000_000_000_000)
  return Math.round(num)
}

export function deepMerge(a: any, b: any): any {
  const r: any = { ...a }
  for (const k of Object.keys(b)) {
    r[k] = (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]))
      ? deepMerge(a[k] ?? {}, b[k])
      : b[k]
  }
  return r
}

export function isMarketOpen(): { open: boolean; label: string; nextOpen?: string } {
  // US Eastern time via Intl
  const etStr = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })
  const et = new Date(etStr)
  const day = et.getDay() // 0=Sun, 6=Sat
  const h = et.getHours()
  const m = et.getMinutes()
  const mins = h * 60 + m

  if (day === 0 || day === 6) {
    const daysUntilMon = day === 0 ? 1 : 2
    return { open: false, label: 'Weekend — Market Closed', nextOpen: `Monday ${daysUntilMon === 1 ? 'tomorrow' : 'in 2 days'} 9:30 AM ET` }
  }
  if (mins < 570) { // before 9:30 AM
    return { open: false, label: 'Pre-Market', nextOpen: 'Today 9:30 AM ET' }
  }
  if (mins >= 960) { // after 4:00 PM
    const isFriday = day === 5
    return { open: false, label: 'After Hours', nextOpen: isFriday ? 'Monday 9:30 AM ET' : 'Tomorrow 9:30 AM ET' }
  }
  return { open: true, label: 'Market Open' }
}

// ─── Keyword cache (in-memory Set for O(1) membership, rebuilt from DB) ──────
let _kwSet: Set<string> = new Set()
let _kwExpiry = 0
const KW_TTL_MS = 60_000   // rebuild from DB at most once per minute

export function activeKeywords(): Set<string> {
  if (Date.now() < _kwExpiry) return _kwSet
  _kwExpiry = Date.now() + KW_TTL_MS
  const d = openDb()
  if (!d) return _kwSet
  try {
    const rows = d.query('SELECT word FROM keywords WHERE active=1').all({}) as { word: string }[]
    _kwSet = new Set(rows.map(r => r.word.toLowerCase()))
    log('DEBUG', 'Keyword cache rebuilt', { count: _kwSet.size })
  } catch { /* keep old set */ } finally { d.close() }
  return _kwSet
}

/** Force-expire the keyword cache (call after any keyword write) */
export function invalidateKeywordCache() { _kwExpiry = 0 }
