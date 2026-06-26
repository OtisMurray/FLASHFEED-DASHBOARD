import { Database } from 'bun:sqlite'
import { existsSync } from 'fs'
import { DB } from '../lib/config.ts'

/** Open the SQLite database (read-only by default) */
export function openDb(write = false): Database | null {
  if (!existsSync(DB)) return null
  return write
    ? new Database(DB)                       // read-write (default, no options)
    : new Database(DB, { readonly: true })   // read-only
}

/** Alias for openDb(true) */
export function openDbWrite(): Database | null {
  return openDb(true)
}
