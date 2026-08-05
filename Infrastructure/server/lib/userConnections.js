import { encryptSecret, decryptSecret, isEncryptedEnvelope } from './settingsCrypto.js'

// Per-user connection storage.
//
// Replaces the single shared app_settings{key:'connections'} document. One
// record per user, secrets encrypted at rest and bound to the owning account,
// so a record read out of Mongo by any route other than its owner's does not
// decrypt.
//
// Only the secret fields are encrypted. url, login and label stay readable: the
// settings UI shows them, they are not credentials, and leaving them legible
// keeps the collection debuggable without a key.

export const USER_CONNECTIONS_COLLECTION = 'user_connections'
export const CONNECTION_SECRET_FIELDS = ['token']

/** Encrypts the secret fields of a resolved connections object for one user. */
export function encryptConnections(connections, userId) {
  const out = {}
  for (const [key, row] of Object.entries(connections || {})) {
    const next = { label: row.label, url: row.url ?? '', login: row.login ?? '' }
    for (const field of CONNECTION_SECRET_FIELDS) {
      next[field] = encryptSecret(row[field], { userId, connectionKey: key, field })
    }
    out[key] = next
  }
  return out
}

/**
 * Decrypts a stored record back into plain connection rows.
 *
 * A field that will not decrypt yields '' and is reported in `errors` rather
 * than throwing, so one unreadable provider cannot take down the whole settings
 * page — and cannot be mistaken for "no token configured" either, because the
 * caller can see the difference.
 */
export function decryptConnections(stored, userId) {
  const out = {}
  const errors = []
  for (const [key, row] of Object.entries(stored || {})) {
    const next = { label: row.label, url: row.url ?? '', login: row.login ?? '' }
    for (const field of CONNECTION_SECRET_FIELDS) {
      const value = row[field]
      if (value == null) { next[field] = ''; continue }
      try {
        next[field] = decryptSecret(value, { userId, connectionKey: key, field })
      } catch (err) {
        next[field] = ''
        errors.push({ connection: key, field, error: String(err?.message || err) })
      }
    }
    out[key] = next
  }
  return { connections: out, errors }
}

/** Reads one user's record. Returns null when they have never saved one. */
export async function loadUserConnections(db, userId) {
  return db.collection(USER_CONNECTIONS_COLLECTION).findOne({ user: String(userId) })
}

export async function saveUserConnections(db, userId, connections) {
  const now = Math.floor(Date.now() / 1000)
  await db.collection(USER_CONNECTIONS_COLLECTION).updateOne(
    { user: String(userId) },
    {
      $set: { user: String(userId), value: encryptConnections(connections, userId), updated_at: now },
      $setOnInsert: { created_at: now },
    },
    { upsert: true },
  )
}

/**
 * Moves the old shared document into one user's encrypted record, once.
 *
 * Ordered so the old document is only removed after the new one has been read
 * back and every migrated secret compared against the original. A failure at
 * any point leaves the shared document exactly where it was — the migration
 * would simply run again on the next boot.
 *
 * `verifyOnly` performs every step except the delete, which is how this was
 * rehearsed against production before being allowed to remove anything.
 */
export async function migrateSharedConnections(db, { userId, verifyOnly = false, log = () => {} } = {}) {
  const shared = await db.collection('app_settings').findOne({ key: 'connections' })
  if (!shared) return { migrated: false, reason: 'no_shared_document' }
  if (!userId) return { migrated: false, reason: 'no_target_user' }

  const existing = await loadUserConnections(db, userId)
  if (existing) return { migrated: false, reason: 'target_already_has_record' }

  const source = shared.value || {}
  await saveUserConnections(db, userId, source)

  // Read back through the same path the API uses, then compare field by field.
  // Writing and trusting the write is how a migration silently loses a
  // credential; this only deletes what it has proven it can reproduce.
  const written = await loadUserConnections(db, userId)
  if (!written) return { migrated: false, reason: 'readback_missing' }
  const { connections: roundTripped, errors } = decryptConnections(written.value, userId)
  if (errors.length) return { migrated: false, reason: 'decrypt_failed', errors }

  const mismatches = []
  let secretsMoved = 0
  for (const [key, row] of Object.entries(source)) {
    for (const field of CONNECTION_SECRET_FIELDS) {
      const before = String(row?.[field] ?? '')
      const after = String(roundTripped[key]?.[field] ?? '')
      if (before !== after) mismatches.push({ connection: key, field })
      else if (before !== '') secretsMoved += 1
    }
    for (const field of ['url', 'login']) {
      if (String(row?.[field] ?? '') !== String(roundTripped[key]?.[field] ?? '')) {
        mismatches.push({ connection: key, field })
      }
    }
  }
  if (mismatches.length) return { migrated: false, reason: 'verification_mismatch', mismatches }

  if (verifyOnly) {
    log(`connections migration rehearsed for ${userId}: ${secretsMoved} secret(s) verified, shared document left in place`)
    return { migrated: false, verified: true, secretsMoved, reason: 'verify_only' }
  }

  await db.collection('app_settings').deleteOne({ key: 'connections' })
  log(`connections migrated to ${userId}: ${secretsMoved} secret(s) verified, shared document removed`)
  return { migrated: true, secretsMoved }
}

/** Ensures a stored record cannot exist twice for one user. */
export async function ensureUserConnectionsIndex(db) {
  await db.collection(USER_CONNECTIONS_COLLECTION).createIndex({ user: 1 }, { unique: true })
}

export { isEncryptedEnvelope }
