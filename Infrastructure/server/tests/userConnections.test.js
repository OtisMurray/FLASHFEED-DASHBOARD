import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { MongoClient } from 'mongodb'
import {
  encryptConnections, decryptConnections, loadUserConnections, saveUserConnections,
  migrateSharedConnections, USER_CONNECTIONS_COLLECTION,
} from '../lib/userConnections.js'

// The migration moves a real credential and then deletes its only other copy,
// so the ordering guarantees are tested against a real MongoDB rather than a
// stand-in. Skips when none is reachable, matching socialTickerCandidates.
const URI = process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://localhost:27017'
const DB = 'feedflash_user_connections_probe'
const ADMIN = '6a6e94768aab52933d265489'
const OTHER = '6a6e93d537b3c47cc99b7cb4'
process.env.SETTINGS_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex')

// The production shape, as read from app_settings on 2026-08-05.
const SHARED = {
  finviz: { label: 'Finviz Elite', url: 'https://elite.finviz.com/export', login: '', token: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeee8c1c' },
  tradingview: { label: 'TradingView', url: 'https://www.tradingview.com', login: '', token: '' },
  td_ameritrade: { label: 'TD Ameritrade / Schwab', url: '', login: '', token: '' },
  interactive_brokers: { label: 'Interactive Brokers', url: '', login: '', token: '' },
}

async function withDb(fn) {
  let client
  try {
    client = await MongoClient.connect(URI, { serverSelectionTimeoutMS: 1500 })
    await client.db(DB).command({ ping: 1 })
  } catch {
    try { await client?.close() } catch { /* nothing to close */ }
    return null
  }
  const db = client.db(DB)
  try {
    await db.collection('app_settings').deleteMany({})
    await db.collection(USER_CONNECTIONS_COLLECTION).deleteMany({})
    return await fn(db)
  } finally {
    await db.dropDatabase().catch(() => {})
    await client.close()
  }
}

test('secrets are ciphertext at rest, never the raw token', async t => {
  const out = await withDb(async db => {
    await saveUserConnections(db, ADMIN, SHARED)
    return loadUserConnections(db, ADMIN)
  })
  if (out === null) return t.skip('no MongoDB reachable')
  const asText = JSON.stringify(out)
  assert.ok(!asText.includes(SHARED.finviz.token), 'raw token found in the stored document')
  assert.equal(typeof out.value.finviz.token.ct, 'string')
  assert.match(out.value.finviz.token.kv, /^[0-9a-f]{8}$/)
  // Non-secret fields stay readable so the collection can be inspected.
  assert.equal(out.value.finviz.url, 'https://elite.finviz.com/export')
})

test('a saved record round-trips through the read path', async t => {
  const out = await withDb(async db => {
    await saveUserConnections(db, ADMIN, SHARED)
    const row = await loadUserConnections(db, ADMIN)
    return decryptConnections(row.value, ADMIN)
  })
  if (out === null) return t.skip('no MongoDB reachable')
  assert.deepEqual(out.errors, [])
  assert.equal(out.connections.finviz.token, SHARED.finviz.token)
  assert.equal(out.connections.tradingview.token, '')
})

test('ISOLATION: another user cannot read the admin record', async t => {
  const out = await withDb(async db => {
    await saveUserConnections(db, ADMIN, SHARED)
    const row = await loadUserConnections(db, ADMIN)
    return { asOther: decryptConnections(row.value, OTHER), otherRecord: await loadUserConnections(db, OTHER) }
  })
  if (out === null) return t.skip('no MongoDB reachable')
  // The other user has no record of their own...
  assert.equal(out.otherRecord, null)
  // ...and reading the admin's bytes under their id yields nothing usable.
  assert.equal(out.asOther.connections.finviz.token, '')
  assert.ok(out.asOther.errors.length > 0, 'cross-user decrypt must be reported as an error')
})

test('MIGRATION: moves the secret and only then removes the shared document', async t => {
  const out = await withDb(async db => {
    await db.collection('app_settings').insertOne({ key: 'connections', value: SHARED, updated_at: 1785939619 })
    const result = await migrateSharedConnections(db, { userId: ADMIN })
    const row = await loadUserConnections(db, ADMIN)
    return {
      result,
      decrypted: decryptConnections(row.value, ADMIN),
      sharedLeft: await db.collection('app_settings').countDocuments({ key: 'connections' }),
    }
  })
  if (out === null) return t.skip('no MongoDB reachable')
  assert.equal(out.result.migrated, true)
  assert.equal(out.result.secretsMoved, 1)
  assert.equal(out.decrypted.connections.finviz.token, SHARED.finviz.token, 'the real credential must survive the move')
  assert.equal(out.decrypted.connections.finviz.url, SHARED.finviz.url)
  assert.equal(out.sharedLeft, 0, 'shared document should be gone once verified')
})

test('MIGRATION: verifyOnly proves the move without deleting anything', async t => {
  const out = await withDb(async db => {
    await db.collection('app_settings').insertOne({ key: 'connections', value: SHARED })
    const result = await migrateSharedConnections(db, { userId: ADMIN, verifyOnly: true })
    return { result, sharedLeft: await db.collection('app_settings').countDocuments({ key: 'connections' }) }
  })
  if (out === null) return t.skip('no MongoDB reachable')
  assert.equal(out.result.migrated, false)
  assert.equal(out.result.verified, true)
  assert.equal(out.result.secretsMoved, 1)
  assert.equal(out.sharedLeft, 1, 'a rehearsal must leave the original in place')
})

test('MIGRATION: is idempotent — a second run will not clobber a live record', async t => {
  const out = await withDb(async db => {
    await db.collection('app_settings').insertOne({ key: 'connections', value: SHARED })
    await migrateSharedConnections(db, { userId: ADMIN })
    // A later save the admin made through the UI.
    await saveUserConnections(db, ADMIN, { ...SHARED, finviz: { ...SHARED.finviz, token: 'rotated-token-value' } })
    await db.collection('app_settings').insertOne({ key: 'connections', value: SHARED })
    const second = await migrateSharedConnections(db, { userId: ADMIN })
    const row = await loadUserConnections(db, ADMIN)
    return { second, token: decryptConnections(row.value, ADMIN).connections.finviz.token }
  })
  if (out === null) return t.skip('no MongoDB reachable')
  assert.equal(out.second.migrated, false)
  assert.equal(out.second.reason, 'target_already_has_record')
  assert.equal(out.token, 'rotated-token-value', 'a re-run must not overwrite a newer credential')
})

test('MIGRATION: nothing to do is not an error', async t => {
  const out = await withDb(async db => migrateSharedConnections(db, { userId: ADMIN }))
  if (out === null) return t.skip('no MongoDB reachable')
  assert.equal(out.migrated, false)
  assert.equal(out.reason, 'no_shared_document')
})

test('encryptConnections leaves url and login legible', () => {
  const enc = encryptConnections(SHARED, ADMIN)
  assert.equal(enc.finviz.url, SHARED.finviz.url)
  assert.equal(enc.finviz.login, '')
  assert.notEqual(enc.finviz.token, SHARED.finviz.token)
  assert.equal(enc.tradingview.token, null, 'an unset secret stays absent rather than becoming ciphertext')
})
