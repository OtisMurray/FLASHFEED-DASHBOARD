import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import {
  encryptSecret, decryptSecret, keyVersion, isEncryptedEnvelope,
  settingsKeyConfigured, SettingsKeyUnavailableError,
} from '../lib/settingsCrypto.js'

const KEY_A = crypto.randomBytes(32).toString('hex')
const KEY_B = crypto.randomBytes(32).toString('hex')
const SLOT = { userId: '6a6e94768aab52933d265489', connectionKey: 'finviz', field: 'token' }
const OTHER_USER = { ...SLOT, userId: '6a6e93d537b3c47cc99b7cb4' }

function withKey(key, fn) {
  const prev = process.env.SETTINGS_ENCRYPTION_KEY
  if (key === undefined) delete process.env.SETTINGS_ENCRYPTION_KEY
  else process.env.SETTINGS_ENCRYPTION_KEY = key
  try { return fn() } finally {
    if (prev === undefined) delete process.env.SETTINGS_ENCRYPTION_KEY
    else process.env.SETTINGS_ENCRYPTION_KEY = prev
  }
}

test('round-trips a real-shaped Finviz token', () => {
  withKey(KEY_A, () => {
    const token = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeee8c1c'   // 36 chars, the production shape
    const env = encryptSecret(token, SLOT)
    assert.notEqual(env.ct, token)
    assert.ok(!JSON.stringify(env).includes(token), 'plaintext must not survive anywhere in the envelope')
    assert.equal(decryptSecret(env, SLOT), token)
  })
})

test('every encryption is unique — the IV is not reused', () => {
  withKey(KEY_A, () => {
    const a = encryptSecret('same-secret', SLOT)
    const b = encryptSecret('same-secret', SLOT)
    assert.notEqual(a.iv, b.iv)
    assert.notEqual(a.ct, b.ct)
    assert.equal(decryptSecret(a, SLOT), decryptSecret(b, SLOT))
  })
})

test('an empty secret is stored as absent, not as an encryption of ""', () => {
  withKey(KEY_A, () => {
    assert.equal(encryptSecret('', SLOT), null)
    assert.equal(encryptSecret(null, SLOT), null)
    assert.equal(encryptSecret(undefined, SLOT), null)
    assert.equal(decryptSecret(null, SLOT), '')
  })
})

test('the key-version tag is present and derived from the key', () => {
  withKey(KEY_A, () => {
    const env = encryptSecret('x', SLOT)
    assert.equal(env.kv, keyVersion(Buffer.from(KEY_A, 'hex')))
    assert.match(env.kv, /^[0-9a-f]{8}$/)
  })
  withKey(KEY_B, () => {
    assert.notEqual(keyVersion(Buffer.from(KEY_B, 'hex')), keyVersion(Buffer.from(KEY_A, 'hex')))
  })
})

test('a record encrypted under another key is named, not an opaque auth failure', () => {
  const env = withKey(KEY_A, () => encryptSecret('secret', SLOT))
  withKey(KEY_B, () => {
    assert.throws(() => decryptSecret(env, SLOT), (err) => {
      assert.ok(err instanceof SettingsKeyUnavailableError)
      assert.match(err.message, /encrypted under key/)
      return true
    })
  })
})

test('ISOLATION: one user cannot decrypt another user\'s record', () => {
  withKey(KEY_A, () => {
    const env = encryptSecret('admins-finviz-token', SLOT)
    // Same key, same collection — only the bound user id differs.
    assert.throws(() => decryptSecret(env, OTHER_USER), /unable to authenticate|Unsupported state/i)
  })
})

test('ISOLATION: a secret cannot be moved between providers', () => {
  withKey(KEY_A, () => {
    const env = encryptSecret('finviz-token', SLOT)
    assert.throws(() => decryptSecret(env, { ...SLOT, connectionKey: 'tradingview' }), /unable to authenticate|Unsupported state/i)
  })
})

test('ISOLATION: a secret cannot be moved between fields', () => {
  withKey(KEY_A, () => {
    const env = encryptSecret('finviz-token', SLOT)
    assert.throws(() => decryptSecret(env, { ...SLOT, field: 'login' }), /unable to authenticate|Unsupported state/i)
  })
})

test('tampered ciphertext is rejected rather than decrypted', () => {
  withKey(KEY_A, () => {
    const env = encryptSecret('secret-value', SLOT)
    const bytes = Buffer.from(env.ct, 'base64')
    bytes[0] ^= 0xff
    assert.throws(() => decryptSecret({ ...env, ct: bytes.toString('base64') }, SLOT), /unable to authenticate|Unsupported state/i)
  })
})

test('a tampered auth tag is rejected', () => {
  withKey(KEY_A, () => {
    const env = encryptSecret('secret-value', SLOT)
    const tag = Buffer.from(env.tag, 'base64')
    tag[0] ^= 0xff
    assert.throws(() => decryptSecret({ ...env, tag: tag.toString('base64') }, SLOT), /unable to authenticate|Unsupported state/i)
  })
})

test('FAIL CLOSED: no key means refusal, never plaintext', () => {
  withKey(undefined, () => {
    assert.equal(settingsKeyConfigured(), false)
    assert.throws(() => encryptSecret('x', SLOT), SettingsKeyUnavailableError)
    assert.throws(() => decryptSecret({ v: 1, kv: 'aaaaaaaa', iv: 'x', tag: 'y', ct: 'z' }, SLOT), SettingsKeyUnavailableError)
  })
})

test('FAIL CLOSED: a wrong-length key is refused rather than padded', () => {
  withKey('abcd', () => {
    assert.equal(settingsKeyConfigured(), false)
    assert.throws(() => encryptSecret('x', SLOT), /32 bytes/)
  })
})

test('a base64 key of the right length is accepted', () => {
  withKey(crypto.randomBytes(32).toString('base64'), () => {
    assert.equal(settingsKeyConfigured(), true)
    assert.equal(decryptSecret(encryptSecret('via-base64', SLOT), SLOT), 'via-base64')
  })
})

test('plaintext left over from before the migration is not mistaken for an envelope', () => {
  assert.equal(isEncryptedEnvelope('a-raw-token-string'), false)
  assert.equal(isEncryptedEnvelope(null), false)
  assert.equal(isEncryptedEnvelope({ ct: 'x' }), false)
  withKey(KEY_A, () => {
    assert.throws(() => decryptSecret('a-raw-token-string', SLOT), /not a recognised encrypted envelope/)
  })
})
