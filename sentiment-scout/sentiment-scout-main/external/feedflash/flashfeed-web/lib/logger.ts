import { appendFileSync } from 'fs'
import { WEB_LOG } from './config.ts'

export type Level = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG'

export function log(level: Level, msg: string, ctx?: Record<string, unknown>) {
  const ts = new Date().toISOString()
  const line = ctx
    ? `[${ts}] [${level}] ${msg} ${JSON.stringify(ctx)}`
    : `[${ts}] [${level}] ${msg}`

  // Colour the level for the terminal
  const colours: Record<Level, string> = {
    INFO: '\x1b[36m',   // cyan
    WARN: '\x1b[33m',   // yellow
    ERROR: '\x1b[31m',   // red
    DEBUG: '\x1b[90m',   // grey
  }
  const reset = '\x1b[0m'
  console.log(`${colours[level]}[${level}]${reset} ${ts.slice(11, 23)} ${msg}${ctx ? ' ' + JSON.stringify(ctx) : ''}`)

  try { appendFileSync(WEB_LOG, line + '\n') } catch { /* ignore write errors */ }
}
