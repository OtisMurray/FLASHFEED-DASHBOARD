import crypto from 'node:crypto'

// Encryption at rest for stored connection secrets.
//
// AES-256-GCM: authenticated, so a tampered ciphertext fails loudly instead of
// decrypting to garbage that then gets sent to a provider as a credential.
//
// The key is SETTINGS_ENCRYPTION_KEY, a Railway variable, in the same shape as
// every other secret in this service. It deliberately does NOT copy
// JWT_SECRET's fallback-to-a-random-per-boot-value behaviour. A random session
// key is survivable for signing — everyone just gets logged out. For encryption
// it is destruction: the data would be written under a key that disappears on
// restart, and nothing would notice until a decrypt failed weeks later. So this
// fails closed, the same posture requireAdminTokenOrSession takes.

const ENVELOPE_VERSION = 1

/** Thrown when the key is missing or malformed, so callers can answer 503 rather than 500. */
export class SettingsKeyUnavailableError extends Error {
  constructor(message) {
    super(message)
    this.name = 'SettingsKeyUnavailableError'
    this.code = 'SETTINGS_KEY_UNAVAILABLE'
  }
}

/** Reads the key at call time so a deploy that sets the variable takes effect without a module reload. */
function activeKey() {
  const raw = String(process.env.SETTINGS_ENCRYPTION_KEY || '').trim()
  if (!raw) {
    throw new SettingsKeyUnavailableError('SETTINGS_ENCRYPTION_KEY is not set; refusing to handle connection secrets.')
  }
  const buf = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64')
  if (buf.length !== 32) {
    throw new SettingsKeyUnavailableError(
      `SETTINGS_ENCRYPTION_KEY must decode to 32 bytes for AES-256; got ${buf.length}.`,
    )
  }
  return buf
}

/**
 * Short fingerprint of the key, stored on every envelope.
 *
 * Derived from the key rather than from a hand-maintained name, so a rotation
 * is self-describing: records written under the old key keep the old tag, and a
 * mismatch is reported as "encrypted under a different key" instead of
 * surfacing as an opaque GCM authentication failure.
 */
export function keyVersion(key = activeKey()) {
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 8)
}

/**
 * Binds a ciphertext to the exact slot it belongs in. A record copied from one
 * user to another, or a token moved between providers, then fails to decrypt
 * rather than silently working.
 */
function aad(userId, connectionKey, field) {
  return Buffer.from(`${String(userId)}|${connectionKey}|${field}`, 'utf8')
}

export function isEncryptedEnvelope(value) {
  return Boolean(value) && typeof value === 'object'
    && value.v === ENVELOPE_VERSION
    && typeof value.ct === 'string' && typeof value.iv === 'string' && typeof value.tag === 'string'
}

export function encryptSecret(plaintext, { userId, connectionKey, field }) {
  const key = activeKey()
  const text = String(plaintext ?? '')
  if (text === '') return null           // an unset secret is absent, not an encryption of ''
  const iv = crypto.randomBytes(12)      // 96-bit IV, the size GCM is specified for
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(aad(userId, connectionKey, field))
  const ct = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
  return {
    v: ENVELOPE_VERSION,
    kv: keyVersion(key),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ct.toString('base64'),
  }
}

export function decryptSecret(envelope, { userId, connectionKey, field }) {
  if (envelope == null) return ''
  if (!isEncryptedEnvelope(envelope)) {
    throw new Error('Stored secret is not a recognised encrypted envelope.')
  }
  const key = activeKey()
  const current = keyVersion(key)
  if (envelope.kv && envelope.kv !== current) {
    throw new SettingsKeyUnavailableError(
      `Record was encrypted under key ${envelope.kv} but SETTINGS_ENCRYPTION_KEY is ${current}.`,
    )
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'))
  decipher.setAAD(aad(userId, connectionKey, field))
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(envelope.ct, 'base64')), decipher.final()]).toString('utf8')
}

/** True when a usable key is configured. Lets a route answer 503 before touching data. */
export function settingsKeyConfigured() {
  try {
    activeKey()
    return true
  } catch {
    return false
  }
}
