import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { serveStatic } from 'hono/bun'
import { appendFileSync, existsSync } from 'fs'
import { join } from 'path'
import { WEB_LOG } from '../lib/config.ts'

import { statusRoutes } from './routes/status.ts'
import { articlesRoutes } from './routes/articles.ts'
import { fetchRoutes } from './routes/fetch.ts'
import { configRoutes } from './routes/config.ts'
import { sentimentRoutes } from './routes/sentiment.ts'
import { screenerRoutes } from './routes/screener.ts'
import { momentumRoutes } from './routes/momentum.ts'
import { socialRoutes } from './routes/social.ts'
import { pricesRoutes } from './routes/prices.ts'
import { settingsRoutes } from './routes/settings.ts'
import { keywordsRoutes } from './routes/keywords.ts'
import { correlationRoutes } from './routes/correlation.ts'

export function createApp(): Hono {
  const app = new Hono()

  app.use('*', cors())

  // HTTP access log — each request line goes to stdout AND server.log
  app.use('*', logger((str) => {
    const ts = new Date().toISOString()
    // hono/logger already prints to stdout; we just also append to file
    try { appendFileSync(WEB_LOG, `[${ts}] [HTTP] ${str.replace(/\x1b\[[0-9;]*m/g, '')}\n`) } catch { /* ignore */ }
  }))

  // Mount all route groups
  app.route('/', statusRoutes)
  app.route('/', articlesRoutes)
  app.route('/', fetchRoutes)
  app.route('/', configRoutes)
  app.route('/', sentimentRoutes)
  app.route('/', screenerRoutes)
  app.route('/', momentumRoutes)
  app.route('/', socialRoutes)
  app.route('/', pricesRoutes)
  app.route('/', settingsRoutes)
  app.route('/', keywordsRoutes)
  app.route('/', correlationRoutes)

  // Static files — prefer Next.js build output, fall back to legacy public/
  const nextOut = join(import.meta.dir, '..', 'dashboard', 'out')
  const staticRoot = existsSync(nextOut) ? nextOut : join(import.meta.dir, '..', 'public')
  app.use('/*', serveStatic({ root: staticRoot }))

  return app
}
