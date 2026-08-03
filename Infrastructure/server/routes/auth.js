import { Router } from 'express'
import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import User from '../models/User.js'
import ApiKey from '../models/ApiKey.js'
import { sendTwoFactorCodeEmail, mailerReady } from '../mailer.js'
import { sendTwoFactorCodeSms, smsReady } from '../smsSender.js'

const router = Router()

// Signing secret for both the short-lived "pending 2FA" token and the real
// session cookie. Falls back to a per-boot random secret so the server never
// crashes on a missing env var — but that means every restart invalidates
// existing sessions, so JWT_SECRET should be set on Railway for real use.
const JWT_SECRET = process.env.JWT_SECRET || (() => {
  console.warn('  Auth    →  JWT_SECRET not set; using a random per-boot secret (sessions won\'t survive a restart)')
  return crypto.randomBytes(48).toString('hex')
})()

const SESSION_COOKIE = 'ff_session'
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000       // 7 days
const PENDING_TTL_MS = 10 * 60 * 1000                 // 10 minutes to enter the code
const TWO_FACTOR_TTL_MS = 10 * 60 * 1000               // code itself expires with the pending token
const MAX_TWO_FACTOR_ATTEMPTS = 5
const RESEND_COOLDOWN_MS = 20 * 1000

// Email 2FA is off by default until Gmail SMTP is actually configured and
// working — set AUTH_REQUIRE_2FA=true once GMAIL_APP_PASSWORD is live to turn
// the code-email step back on. Login still checks the password either way.
const REQUIRE_2FA = String(process.env.AUTH_REQUIRE_2FA || 'false').toLowerCase() === 'true'

const publicUser = (u) => ({ username: u.username, email: u.email, role: u.role })

function makeEightDigitCode() {
  return String(Math.floor(10_000_000 + Math.random() * 90_000_000))
}

function setSessionCookie(res, user) {
  const token = jwt.sign({ sub: String(user._id), purpose: 'session' }, JWT_SECRET, { expiresIn: SESSION_TTL_MS / 1000 })
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: SESSION_TTL_MS,
  })
}

// POST /api/auth/register — { username, email, password }
router.post('/register', async (req, res) => {
  try {
    const username = String(req.body?.username || '').trim()
    const email = String(req.body?.email || '').trim().toLowerCase()
    const password = String(req.body?.password || '')
    if (!username || !email || !password) return res.status(400).json({ ok: false, error: 'Username, email, and password are required.' })
    if (password.length < 8) return res.status(400).json({ ok: false, error: 'Password must be at least 8 characters.' })
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ ok: false, error: 'Enter a valid email address.' })

    const passwordHash = await bcrypt.hash(password, 12)
    const user = await User.create({ username, email, passwordHash, role: 'user' })
    res.status(201).json({ ok: true, message: 'Account created — you can log in now.', user: publicUser(user) })
  } catch (err) {
    if (err?.code === 11000) return res.status(409).json({ ok: false, error: 'That username or email is already registered.' })
    console.error('POST /api/auth/register failed:', err)
    res.status(500).json({ ok: false, error: 'Could not create the account.' })
  }
})

// POST /api/auth/login — { usernameOrEmail, password } → emails an 8-digit code, returns a pending token
router.post('/login', async (req, res) => {
  try {
    const identifier = String(req.body?.usernameOrEmail || '').trim()
    const password = String(req.body?.password || '')
    if (!identifier || !password) return res.status(400).json({ ok: false, error: 'Username/email and password are required.' })

    const user = await User.findOne({
      $or: [
        { username: new RegExp(`^${identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
        { email: identifier.toLowerCase() },
      ],
    })
    // Same generic error whether the account doesn't exist or the password is
    // wrong — don't let a login attempt reveal which accounts exist.
    const invalid = () => res.status(401).json({ ok: false, error: 'Invalid username/email or password.' })
    if (!user) return invalid()
    const passwordOk = await bcrypt.compare(password, user.passwordHash)
    if (!passwordOk) return invalid()

    if (!REQUIRE_2FA) {
      user.lastLoginAt = new Date()
      await user.save()
      setSessionCookie(res, user)
      return res.json({ ok: true, user: publicUser(user) })
    }

    const code = makeEightDigitCode()
    user.twoFactorCodeHash = await bcrypt.hash(code, 10)
    user.twoFactorExpiresAt = new Date(Date.now() + TWO_FACTOR_TTL_MS)
    user.twoFactorAttempts = 0
    await user.save()

    let deliveryMessage
    try {
      deliveryMessage = await deliverTwoFactorCode(user, code)
    } catch (sendErr) {
      console.error('2FA code send failed:', sendErr.message)
      return res.status(503).json({ ok: false, error: `Could not send the verification code: ${sendErr.message}` })
    }

    const pendingToken = jwt.sign({ sub: String(user._id), purpose: '2fa' }, JWT_SECRET, { expiresIn: PENDING_TTL_MS / 1000 })
    res.json({ ok: true, pendingToken, message: deliveryMessage })
  } catch (err) {
    console.error('POST /api/auth/login failed:', err)
    res.status(500).json({ ok: false, error: 'Login failed.' })
  }
})

function maskEmail(email) {
  const [name, domain] = String(email).split('@')
  if (!domain) return email
  const visible = name.slice(0, Math.min(2, name.length))
  return `${visible}${'*'.repeat(Math.max(1, name.length - visible.length))}@${domain}`
}

function maskPhone(phone) {
  const digits = String(phone || '')
  return digits.length > 4 ? `${'*'.repeat(digits.length - 4)}${digits.slice(-4)}` : digits
}

// Delivers the code over whichever channel the account prefers. Throws with a
// clear, user-facing reason if that channel isn't actually configured yet
// (e.g. twoFactorMethod is 'sms' but Twilio credentials aren't set) rather
// than silently falling back to a channel the user didn't choose.
async function deliverTwoFactorCode(user, code) {
  if (user.twoFactorMethod === 'sms') {
    if (!user.phone) throw new Error('No phone number on file for SMS codes — add one or switch to email.')
    await sendTwoFactorCodeSms(user.phone, code)
    return `We texted an 8-digit code to ${maskPhone(user.phone)}.`
  }
  await sendTwoFactorCodeEmail(user.email, code)
  return `We emailed an 8-digit code to ${maskEmail(user.email)}.`
}

async function userFromPendingToken(pendingToken) {
  const payload = jwt.verify(pendingToken, JWT_SECRET)
  if (payload.purpose !== '2fa') throw new Error('bad token purpose')
  const user = await User.findById(payload.sub)
  if (!user || !user.twoFactorCodeHash || !user.twoFactorExpiresAt) throw new Error('no pending 2fa')
  if (user.twoFactorExpiresAt.getTime() < Date.now()) throw new Error('expired')
  return user
}

// POST /api/auth/verify-2fa — { pendingToken, code }
router.post('/verify-2fa', async (req, res) => {
  try {
    const pendingToken = String(req.body?.pendingToken || '')
    const code = String(req.body?.code || '').trim()
    if (!pendingToken || !code) return res.status(400).json({ ok: false, error: 'Code is required.' })

    let user
    try {
      user = await userFromPendingToken(pendingToken)
    } catch (_) {
      return res.status(401).json({ ok: false, error: 'Your code expired — please log in again.' })
    }

    if (user.twoFactorAttempts >= MAX_TWO_FACTOR_ATTEMPTS) {
      user.twoFactorCodeHash = null
      user.twoFactorExpiresAt = null
      await user.save()
      return res.status(429).json({ ok: false, error: 'Too many attempts — please log in again.' })
    }

    const codeOk = await bcrypt.compare(code, user.twoFactorCodeHash)
    if (!codeOk) {
      user.twoFactorAttempts += 1
      await user.save()
      return res.status(400).json({ ok: false, error: 'Incorrect code.' })
    }

    user.twoFactorCodeHash = null
    user.twoFactorExpiresAt = null
    user.twoFactorAttempts = 0
    user.lastLoginAt = new Date()
    await user.save()

    setSessionCookie(res, user)
    res.json({ ok: true, user: publicUser(user) })
  } catch (err) {
    console.error('POST /api/auth/verify-2fa failed:', err)
    res.status(500).json({ ok: false, error: 'Verification failed.' })
  }
})

// POST /api/auth/resend-2fa — { pendingToken }
router.post('/resend-2fa', async (req, res) => {
  try {
    const pendingToken = String(req.body?.pendingToken || '')
    let user
    try {
      user = await userFromPendingToken(pendingToken)
    } catch (_) {
      return res.status(401).json({ ok: false, error: 'Your session expired — please log in again.' })
    }

    const sentAgeMs = user.twoFactorExpiresAt ? TWO_FACTOR_TTL_MS - (user.twoFactorExpiresAt.getTime() - Date.now()) : Infinity
    if (sentAgeMs < RESEND_COOLDOWN_MS) {
      return res.status(429).json({ ok: false, error: 'Please wait a few seconds before requesting another code.' })
    }

    const code = makeEightDigitCode()
    user.twoFactorCodeHash = await bcrypt.hash(code, 10)
    user.twoFactorExpiresAt = new Date(Date.now() + TWO_FACTOR_TTL_MS)
    user.twoFactorAttempts = 0
    await user.save()

    const deliveryMessage = await deliverTwoFactorCode(user, code)
    res.json({ ok: true, message: deliveryMessage })
  } catch (err) {
    console.error('POST /api/auth/resend-2fa failed:', err)
    res.status(500).json({ ok: false, error: 'Could not resend the code.' })
  }
})

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  res.clearCookie(SESSION_COOKIE)
  res.json({ ok: true })
})

// Shared session check — reads the ff_session cookie, attaches req.user (the
// Mongoose doc) on success. Used by /me below and by any other route (this
// file or elsewhere) that needs to know who's logged in.
export async function requireAuth(req, res, next) {
  try {
    const token = req.cookies?.[SESSION_COOKIE]
    if (!token) return res.status(401).json({ ok: false, error: 'Not logged in.' })
    const payload = jwt.verify(token, JWT_SECRET)
    if (payload.purpose !== 'session') return res.status(401).json({ ok: false, error: 'Not logged in.' })
    const user = await User.findById(payload.sub)
    if (!user) return res.status(401).json({ ok: false, error: 'Not logged in.' })
    req.user = user
    next()
  } catch (_) {
    res.status(401).json({ ok: false, error: 'Not logged in.' })
  }
}

// GET /api/auth/me — reads the session cookie, used by the frontend on load
router.get('/me', requireAuth, (req, res) => {
  res.json({ ok: true, user: publicUser(req.user) })
})

// GET /api/auth/status — which delivery channels are configured, for the login/settings UI
router.get('/status', (_req, res) => {
  res.json({ ok: true, mailerConfigured: mailerReady(), smsConfigured: smsReady() })
})

// PUT /api/auth/profile — phone number, 2FA channel choice, SMS stock-alert
// opt-in + ticker list. All optional/independent: setting a phone doesn't
// turn on SMS 2FA or alerts by itself, each is its own explicit choice.
router.put('/profile', requireAuth, async (req, res) => {
  try {
    const body = req.body || {}
    if (body.phone !== undefined) {
      const phone = String(body.phone || '').trim()
      if (phone && !/^\+[1-9]\d{6,14}$/.test(phone)) {
        return res.status(400).json({ ok: false, error: 'Phone must be E.164 format, e.g. +15551234567.' })
      }
      req.user.phone = phone || null
    }
    if (body.twoFactorMethod !== undefined) {
      if (!['email', 'sms'].includes(body.twoFactorMethod)) {
        return res.status(400).json({ ok: false, error: 'twoFactorMethod must be "email" or "sms".' })
      }
      if (body.twoFactorMethod === 'sms' && !(req.user.phone || body.phone)) {
        return res.status(400).json({ ok: false, error: 'Add a phone number before switching 2FA to SMS.' })
      }
      req.user.twoFactorMethod = body.twoFactorMethod
    }
    if (body.smsAlertsOptIn !== undefined) req.user.smsAlertsOptIn = !!body.smsAlertsOptIn
    if (body.smsAlertTickers !== undefined) {
      req.user.smsAlertTickers = Array.isArray(body.smsAlertTickers)
        ? body.smsAlertTickers.map(t => String(t).toUpperCase().trim()).filter(Boolean).slice(0, 50)
        : []
    }
    await req.user.save()
    res.json({ ok: true, profile: {
      phone: req.user.phone,
      twoFactorMethod: req.user.twoFactorMethod,
      smsAlertsOptIn: req.user.smsAlertsOptIn,
      smsAlertTickers: req.user.smsAlertTickers,
    } })
  } catch (err) {
    console.error('PUT /api/auth/profile failed:', err)
    res.status(500).json({ ok: false, error: 'Could not save profile.' })
  }
})

// GET/PUT /api/auth/preferences — the "account that caches" piece. A free-form
// object (watchlist, saved screener filters, UI layout, whatever the frontend
// wants) tied to the logged-in account instead of just localStorage, so it
// follows you across devices/browsers.
router.get('/preferences', requireAuth, (req, res) => {
  res.json({ ok: true, preferences: req.user.preferences || {} })
})

router.put('/preferences', requireAuth, async (req, res) => {
  try {
    const incoming = req.body?.preferences
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
      return res.status(400).json({ ok: false, error: 'preferences must be an object.' })
    }
    // Merge rather than replace, so one screen's PUT can't wipe out another
    // screen's saved prefs (e.g. saving screener filters doesn't erase the watchlist).
    req.user.preferences = { ...(req.user.preferences || {}), ...incoming }
    req.user.markModified('preferences')
    await req.user.save()
    res.json({ ok: true, preferences: req.user.preferences })
  } catch (err) {
    console.error('PUT /api/auth/preferences failed:', err)
    res.status(500).json({ ok: false, error: 'Could not save preferences.' })
  }
})

// ── Public API keys (for /api/v1/*, see routes/apiV1.js) ───────────────────
const API_KEY_PREFIX = 'ff_live_'
const hashApiKey = (raw) => crypto.createHash('sha256').update(raw).digest('hex')

router.get('/api-keys', requireAuth, async (req, res) => {
  const keys = await ApiKey.find({ user: req.user._id, revoked: false }).sort({ createdAt: -1 })
  res.json({ ok: true, keys: keys.map(k => ({
    id: String(k._id), label: k.label, keyPrefix: k.keyPrefix,
    createdAt: k.createdAt, lastUsedAt: k.lastUsedAt,
  })) })
})

// Returns the full key exactly once — only the hash is kept after this response.
router.post('/api-keys', requireAuth, async (req, res) => {
  try {
    const label = String(req.body?.label || 'API key').slice(0, 80)
    const raw = API_KEY_PREFIX + crypto.randomBytes(24).toString('hex')
    await ApiKey.create({
      user: req.user._id,
      label,
      keyHash: hashApiKey(raw),
      keyPrefix: raw.slice(0, API_KEY_PREFIX.length + 6),
    })
    res.status(201).json({ ok: true, key: raw, note: 'Copy this now — it will not be shown again.' })
  } catch (err) {
    console.error('POST /api/auth/api-keys failed:', err)
    res.status(500).json({ ok: false, error: 'Could not create the key.' })
  }
})

router.delete('/api-keys/:id', requireAuth, async (req, res) => {
  const result = await ApiKey.updateOne({ _id: req.params.id, user: req.user._id }, { $set: { revoked: true } })
  res.json({ ok: true, revoked: result.matchedCount > 0 })
})

export default router
