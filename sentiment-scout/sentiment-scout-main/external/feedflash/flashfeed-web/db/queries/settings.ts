import { openDb } from '../index.ts'
import { invalidateKeywordCache } from '../../lib/helpers.ts'

// ─── Keywords CRUD ────────────────────────────────────────────────────────────

export function getKeywords(): any[] {
  const d = openDb()
  if (!d) return []
  try {
    return d.query('SELECT id, word, category, active FROM keywords ORDER BY category, word').all({})
  } catch { return [] } finally { d.close() }
}

export function addKeyword(word: string, category: string): void {
  const d = openDb(true)
  if (!d) throw new Error('Database not found')
  try {
    d.run('INSERT OR IGNORE INTO keywords (word, category, active, created_at) VALUES (?,?,1,?)',
      [word.trim(), category.trim() || 'general', Math.floor(Date.now() / 1000)])
    invalidateKeywordCache()
  } finally { d.close() }
}

export function updateKeyword(id: number, active: boolean): void {
  const d = openDb(true)
  if (!d) throw new Error('Database not found')
  try { d.run('UPDATE keywords SET active=? WHERE id=?', [active ? 1 : 0, id]); invalidateKeywordCache() }
  finally { d.close() }
}

export function deleteKeyword(id: number): void {
  const d = openDb(true)
  if (!d) throw new Error('Database not found')
  try { d.run('DELETE FROM keywords WHERE id=?', [id]); invalidateKeywordCache() }
  finally { d.close() }
}

// ─── Accounts CRUD ────────────────────────────────────────────────────────────

export function getAccounts(): any[] {
  const d = openDb()
  if (!d) return []
  try {
    return d.query('SELECT id, platform, handle, active FROM watched_accounts ORDER BY platform, handle').all({})
  } catch { return [] } finally { d.close() }
}

export function addAccount(platform: string, handle: string): void {
  const d = openDb(true)
  if (!d) throw new Error('Database not found')
  try {
    d.run('INSERT OR IGNORE INTO watched_accounts (platform, handle, active, created_at) VALUES (?,?,1,?)',
      [platform.trim(), handle.trim().replace(/^@/, ''), Math.floor(Date.now() / 1000)])
  } finally { d.close() }
}

export function updateAccount(id: number, active: boolean): void {
  const d = openDb(true)
  if (!d) throw new Error('Database not found')
  try { d.run('UPDATE watched_accounts SET active=? WHERE id=?', [active ? 1 : 0, id]) }
  finally { d.close() }
}

export function deleteAccount(id: number): void {
  const d = openDb(true)
  if (!d) throw new Error('Database not found')
  try { d.run('DELETE FROM watched_accounts WHERE id=?', [id]) }
  finally { d.close() }
}
