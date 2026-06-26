/**
 * FlashFeed Web Server — Bun + Hono
 * Wraps the feedflash CLI with a REST API and serves the dashboard SPA.
 * Direct SQLite reads for articles/stats (zero subprocess overhead).
 * Subprocess only for: fetch, cleanup, watch, impersonate-test.
 */

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { serveStatic } from 'hono/bun'
import { streamSSE } from 'hono/streaming'
import { Database } from 'bun:sqlite'
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'fs'
import { join, resolve } from 'path'

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT ?? '3000')
const ROOT = resolve(process.env.FLASHFEED_ROOT ?? join(import.meta.dir, '..'))
const BIN = join(ROOT, 'build', 'feedflash')
const DB = join(ROOT, 'feedflash.db')
const CFG = join(ROOT, 'config.json')
const LOG = join(ROOT, 'feedflash.log')          // C++ binary log
const WEB_LOG = join(import.meta.dir, 'server.log')  // this server's log

// ─── Ticker → Company name map (from finviz.csv) ──────────────────────────────
const TICKER_COMPANY = new Map<string, string>()
const FINVIZ_DATA = new Map<string, { sector?: string; industry?: string; price?: number; change_pct?: number; volume?: number }>()
  ; (() => {
    const csv = join(ROOT, 'social_pipeline', 'finviz.csv')
    if (!existsSync(csv)) return
    const lines = readFileSync(csv, 'utf8').split('\n')
    const header = lines[0].split(',').map(h => h.replace(/"/g, '').trim())
    const ti = header.indexOf('Ticker')
    const ci = header.indexOf('Company')
    const si = header.indexOf('Sector')
    const ii = header.indexOf('Industry')
    const pi = header.indexOf('Price')
    const cpi = header.indexOf('Change')
    const vi = header.indexOf('Volume')
    if (ti < 0 || ci < 0) return
    for (let i = 1; i < lines.length; i++) {
      // Basic CSV split, ignores commas inside quotes for simplicity but works for this file
      const cols = lines[i].match(/(".*?"|[^",\s]+)(?=\s*,|\s*$)/g)
      if (!cols) continue
      const ticker = cols[ti]?.replace(/"/g, '').trim()
      const company = cols[ci]?.replace(/"/g, '').trim()
      const sector = si >= 0 ? cols[si]?.replace(/"/g, '').trim() : undefined
      const ind = ii >= 0 ? cols[ii]?.replace(/"/g, '').trim() : undefined
      
      const priceStr = pi >= 0 ? cols[pi]?.replace(/"/g, '').trim() : ''
      const changeStr = cpi >= 0 ? cols[cpi]?.replace(/"/g, '').trim().replace('%', '') : ''
      const volStr = vi >= 0 ? cols[vi]?.replace(/"/g, '').trim() : ''
      
      const price = priceStr ? parseFloat(priceStr) : undefined
      const change_pct = changeStr ? parseFloat(changeStr) : undefined
      const volume = volStr ? parseInt(volStr.replace(/,/g, '')) : undefined

      if (ticker && company) {
        TICKER_COMPANY.set(ticker, company)
        FINVIZ_DATA.set(ticker, { sector, industry: ind, price, change_pct, volume })
      }
    }
    console.log(`[INFO] Loaded ${TICKER_COMPANY.size} ticker mappings & finviz data`)
  })()

/** Port of the Python sentiment microservice (sentiment_service/service.py) */
function sentimentPort(): number {
  const cfg = readCfg()
  return cfg.sentiment?.service_port ?? 5001
}

// ─── Logger ───────────────────────────────────────────────────────────────────
type Level = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG'

function log(level: Level, msg: string, ctx?: Record<string, unknown>) {
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

// ─── App ──────────────────────────────────────────────────────────────────────
const app = new Hono()
app.use('*', cors())

// HTTP access log — each request line goes to stdout AND server.log
app.use('*', logger((str) => {
  const ts = new Date().toISOString()
  // hono/logger already prints to stdout; we just also append to file
  try { appendFileSync(WEB_LOG, `[${ts}] [HTTP] ${str.replace(/\x1b\[[0-9;]*m/g, '')}\n`) } catch { /* ignore */ }
}))

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** High-resolution timer that returns elapsed ms when called */
function ms() {
  const t = performance.now()
  return () => Math.round(performance.now() - t)
}

/** Spawn the feedflash binary with given args and capture output */
async function cli(args: string[], timeoutMs = 120_000) {
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

// ─── Dictionary sentiment (mirrors C++ SentimentClassifier) ──────────────────
const BULLISH_KW = [
  'ipo', 'beat', 'deal', 'gain', 'hire', 'rose', 'grew', 'soar',
  'beats', 'surge', 'rally', 'jumps', 'rises', 'buyback', 'record',
  'profit', 'growth', 'strong', 'raised', 'expand', 'upgrade', 'dividend',
  'approved', 'approval', 'acquire', 'exceeds', 'outperform', 'breakout',
  'earnings beat', 'revenue beat', 'guidance raised', 'guidance raise',
  'raises guidance', 'stock split', 'share buyback', 'record revenue',
  'record profit', 'partnership', 'new contract', 'wins contract',
]
const BEARISH_KW = [
  'miss', 'loss', 'drop', 'halt', 'fine', 'sued', 'fell', 'sank',
  'misses', 'recall', 'layoff', 'layoffs', 'plunge', 'tumble', 'slides',
  'declines', 'warning', 'cutback', 'deficit', 'downgrade', 'shortfall',
  'bankrupt', 'subpoena', 'probe', 'fraud', 'penalty', 'suspend',
  'earnings miss', 'revenue miss', 'guidance cut', 'cuts guidance',
  'lowers guidance', 'misses estimates', 'below expectations',
  'investigation', 'class action', 'bankruptcy', 'restructuring',
  'workforce reduction', 'job cuts', 'revenue decline', 'profit warning',
]

function dictionarySentiment(title: string, content = ''): 'bullish' | 'bearish' | 'neutral' {
  const t = (title + ' ' + content.slice(0, 300)).toLowerCase()
  const bull = BULLISH_KW.filter(k => t.includes(k)).length * 2
  const bear = BEARISH_KW.filter(k => t.includes(k)).length * 2
  if (bull === bear) return 'neutral'
  return bull > bear ? 'bullish' : 'bearish'
}

/** Score all articles with NULL sentiment using dictionary classifier (runs at startup, instant) */
function stampNullSentiment() {
  if (!existsSync(DB)) return
  const db = new Database(DB)
  try {
    const rows = db.query(
      `SELECT id, title, content FROM articles WHERE sentiment IS NULL LIMIT 2000`
    ).all() as { id: string; title: string; content: string | null }[]
    if (!rows.length) return
    const now = Math.floor(Date.now() / 1000)
    const stmt = db.prepare(
      `UPDATE articles SET sentiment=?, sentiment_at=? WHERE id=?`
    )
    db.transaction(() => {
      for (const row of rows) {
        const label = dictionarySentiment(row.title, row.content ?? '')
        stmt.run(label, now, row.id)
      }
    })()
    log('INFO', 'Dictionary sentiment stamped on existing articles', { count: rows.length })
  } catch (e) {
    log('WARN', 'stampNullSentiment failed', { reason: String(e) })
  } finally {
    db.close()
  }
}

/** Open the SQLite database (read-only by default) */
function openDb(write = false): Database | null {
  if (!existsSync(DB)) return null
  return write
    ? new Database(DB)                       // read-write (default, no options)
    : new Database(DB, { readonly: true })   // read-only
}

/** Run sentiment schema migrations — idempotent, silently skips existing columns/tables */
function migrateSentimentSchema() {
  if (!existsSync(DB)) return
  const d = new Database(DB)
  try {
    // Ensure articles table exists (normally created by C++ binary, but may not be built)
    d.run(`CREATE TABLE IF NOT EXISTS articles (
      id            TEXT PRIMARY KEY,
      title         TEXT NOT NULL,
      content       TEXT,
      url           TEXT,
      source        TEXT,
      category      TEXT,
      publish_date  INTEGER,
      fetched_date  INTEGER
    )`)
    // Add sentiment columns to articles (ALTER TABLE silently fails if already exist)
    try { d.run('ALTER TABLE articles ADD COLUMN sentiment TEXT DEFAULT NULL') } catch { }
    try { d.run('ALTER TABLE articles ADD COLUMN sentiment_at INTEGER DEFAULT NULL') } catch { }
    try { d.run('ALTER TABLE articles ADD COLUMN ml_confidence REAL DEFAULT NULL') } catch { }
    try { d.run('ALTER TABLE articles ADD COLUMN ticker TEXT DEFAULT NULL') } catch { }
    try { d.run('ALTER TABLE articles ADD COLUMN company TEXT DEFAULT NULL') } catch { }
    // Correlation tracking columns
    try { d.run('ALTER TABLE articles ADD COLUMN price_at REAL DEFAULT NULL') } catch { }
    try { d.run('ALTER TABLE articles ADD COLUMN price_after_1h REAL DEFAULT NULL') } catch { }
    try { d.run('ALTER TABLE articles ADD COLUMN price_after_24h REAL DEFAULT NULL') } catch { }
    try { d.run('ALTER TABLE articles ADD COLUMN prediction_correct_1h INTEGER DEFAULT NULL') } catch { }
    try { d.run('ALTER TABLE articles ADD COLUMN prediction_correct_24h INTEGER DEFAULT NULL') } catch { }
    // Create asset_reports table
    d.run(`CREATE TABLE IF NOT EXISTS asset_reports (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      asset      TEXT    NOT NULL,
      date       TEXT    NOT NULL,
      sentiment  TEXT    NOT NULL,
      report     TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE(asset, date)
    )`)
    d.run('CREATE INDEX IF NOT EXISTS idx_asset_reports_asset ON asset_reports(asset)')
    d.run('CREATE INDEX IF NOT EXISTS idx_asset_reports_date  ON asset_reports(date DESC)')
    log('INFO', 'Sentiment schema migration OK')
  } catch (e) {
    log('WARN', 'Sentiment schema migration warning', { error: String(e) })
  } finally {
    d.close()
  }
}

/** Read config.json, returning a default stub if missing */
function readCfg(): any {
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

function writeCfg(c: any) {
  writeFileSync(CFG, JSON.stringify(c, null, 2), 'utf-8')
  log('INFO', 'config.json written')
}

/** Parse human-readable numbers like "107.64M", "1.2B", "500K", or plain integers */
function parseHumanNumber(val: unknown): number {
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

function deepMerge(a: any, b: any): any {
  const r: any = { ...a }
  for (const k of Object.keys(b)) {
    r[k] = (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]))
      ? deepMerge(a[k] ?? {}, b[k])
      : b[k]
  }
  return r
}

/** Migrate keywords + watched_accounts tables into feedflash.db */
function migrateSettingsSchema() {
  if (!existsSync(DB)) return
  const d = new Database(DB)
  try {
    d.run(`CREATE TABLE IF NOT EXISTS keywords (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      word       TEXT    NOT NULL UNIQUE,
      category   TEXT    DEFAULT 'general',
      active     INTEGER DEFAULT 1,
      created_at INTEGER NOT NULL
    )`)
    d.run(`CREATE TABLE IF NOT EXISTS watched_accounts (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      platform   TEXT    NOT NULL,
      handle     TEXT    NOT NULL,
      active     INTEGER DEFAULT 1,
      created_at INTEGER NOT NULL,
      UNIQUE(platform, handle)
    )`)
    const now = Math.floor(Date.now() / 1000)
    const defaultKw: [string, string][] = [
      // Fundamental / earnings
      ['Earnings', 'fundamental'], ['Dividend', 'fundamental'], ['Guidance', 'fundamental'],
      ['Beat', 'fundamental'], ['Miss', 'fundamental'], ['Restatement', 'fundamental'],
      // Corporate actions
      ['IPO', 'corporate'], ['Delisting', 'corporate'], ['Merger', 'corporate'],
      ['Acquisition', 'corporate'], ['Contract', 'corporate'], ['Partnership', 'corporate'],
      ['Buyback', 'corporate'], ['Spinoff', 'corporate'], ['Restructuring', 'corporate'],
      ['Layoffs', 'corporate'],
      // Regulatory / legal
      ['FDA', 'regulatory'], ['SEC', 'regulatory'], ['Approval', 'regulatory'],
      ['Investigation', 'regulatory'], ['Probe', 'regulatory'], ['Lawsuit', 'legal'],
      ['Settlement', 'legal'], ['Fraud', 'legal'],
      // Analyst
      ['Upgrade', 'analyst'], ['Downgrade', 'analyst'], ['Target', 'analyst'],
      // Risk / macro
      ['Bankruptcy', 'risk'], ['Recall', 'risk'], ['Tariff', 'macro'],
    ]
    for (const [word, cat] of defaultKw) {
      try { d.run('INSERT OR IGNORE INTO keywords (word, category, active, created_at) VALUES (?,?,1,?)', [word, cat, now]) } catch { }
    }
    const defaultAccts: [string, string][] = [
      ['reddit', 'wallstreetbets'], ['reddit', 'stocks'], ['reddit', 'pennystocks'],
      ['reddit', 'investing'], ['reddit', 'SecurityAnalysis'], ['reddit', 'StockMarket'],
      ['twitter', 'Benzinga'], ['twitter', 'CNBC'], ['twitter', 'unusual_whales'],
      ['twitter', 'ewhispers'], ['twitter', 'marketwatch'], ['twitter', 'WSJmarkets'],
    ]
    for (const [plat, handle] of defaultAccts) {
      try { d.run('INSERT OR IGNORE INTO watched_accounts (platform, handle, active, created_at) VALUES (?,?,1,?)', [plat, handle, now]) } catch { }
    }
    log('INFO', 'Settings schema migration OK')
  } catch (e) {
    log('WARN', 'Settings schema migration warning', { error: String(e) })
  } finally {
    d.close()
  }
}

// ─── Keyword cache (in-memory Set for O(1) membership, rebuilt from DB) ──────
let _kwSet: Set<string> = new Set()
let _kwExpiry = 0
const KW_TTL_MS = 60_000   // rebuild from DB at most once per minute

function activeKeywords(): Set<string> {
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
function invalidateKeywordCache() { _kwExpiry = 0 }

// ─── Routes ───────────────────────────────────────────────────────────────────

// GET /api/status — server health + binary/db availability
app.get('/api/status', (c) => {
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

// GET /api/articles — direct SQLite read (fastest path)
app.get('/api/articles', (c) => {
  const t = ms()
  const limit = Math.min(+(c.req.query('limit') ?? 50), 500)
  const offset = +(c.req.query('offset') ?? 0)
  const source = c.req.query('source') ?? null
  const category = c.req.query('category') ?? null
  const search = c.req.query('search') ?? null
  const sentiment = c.req.query('sentiment') ?? null  // bullish|bearish|neutral|unanalyzed
  const keywords_only = c.req.query('keywords_only') === '1'

  const d = openDb()
  if (!d) {
    log('WARN', 'Articles requested but database not found')
    return c.json({ articles: [], total: 0, ms: t(), error: 'Database not found. Add a feed and run Fetch.' })
  }

  try {
    const conds: string[] = []
    const params: Record<string, any> = {}

    if (source) { conds.push('source = $source'); params.$source = source }
    if (category) { conds.push('category = $category'); params.$category = category }
    if (search) { conds.push('(title LIKE $search OR content LIKE $search)'); params.$search = `%${search}%` }
    if (sentiment === 'unanalyzed') {
      conds.push('sentiment IS NULL')
    } else if (sentiment) {
      conds.push('sentiment = $sentiment')
      params.$sentiment = sentiment
    }
    if (keywords_only) {
      const kws = [...activeKeywords()]
      if (kws.length > 0) {
        // Build OR-chain from in-memory Set — each param is a positional named bind
        const kwConds = kws.map((_, i) => `title LIKE $kw${i}`).join(' OR ')
        conds.push(`(${kwConds})`)
        kws.forEach((kw, i) => { params[`$kw${i}`] = `%${kw}%` })
      }
    }

    const where = conds.length ? ' WHERE ' + conds.join(' AND ') : ''

    const articles = d.query(
      `SELECT id, title, content, url, source, category, publish_date, fetched_date, ticker, company, sentiment, sentiment_at
       FROM articles${where}
       ORDER BY COALESCE(publish_date, fetched_date) DESC
       LIMIT $limit OFFSET $offset`
    ).all({ ...params, $limit: limit, $offset: offset })

    const { count } = d.query(
      `SELECT COUNT(*) as count FROM articles${where}`
    ).get({ ...params }) as { count: number }

    const duration = t()
    log('DEBUG', 'Articles query', { count, limit, offset, source, category, sentiment, ms: duration })
    return c.json({ articles, total: count, limit, offset, ms: duration })
  } finally {
    d.close()
  }
})

// GET /api/stats — DB statistics (direct SQLite read)
app.get('/api/stats', (c) => {
  const t = ms()
  const d = openDb()
  if (!d) return c.json({ total: 0, sources: [], categories: [], recency: null, sentiment: null, ms: t() })

  try {
    const { total } = d.query('SELECT COUNT(*) as total FROM articles').get({}) as { total: number }
    const sources = d.query(
      'SELECT source, COUNT(*) as count, MAX(fetched_date) as last_fetched FROM articles GROUP BY source ORDER BY count DESC'
    ).all({})
    const categories = d.query(
      "SELECT COALESCE(category, 'uncategorized') as category, COUNT(*) as count FROM articles GROUP BY category ORDER BY count DESC"
    ).all({})
    const recency = d.query(
      'SELECT MAX(fetched_date) as last_fetch, MIN(publish_date) as oldest, MAX(publish_date) as newest FROM articles'
    ).get({})

    // Sentiment breakdown (only if columns exist)
    let sentimentStats: any = null
    try {
      sentimentStats = d.query(
        `SELECT
           COUNT(*) FILTER (WHERE sentiment = 'bullish')  as bullish,
           COUNT(*) FILTER (WHERE sentiment = 'bearish')  as bearish,
           COUNT(*) FILTER (WHERE sentiment = 'neutral')  as neutral,
           COUNT(*) FILTER (WHERE sentiment IS NULL)      as unanalyzed
         FROM articles`
      ).get({})
    } catch { /* sentiment columns not yet migrated */ }

    return c.json({ total, sources, categories, recency, sentiment: sentimentStats, ms: t() })
  } finally {
    d.close()
  }
})

// GET /api/sources — list sources from config.json
app.get('/api/sources', (c) => {
  const t = ms()
  const config = readCfg()
  return c.json({ sources: config.sources?.rss_feeds ?? [], ms: t() })
})

// POST /api/sources — add a new source
app.post('/api/sources', async (c) => {
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
app.delete('/api/sources/:name', (c) => {
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

// ─── Bun-native RSS fetcher (fallback when C++ binary isn't built) ───────────

/** Minimal XML tag extractor — avoids needing an XML parser dependency */
function xmlText(xml: string, tag: string): string {
  // Try <tag>…</tag>
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i')
  const m = xml.match(re)
  if (!m) return ''
  // Strip CDATA wrappers
  return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim()
}

/** Extract href from <link … href="…"/> (Atom feeds) */
function atomLink(entry: string): string {
  const m = entry.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i)
    ?? entry.match(/<link[^>]*href=["']([^"']+)["'][^>]*rel=["']alternate["']/i)
    ?? entry.match(/<link[^>]*href=["']([^"']+)["']/i)
  return m ? m[1] : ''
}

/** Parse RSS/Atom XML into article objects */
function parseRssFeed(xml: string, sourceName: string, category: string): Array<{
  id: string; title: string; content: string; url: string; source: string; category: string; publish_date: number | null; fetched_date: number
}> {
  const now = Math.floor(Date.now() / 1000)
  const articles: any[] = []

  // Split into items (RSS) or entries (Atom)
  const itemRegex = /<(?:item|entry)[\s>]([\s\S]*?)<\/(?:item|entry)>/gi
  let match
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1]
    const title = xmlText(block, 'title')
    if (!title) continue

    const url = xmlText(block, 'link') || atomLink(block) || xmlText(block, 'guid')
    const content = xmlText(block, 'description') || xmlText(block, 'summary') || xmlText(block, 'content')
    const pubStr = xmlText(block, 'pubDate') || xmlText(block, 'published') || xmlText(block, 'updated') || xmlText(block, 'dc:date')
    let pubDate: number | null = null
    if (pubStr) {
      const d = new Date(pubStr)
      if (!isNaN(d.getTime())) pubDate = Math.floor(d.getTime() / 1000)
    }

    // Deterministic ID from URL or title
    const raw = url || `${sourceName}::${title}`
    // Simple hash — Bun has crypto, but a quick string hash works for dedup
    let hash = 0
    for (let i = 0; i < raw.length; i++) { hash = ((hash << 5) - hash + raw.charCodeAt(i)) | 0 }
    const id = `rss-${Math.abs(hash).toString(36)}-${pubDate ?? now}`

    // Strip HTML tags from content for clean text
    const cleanContent = content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1000)

    articles.push({ id, title, content: cleanContent, url, source: sourceName, category, publish_date: pubDate, fetched_date: now })
  }

  return articles
}

/** Fetch all configured RSS feeds and insert into SQLite (Bun-native, no C++ needed) */
async function bunFetchFeeds(): Promise<{ new_articles: number; duplicates: number; errors: number; total: number; ms: number }> {
  const elapsed = ms()
  const cfg = readCfg()
  const feeds: { name: string; url: string; category: string }[] = cfg.sources?.rss_feeds ?? []
  if (!feeds.length) return { new_articles: 0, duplicates: 0, errors: 0, total: 0, ms: elapsed() }

  // Ensure articles table exists
  migrateSentimentSchema()

  let newCount = 0
  let dupeCount = 0
  let errCount = 0

  const db = openDb(true)
  if (!db) return { new_articles: 0, duplicates: 0, errors: errCount, total: 0, ms: elapsed() }

  const insertStmt = db.prepare(
    `INSERT OR IGNORE INTO articles (id, title, content, url, source, category, publish_date, fetched_date)
     VALUES ($id, $title, $content, $url, $source, $category, $publish_date, $fetched_date)`
  )

  // Fetch feeds in parallel (max 5 concurrent)
  const batchSize = 5
  for (let i = 0; i < feeds.length; i += batchSize) {
    const batch = feeds.slice(i, i + batchSize)
    const results = await Promise.allSettled(
      batch.map(async (feed) => {
        try {
          const res = await fetch(feed.url, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
              'Accept': 'application/rss+xml, application/xml, application/atom+xml, text/xml, */*',
            },
            signal: AbortSignal.timeout(15000),
          })
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const xml = await res.text()
          return parseRssFeed(xml, feed.name, feed.category)
        } catch (e) {
          log('WARN', `RSS fetch failed: ${feed.name}`, { url: feed.url, error: String(e).slice(0, 100) })
          errCount++
          return []
        }
      })
    )

    // Insert articles from this batch
    for (const r of results) {
      if (r.status !== 'fulfilled') { errCount++; continue }
      for (const art of r.value) {
        try {
          const info = insertStmt.run({
            $id: art.id,
            $title: art.title,
            $content: art.content,
            $url: art.url,
            $source: art.source,
            $category: art.category,
            $publish_date: art.publish_date,
            $fetched_date: art.fetched_date,
          })
          if (info.changes > 0) newCount++; else dupeCount++
        } catch { dupeCount++ }
      }
    }
  }

  // Now extract tickers from new articles
  if (newCount > 0) {
    try {
      const untagged = db.query(
        `SELECT id, title, content FROM articles WHERE ticker IS NULL ORDER BY fetched_date DESC LIMIT 500`
      ).all() as { id: string; title: string; content: string | null }[]
      const tickerStmt = db.prepare(`UPDATE articles SET ticker=$ticker, company=$company WHERE id=$id`)
      for (const art of untagged) {
        const text = (art.title + ' ' + (art.content ?? '')).toUpperCase()
        const found: string[] = []
        // Quick scan: check if any known ticker symbol appears as a whole word
        for (const [sym] of TICKER_COMPANY) {
          if (sym.length < 2) continue // skip single-letter tickers
          const re = new RegExp(`\\b${sym}\\b`)
          if (re.test(text)) found.push(sym)
          if (found.length >= 5) break
        }
        if (found.length > 0) {
          tickerStmt.run({ $ticker: found.join(','), $company: TICKER_COMPANY.get(found[0]) ?? null, $id: art.id })
        }
        // Also stamp sentiment
        const label = dictionarySentiment(art.title, art.content ?? '')
        db.run(`UPDATE articles SET sentiment=$s, sentiment_at=$t WHERE id=$id AND sentiment IS NULL`,
          { $s: label, $t: Math.floor(Date.now() / 1000), $id: art.id })
      }
    } catch (e) {
      log('WARN', 'Ticker extraction failed', { error: String(e) })
    }
  }

  const { total } = db.query('SELECT COUNT(*) as total FROM articles').get({}) as { total: number }
  db.close()

  return { new_articles: newCount, duplicates: dupeCount, errors: errCount, total, ms: elapsed() }
}

// POST /api/fetch — run --fetch command (uses C++ binary if available, Bun-native fallback otherwise)
app.post('/api/fetch', async (c) => {
  log('INFO', 'Fetch triggered via dashboard')

  // If the C++ binary exists, use it (original behavior)
  if (existsSync(BIN)) {
    const r = await cli(['--fetch'])
    const match = (re: RegExp) => { const m = r.out.match(re); return m ? +m[1] : null }

    const newArts = match(/New articles:\s+(\d+)/)
    const dupes = match(/Duplicates:\s+(\d+)/)
    const errors = match(/Errors:\s+(\d+)/)
    const total = match(/Total in DB:\s+(\d+)/)

    if (r.code === 0) {
      log('INFO', 'Fetch complete (C++ binary)', { new_articles: newArts, duplicates: dupes, errors, total, ms: r.ms })
      migrateSentimentSchema()
      if ((newArts ?? 0) > 0) {
        scorePendingArticles(200)
          .then(n => { if (n > 0) log('INFO', 'Post-fetch sentiment scoring complete', { scored: n }) })
          .catch(e => log('WARN', 'Post-fetch sentiment scoring skipped', { reason: String(e) }))
      }
    } else {
      log('ERROR', 'Fetch failed', { code: r.code, ms: r.ms })
    }

    return c.json({
      success: r.code === 0,
      new_articles: newArts,
      duplicates: dupes,
      errors,
      total,
      output: r.out,
      stderr: r.err,
      ms: r.ms,
    })
  }

  // Bun-native RSS fallback
  log('INFO', 'Using Bun-native RSS fetcher (C++ binary not available)')
  try {
    const result = await bunFetchFeeds()
    log('INFO', 'Bun RSS fetch complete', result)

    // Fire-and-forget sentiment scoring
    if (result.new_articles > 0) {
      scorePendingArticles(200)
        .then(n => { if (n > 0) log('INFO', 'Post-fetch sentiment scoring complete', { scored: n }) })
        .catch(e => log('WARN', 'Post-fetch sentiment scoring skipped', { reason: String(e) }))
    }

    return c.json({
      success: true,
      new_articles: result.new_articles,
      duplicates: result.duplicates,
      errors: result.errors,
      total: result.total,
      output: `Bun RSS fetcher: ${result.new_articles} new, ${result.duplicates} dupes, ${result.errors} errors`,
      stderr: '',
      ms: result.ms,
    })
  } catch (e) {
    log('ERROR', 'Bun RSS fetch failed', { error: String(e) })
    return c.json({ success: false, error: String(e), ms: 0 }, 500)
  }
})

// POST /api/clear — delete ALL articles from the database
app.post('/api/clear', (c) => {
  const t = ms()
  const d = openDb(true)
  if (!d) {
    log('WARN', 'Clear requested but database not found')
    return c.json({ error: 'Database not found' }, 404)
  }
  try {
    const { count } = d.query('SELECT COUNT(*) as count FROM articles').get({}) as { count: number }
    d.query('DELETE FROM articles').run()
    log('INFO', 'All articles cleared from database', { deleted: count })
    return c.json({ success: true, deleted: count, ms: t() })
  } catch (e) {
    log('ERROR', 'Clear failed', { error: String(e) })
    return c.json({ error: String(e) }, 500)
  } finally {
    d.close()
  }
})

// POST /api/cleanup — run --cleanup <days>
app.post('/api/cleanup', async (c) => {
  const { days = 30 } = await c.req.json()
  log('INFO', 'Cleanup triggered', { days: +days })
  const r = await cli(['--cleanup', String(+days)])
  if (r.code === 0) {
    log('INFO', 'Cleanup complete', { days: +days, ms: r.ms })
  } else {
    log('ERROR', 'Cleanup failed', { days: +days, code: r.code })
  }
  return c.json({ success: r.code === 0, output: r.out, ms: r.ms, days: +days })
})

// GET /api/config — read full config.json
app.get('/api/config', (c) => {
  const t = ms()
  return c.json({ config: readCfg(), ms: t() })
})

// PUT /api/config — deep-merge update into config.json
app.put('/api/config', async (c) => {
  const t = ms()
  const body = await c.req.json()
  const updated = deepMerge(readCfg(), body)
  writeCfg(updated)
  log('INFO', 'Config updated via dashboard', { keys: Object.keys(body) })
  return c.json({ success: true, config: updated, ms: t() })
})

// GET /api/logs — tail the log file
app.get('/api/logs', (c) => {
  const t = ms()
  const lines = +(c.req.query('lines') ?? 200)
  if (!existsSync(LOG)) return c.json({ logs: [], total: 0, ms: t() })
  const all = readFileSync(LOG, 'utf-8').split('\n').filter(Boolean)
  return c.json({ logs: all.slice(-lines), total: all.length, ms: t() })
})

// POST /api/test-impersonate — run --impersonate-test <url> [browser]
app.post('/api/test-impersonate', async (c) => {
  const { url, browser = 'chrome' } = await c.req.json()
  if (!url) return c.json({ error: 'url is required' }, 400)
  log('INFO', 'Impersonate test triggered', { url, browser })
  const r = await cli(['--impersonate-test', url, browser])
  log(r.code === 0 ? 'INFO' : 'WARN', 'Impersonate test result', { url, browser, success: r.code === 0, ms: r.ms })
  return c.json({ success: r.code === 0, output: r.out, stderr: r.err, ms: r.ms })
})

// GET /api/watch?interval=30 — SSE stream from --watch command
// interval: polling cadence in seconds (default 60, min 10, max 3600)
app.get('/api/watch', (c) => {
  const rawInterval = parseInt(c.req.query('interval') ?? '60', 10)
  const intervalSec = Math.max(10, Math.min(3600, isNaN(rawInterval) ? 60 : rawInterval))
  return streamSSE(c, async (stream) => {
    log('INFO', 'Watch mode SSE client connected', { ip: c.req.header('x-forwarded-for') ?? 'local', intervalSec })

    await stream.writeSSE({
      event: 'start',
      data: JSON.stringify({ message: 'Watch mode starting…', ts: Date.now() }),
    })

    if (!existsSync(BIN)) {
      log('ERROR', 'Watch mode: binary not found')
      await stream.writeSSE({
        event: 'error',
        data: JSON.stringify({ message: `Binary not found at ${BIN}` }),
      })
      return
    }

    const proc = Bun.spawn([BIN, '--config', CFG, '--watch', String(intervalSec)], {
      cwd: ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    })

    // Kill the subprocess when the client disconnects
    c.req.raw.signal.addEventListener('abort', () => {
      log('INFO', 'Watch mode SSE client disconnected — killing subprocess')
      proc.kill()
    })

    const decoder = new TextDecoder()
    const reader = proc.stdout.getReader()
    let lineCount = 0

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const text = decoder.decode(value)
        for (const line of text.split('\n')) {
          const trimmed = line.trim()
          if (trimmed) {
            lineCount++
            log('DEBUG', `[watch] ${trimmed}`)
            await stream.writeSSE({
              event: 'line',
              data: JSON.stringify({ text: trimmed, ts: Date.now() }),
            })

            // Detect when fetch cycle completes and new articles are pulled
            const newArtsMatch = trimmed.match(/(\d+)\s+new article/)
            if (newArtsMatch) {
              const count = parseInt(newArtsMatch[1], 10)
              if (count > 0) {
                // Instantly score new articles
                scorePendingArticles(200)
                  .then(n => { if (n > 0) log('INFO', 'Watch-mode sentiment scoring complete', { scored: n }) })
                  .catch(e => log('WARN', 'Watch-mode sentiment scoring failed', { reason: String(e) }))
              }
              
              // Run correlation tracking sequentially after fetch completes
              const trackerPath = join(import.meta.dir, '..', 'flashfeed-web', 'correlation_tracker.py')
              const script = existsSync(trackerPath) ? trackerPath : join(import.meta.dir, 'correlation_tracker.py')
              if (existsSync(script)) {
                log('DEBUG', 'Watch-mode triggering correlation tracker')
                Bun.spawn(['python3', script, DB]).exited.catch(() => {})
              }
            }
          }
        }
      }
    } catch (_) {
      // Stream closed by client disconnect — normal
    }

    log('INFO', 'Watch mode subprocess ended', { lines_streamed: lineCount })
    await stream.writeSSE({
      event: 'end',
      data: JSON.stringify({ message: 'Watch mode ended', ts: Date.now() }),
    })
  })
})

// GET /api/weblog — tail this server's own log file
app.get('/api/weblog', (c) => {
  const t = ms()
  const lines = +(c.req.query('lines') ?? 200)
  if (!existsSync(WEB_LOG)) return c.json({ logs: [], total: 0, ms: t() })
  const all = readFileSync(WEB_LOG, 'utf-8').split('\n').filter(Boolean)
  return c.json({ logs: all.slice(-lines), total: all.length, path: WEB_LOG, ms: t() })
})

// ─── Sentiment Routes ─────────────────────────────────────────────────────────

// GET /api/sentiment/status — check if Python service is running
app.get('/api/sentiment/status', async (c) => {
  const t = ms()
  const port = sentimentPort()
  try {
    const res = await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(2000) })
    const data = await res.json() as any
    return c.json({ ok: data.ok === true, port, ms: t() })
  } catch {
    return c.json({ ok: false, port, ms: t(), error: `Service not running on port ${port}. Start it with: cd sentiment_service && python service.py` })
  }
})

// POST /api/sentiment/analyze-asset — score all DB articles for a ticker, aggregate result
app.post('/api/sentiment/analyze-asset', async (c) => {
  const t = ms()
  const body = await c.req.json()
  const asset = (body.asset ?? '').trim()
  const limit = Math.min(+(body.limit ?? 30), 100)
  const port = sentimentPort()

  if (!asset) return c.json({ error: 'asset (ticker) is required' }, 400)

  // Fetch articles from our DB that mention this ticker
  const db = openDb()
  if (!db) return c.json({ error: 'Database not found' }, 404)

  let articles: any[]
  try {
    articles = db.query(
      `SELECT id, title, content FROM articles
       WHERE ticker LIKE $t OR title LIKE $t
       ORDER BY COALESCE(publish_date, fetched_date) DESC
       LIMIT $limit`
    ).all({ $t: `%${asset}%`, $limit: limit })
  } finally {
    db.close()
  }

  if (!articles.length) {
    return c.json({ error: `No articles found for ticker "${asset}". Fetch feeds first.` }, 404)
  }

  log('INFO', 'Analyze asset requested', { asset, articles: articles.length })

  let results: any[] = []
  try {
    const res = await fetch(`http://localhost:${port}/analyze-articles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ articles }),
      signal: AbortSignal.timeout(120_000),
    })
    const data = await res.json() as any
    if (!res.ok) return c.json(data, res.status as any)
    results = data.results ?? []
  } catch (e) {
    const msg = String(e)
    if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
      return c.json({ error: `Sentiment service not running on port ${port}. Start it with: cd sentiment_service && python3 service.py` }, 503)
    }
    return c.json({ error: msg }, 500)
  }

  // Aggregate: majority vote + average confidence
  const counts: Record<string, number> = { bullish: 0, bearish: 0, neutral: 0 }
  let totalConf = 0, confCount = 0
  for (const r of results) {
    if (r.sentiment) counts[r.sentiment] = (counts[r.sentiment] ?? 0) + 1
    if (r.confidence != null) { totalConf += r.confidence; confCount++ }
  }
  const overall = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'neutral'
  const avgConf = confCount ? +(totalConf / confCount).toFixed(4) : null

  // Store aggregate in asset_reports
  const dw = openDb(true)
  if (dw) {
    try {
      const today = new Date().toISOString().slice(0, 10)
      dw.run(
        `INSERT INTO asset_reports (asset, date, sentiment, report, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(asset, date) DO UPDATE SET sentiment=excluded.sentiment, report=excluded.report, created_at=excluded.created_at`,
        [asset, today, overall, JSON.stringify(counts), Math.floor(Date.now() / 1000)]
      )
    } finally {
      dw.close()
    }
  }

  log('INFO', 'Asset analysis complete', { asset, overall, counts, ms: t() })
  return c.json({ asset, sentiment: overall, confidence: avgConf, counts, articles_analyzed: results.length, ms: t() })
})

// GET /api/sentiment/reports — list stored asset reports
app.get('/api/sentiment/reports', (c) => {
  const t = ms()
  const asset = c.req.query('asset') ?? null
  const date = c.req.query('date') ?? null
  const limit = Math.min(+(c.req.query('limit') ?? 50), 200)

  const d = openDb()
  if (!d) return c.json({ reports: [], ms: t() })

  try {
    const conds: string[] = []
    const params: Record<string, any> = {}
    if (asset) { conds.push('asset = $asset'); params.$asset = asset }
    if (date) { conds.push('date  = $date'); params.$date = date }
    const where = conds.length ? ' WHERE ' + conds.join(' AND ') : ''

    const reports = d.query(
      `SELECT id, asset, date, sentiment, report, created_at FROM asset_reports${where} ORDER BY created_at DESC LIMIT $limit`
    ).all({ ...params, $limit: limit })

    return c.json({ reports, ms: t() })
  } catch (e) {
    return c.json({ reports: [], ms: t(), error: String(e) })
  } finally {
    d.close()
  }
})

// POST /api/sentiment/analyze-articles — batch-analyze articles already in the DB
app.post('/api/sentiment/analyze-articles', async (c) => {
  const t = ms()
  const body = await c.req.json()

  const ids = (body.ids as string[] | undefined) ?? null
  const limit = Math.min(+(body.limit ?? 50), 200)
  const port = sentimentPort()

  const db = openDb()
  if (!db) return c.json({ error: 'Database not found' }, 404)

  let articles: any[]
  try {
    if (ids?.length) {
      const placeholders = ids.map((_, i) => `$id${i}`).join(',')
      const params: Record<string, string> = {}
      ids.forEach((id, i) => { params[`$id${i}`] = id })
      articles = db.query(
        `SELECT id, title, content FROM articles WHERE id IN (${placeholders})`
      ).all(params)
    } else {
      articles = db.query(
        `SELECT id, title, content FROM articles WHERE sentiment IS NULL ORDER BY COALESCE(publish_date, fetched_date) DESC LIMIT $limit`
      ).all({ $limit: limit })
    }
  } finally {
    db.close()
  }

  if (!articles.length) {
    return c.json({ analyzed: 0, results: [], ms: t() })
  }

  log('INFO', 'Batch article analysis requested', { count: articles.length })

  let results: any[] = []
  try {
    const res = await fetch(`http://localhost:${port}/analyze-articles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ articles }),
      signal: AbortSignal.timeout(300_000),
    })
    const data = await res.json() as any
    if (!res.ok) return c.json(data, res.status as any)
    results = data.results ?? []
  } catch (e) {
    const msg = String(e)
    if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
      return c.json({ error: `Sentiment service not running on port ${port}. Start it with: cd sentiment_service && python3 service.py` }, 503)
    }
    return c.json({ error: msg }, 500)
  }

  // Write results back to the articles table (sentiment + confidence + ticker + company)
  let updated = 0
  const dw = openDb(true)
  if (dw) {
    try {
      const now = Math.floor(Date.now() / 1000)
      for (const r of results) {
        if (r.id && r.sentiment) {
          const primaryTicker: string | null = (r.tickers as string[] | undefined)?.[0] ?? null
          const company: string | null =
            (r.company as string | undefined) ??
            (primaryTicker ? (TICKER_COMPANY.get(primaryTicker) ?? null) : null)
          dw.run(
            'UPDATE articles SET sentiment = ?, ml_confidence = ?, sentiment_at = ?, ticker = COALESCE(ticker, ?), company = COALESCE(company, ?) WHERE id = ?',
            [r.sentiment, r.confidence ?? null, now, primaryTicker, company, r.id]
          )
          updated++
        }
      }
    } finally {
      dw.close()
    }
  }

  log('INFO', 'Batch article analysis complete', { analyzed: updated, total: results.length, ms: t() })
  return c.json({ analyzed: updated, total: results.length, results, ms: t() })
})

// POST /api/sentiment/quick-analyze — fast rule-based analysis (DS440 engine, no FinBERT)
app.post('/api/sentiment/quick-analyze', async (c) => {
  const t = ms()
  const body = await c.req.json()
  const limit = Math.min(+(body.limit ?? 50), 500)
  const port = sentimentPort()

  const db = openDb()
  if (!db) return c.json({ error: 'Database not found' }, 404)

  let articles: any[]
  try {
    articles = db.query(
      `SELECT id, title, content FROM articles
       WHERE sentiment IS NULL
       ORDER BY COALESCE(publish_date, fetched_date) DESC
       LIMIT $limit`
    ).all({ $limit: limit })
  } finally {
    db.close()
  }

  if (!articles.length) return c.json({ analyzed: 0, results: [], ms: t() })

  log('INFO', 'Quick analyze requested', { count: articles.length })

  let results: any[] = []
  try {
    const res = await fetch(`http://localhost:${port}/quick-sentiment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ articles }),
      signal: AbortSignal.timeout(30_000),
    })
    const data = await res.json() as any
    if (!res.ok) return c.json(data, res.status as any)
    results = data.results ?? []
  } catch (e) {
    const msg = String(e)
    if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
      return c.json({ error: `Sentiment service not running on port ${port}. Start it with: cd sentiment_service && python3 service.py` }, 503)
    }
    return c.json({ error: msg }, 500)
  }

  let updated = 0
  const dw = openDb(true)
  if (dw) {
    try {
      const now = Math.floor(Date.now() / 1000)
      for (const r of results) {
        if (r.id && r.sentiment) {
          dw.run(
            'UPDATE articles SET sentiment = ?, ml_confidence = ?, sentiment_at = ? WHERE id = ?',
            [r.sentiment, r.confidence ?? null, now, r.id]
          )
          updated++
        }
      }
    } finally {
      dw.close()
    }
  }

  log('INFO', 'Quick analyze complete', { analyzed: updated, total: results.length, ms: t() })
  return c.json({ analyzed: updated, total: results.length, results, ms: t() })
})

// POST /api/sentiment/extract-tickers — extract ticker symbols and store in DB
app.post('/api/sentiment/extract-tickers', async (c) => {
  const t = ms()
  const body = await c.req.json()
  const limit = Math.min(+(body.limit ?? 200), 1000)
  const port = sentimentPort()

  const db = openDb()
  if (!db) return c.json({ error: 'Database not found' }, 404)

  let articles: any[]
  try {
    articles = db.query(
      `SELECT id, title, content FROM articles
       WHERE (ticker IS NULL OR ticker = '')
       ORDER BY COALESCE(publish_date, fetched_date) DESC
       LIMIT $limit`
    ).all({ $limit: limit })
  } finally {
    db.close()
  }

  if (!articles.length) return c.json({ updated: 0, total_tickers_found: 0, articles_processed: 0, ms: t() })

  log('INFO', 'Extract tickers requested', { count: articles.length })

  let results: any[] = []
  try {
    const res = await fetch(`http://localhost:${port}/extract-tickers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ articles }),
      signal: AbortSignal.timeout(30_000),
    })
    const data = await res.json() as any
    if (!res.ok) return c.json(data, res.status as any)
    results = data.results ?? []
  } catch (e) {
    const msg = String(e)
    if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
      return c.json({ error: `Sentiment service not running on port ${port}. Start it with: cd sentiment_service && python3 service.py` }, 503)
    }
    return c.json({ error: msg }, 500)
  }

  let updated = 0
  const dw = openDb(true)
  if (dw) {
    try {
      for (const r of results) {
        if (r.id) {
          const val = r.tickers?.length ? r.tickers.join(',') : '-'
          dw.run('UPDATE articles SET ticker = ? WHERE id = ?', [val, r.id])
          if (r.tickers?.length) updated++
        }
      }
    } finally {
      dw.close()
    }
  }

  const totalTickers = results.reduce((n: number, r: any) => n + (r.tickers?.length ?? 0), 0)
  log('INFO', 'Ticker extraction complete', { updated, totalTickers, total: results.length, ms: t() })
  return c.json({ updated, total_tickers_found: totalTickers, articles_processed: results.length, ms: t() })
})

// ─── DS440 Proxy / Social Integration ───────────────────────────────────────

const DS440_URL = process.env.DS440_URL ?? 'https://dashboard-seven-mauve-17.vercel.app'

async function fetchDs440(path: string, timeout = 8000): Promise<any> {
  const res = await fetch(`${DS440_URL}${path}`, {
    signal: AbortSignal.timeout(timeout),
    headers: { 'Accept': 'application/json' },
  })
  if (!res.ok) throw new Error(`DS440 returned ${res.status}`)
  return res.json()
}

// ─── News sentiment cache (avoids re-scanning 5k rows on every screener refresh) ─
const newsSentimentCache: { data: Map<string, { sum: number; total: number; bullish: number; bearish: number; neutral: number }> | null; ts: number } = { data: null, ts: 0 }
const NEWS_SENT_TTL = 30_000  // 30s — matches screener auto-refresh minimum

function getNewsSentimentMap(): Map<string, { sum: number; total: number; bullish: number; bearish: number; neutral: number }> {
  const now = Date.now()
  if (newsSentimentCache.data && now - newsSentimentCache.ts < NEWS_SENT_TTL) {
    return newsSentimentCache.data
  }
  const newsMap = new Map<string, { sum: number; total: number; bullish: number; bearish: number; neutral: number }>()

  const addToMap = (ticker: string, sentiment: string) => {
    if (!newsMap.has(ticker)) newsMap.set(ticker, { sum: 0, total: 0, bullish: 0, bearish: 0, neutral: 0 })
    const n = newsMap.get(ticker)!
    n.total++
    const s = sentiment === 'bullish' ? 0.6 : sentiment === 'bearish' ? -0.6 : 0
    n.sum += s
    if (s > 0.1) n.bullish++; else if (s < -0.1) n.bearish++; else n.neutral++
  }

  try {
    const db = openDb(false)
    if (db) {
      const cutoff = Math.floor(now / 1000) - 7 * 24 * 3600

      // Pass 1: articles with pre-extracted tickers
      const tagged: any[] = db.query(
        `SELECT ticker, sentiment FROM articles
         WHERE ticker IS NOT NULL AND length(ticker) > 0
           AND fetched_date > ?
         ORDER BY fetched_date DESC LIMIT 5000`
      ).all(cutoff) as any[]
      for (const a of tagged) {
        const tickers = (a.ticker as string).split(',').map((s: string) => s.trim()).filter(Boolean)
        for (const ticker of tickers) addToMap(ticker, a.sentiment ?? 'neutral')
      }

      // Pass 2: scan titles of untagged articles for known ticker symbols & company names
      const untagged: any[] = db.query(
        `SELECT title, sentiment FROM articles
         WHERE (ticker IS NULL OR length(ticker) = 0)
           AND fetched_date > ?
         ORDER BY fetched_date DESC LIMIT 3000`
      ).all(cutoff) as any[]

      // Build company-name-to-ticker reverse map for faster title matching
      const companyToTicker = new Map<string, string>()
      for (const [sym, company] of TICKER_COMPANY) {
        if (sym.length >= 2 && company.length >= 4 && !TICKER_BLACKLIST.has(sym)) {
          companyToTicker.set(company.toUpperCase(), sym)
        }
      }

      for (const a of untagged) {
        const titleUpper = (a.title ?? '').toUpperCase()
        if (!titleUpper) continue
        const matched = new Set<string>()

        // Check company names in title (high confidence)
        for (const [companyUpper, sym] of companyToTicker) {
          if (matched.size >= 3) break
          if (titleUpper.includes(companyUpper)) matched.add(sym)
        }

        // Check ticker symbols as whole words (only 3+ char to avoid false positives)
        if (matched.size === 0) {
          for (const [sym] of TICKER_COMPANY) {
            if (sym.length < 3 || TICKER_BLACKLIST.has(sym)) continue
            if (matched.size >= 3) break
            if (new RegExp(`\\b${sym}\\b`).test(titleUpper)) matched.add(sym)
          }
        }

        for (const ticker of matched) addToMap(ticker, a.sentiment ?? 'neutral')
      }

      db.close()
    }
  } catch (e) {
    log('WARN', 'News sentiment cache build failed', { error: String(e) })
  }
  newsSentimentCache.data = newsMap
  newsSentimentCache.ts = now
  log('DEBUG', 'News sentiment cache refreshed', { tickers: newsMap.size })
  return newsMap
}

app.get('/api/screener', async (c) => {
  const t = ms()
  const window = c.req.query('window') ?? '60'
  let rows: any[] = []
  let source = ''
  let lastSync = ''

  try {
    const data = await fetchDs440(`/api/screener?window=${window}`)
    if (Array.isArray(data.data) && data.data.length > 0) {
      rows = data.data
      source = data.source ?? ''
      lastSync = data.lastSync ?? new Date().toISOString()
    } else {
      throw new Error('Empty screener from DS440')
    }
  } catch (_e) {
    // Fallback: build news screener from local SQLite articles with ticker data
    try {
      const db = openDb(false)
      if (!db) throw new Error('DB unavailable')
      const cutoff = Math.floor(Date.now() / 1000) - 7 * 24 * 3600  // last 7 days
      const arts: any[] = db.query(
        `SELECT ticker, sentiment, title FROM articles
         WHERE ticker IS NOT NULL AND length(ticker) > 0
           AND fetched_date > ?
         ORDER BY fetched_date DESC LIMIT 2000`
      ).all(cutoff) as any[]
      db.close()
      const map = new Map<string, any>()
      for (const a of arts) {
        // ticker column may have comma-separated tickers
        const tickers = (a.ticker as string).split(',').map((s: string) => s.trim()).filter(Boolean)
        for (const ticker of tickers) {
          if (!map.has(ticker)) map.set(ticker, { ticker, message_count: 0, bullish_count: 0, bearish_count: 0, neutral_count: 0, _sum: 0, source: 'news' })
          const r = map.get(ticker)!
          r.message_count++
          const s = a.sentiment === 'bullish' ? 0.6 : a.sentiment === 'bearish' ? -0.6 : 0
          r._sum += s
          if (s > 0.1) r.bullish_count++; else if (s < -0.1) r.bearish_count++; else r.neutral_count++
        }
      }
      // FIX: assign to outer `rows` — not a new local variable
      rows = Array.from(map.values())
        .map(r => {
          const newsSent = r.message_count ? +(r._sum / r.message_count).toFixed(4) : 0
          const company = TICKER_COMPANY.get(r.ticker) ?? null
          return {
            ticker: r.ticker,
            company,
            structured_sentiment: newsSent,
            social_sentiment: newsSent,
            news_article_count: r.message_count,
            avg_sentiment: newsSent,
            message_density: r.message_count,
            bullish_count: r.bullish_count,
            bearish_count: r.bearish_count,
            neutral_count: r.neutral_count,
            source: 'news',
          }
        })
        .filter(r => r.news_article_count >= 1)
        .sort((a, b) => b.news_article_count - a.news_article_count)
      log('INFO', `Screener news fallback: ${rows.length} tickers from ${arts.length} articles`)
      lastSync = new Date().toISOString()
    } catch (e2) {
      log('WARN', 'Screener fallback failed', { error: String(e2) })
      return c.json({ data: [], lastSync: null, error: 'Screener data unavailable', ms: t() })
    }
  }

  // Inject news sentiment from local SQLite (cached for 30s — no duplicate scans on concurrent requests)
  if (rows.length > 0) {
    try {
      const newsMap = getNewsSentimentMap()
      for (const r of rows) {
        const n = newsMap.get(r.ticker)
        if (n && n.total > 0) {
          r.structured_sentiment = +(n.sum / n.total).toFixed(4)
          r.news_article_count = n.total
          r.news_bullish_count = n.bullish
          r.news_bearish_count = n.bearish
          r.news_neutral_count = n.neutral
          // Add 'news' to sources array if not already present
          if (!r.sources) r.sources = []
          if (Array.isArray(r.sources) && !r.sources.includes('news')) r.sources.push('news')
        }
      }
    } catch (e3) {
      log('WARN', 'News sentiment enrichment failed', { error: String(e3) })
    }
  }


  // Inject fundamental/technical data via Yahoo Finance & Finviz map
  if (rows.length > 0) {
    const toFetch = rows.slice(0, 50).map((r: any) => r.ticker)
    const map = await fetchLivePrices(toFetch)
    for (const r of rows) {
      const live = map.get(r.ticker)
      const fv = FINVIZ_DATA.get(r.ticker)

      // Inject standard fields
      if (live) {
        if (!r.price) r.price = live.price
        if (!r.change) r.change = live.change
        if (!r.change_pct) r.change_pct = live.changePct
        if (!r.volume) r.volume = live.volume
        if (!r.avg_volume) r.avg_volume = live.avg_volume
        if (!r.market_cap) r.market_cap = live.market_cap
        if (!r.pe_ratio) r.pe_ratio = live.pe_ratio
        if (!r.week_52_high) r.week_52_high = live.week_52_high
        if (!r.week_52_low) r.week_52_low = live.week_52_low
        if (!r.earnings_date) r.earnings_date = live.earnings_date
      }
      if (fv) {
        if (!r.sector) r.sector = fv.sector
        if (!r.industry) r.industry = fv.industry
      }
    }
  }

  return c.json({ data: rows, lastSync, source, ms: t() })
})

// ─── Market Hours ────────────────────────────────────────────────────────────

function isMarketOpen(): { open: boolean; label: string; nextOpen?: string } {
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

// Common English words that are also ticker symbols — filter these out
const TICKER_BLACKLIST = new Set([
  'A','I','AM','AN','ARE','AS','AT','BE','BY','DO','FOR','GO','HAS','HE','HER','HIS',
  'HOW','IF','IN','IS','IT','ITS','MAY','ME','MY','NEW','NO','NOT','NOW','OF','OLD',
  'ON','ONE','OR','OUR','OUT','OWN','SAY','SHE','SO','THE','TO','TOP','TWO','UP','US',
  'WAS','WAY','WE','WHO','WHY','ALL','ANY','BIG','CAN','DAY','DID','GET','GOT','HAD',
  'HAS','HIM','HOT','KEY','LET','LOW','MAN','MEN','NET','OFF','OIL','PAY','PUT','RAN',
  'RUN','SAW','SET','SIT','SIX','TEN','THE','TOO','USE','VIA','WAR','WON','YET',
  'BEST','CALL','COME','DATA','EACH','ELSE','EVER','FAST','FIND','FIVE','FREE','FULL',
  'FUND','GAVE','GOOD','HALF','HARD','HERE','HIGH','HOME','HOPE','HUGE','IDEA','INTO',
  'JUST','KEEP','KNOW','LAST','LATE','LEAD','LEFT','LESS','LIFE','LINE','LIST','LIVE',
  'LONG','LOOK','LOST','LOTS','MADE','MAIN','MAKE','MANY','MARK','MIND','MINE','MISS',
  'MORE','MOST','MUCH','MUST','NAME','NEAR','NEED','NEXT','NINE','NOTE','ONLY','OPEN',
  'OVER','PART','PAST','PLAN','PLAY','POST','PUSH','RATE','READ','REAL','REST','RIDE',
  'RISE','RISK','ROAD','ROLE','RULE','SAFE','SAID','SALE','SAME','SAVE','SEEN','SELF',
  'SEND','SHOW','SHUT','SIDE','SIGN','SIZE','SOME','SOON','STEP','STOP','SUCH','SURE',
  'TAKE','TALK','TEAM','TELL','TERM','TEST','TEXT','THAN','THAT','THEM','THEN','THEY',
  'THIS','THUS','TIME','TOLD','TOOK','TURN','TYPE','UPON','USED','VERY','VIEW','VOTE',
  'WAIT','WALK','WALL','WANT','WARM','WAVE','WEEK','WELL','WENT','WERE','WEST','WHAT',
  'WHEN','WIDE','WILL','WISH','WITH','WORD','WORK','YEAR','YOUR','ZERO',
  'FOR','CEO','CFO',
])

// ─── Social Trending (After-Hours Buzz) ──────────────────────────────────────

const trendingCache: { data: any[] | null; ts: number } = { data: null, ts: 0 }
const TRENDING_TTL = 120_000 // 2min cache

async function fetchSocialTrending(): Promise<any[]> {
  const now = Date.now()
  if (trendingCache.data && now - trendingCache.ts < TRENDING_TTL) return trendingCache.data

  const trending: any[] = []

  try {
    // Try DS440 screener for social volume
    const data = await fetchDs440('/api/screener?window=1440', 10000).catch(() => null)  // last 24h
    const rows = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : [])

    if (rows.length > 0) {
      for (const r of rows) {
        const tk = r.ticker || r.symbol
        if (!tk || tk.length < 2) continue
        const msgCount = r.message_count ?? r.post_count ?? 0
        const avgSent = r.avg_sentiment ?? r.sentiment ?? 0
        const bullish = r.bullish_count ?? 0
        const bearish = r.bearish_count ?? 0
        if (msgCount < 2) continue // need at least 2 mentions to trend
        trending.push({
          ticker: tk,
          company: TICKER_COMPANY.get(tk) ?? null,
          sector: FINVIZ_DATA.get(tk)?.sector ?? null,
          social_message_count: msgCount,
          social_sentiment: avgSent,
          social_bullish: bullish,
          social_bearish: bearish,
          social_neutral: (r.neutral_count ?? Math.max(0, msgCount - bullish - bearish)),
          buzz_score: msgCount * (1 + Math.abs(avgSent)), // higher buzz = more posts × stronger sentiment
        })
      }
    }

    // StockTwits trending symbols + per-ticker streams
    try {
      // Fetch trending symbols from StockTwits
      const stResp = await fetch('https://api.stocktwits.com/api/2/trending/symbols.json', {
        signal: AbortSignal.timeout(8000),
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
      }).catch(() => null)

      if (stResp && stResp.ok) {
        const stData = await stResp.json().catch(() => null)
        const symbols = stData?.symbols ?? []

        // For each trending symbol, fetch its stream to get posts & sentiment
        // Filter out crypto (.X suffix) and blacklisted tickers
        const stTickers = symbols.map((s: any) => s.symbol).filter((sym: string) =>
          sym && !sym.includes('.') && sym.length >= 2 && !TICKER_BLACKLIST.has(sym)
        ).slice(0, 15)
        const stResults = await Promise.allSettled(
          stTickers.map(async (sym: string) => {
            try {
              const streamResp = await fetch(`https://api.stocktwits.com/api/2/streams/symbol/${sym}.json`, {
                signal: AbortSignal.timeout(5000),
                headers: {
                  'Accept': 'application/json',
                  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                },
              })
              if (!streamResp.ok) return null
              const streamData = await streamResp.json()
              const msgs = streamData?.messages ?? []
              let bullish = 0, bearish = 0, neutral = 0
              const posts: any[] = []
              for (const m of msgs.slice(0, 30)) {
                const sent = m.entities?.sentiment?.basic
                if (sent === 'Bullish') bullish++
                else if (sent === 'Bearish') bearish++
                else neutral++
                if (posts.length < 8) {
                  posts.push({
                    title: (m.body || '').slice(0, 300),
                    source: 'stocktwits',
                    url: `https://stocktwits.com/message/${m.id}`,
                    sentiment_score: sent === 'Bullish' ? 0.5 : sent === 'Bearish' ? -0.5 : 0,
                    published_at: m.created_at || null,
                    author: m.user?.username || null,
                    score: m.likes?.total ?? null,
                    comments: m.conversation?.replies ?? null,
                  })
                }
              }
              const total = bullish + bearish + neutral
              const avgSent = total > 0 ? +((bullish * 0.5 - bearish * 0.5) / total).toFixed(4) : 0
              return {
                ticker: sym,
                company: TICKER_COMPANY.get(sym) ?? streamData?.symbol?.title ?? null,
                sector: FINVIZ_DATA.get(sym)?.sector ?? null,
                social_message_count: total,
                social_sentiment: avgSent,
                social_bullish: bullish,
                social_bearish: bearish,
                social_neutral: neutral,
                buzz_score: total * (1 + Math.abs(avgSent)),
                social_posts: posts,
                source: 'stocktwits',
              }
            } catch { return null }
          })
        )
        for (const r of stResults) {
          if (r.status === 'fulfilled' && r.value) {
            // Merge with existing trending data — if ticker already exists, combine counts
            const existing = trending.find(t => t.ticker === r.value!.ticker)
            if (existing) {
              existing.social_message_count += r.value.social_message_count
              existing.social_bullish += r.value.social_bullish
              existing.social_bearish += r.value.social_bearish
              existing.social_neutral += r.value.social_neutral
              existing.buzz_score += r.value.buzz_score
              // Append StockTwits posts
              existing.social_posts = [...(existing.social_posts ?? []), ...(r.value.social_posts ?? [])].slice(0, 10)
              // Recalculate average sentiment
              const totSent = existing.social_bullish * 0.5 - existing.social_bearish * 0.5
              const totCount = existing.social_bullish + existing.social_bearish + existing.social_neutral
              existing.social_sentiment = totCount > 0 ? +(totSent / totCount).toFixed(4) : 0
            } else {
              trending.push(r.value)
            }
          }
        }
        log('INFO', `StockTwits: fetched ${stTickers.length} trending symbols, got ${stResults.filter(r => r.status === 'fulfilled' && r.value).length} streams`)
      }
    } catch (e) {
      log('DEBUG', 'StockTwits trending fetch failed', { error: String(e) })
    }

    // Fallback: scan local articles from last 48h for buzz
    if (trending.length === 0) {
      try {
        const db = openDb(false)
        if (db) {
          try {
            const tblCheck = db.query(`SELECT name FROM sqlite_master WHERE type='table' AND name='articles'`).get()
            if (tblCheck) {
              const cutoff = Math.floor(now / 1000) - 48 * 3600
              const arts: any[] = db.query(
                `SELECT ticker, sentiment FROM articles WHERE ticker IS NOT NULL AND length(ticker) > 0 AND fetched_date > ? ORDER BY fetched_date DESC LIMIT 3000`
              ).all(cutoff) as any[]
              const tickerBuzz = new Map<string, { total: number; bullish: number; bearish: number; neutral: number; sentSum: number }>()
              for (const a of arts) {
                for (const tk of (a.ticker as string).split(',').map((s: string) => s.trim()).filter(Boolean)) {
                  if (tk.length < 2 || !TICKER_COMPANY.has(tk) || TICKER_BLACKLIST.has(tk)) continue
                  if (!tickerBuzz.has(tk)) tickerBuzz.set(tk, { total: 0, bullish: 0, bearish: 0, neutral: 0, sentSum: 0 })
                  const b = tickerBuzz.get(tk)!
                  b.total++
                  if (a.sentiment === 'bullish') { b.bullish++; b.sentSum += 0.5 }
                  else if (a.sentiment === 'bearish') { b.bearish++; b.sentSum -= 0.5 }
                  else { b.neutral++ }
                }
              }
              for (const [tk, b] of tickerBuzz) {
                if (b.total < 3) continue
                const avgSent = b.sentSum / b.total
                trending.push({
                  ticker: tk,
                  company: TICKER_COMPANY.get(tk) ?? null,
                  sector: FINVIZ_DATA.get(tk)?.sector ?? null,
                  social_message_count: b.total,
                  social_sentiment: +avgSent.toFixed(4),
                  social_bullish: b.bullish,
                  social_bearish: b.bearish,
                  social_neutral: b.neutral,
                  buzz_score: b.total * (1 + Math.abs(avgSent)),
                  source: 'news_fallback',
                })
              }
            }
          } finally { db.close() }
        }
      } catch (e) {
        log('DEBUG', 'Trending: article fallback failed', { error: String(e) })
      }
    }

    // Also try to fetch individual posts for top trending tickers
    const topTrending = trending.sort((a, b) => b.buzz_score - a.buzz_score).slice(0, 20)
    const postResults = await Promise.allSettled(
      topTrending.slice(0, 10).map(async (t) => {
        try {
          const postsData = await fetchDs440(`/api/posts?ticker=${t.ticker}&window=1440`, 5000).catch(() => null)
          const posts = Array.isArray(postsData) ? postsData : (postsData?.posts ?? [])
          return { ticker: t.ticker, posts: posts.slice(0, 8) }
        } catch { return { ticker: t.ticker, posts: [] } }
      })
    )
    const postMap = new Map<string, any[]>()
    for (const r of postResults) {
      if (r.status === 'fulfilled' && r.value.posts.length > 0) {
        postMap.set(r.value.ticker, r.value.posts.map((p: any) => ({
          title: p.title || p.text || '',
          source: p.source || p.subreddit || 'social',
          url: p.url || '',
          sentiment_score: p.sentiment_score ?? 0,
          published_at: p.published_at || p.created_at || null,
          author: p.author || null,
          score: p.score ?? null,
          comments: p.num_comments ?? null,
        })))
      }
    }
    for (const t of topTrending) {
      const ds440Posts = postMap.get(t.ticker)
      if (ds440Posts && ds440Posts.length > 0) {
        // Merge DS440 posts with any existing StockTwits posts
        const existing = t.social_posts ?? []
        const merged: any[] = []
        let ei = 0, di = 0
        while (merged.length < 10 && (ei < existing.length || di < ds440Posts.length)) {
          if (ei < existing.length) merged.push(existing[ei++])
          if (di < ds440Posts.length && merged.length < 10) merged.push(ds440Posts[di++])
        }
        t.social_posts = merged
      }
      // If no posts from either source, leave whatever was already there (StockTwits data)
    }

    trendingCache.data = topTrending
    trendingCache.ts = now
    return topTrending
  } catch (e) {
    log('DEBUG', 'Social trending fetch failed', { error: String(e) })
    return trending
  }
}

// Trending endpoint
app.get('/api/momentum/trending', async (c) => {
  const t = ms()
  const sentimentFilter = c.req.query('sentiment') ?? '' // bullish | bearish | ''
  const limit = Math.min(parseInt(c.req.query('limit') ?? '15'), 30)
  const maxPrice = parseFloat(c.req.query('max_price') ?? '0')
  const market = isMarketOpen()

  try {
    let trending = await fetchSocialTrending()

    // Apply filters — same filters as the main momentum section
    if (sentimentFilter === 'bullish') trending = trending.filter(t => (t.social_sentiment ?? 0) > 0.05)
    else if (sentimentFilter === 'bearish') trending = trending.filter(t => (t.social_sentiment ?? 0) < -0.05)
    if (maxPrice > 0) {
      trending = trending.filter(t => {
        const fv = FINVIZ_DATA.get(t.ticker)
        const price = fv?.price ?? 0
        return price > 0 && price <= maxPrice
      })
    }

    trending = trending.slice(0, limit)

    // Enrich with live prices (batch in groups of 50)
    const trendSyms = trending.map(t => t.ticker).filter(Boolean)
    for (let i = 0; i < trendSyms.length; i += 50) {
      const batch = trendSyms.slice(i, i + 50)
      const priceMap = await fetchLivePrices(batch)
      for (const [sym, live] of priceMap) {
        const row = trending.find(t => t.ticker === sym)
        if (row) {
          row.price = live.price ?? null
          row.change = live.change ?? null
          row.change_pct = live.changePct ?? null
          row.volume = live.volume ?? null
          row.avg_volume = live.avg_volume ?? null
          const vol = typeof live.volume === 'number' ? live.volume : 0
          const avgVol = parseHumanNumber(live.avg_volume)
          row.volume_num = vol
          row.rvol = avgVol > 0 ? +(vol / avgVol).toFixed(2) : 0
        }
      }
    }

    return c.json({ trending, market, updated: new Date().toISOString(), ms: t() })
  } catch (e) {
    log('WARN', 'Trending endpoint failed', { error: String(e) })
    return c.json({ trending: [], market, error: String(e), ms: t() }, 500)
  }
})

// Market status endpoint
app.get('/api/market/status', (c) => {
  return c.json(isMarketOpen())
})

// ─── Momentum Scanner ────────────────────────────────────────────────────────

const CATALYST_KEYWORDS = [
  'contract', 'fda', 'earnings', 'merger', 'acquisition',
  'data center', 'offering', 'split', 'partnership', 'guidance',
]

const momentumCache: { data: any | null; ts: number } = { data: null, ts: 0 }
const MOMENTUM_TTL = 60_000 // 60s cache

app.get('/api/momentum', async (c) => {
  const t = ms()
  const minVolume = parseInt(c.req.query('min_volume') ?? '100000')
  const minRvol = parseFloat(c.req.query('min_rvol') ?? '1')
  const limit = Math.min(parseInt(c.req.query('limit') ?? '10'), 25)
  const sentimentFilter = c.req.query('sentiment') ?? '' // bullish | bearish | ''
  const maxPrice = parseFloat(c.req.query('max_price') ?? '0')

  const now = Date.now()
  const market = isMarketOpen()

  if (momentumCache.data && now - momentumCache.ts < MOMENTUM_TTL) {
    const filtered = applyMomentumFilters(momentumCache.data.tickers, minVolume, minRvol, limit, sentimentFilter, maxPrice)
    return c.json({ tickers: filtered, updated: momentumCache.data.updated, market, cached: true, ms: t() })
  }

  try {
    // 1. Build ticker universe: DS440 screener > article tickers + liquid list
    let screenerRows: any[] = []
    try {
      const data = await fetchDs440('/api/screener?window=60')
      if (Array.isArray(data.data) && data.data.length > 0) screenerRows = data.data
    } catch { /* fall through */ }

    if (!screenerRows.length) {
      // Always start with known liquid tickers
      const liquidTickers = [
        'SPY','QQQ','IWM','DIA',
        'AAPL','MSFT','GOOGL','AMZN','NVDA','META','TSLA','AMD','INTC','CRM','PLTR','SMCI','AVGO','MU','MRVL',
        'JPM','BAC','GS','MS','V','MA','WFC',
        'JNJ','UNH','PFE','MRNA','ABBV','LLY',
        'XOM','CVX','OXY','SLB',
        'GME','AMC','SOFI','RIVN','LCID','NIO','MARA','RIOT','COIN','HOOD',
        'F','SNAP','UBER','SQ','ROKU','DKNG','RBLX','NFLX','DIS','PYPL','BABA','BA','CAT','DE',
      ]
      const allTickers = new Set(liquidTickers)

      // Add penny stocks/small caps from FINVIZ_DATA if price filter is used
      if (maxPrice > 0) {
        for (const [tk, fv] of FINVIZ_DATA.entries()) {
          if (fv.price !== undefined && fv.price <= maxPrice && fv.volume !== undefined && fv.volume >= minVolume) {
            allTickers.add(tk)
          }
        }
      }

      // Add article tickers (filtered for quality)
      try {
        const db = openDb(false)
        if (db) {
          try {
            const tblCheck = db.query(`SELECT name FROM sqlite_master WHERE type='table' AND name='articles'`).get()
            if (tblCheck) {
              const cutoff = Math.floor(now / 1000) - 7 * 24 * 3600
              const arts: any[] = db.query(
                `SELECT ticker FROM articles WHERE ticker IS NOT NULL AND length(ticker) > 0 AND fetched_date > ? ORDER BY fetched_date DESC LIMIT 2000`
              ).all(cutoff) as any[]
              // Count how many articles mention each ticker to rank relevance
              const tickerCounts = new Map<string, number>()
              for (const a of arts) {
                for (const tk of (a.ticker as string).split(',').map((s: string) => s.trim()).filter(Boolean)) {
                  if (tk.length >= 2 && !TICKER_BLACKLIST.has(tk) && TICKER_COMPANY.has(tk)) {
                    tickerCounts.set(tk, (tickerCounts.get(tk) ?? 0) + 1)
                  }
                }
              }
              // Add top mentioned tickers (most newsworthy = most likely to have momentum)
              const sorted = [...tickerCounts.entries()].sort((a, b) => b[1] - a[1])
              for (const [tk] of sorted.slice(0, 150)) {
                allTickers.add(tk)
              }
            }
          } finally { db.close() }
        }
      } catch (e) {
        log('DEBUG', 'Momentum: articles scan failed', { error: String(e) })
      }

      screenerRows = Array.from(allTickers).map(tk => ({ ticker: tk }))
      log('INFO', `Momentum: scanning ${screenerRows.length} tickers (${liquidTickers.length} liquid + article tickers)`)
    }

    // 2. Enrich with live prices — batch in groups of 50 (CNBC limit)
    const allTickerSyms = screenerRows.map((r: any) => r.ticker).filter(Boolean)
    const priceMap = new Map<string, any>()
    for (let i = 0; i < allTickerSyms.length; i += 50) {
      const batch = allTickerSyms.slice(i, i + 50)
      const batchMap = await fetchLivePrices(batch)
      for (const [k, v] of batchMap) priceMap.set(k, v)
    }

    const enriched = screenerRows.map((r: any) => {
      const live = priceMap.get(r.ticker)
      if (live) {
        r.price = live.price ?? r.price
        r.change = live.change ?? r.change
        r.change_pct = live.changePct ?? r.change_pct
        r.volume = live.volume ?? r.volume
        r.avg_volume = live.avg_volume ?? r.avg_volume
        r.market_cap = live.market_cap ?? r.market_cap
      }
      const fv = FINVIZ_DATA.get(r.ticker)
      if (fv) {
        r.sector = r.sector ?? fv.sector
        r.industry = r.industry ?? fv.industry
      }
      r.company = r.company ?? TICKER_COMPANY.get(r.ticker) ?? null
      // Compute relative volume
      const vol = typeof r.volume === 'number' ? r.volume : parseInt(String(r.volume || '0').replace(/,/g, ''))
      const avgVol = parseHumanNumber(r.avg_volume)
      r.volume_num = vol || 0
      r.avg_volume_num = avgVol || 0
      r.rvol = avgVol > 0 ? +(vol / avgVol).toFixed(2) : 0
      return r
    })

    // 3. Pull recent headlines per ticker from SQLite (if articles table exists)
    const headlinesMap = new Map<string, { title: string; url: string; source: string; date: number; sentiment: string | null }[]>()
    try {
      const db2 = openDb(false)
      if (db2) {
        try {
          const tblCheck = db2.query(`SELECT name FROM sqlite_master WHERE type='table' AND name='articles'`).get()
          if (tblCheck) {
            const cutoff = Math.floor(now / 1000) - 3 * 24 * 3600 // last 3 days
            const arts: any[] = db2.query(
              `SELECT ticker, title, url, source, COALESCE(publish_date, fetched_date) as date, sentiment
               FROM articles WHERE ticker IS NOT NULL AND length(ticker) > 0 AND fetched_date > ?
               ORDER BY date DESC LIMIT 2000`
            ).all(cutoff) as any[]
            for (const a of arts) {
              for (const tk of (a.ticker as string).split(',').map((s: string) => s.trim()).filter(Boolean)) {
                if (!headlinesMap.has(tk)) headlinesMap.set(tk, [])
                const arr = headlinesMap.get(tk)!
                if (arr.length < 10) {
                  arr.push({ title: a.title, url: a.url, source: a.source, date: a.date, sentiment: a.sentiment })
                }
              }
            }
          }
        } finally { db2.close() }
      }
    } catch (e) {
      log('DEBUG', 'Momentum: headlines query failed', { error: String(e) })
    }

    // 4. Classify catalysts in headlines
    for (const [ticker, headlines] of headlinesMap) {
      for (const h of headlines) {
        const lower = h.title.toLowerCase()
        const catalysts = CATALYST_KEYWORDS.filter(kw => lower.includes(kw))
        ;(h as any).catalysts = catalysts
      }
    }

    // 5. Attach headlines to enriched rows
    for (const r of enriched) {
      r.headlines = headlinesMap.get(r.ticker) ?? []
      r.catalyst_count = r.headlines.filter((h: any) => h.catalysts?.length > 0).length
    }

    // 6. Enrich with news sentiment from SQLite
    try {
      const newsMap = getNewsSentimentMap()
      for (const r of enriched) {
        const n = newsMap.get(r.ticker)
        if (n && n.total > 0) {
          r.news_sentiment = +(n.sum / n.total).toFixed(4)
          r.news_article_count = n.total
          r.news_bullish = n.bullish
          r.news_bearish = n.bearish
          r.news_neutral = n.neutral
        } else {
          r.news_sentiment = 0
          r.news_article_count = 0
          r.news_bullish = 0
          r.news_bearish = 0
          r.news_neutral = 0
        }
      }
    } catch (e) {
      log('DEBUG', 'Momentum: news sentiment enrichment failed', { error: String(e) })
    }

    // 7. Enrich with social sentiment from DS440 (batch — non-blocking)
    try {
      const socialTickers = enriched.slice(0, 30).map((r: any) => r.ticker)
      const socialResults = await Promise.allSettled(
        socialTickers.map(async (sym: string) => {
          try {
            const [tickerData, postsData] = await Promise.all([
              fetchDs440(`/api/ticker/${sym}`, 5000).catch(() => null),
              fetchDs440(`/api/posts?ticker=${sym}&window=60`, 5000).catch(() => []),
            ])
            const row = Array.isArray(tickerData) ? tickerData?.[0] : tickerData
            const posts = Array.isArray(postsData) ? postsData : (postsData?.posts ?? [])
            return {
              ticker: sym,
              social_sentiment: row?.avg_sentiment ?? null,
              social_message_count: row?.message_count ?? 0,
              social_bullish: row?.bullish_count ?? 0,
              social_bearish: row?.bearish_count ?? 0,
              social_neutral: row?.neutral_count ?? 0,
              social_posts: posts.slice(0, 8).map((p: any) => ({
                title: p.title || p.text || '',
                source: p.source || p.subreddit || 'social',
                url: p.url || '',
                sentiment_score: p.sentiment_score ?? 0,
                published_at: p.published_at || p.created_at || null,
                author: p.author || null,
                score: p.score ?? null,
                comments: p.num_comments ?? null,
              })),
            }
          } catch { return { ticker: sym, social_sentiment: null, social_message_count: 0, social_bullish: 0, social_bearish: 0, social_neutral: 0, social_posts: [] } }
        })
      )
      for (const res of socialResults) {
        if (res.status !== 'fulfilled') continue
        const sd = res.value
        const row = enriched.find((r: any) => r.ticker === sd.ticker)
        if (row) {
          row.social_sentiment = sd.social_sentiment
          row.social_message_count = sd.social_message_count
          row.social_bullish = sd.social_bullish
          row.social_bearish = sd.social_bearish
          row.social_neutral = sd.social_neutral
          row.social_posts = sd.social_posts
        }
      }
    } catch (e) {
      log('DEBUG', 'Momentum: social enrichment failed (DS440 may be offline)', { error: String(e) })
    }

    // 7b. StockTwits enrichment — merge with DS440 data (not just fallback)
    try {
      const topTickers = enriched.slice(0, 20)
      const stResults = await Promise.allSettled(
        topTickers.map(async (r: any) => {
          try {
            const resp = await fetch(`https://api.stocktwits.com/api/2/streams/symbol/${r.ticker}.json`, {
              signal: AbortSignal.timeout(5000),
              headers: {
                'Accept': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              },
            })
            if (!resp.ok) return null
            const data = await resp.json()
            const msgs = data?.messages ?? []
            let bullish = 0, bearish = 0, neutral = 0
            const posts: any[] = []
            for (const m of msgs.slice(0, 20)) {
              const sent = m.entities?.sentiment?.basic
              if (sent === 'Bullish') bullish++
              else if (sent === 'Bearish') bearish++
              else neutral++
              if (posts.length < 6) {
                posts.push({
                  title: (m.body || '').slice(0, 300),
                  source: 'stocktwits',
                  url: `https://stocktwits.com/message/${m.id}`,
                  sentiment_score: sent === 'Bullish' ? 0.5 : sent === 'Bearish' ? -0.5 : 0,
                  published_at: m.created_at || null,
                  author: m.user?.username || null,
                  score: m.likes?.total ?? null,
                  comments: m.conversation?.replies ?? null,
                })
              }
            }
            const total = bullish + bearish + neutral
            return {
              ticker: r.ticker,
              st_sentiment: total > 0 ? +((bullish * 0.5 - bearish * 0.5) / total).toFixed(4) : null,
              st_count: total,
              st_bullish: bullish,
              st_bearish: bearish,
              st_neutral: neutral,
              st_posts: posts,
            }
          } catch { return null }
        })
      )
      for (const res of stResults) {
        if (res.status !== 'fulfilled' || !res.value) continue
        const sd = res.value
        const row = enriched.find((r: any) => r.ticker === sd.ticker)
        if (row && sd.st_count > 0) {
          // Merge: combine DS440 (Bluesky/Reddit) + StockTwits counts
          row.social_message_count = (row.social_message_count ?? 0) + sd.st_count
          row.social_bullish = (row.social_bullish ?? 0) + sd.st_bullish
          row.social_bearish = (row.social_bearish ?? 0) + sd.st_bearish
          row.social_neutral = (row.social_neutral ?? 0) + sd.st_neutral
          // Merge posts — interleave DS440 and StockTwits, up to 10
          const existingPosts = row.social_posts ?? []
          const merged: any[] = []
          let ei = 0, si = 0
          while (merged.length < 10 && (ei < existingPosts.length || si < sd.st_posts.length)) {
            if (ei < existingPosts.length) merged.push(existingPosts[ei++])
            if (si < sd.st_posts.length && merged.length < 10) merged.push(sd.st_posts[si++])
          }
          row.social_posts = merged
          // Recalculate average sentiment across all sources
          const totalSent = (row.social_bullish * 0.5) - (row.social_bearish * 0.5)
          const totalCount = row.social_bullish + row.social_bearish + row.social_neutral
          row.social_sentiment = totalCount > 0 ? +(totalSent / totalCount).toFixed(4) : row.social_sentiment
          row.social_source = row.social_source ? `${row.social_source}+stocktwits` : 'stocktwits'
        }
      }
      log('INFO', `StockTwits: enriched ${stResults.filter(r => r.status === 'fulfilled' && r.value && r.value.st_count > 0).length}/${topTickers.length} momentum tickers`)
    } catch (e) {
      log('DEBUG', 'Momentum: StockTwits enrichment failed', { error: String(e) })
    }

    // 8. Fallback: populate social column from local articles when DS440 has no posts
    for (const r of enriched) {
      if ((!r.social_posts || r.social_posts.length === 0) && r.headlines && r.headlines.length > 0) {
        r.social_posts = r.headlines.slice(0, 6).map((h: any) => ({
          title: h.title,
          source: h.source || 'news',
          url: h.url || '',
          sentiment_score: h.sentiment === 'bullish' ? 0.5 : h.sentiment === 'bearish' ? -0.5 : 0,
          published_at: h.date ? new Date(h.date * 1000).toISOString() : null,
          author: null,
          score: null,
          comments: null,
        }))
        r.social_source = 'news_fallback'
        // Also fill social sentiment from news if empty
        if (!r.social_message_count) {
          r.social_message_count = r.news_article_count ?? 0
          r.social_sentiment = r.news_sentiment ?? 0
          r.social_bullish = r.news_bullish ?? 0
          r.social_bearish = r.news_bearish ?? 0
          r.social_neutral = r.news_neutral ?? 0
        }
      }
    }

    // 9. Compute combined sentiment score for filtering
    for (const r of enriched) {
      const ns = r.news_sentiment ?? 0
      const ss = r.social_sentiment ?? 0
      const hasNews = (r.news_article_count ?? 0) > 0
      const hasSocial = (r.social_message_count ?? 0) > 0
      if (hasNews && hasSocial) r.combined_sentiment = (ns + ss) / 2
      else if (hasNews) r.combined_sentiment = ns
      else if (hasSocial) r.combined_sentiment = ss
      else r.combined_sentiment = 0
    }

    // Cache the full enriched data
    momentumCache.data = { tickers: enriched, updated: new Date().toISOString() }
    momentumCache.ts = now

    const filtered = applyMomentumFilters(enriched, minVolume, minRvol, limit, sentimentFilter)
    return c.json({ tickers: filtered, updated: momentumCache.data.updated, market, cached: false, ms: t() })
  } catch (e) {
    log('WARN', 'Momentum scanner failed', { error: String(e) })
    return c.json({ tickers: [], updated: null, market, error: String(e), ms: t() }, 500)
  }
})

function applyMomentumFilters(tickers: any[], minVolume: number, minRvol: number, limit: number, sentiment = '', maxPrice: number = 0): any[] {
  return tickers
    .filter(t => {
      if (t.volume_num <= minVolume || t.rvol < minRvol) return false
      if (maxPrice > 0 && t.price > maxPrice) return false
      if (sentiment === 'bullish' && (t.combined_sentiment ?? 0) <= 0.05) return false
      if (sentiment === 'bearish' && (t.combined_sentiment ?? 0) >= -0.05) return false
      return true
    })
    .sort((a, b) => (b.change_pct ?? 0) - (a.change_pct ?? 0))
    .slice(0, limit)
}

app.get('/api/social/posts', async (c) => {
  const t = ms()
  const ticker = c.req.query('ticker') ?? ''
  const window = c.req.query('window') ?? '60'
  const source = c.req.query('source') ?? ''
  const qs = new URLSearchParams({ window })
  if (ticker) qs.set('ticker', ticker)
  if (source) qs.set('source', source)
  try {
    const raw = await fetchDs440(`/api/posts?${qs}`)
    const posts = Array.isArray(raw) ? raw : (raw.posts ?? raw.data ?? [])
    // Enrich each post with sentiment_label and company names for mentioned tickers
    const enriched = posts.map((p: any) => {
      const score: number = p.sentiment_score ?? 0
      const sentiment_label = score > 0.05 ? 'bullish' : score < -0.05 ? 'bearish' : 'neutral'
      const ticker_companies: Record<string, string> = {}
      for (const t of (p.tickers_mentioned ?? [])) {
        const co = TICKER_COMPANY.get(t)
        if (co) ticker_companies[t] = co
      }
      return { ...p, sentiment_label, ticker_companies }
    })
    return c.json({ posts: enriched, ms: t() })
  } catch (e) {
    return c.json({ posts: [], error: 'DS440 service unavailable', ms: t() })
  }
})

app.get('/api/social/alerts', async (c) => {
  const t = ms()
  try {
    const raw = await fetchDs440('/api/alerts')
    const alerts = Array.isArray(raw) ? raw : (raw.alerts ?? raw.data ?? [])
    return c.json({ alerts, ms: t() })
  } catch (e) {
    return c.json({ alerts: [], error: 'DS440 service unavailable', ms: t() })
  }
})

app.get('/api/social/phrases', async (c) => {
  const t = ms()
  try {
    const raw = await fetchDs440('/api/phrases')
    const phrases = Array.isArray(raw) ? raw : (raw.phrases ?? raw.data ?? [])
    return c.json({ phrases, ms: t() })
  } catch (e) {
    return c.json({ phrases: [], error: 'DS440 service unavailable', ms: t() })
  }
})

app.get('/api/social/subreddits', async (c) => {
  const t = ms()
  try {
    const raw = await fetchDs440('/api/subreddits/health')
    const subreddits = Array.isArray(raw) ? raw : (raw.subreddits ?? raw.health ?? raw.data ?? [])
    return c.json({ subreddits, ms: t() })
  } catch (e) {
    return c.json({ subreddits: [], error: 'DS440 service unavailable', ms: t() })
  }
})

app.get('/api/social/ticker/:symbol', async (c) => {
  const t = ms()
  const sym = c.req.param('symbol').toUpperCase()
  try {
    // Fetch ticker row + recent posts in parallel
    const [tickerRaw, postsRaw] = await Promise.all([
      fetchDs440(`/api/ticker/${sym}`),
      fetchDs440(`/api/posts?ticker=${sym}&window=60`).catch(() => []),
    ])
    const posts = Array.isArray(postsRaw) ? postsRaw : (postsRaw.posts ?? [])
    // Normalise: DS440 returns a flat screener row; build a windows map from it
    const row = Array.isArray(tickerRaw) ? tickerRaw[0] : tickerRaw
    const windows: Record<string, any> = row?.windows ?? {}
    if (!Object.keys(windows).length && row?.avg_sentiment != null) {
      windows['60'] = {
        avg_sentiment: row.avg_sentiment,
        message_count: row.message_count ?? 0,
        bullish_count: row.bullish_count ?? 0,
        bearish_count: row.bearish_count ?? 0,
        neutral_count: row.neutral_count ?? 0,
      }
    }
    return c.json({ ticker: sym, row, windows, recentPosts: posts.slice(0, 20), ms: t() })
  } catch (e) {
    // Fallback: use local news articles for this ticker
    try {
      const db = openDb(false)
      if (!db) throw new Error('DB unavailable')
      const arts: any[] = db.query(
        `SELECT id, title, url, source, sentiment, ml_confidence, publish_date, fetched_date
         FROM articles WHERE ticker LIKE ? OR ticker LIKE ? OR ticker LIKE ? OR ticker = ?
         ORDER BY COALESCE(publish_date, fetched_date) DESC LIMIT 20`
      ).all(`${sym},%`, `%,${sym},%`, `%,${sym}`, sym) as any[]
      db.close()
      const recentPosts = arts.map(a => ({
        id: a.id, source: 'news', title: a.title, url: a.url,
        published_at: a.publish_date ? new Date(a.publish_date * 1000).toISOString() : null,
        sentiment_score: a.sentiment === 'positive' ? 0.6 : a.sentiment === 'negative' ? -0.6 : 0,
        tickers_mentioned: [sym],
      }))
      const sentiments = recentPosts.map(p => p.sentiment_score)
      const avg = sentiments.length ? sentiments.reduce((s, v) => s + v, 0) / sentiments.length : 0
      const windows: Record<string, any> = {}
      if (recentPosts.length > 0) {
        windows['news'] = {
          avg_sentiment: +avg.toFixed(4),
          message_count: recentPosts.length,
          bullish_count: sentiments.filter(s => s > 0.1).length,
          bearish_count: sentiments.filter(s => s < -0.1).length,
          neutral_count: sentiments.filter(s => Math.abs(s) <= 0.1).length,
        }
      }
      return c.json({ ticker: sym, row: null, windows, recentPosts, source: 'news_fallback', ms: t() })
    } catch (_e2) {
      return c.json({ ticker: sym, windows: {}, recentPosts: [], error: 'DS440 service unavailable', ms: t() })
    }
  }
})

app.get('/api/social/ticker/:symbol/history', async (c) => {
  const t = ms()
  const sym = c.req.param('symbol').toUpperCase()
  const timeRange = c.req.query('timeRange') ?? '24hr'
  try {
    const raw = await fetchDs440(`/api/ticker/${sym}/history?timeRange=${timeRange}`)
    const history = Array.isArray(raw) ? raw : (raw.history ?? raw.data ?? raw)
    return c.json({ history, ms: t() })
  } catch (e) {
    return c.json({ history: [], error: 'DS440 service unavailable', ms: t() })
  }
})

// ─── Technical Indicators ─────────────────────────────────────────────────────

function calcEMA(data: number[], period: number): (number | null)[] {
  const result: (number | null)[] = Array(data.length).fill(null)
  if (data.length < period) return result
  const k = 2 / (period + 1)
  let seed = 0
  for (let i = 0; i < period; i++) seed += data[i]
  result[period - 1] = seed / period
  for (let i = period; i < data.length; i++) {
    result[i] = data[i] * k + (result[i - 1] as number) * (1 - k)
  }
  return result
}

function calcRSI(closes: number[], period = 14): (number | null)[] {
  const rsi: (number | null)[] = Array(closes.length).fill(null)
  if (closes.length < period + 1) return rsi
  let avgGain = 0, avgLoss = 0
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1]
    if (d > 0) avgGain += d; else avgLoss -= d
  }
  avgGain /= period; avgLoss /= period
  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1]
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
  }
  return rsi
}

function calcBollinger(closes: number[], period = 20, mult = 2) {
  const upper: (number | null)[] = Array(closes.length).fill(null)
  const middle: (number | null)[] = Array(closes.length).fill(null)
  const lower: (number | null)[] = Array(closes.length).fill(null)
  for (let i = period - 1; i < closes.length; i++) {
    const slice = closes.slice(i - period + 1, i + 1)
    const mean = slice.reduce((a, b) => a + b, 0) / period
    const std = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period)
    middle[i] = mean; upper[i] = mean + mult * std; lower[i] = mean - mult * std
  }
  return { upper, middle, lower }
}

function calcMACD(closes: number[]) {
  const ema12 = calcEMA(closes, 12)
  const ema26 = calcEMA(closes, 26)
  const macdLine = ema12.map((v, i) => v != null && ema26[i] != null ? v - (ema26[i] as number) : null)
  const macdValues = macdLine.filter((v): v is number => v != null)
  const signalShort = calcEMA(macdValues, 9)
  const offset = macdLine.length - signalShort.length
  const signal: (number | null)[] = [...Array(offset).fill(null), ...signalShort]
  const hist = macdLine.map((v, i) => v != null && signal[i] != null ? v - (signal[i] as number) : null)
  return { macd: macdLine, signal, hist }
}

// ─── Live price cache ──────────────────────────────────────────────────────────
// Successful quotes cached for 60s; failures cached for 5 min to stop hammering Yahoo.
const priceCache = new Map<string, { price: number; change: number; changePct: number; volume: number | null; avg_volume: number | null; market_cap: string | null; pe_ratio: number | null; week_52_high: number | null; week_52_low: number | null; earnings_date: string | null; ts: number }>()
const PRICE_TTL = 60_000   // ms — re-fetch successful quotes after 60s
const PRICE_FAIL_TTL = 300_000  // ms — don't retry a failed batch for 5 min
let priceFetchFailedAt = 0    // timestamp of last Yahoo batch failure

async function fetchLivePrices(tickers: string[]): Promise<Map<string, { price: number; change: number; changePct: number; volume: number | null; avg_volume: number | null; market_cap: string | null; pe_ratio: number | null; week_52_high: number | null; week_52_low: number | null; earnings_date: string | null }>> {
  const result = new Map<string, { price: number; change: number; changePct: number; volume: number | null; avg_volume: number | null; market_cap: string | null; pe_ratio: number | null; week_52_high: number | null; week_52_low: number | null; earnings_date: string | null }>()
  const now = Date.now()

  const toFetch = tickers.filter(t => {
    const cached = priceCache.get(t)
    if (cached && now - cached.ts < PRICE_TTL) {
      result.set(t, {
        price: cached.price, change: cached.change, changePct: cached.changePct,
        volume: cached.volume, avg_volume: cached.avg_volume, market_cap: cached.market_cap,
        pe_ratio: cached.pe_ratio, week_52_high: cached.week_52_high, week_52_low: cached.week_52_low,
        earnings_date: cached.earnings_date
      })
      return false
    }
    return true
  })

  if (!toFetch.length) return result

  // If the last fetch attempt failed recently, skip — don't hammer Yahoo during an outage
  if (priceFetchFailedAt > 0 && now - priceFetchFailedAt < PRICE_FAIL_TTL) return result

  const symbols = toFetch.join('|')
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'application/json',
  }

  let lastErr = ''

  try {
    const url = `https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=${encodeURIComponent(symbols)}&requestMethod=itv`
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) })
    if (!res.ok) throw new Error(`CNBC status ${res.status}`)

    const json: any = await res.json()
    const quotes: any[] = json?.FormattedQuoteResult?.FormattedQuote ?? []

    for (const q of quotes) {
      const sym = q?.symbol
      if (!sym) continue
      const entry = {
        price: parseFloat((q.last || '0').replace(/,/g, '')) || 0,
        change: parseFloat((q.change || '0').replace(/,/g, '')) || 0,
        changePct: parseFloat((q.change_pct || '0').replace('%', '')) || 0,
        volume: parseInt((q.volume || '0').replace(/,/g, '')) || null,
        avg_volume: q.tendayavgvol || null,
        market_cap: q.mktcapView || null,
        pe_ratio: parseFloat(q.pe) || null,
        week_52_high: parseFloat(q.yrhiprice) || null,
        week_52_low: parseFloat(q.yrloprice) || null,
        earnings_date: null,
        ts: now,
      }
      priceCache.set(sym, entry)
      const { ts, ...liveData } = entry
      result.set(sym, liveData)
    }
    priceFetchFailedAt = 0  // clear failure flag on success
    return result
  } catch (e) {
    lastErr = String(e).slice(0, 80)
  }

  // Both hosts failed — back off for PRICE_FAIL_TTL before trying again
  priceFetchFailedAt = now
  log('WARN', 'Live price fetch failed (backing off 5 min)', { reason: lastErr })
  return result
}


// GET /api/prices?tickers=AAPL,TSLA,GOOG — batch live quotes (60s cache)
app.get('/api/prices', async (c) => {
  const t = ms()
  const raw = c.req.query('tickers') ?? ''
  const tickers = raw.split(',').map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, 50)
  if (!tickers.length) return c.json({ prices: {}, ms: t() })

  const map = await fetchLivePrices(tickers)
  const prices: Record<string, { price: number; change: number; changePct: number }> = {}
  for (const [sym, data] of map) prices[sym] = data

  return c.json({ prices, ms: t() })
})

// GET /api/charts/:ticker — OHLCV + RSI + MACD + Bollinger from Yahoo Finance
app.get('/api/charts/:ticker', async (c) => {
  const t = ms()
  const ticker = c.req.param('ticker').toUpperCase()
  const range = c.req.query('range') ?? '3mo'
  const interval = c.req.query('interval') ?? '1d'

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=${interval}&range=${range}&includePrePost=false`
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(10000),
    })
    const json: any = await res.json()
    const result = json?.chart?.result?.[0]
    if (!result) return c.json({ error: 'No data found for ticker', ticker, ms: t() }, 404)

    const timestamps: number[] = result.timestamp ?? []
    const q = result.indicators?.quote?.[0] ?? {}
    const opens: number[] = q.open ?? []
    const highs: number[] = q.high ?? []
    const lows: number[] = q.low ?? []
    const closes: number[] = q.close ?? []
    const volumes: number[] = q.volume ?? []

    const valid = timestamps
      .map((ts, i) => ({ ts, o: opens[i], h: highs[i], l: lows[i], c: closes[i], v: volumes[i] }))
      .filter(d => d.c != null && d.o != null)

    const cleanCloses = valid.map(d => d.c)
    const rsi = calcRSI(cleanCloses)
    const bb = calcBollinger(cleanCloses)
    const macd = calcMACD(cleanCloses)

    // News sentiment per day from our SQLite
    let newsSentiment: any[] = []
    const db = openDb()
    if (db) {
      try {
        newsSentiment = db.query(
          `SELECT DATE(datetime(COALESCE(publish_date, fetched_date), 'unixepoch')) as date,
                  AVG(CASE sentiment WHEN 'bullish' THEN 1 WHEN 'bearish' THEN -1 ELSE 0 END) as avg_sent,
                  COUNT(*) as count
           FROM articles
           WHERE (ticker LIKE $t OR title LIKE $t)
             AND COALESCE(publish_date, fetched_date) IS NOT NULL
           GROUP BY date ORDER BY date ASC`
        ).all({ $t: `%${ticker}%` }) as any[]
      } finally {
        db.close()
      }
    }

    return c.json({
      ticker,
      candles: valid.map((d, i) => ({
        time: d.ts, open: d.o, high: d.h, low: d.l, close: d.c, volume: d.v,
        rsi: rsi[i],
        bb_upper: bb.upper[i],
        bb_middle: bb.middle[i],
        bb_lower: bb.lower[i],
        macd: macd.macd[i],
        macd_signal: macd.signal[i],
        macd_hist: macd.hist[i],
      })),
      news_sentiment: newsSentiment,
      meta: result.meta ?? {},
      ms: t(),
    })
  } catch (e) {
    log('WARN', 'Chart fetch failed', { ticker, error: String(e) })
    return c.json({ error: String(e), ticker, ms: t() }, 500)
  }
})

// ─── Settings Routes ──────────────────────────────────────────────────────────

app.get('/api/settings/keywords', (c) => {
  const t = ms()
  const d = openDb()
  if (!d) return c.json({ keywords: [], ms: t() })
  try {
    const keywords = d.query('SELECT id, word, category, active FROM keywords ORDER BY category, word').all({})
    return c.json({ keywords, ms: t() })
  } catch { return c.json({ keywords: [], ms: t() }) } finally { d.close() }
})

app.post('/api/settings/keywords', async (c) => {
  const t = ms()
  const { word, category = 'general' } = await c.req.json()
  if (!word?.trim()) return c.json({ error: 'word is required' }, 400)
  const d = openDb(true)
  if (!d) return c.json({ error: 'Database not found' }, 404)
  try {
    d.run('INSERT OR IGNORE INTO keywords (word, category, active, created_at) VALUES (?,?,1,?)',
      [word.trim(), category.trim() || 'general', Math.floor(Date.now() / 1000)])
    invalidateKeywordCache()
    return c.json({ success: true, ms: t() })
  } catch (e) { return c.json({ error: String(e) }, 500) } finally { d.close() }
})

app.patch('/api/settings/keywords/:id', async (c) => {
  const t = ms()
  const id = +c.req.param('id')
  const { active } = await c.req.json()
  const d = openDb(true)
  if (!d) return c.json({ error: 'Database not found' }, 404)
  try { d.run('UPDATE keywords SET active=? WHERE id=?', [active ? 1 : 0, id]); invalidateKeywordCache(); return c.json({ success: true, ms: t() }) }
  finally { d.close() }
})

app.delete('/api/settings/keywords/:id', (c) => {
  const t = ms()
  const id = +c.req.param('id')
  const d = openDb(true)
  if (!d) return c.json({ error: 'Database not found' }, 404)
  try { d.run('DELETE FROM keywords WHERE id=?', [id]); invalidateKeywordCache(); return c.json({ success: true, ms: t() }) }
  finally { d.close() }
})

// GET /api/keywords/active — return the in-memory Set as an array (instant, no DB round-trip)
app.get('/api/keywords/active', (c) => {
  const t = ms()
  const kws = [...activeKeywords()]
  return c.json({ keywords: kws, count: kws.length, ms: t() })
})

app.get('/api/settings/accounts', (c) => {
  const t = ms()
  const d = openDb()
  if (!d) return c.json({ accounts: [], ms: t() })
  try {
    const accounts = d.query('SELECT id, platform, handle, active FROM watched_accounts ORDER BY platform, handle').all({})
    return c.json({ accounts, ms: t() })
  } catch { return c.json({ accounts: [], ms: t() }) } finally { d.close() }
})

app.post('/api/settings/accounts', async (c) => {
  const t = ms()
  const { platform, handle } = await c.req.json()
  if (!platform?.trim() || !handle?.trim()) return c.json({ error: 'platform and handle are required' }, 400)
  const d = openDb(true)
  if (!d) return c.json({ error: 'Database not found' }, 404)
  try {
    d.run('INSERT OR IGNORE INTO watched_accounts (platform, handle, active, created_at) VALUES (?,?,1,?)',
      [platform.trim(), handle.trim().replace(/^@/, ''), Math.floor(Date.now() / 1000)])
    return c.json({ success: true, ms: t() })
  } catch (e) { return c.json({ error: String(e) }, 500) } finally { d.close() }
})

app.patch('/api/settings/accounts/:id', async (c) => {
  const t = ms()
  const id = +c.req.param('id')
  const { active } = await c.req.json()
  const d = openDb(true)
  if (!d) return c.json({ error: 'Database not found' }, 404)
  try { d.run('UPDATE watched_accounts SET active=? WHERE id=?', [active ? 1 : 0, id]); return c.json({ success: true, ms: t() }) }
  finally { d.close() }
})

app.delete('/api/settings/accounts/:id', (c) => {
  const t = ms()
  const id = +c.req.param('id')
  const d = openDb(true)
  if (!d) return c.json({ error: 'Database not found' }, 404)
  try { d.run('DELETE FROM watched_accounts WHERE id=?', [id]); return c.json({ success: true, ms: t() }) }
  finally { d.close() }
})

// ─── Correlation Routes ───────────────────────────────────────────────────────

// GET /api/correlation — accuracy stats + breakdown
app.get('/api/correlation', (c) => {
  const t = ms()
  const d = openDb()
  if (!d) return c.json({ stats: null, breakdown: [], ms: t() })
  try {
    const window = c.req.query('window') || 'both' // '1h' | '24h' | 'both'

    // Overall accuracy
    const stats1h = d.query(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN prediction_correct_1h = 1 THEN 1 ELSE 0 END) as correct,
        SUM(CASE WHEN prediction_correct_1h = 0 THEN 1 ELSE 0 END) as incorrect
      FROM articles
      WHERE prediction_correct_1h IS NOT NULL
    `).get({}) as any

    const stats24h = d.query(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN prediction_correct_24h = 1 THEN 1 ELSE 0 END) as correct,
        SUM(CASE WHEN prediction_correct_24h = 0 THEN 1 ELSE 0 END) as incorrect
      FROM articles
      WHERE prediction_correct_24h IS NOT NULL
    `).get({}) as any

    // Per-ticker breakdown
    const breakdown = d.query(`
      SELECT
        ticker,
        company,
        COUNT(*) as total,
        SUM(CASE WHEN prediction_correct_1h = 1 THEN 1 ELSE 0 END) as correct_1h,
        SUM(CASE WHEN prediction_correct_24h = 1 THEN 1 ELSE 0 END) as correct_24h,
        AVG(CASE WHEN price_after_1h IS NOT NULL AND price_at > 0
              THEN (price_after_1h - price_at) / price_at * 100 END) as avg_move_1h_pct,
        AVG(CASE WHEN price_after_24h IS NOT NULL AND price_at > 0
              THEN (price_after_24h - price_at) / price_at * 100 END) as avg_move_24h_pct
      FROM articles
      WHERE ticker IS NOT NULL AND ticker != '' AND prediction_correct_1h IS NOT NULL
      GROUP BY ticker
      ORDER BY total DESC
      LIMIT 30
    `).all({}) as any[]

    // Pending articles (have ticker+sentiment, no price data yet)
    const pendingRow = d.query(`
      SELECT COUNT(*) as cnt FROM articles
      WHERE ticker IS NOT NULL AND ticker != '' AND sentiment IS NOT NULL AND price_at IS NULL
    `).get({}) as any

    return c.json({
      stats: {
        h1: {
          total: stats1h?.total ?? 0,
          correct: stats1h?.correct ?? 0,
          accuracy: stats1h?.total > 0 ? Math.round((stats1h.correct / stats1h.total) * 100) : null,
        },
        h24: {
          total: stats24h?.total ?? 0,
          correct: stats24h?.correct ?? 0,
          accuracy: stats24h?.total > 0 ? Math.round((stats24h.correct / stats24h.total) * 100) : null,
        },
        pending: pendingRow?.cnt ?? 0,
      },
      breakdown: breakdown.map((r: any) => ({
        ticker: r.ticker,
        company: r.company ?? null,
        total: r.total,
        accuracy_1h: r.total > 0 ? Math.round((r.correct_1h / r.total) * 100) : null,
        accuracy_24h: r.total > 0 ? Math.round((r.correct_24h / r.total) * 100) : null,
        avg_move_1h_pct: r.avg_move_1h_pct != null ? +r.avg_move_1h_pct.toFixed(2) : null,
        avg_move_24h_pct: r.avg_move_24h_pct != null ? +r.avg_move_24h_pct.toFixed(2) : null,
      })),
      ms: t(),
    })
  } catch (e) {
    return c.json({ error: String(e) }, 500)
  } finally { d.close() }
})

// POST /api/correlation/run — trigger the Python tracker
app.post('/api/correlation/run', async (c) => {
  const t = ms()
  const trackerPath = join(import.meta.dir, '..', 'flashfeed-web', 'correlation_tracker.py')
  const script = existsSync(trackerPath)
    ? trackerPath
    : join(import.meta.dir, 'correlation_tracker.py')
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

// Static files — must be last
app.use('/*', serveStatic({ root: join(import.meta.dir, 'public') }))

// ─── Background sentiment worker ──────────────────────────────────────────────
// Drains articles with NULL sentiment every 30s using FinBERT.
// Covers: articles inserted before the C++ classifier was added, and any the
// post-fetch fire-and-forget missed (service not yet ready, timeout, etc.).

async function scorePendingArticles(batchSize = 50): Promise<number> {
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

function startSentimentWorker(intervalMs = 30_000) {
  let running = false
  setInterval(async () => {
    if (running) return          // skip if previous batch still processing
    running = true
    try {
      await scorePendingArticles(50)
    } catch (e) {
      log('WARN', 'Background sentiment worker error', { reason: String(e).slice(0, 120) })
    } finally {
      running = false
    }
  }, intervalMs)
  log('INFO', `Background sentiment worker started (every ${intervalMs / 1000}s)`)
}

function startCorrelationWorker(intervalMs = 30_000) {
  let running = false
  setInterval(async () => {
    if (running) return
    running = true
    try {
      const trackerPath = join(import.meta.dir, '..', 'flashfeed-web', 'correlation_tracker.py')
      const script = existsSync(trackerPath) ? trackerPath : join(import.meta.dir, 'correlation_tracker.py')
      if (existsSync(script)) {
        const proc = Bun.spawn(['python3', script, DB], { stdout: 'pipe', stderr: 'pipe' })
        const code = await proc.exited
        if (code === 0) log('DEBUG', 'Background correlation run complete')
        else log('WARN', 'Background correlation run failed', { code })
      }
    } catch (e) {
      log('WARN', 'Background correlation worker error', { reason: String(e).slice(0, 120) })
    } finally {
      running = false
    }
  }, intervalMs)
  log('INFO', `Background correlation worker started (every ${intervalMs / 1000}s)`)
}

// ─── Start ────────────────────────────────────────────────────────────────────
migrateSentimentSchema()   // idempotent — runs every start, no-ops if already migrated (includes correlation columns)
migrateSettingsSchema()    // keywords + watched_accounts tables
stampNullSentiment()       // instantly score any articles that have no sentiment label yet

log('INFO', '─────────────────────────────────────')
log('INFO', `FlashFeed Web starting on port ${PORT}`)
log('INFO', `Root:    ${ROOT}`)
log('INFO', `Binary:  ${existsSync(BIN) ? '✓' : '✗ NOT FOUND'}  ${BIN}`)
log('INFO', `DB:      ${existsSync(DB) ? '✓' : '✗ not found'}  ${DB}`)
log('INFO', `Config:  ${CFG}`)
log('INFO', `Web log: ${WEB_LOG}`)
log('INFO', '─────────────────────────────────────')

startSentimentWorker(30_000)   // score unanalyzed articles every 30s in background
startCorrelationWorker(30_000) // check price correlation every 30 secs in background

console.log(`\n⚡ FlashFeed Web  →  http://localhost:${PORT}\n`)

export default { port: PORT, fetch: app.fetch, idleTimeout: 120 }
