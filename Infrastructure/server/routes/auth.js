import { Router } from 'express'
import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import User from '../models/User.js'
import { sendTwoFactorCodeEmail, mailerReady } from '../mailer.js'

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

    try {
      await sendTwoFactorCodeEmail(user.email, code)
    } catch (mailErr) {
      console.error('2FA email send failed:', mailErr.message)
      return res.status(503).json({ ok: false, error: 'Could not send the verification email. Try again shortly, or contact an admin.' })
    }

    const pendingToken = jwt.sign({ sub: String(user._id), purpose: '2fa' }, JWT_SECRET, { expiresIn: PENDING_TTL_MS / 1000 })
    res.json({ ok: true, pendingToken, message: `We emailed an 8-digit code to ${maskEmail(user.email)}.` })
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

    await sendTwoFactorCodeEmail(user.email, code)
    res.json({ ok: true, message: `New code sent to ${maskEmail(user.email)}.` })
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

// GET /api/auth/me — reads the session cookie, used by the frontend on load
router.get('/me', async (req, res) => {
  try {
    const token = req.cookies?.[SESSION_COOKIE]
    if (!token) return res.status(401).json({ ok: false })
    const payload = jwt.verify(token, JWT_SECRET)
    if (payload.purpose !== 'session') return res.status(401).json({ ok: false })
    const user = await User.findById(payload.sub)
    if (!user) return res.status(401).json({ ok: false })
    res.json({ ok: true, user: publicUser(user) })
  } catch (_) {
    res.status(401).json({ ok: false })
  }
})

// GET /api/auth/status — whether email delivery is configured, for the login UI
router.get('/status', (_req, res) => {
  res.json({ ok: true, mailerConfigured: mailerReady() })
})


export default router
