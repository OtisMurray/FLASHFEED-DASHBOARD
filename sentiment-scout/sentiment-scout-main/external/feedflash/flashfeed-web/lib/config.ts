import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
// Note: log is not imported here to avoid circular deps (logger imports WEB_LOG from config)

export const PORT = parseInt(process.env.PORT ?? '3000')
export const ROOT = resolve(process.env.FLASHFEED_ROOT ?? join(import.meta.dir, '..', '..'))
export const BIN = join(ROOT, 'build', 'feedflash')
export const DB = join(ROOT, 'feedflash.db')
export const CFG = join(ROOT, 'config.json')
export const LOG = join(ROOT, 'feedflash.log')          // C++ binary log
export const WEB_LOG = join(import.meta.dir, '..', 'server.log')  // this server's log

/** Read config.json, returning a default stub if missing */
export function readCfg(): any {
  if (!existsSync(CFG)) {
    return {
      database: { path: './feedflash.db' },
      sources: { rss_feeds: [] },
      impersonation: {
        enabled: false, preferred_browser: 'rotate', max_retries: 3,
        backoff_base_ms: 500, backoff_max_ms: 30000, timeout_seconds: 30,
        connect_timeout_seconds: 10, follow_redirects: true, max_redirects: 5,
        verbose: false, cookie_jar: '', curl_impersonate_path: '',
      },
      logging: { level: 'info', file: './feedflash.log' },
    }
  }
  return JSON.parse(readFileSync(CFG, 'utf-8'))
}

export function writeCfg(c: any) {
  writeFileSync(CFG, JSON.stringify(c, null, 2), 'utf-8')
}
