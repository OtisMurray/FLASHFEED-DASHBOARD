import { Router } from 'express'
import crypto from 'node:crypto'
import mongoose from 'mongoose'
import ApiKey from '../models/ApiKey.js'

// Public, read-only API for FlashFeed's own data (screener + news). Thin,
// additive wrapper — queries the same collections the internal /api/screener
// and /api/articles routes use, but doesn't touch or reuse their route
// handlers, so nothing here can change their behavior.
const router = Router()

const hashApiKey = (raw) => crypto.createHash('sha256').update(raw).digest('hex')
const RATE_LIMIT_PER_MINUTE = Number(process.env.API_V1_RATE_LIMIT_PER_MINUTE || 60)

async function requireApiKey(req, res, next) {
  const header = req.get('Authorization') || ''
  const raw = header.startsWith('Bearer ') ? header.slice(7).trim() : String(req.get('X-API-Key') || '').trim()
  if (!raw) return res.status(401).json({ ok: false, error: 'Missing API key. Pass it as "Authorization: Bearer <key>" or "X-API-Key".' })

  const key = await ApiKey.findOne({ keyHash: hashApiKey(raw), revoked: false })
  if (!key) return res.status(401).json({ ok: false, error: 'Invalid or revoked API key.' })

  // Rate limit per key, using the same Redis instance the response-cache
  // middleware in index.js already relies on. Fails open (allows the request)
  // if Redis is unavailable — a public API should degrade, not go fully dark,
  // when the RAM cache layer is down.
  const redis = req.app.locals.redis
  const redisReady = req.app.locals.redisReady
  if (redis && typeof redisReady === 'function' && redisReady()) {
    try {
      const bucket = `apikey_rl:${key._id}:${Math.floor(Date.now() / 60000)}`
      const count = await redis.incr(bucket)
      if (count === 1) await redis.expire(bucket, 65)
      if (count > RATE_LIMIT_PER_MINUTE) {
        return res.status(429).json({ ok: false, error: `Rate limit exceeded (${RATE_LIMIT_PER_MINUTE}/min).` })
      }
    } catch (_) { /* Redis hiccup — don't block the request over it */ }
  }

  key.lastUsedAt = new Date()
  key.save().catch(() => {})   // best-effort; never block the request on this write
  req.apiKeyUserId = key.user
  next()
}

router.use(requireApiKey)

// GET /api/v1/screener — same universe /api/screener serves, trimmed to the
// fields a third-party consumer actually needs.
router.get('/screener', async (req, res) => {
  try {
    const db = mongoose.connection.db
    if (!db) return res.status(503).json({ ok: false, error: 'Database not connected.' })
    const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 100))
    const rows = await db.collection('screeners').find(
      { price: { $ne: null } },
      { projection: {
        ticker: 1, company: 1, exchange: 1, sector: 1, price: 1, change_pct: 1,
        volume: 1, market_cap: 1, rel_volume: 1, rsi: 1,
        structured_sentiment: 1, social_sentiment: 1,
      } },
    ).sort({ change_pct: -1 }).limit(limit).toArray()
    res.json({ ok: true, count: rows.length, rows })
  } catch (err) {
    console.error('GET /api/v1/screener failed:', err)
    res.status(500).json({ ok: false, error: 'Internal error.' })
  }
})

// GET /api/v1/news?ticker=AAPL — recent structured news for one ticker.
router.get('/news', async (req, res) => {
  try {
    const db = mongoose.connection.db
    if (!db) return res.status(503).json({ ok: false, error: 'Database not connected.' })
    const ticker = String(req.query.ticker || '').toUpperCase().trim()
    if (!ticker) return res.status(400).json({ ok: false, error: 'ticker query param is required.' })
    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 20))
    const rows = await db.collection('articles').find(
      { $or: [{ ticker }, { tickers: ticker }] },
      { projection: { title: 1, url: 1, source: 1, sentiment: 1, publish_date: 1, fetched_date: 1 } },
    ).sort({ publish_date: -1, fetched_date: -1 }).limit(limit).toArray()
    res.json({ ok: true, ticker, count: rows.length, articles: rows })
  } catch (err) {
    console.error('GET /api/v1/news failed:', err)
    res.status(500).json({ ok: false, error: 'Internal error.' })
  }
})

export default router
