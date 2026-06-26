// ─────────────────────────────────────────────────────────────────────────────
//  diskdb.js — Hard-disk (persistent) news database for FlashFeed
// ─────────────────────────────────────────────────────────────────────────────
//  The on-DISK companion to the RAM layer (Redis). Redis holds the hot feed in
//  memory with zero disk I/O; this module persists news to a real SQLite file on
//  the local hard disk so it survives restarts AND enforces per-bucket retention
//  with automatic deletion.
//
//  SQLite backend, in priority order (no native build required on Node ≥ 22.5):
//    1. node:sqlite  (DatabaseSync) — built into Node 22+, zero dependencies
//    2. better-sqlite3 — native module fallback for older Node
//
//  Three buckets, each with its own retention window:
//    • manual — "Save 3 days" button / on-exit beacon.                3 days
//    • auto   — background auto-grabber while you are AWAY.            2 days
//    • fetch  — the Redis+Kafka fetch path, on every refresh.         3 days
//
//  A sweeper runs on an interval (and once at boot) and hard-deletes any row
//  whose expires_at has passed. The module degrades gracefully: if no SQLite
//  backend loads, or DISK_DB_ENABLED=false, every operation becomes a safe no-op
//  and the rest of the server is unaffected.
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const ENABLED = process.env.DISK_DB_ENABLED !== 'false'

// Retention windows (days). 0 ⇒ keep forever (no expiry).
const TTL_DAYS = {
  manual: Number(process.env.DISK_TTL_MANUAL_DAYS ?? 3),
  auto:   Number(process.env.DISK_TTL_AUTO_DAYS   ?? 2),
  fetch:  Number(process.env.DISK_TTL_FETCH_DAYS  ?? 3),
}

const DAY_MS = 86_400_000
const SWEEP_INTERVAL_MS = Number(process.env.DISK_SWEEP_INTERVAL_MS || 10 * 60 * 1000) // 10 min

const DEFAULT_DB_PATH = path.join(process.cwd(), 'data', 'feedflash_disk.db')
const DB_PATH = process.env.DISK_DB_PATH || DEFAULT_DB_PATH

let db = null            // SQLite handle (or null if unavailable)
let backend = null       // 'node:sqlite' | 'better-sqlite3'
let available = false
let sweepTimer = null
let lastSweepAt = null
let lastSweepDeleted = 0

// ── Helpers ──────────────────────────────────────────────────────────────────
function dedupKey(row) {
  const basis = (row.url && String(row.url).trim())
    ? String(row.url).trim().toLowerCase()
    : `${(row.ticker || '').toUpperCase()}|${(row.title || '').trim().toLowerCase()}`
  return crypto.createHash('sha1').update(basis).digest('hex').slice(0, 24)
}
function ttlMsFor(bucket) {
  const days = TTL_DAYS[bucket]
  return (days && days > 0) ? days * DAY_MS : null   // null ⇒ never expires
}

// Open the best available SQLite backend.
async function open(dbPath) {
  // 1. Node's built-in SQLite (no native build).
  try {
    const { DatabaseSync } = await import('node:sqlite')
    const handle = new DatabaseSync(dbPath)
    backend = 'node:sqlite'
    return handle
  } catch (_) { /* fall through */ }
  // 2. better-sqlite3 native fallback.
  try {
    const mod = await import('better-sqlite3')
    const Database = mod.default || mod
    const handle = new Database(dbPath)
    backend = 'better-sqlite3'
    return handle
  } catch (e) {
    throw new Error('no SQLite backend (node:sqlite unavailable and better-sqlite3 not installed): ' + e.message)
  }
}

// ── Init ─────────────────────────────────────────────────────────────────────
export async function init() {
  if (!ENABLED) { console.log('  DiskDB  →  disabled (DISK_DB_ENABLED=false)'); return false }
  try {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true })
    db = await open(DB_PATH)
    try { db.exec('PRAGMA journal_mode = WAL'); db.exec('PRAGMA synchronous = NORMAL') } catch (_) {}
    db.exec(`
      CREATE TABLE IF NOT EXISTS news_disk (
        uid             TEXT PRIMARY KEY,
        bucket          TEXT NOT NULL,
        ticker          TEXT,
        title           TEXT,
        source          TEXT,
        url             TEXT,
        summary         TEXT,
        sentiment       TEXT,
        sentiment_score REAL,
        published_at    INTEGER,
        stored_at       INTEGER NOT NULL,
        expires_at      INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_disk_bucket_exp ON news_disk(bucket, expires_at);
      CREATE INDEX IF NOT EXISTS idx_disk_ticker     ON news_disk(ticker);
      CREATE INDEX IF NOT EXISTS idx_disk_stored     ON news_disk(stored_at);
    `)
    available = true
    const deleted = sweep()
    sweepTimer = setInterval(sweep, SWEEP_INTERVAL_MS)
    if (sweepTimer.unref) sweepTimer.unref()
    console.log(`  DiskDB  →  hard-disk store ready via ${backend} @ ${DB_PATH} (manual ${TTL_DAYS.manual}d · auto ${TTL_DAYS.auto}d · fetch ${TTL_DAYS.fetch}d; swept ${deleted} stale)`)
    return true
  } catch (e) {
    console.warn('  DiskDB  →  hard-disk persistence OFF:', e.message)
    available = false; db = null
    return false
  }
}

export function isEnabled() { return ENABLED && available && !!db }
export function backendName() { return backend }

// ── Write ────────────────────────────────────────────────────────────────────
export function storeNews(rows, bucket = 'manual') {
  if (!isEnabled() || !Array.isArray(rows) || rows.length === 0) return { stored: 0, bucket }
  const now = Date.now()
  const ttl = ttlMsFor(bucket)
  const expires = ttl == null ? null : now + ttl
  const stmt = db.prepare(`
    INSERT INTO news_disk
      (uid, bucket, ticker, title, source, url, summary, sentiment, sentiment_score, published_at, stored_at, expires_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(uid) DO UPDATE SET
      ticker=excluded.ticker, title=excluded.title, source=excluded.source, url=excluded.url,
      summary=excluded.summary, sentiment=excluded.sentiment, sentiment_score=excluded.sentiment_score,
      published_at=excluded.published_at
  `)
  // NOTE: stored_at / expires_at are intentionally NOT updated on conflict. Re-grabbing
  // the same article (the 20-min on-site auto-fetch re-sees everything in the 3-day
  // window) refreshes its content but must NOT extend its retention clock — otherwise a
  // frequently-re-seen article would never hit its "delete after N days" deadline.
  let stored = 0
  try {
    db.exec('BEGIN')
    for (const r of rows) {
      stmt.run(
        `${bucket}:${dedupKey(r)}`,
        bucket,
        (r.ticker || '').toString().toUpperCase() || null,
        r.title ?? null,
        r.source ?? null,
        r.url ?? null,
        r.summary ?? null,
        r.sentiment ?? null,
        (r.sentiment_score === undefined || r.sentiment_score === null) ? null : Number(r.sentiment_score),
        (r.published_at === undefined || r.published_at === null) ? null : Math.floor(Number(r.published_at)),
        now,
        expires,
      )
      stored += 1
    }
    db.exec('COMMIT')
  } catch (e) {
    try { db.exec('ROLLBACK') } catch (_) {}
    console.warn('DiskDB storeNews error:', e.message)
    stored = 0
  }
  return { stored, bucket, expires_at: expires }
}

// ── Read ─────────────────────────────────────────────────────────────────────
export function listNews({ bucket, ticker, limit = 200 } = {}) {
  if (!isEnabled()) return []
  const where = []
  const args = []
  if (bucket) { where.push('bucket = ?'); args.push(bucket) }
  if (ticker) { where.push('ticker = ?'); args.push(ticker.toUpperCase()) }
  const lim = Math.max(1, Math.min(5000, Number(limit) || 200))
  const sql = `SELECT ticker, title, source, url, summary, sentiment, sentiment_score,
                      published_at, stored_at, expires_at, bucket
               FROM news_disk
               ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY COALESCE(published_at, stored_at/1000) DESC
               LIMIT ?`
  try { return db.prepare(sql).all(...args, lim) }
  catch (e) { console.warn('DiskDB listNews error:', e.message); return [] }
}

export function recentForExport(days = 3, bucket = null) {
  if (!isEnabled()) return []
  const cutoff = Date.now() - Math.max(1, Number(days) || 3) * DAY_MS
  const args = [cutoff]
  let bucketClause = ''
  if (bucket) { bucketClause = 'AND bucket = ?'; args.push(bucket) }
  const sql = `SELECT ticker, title, source, url, summary, sentiment, sentiment_score,
                      published_at, stored_at, expires_at, bucket
               FROM news_disk
               WHERE stored_at >= ? ${bucketClause}
               ORDER BY COALESCE(published_at, stored_at/1000) DESC
               LIMIT 10000`
  try { return db.prepare(sql).all(...args) }
  catch (e) { console.warn('DiskDB export error:', e.message); return [] }
}

// ── Sweep (auto-delete expired) ──────────────────────────────────────────────
export function sweep() {
  if (!isEnabled()) return 0
  try {
    const info = db.prepare('DELETE FROM news_disk WHERE expires_at IS NOT NULL AND expires_at < ?').run(Date.now())
    lastSweepAt = Date.now()
    lastSweepDeleted = Number(info.changes || 0)
    return lastSweepDeleted
  } catch (e) { console.warn('DiskDB sweep error:', e.message); return 0 }
}

export function clearBucket(bucket) {
  if (!isEnabled() || !bucket) return 0
  try { return Number(db.prepare('DELETE FROM news_disk WHERE bucket = ?').run(bucket).changes || 0) }
  catch (e) { console.warn('DiskDB clearBucket error:', e.message); return 0 }
}

// ── Stats ────────────────────────────────────────────────────────────────────
export function stats() {
  const base = {
    enabled: ENABLED,
    available: isEnabled(),
    backend,
    path: DB_PATH,
    retention_days: { ...TTL_DAYS },
    sweep_interval_sec: Math.round(SWEEP_INTERVAL_MS / 1000),
    last_sweep_at: lastSweepAt,
    last_sweep_deleted: lastSweepDeleted,
    db_size_bytes: 0,
    total: 0,
    by_bucket: { manual: 0, auto: 0, fetch: 0 },
    oldest_stored_at: null,
    newest_stored_at: null,
  }
  if (!isEnabled()) return base
  try {
    for (const r of db.prepare('SELECT bucket, COUNT(*) AS c FROM news_disk GROUP BY bucket').all()) {
      base.by_bucket[r.bucket] = Number(r.c); base.total += Number(r.c)
    }
    const span = db.prepare('SELECT MIN(stored_at) AS lo, MAX(stored_at) AS hi FROM news_disk').get()
    base.oldest_stored_at = span?.lo ?? null
    base.newest_stored_at = span?.hi ?? null
    try { base.db_size_bytes = fs.statSync(DB_PATH).size } catch (_) {}
  } catch (e) { console.warn('DiskDB stats error:', e.message) }
  return base
}

export function close() {
  try { if (sweepTimer) clearInterval(sweepTimer) } catch (_) {}
  try { if (db) db.close() } catch (_) {}
  db = null; available = false
}
