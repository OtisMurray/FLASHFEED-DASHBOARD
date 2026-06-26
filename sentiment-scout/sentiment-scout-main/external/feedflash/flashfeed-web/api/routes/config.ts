import { Hono } from 'hono'
import { existsSync, readFileSync } from 'fs'
import { LOG, WEB_LOG } from '../../lib/config.ts'
import { ms, deepMerge, cli } from '../../lib/helpers.ts'
import { log } from '../../lib/logger.ts'
import { readCfg, writeCfg } from '../../lib/config.ts'

export const configRoutes = new Hono()

// GET /api/sources — list sources from config.json
configRoutes.get('/api/sources', (c) => {
  const t = ms()
  const config = readCfg()
  return c.json({ sources: config.sources?.rss_feeds ?? [], ms: t() })
})

// POST /api/sources — add a new source
configRoutes.post('/api/sources', async (c) => {
  const t = ms()
  const body = await c.req.json()
  const { name, url, category = 'general' } = body

  if (!name?.trim() || !url?.trim()) {
    return c.json({ error: 'name and url are required' }, 400)
  }

  const config = readCfg()
  if (!config.sources) config.sources = {}
  if (!config.sources.rss_feeds) config.sources.rss_feeds = []

  const existing = config.sources.rss_feeds
  if (existing.some((s: any) => s.name === name.trim())) {
    return c.json({ error: 'A source with that name already exists' }, 409)
  }
  if (existing.some((s: any) => s.url === url.trim())) {
    return c.json({ error: 'A source with that URL already exists' }, 409)
  }

  const source = { name: name.trim(), url: url.trim(), category: category.trim() || 'general' }
  config.sources.rss_feeds.push(source)
  writeCfg(config)

  log('INFO', 'Source added', { name: source.name, url: source.url, category: source.category })
  return c.json({ success: true, source, ms: t() })
})

// DELETE /api/sources/:name — remove a source
configRoutes.delete('/api/sources/:name', (c) => {
  const t = ms()
  const name = decodeURIComponent(c.req.param('name'))

  const config = readCfg()
  const sources: any[] = config.sources?.rss_feeds ?? []
  const idx = sources.findIndex((s) => s.name === name)

  if (idx === -1) return c.json({ error: 'Source not found' }, 404)

  sources.splice(idx, 1)
  config.sources.rss_feeds = sources
  writeCfg(config)

  log('INFO', 'Source removed', { name })
  return c.json({ success: true, removed: name, ms: t() })
})

// GET /api/config — read full config.json
configRoutes.get('/api/config', (c) => {
  const t = ms()
  return c.json({ config: readCfg(), ms: t() })
})

// PUT /api/config — deep-merge update into config.json
configRoutes.put('/api/config', async (c) => {
  const t = ms()
  const body = await c.req.json()
  const updated = deepMerge(readCfg(), body)
  writeCfg(updated)
  log('INFO', 'Config updated via dashboard', { keys: Object.keys(body) })
  return c.json({ success: true, config: updated, ms: t() })
})

// GET /api/logs — tail the log file
configRoutes.get('/api/logs', (c) => {
  const t = ms()
  const lines = +(c.req.query('lines') ?? 200)
  if (!existsSync(LOG)) return c.json({ logs: [], total: 0, ms: t() })
  const all = readFileSync(LOG, 'utf-8').split('\n').filter(Boolean)
  return c.json({ logs: all.slice(-lines), total: all.length, ms: t() })
})

// GET /api/weblog — tail this server's own log file
configRoutes.get('/api/weblog', (c) => {
  const t = ms()
  const lines = +(c.req.query('lines') ?? 200)
  if (!existsSync(WEB_LOG)) return c.json({ logs: [], total: 0, ms: t() })
  const all = readFileSync(WEB_LOG, 'utf-8').split('\n').filter(Boolean)
  return c.json({ logs: all.slice(-lines), total: all.length, path: WEB_LOG, ms: t() })
})

// POST /api/test-impersonate — run --impersonate-test <url> [browser]
configRoutes.post('/api/test-impersonate', async (c) => {
  const { url, browser = 'chrome' } = await c.req.json()
  if (!url) return c.json({ error: 'url is required' }, 400)
  log('INFO', 'Impersonate test triggered', { url, browser })
  const r = await cli(['--impersonate-test', url, browser])
  log(r.code === 0 ? 'INFO' : 'WARN', 'Impersonate test result', { url, browser, success: r.code === 0, ms: r.ms })
  return c.json({ success: r.code === 0, output: r.out, stderr: r.err, ms: r.ms })
})
