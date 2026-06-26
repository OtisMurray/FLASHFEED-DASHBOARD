import { Database } from 'bun:sqlite'
import { existsSync } from 'fs'
import { DB } from '../lib/config.ts'
import { log } from '../lib/logger.ts'

/** Run sentiment schema migrations — idempotent, silently skips existing columns/tables */
export function migrateSentimentSchema() {
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

/** Migrate keywords + watched_accounts tables into feedflash.db */
export function migrateSettingsSchema() {
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
