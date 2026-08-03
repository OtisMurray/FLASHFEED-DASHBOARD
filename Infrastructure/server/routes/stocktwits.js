import { Router } from 'express'
import { requireAuth } from './auth.js'
import User from '../models/User.js'

// "Log in to your StockTwits account" — real OAuth2 (StockTwits' own login
// page, FlashFeed never sees the StockTwits password). Inert until
// STOCKTWITS_CLIENT_ID / STOCKTWITS_CLIENT_SECRET are set (register a free
// app at stocktwits.com/developers to get these).
const router = Router()

const CLIENT_ID = process.env.STOCKTWITS_CLIENT_ID || ''
const CLIENT_SECRET = process.env.STOCKTWITS_CLIENT_SECRET || ''
const REDIRECT_URI = process.env.STOCKTWITS_REDIRECT_URI || ''
const configured = () => !!(CLIENT_ID && CLIENT_SECRET && REDIRECT_URI)

if (!configured()) {
  console.warn('  StockTwits → OAuth disabled (STOCKTWITS_CLIENT_ID / STOCKTWITS_CLIENT_SECRET / STOCKTWITS_REDIRECT_URI not set)')
}

// GET /api/auth/stocktwits/connect — sends the logged-in user to StockTwits'
// own login/consent screen. State is the user's id (signed indirectly by
// requiring an active session on the callback) so the callback knows who to
// attach the token to without trusting a client-supplied user id.
router.get('/connect', requireAuth, (req, res) => {
  if (!configured()) return res.status(503).json({ ok: false, error: 'StockTwits login is not configured yet.' })
  const url = new URL('https://api.stocktwits.com/api/2/oauth/authorize')
  url.searchParams.set('client_id', CLIENT_ID)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('redirect_uri', REDIRECT_URI)
  url.searchParams.set('scope', 'read')
  url.searchParams.set('state', String(req.user._id))
  res.json({ ok: true, authorizeUrl: url.toString() })
})

// GET /api/auth/stocktwits/callback — StockTwits redirects here with ?code=&state=
router.get('/callback', async (req, res) => {
  if (!configured()) return res.status(503).send('StockTwits login is not configured yet.')
  try {
    const code = String(req.query.code || '')
    const userId = String(req.query.state || '')
    if (!code || !userId) return res.status(400).send('Missing code/state.')

    const tokenRes = await fetch('https://api.stocktwits.com/api/2/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: REDIRECT_URI,
      }),
    })
    const tokenData = await tokenRes.json()
    if (!tokenRes.ok || !tokenData.access_token) {
      console.error('StockTwits token exchange failed:', tokenData)
      return res.status(502).send('StockTwits login failed — could not exchange the authorization code.')
    }

    await User.findByIdAndUpdate(userId, {
      $set: {
        'stocktwits.accessToken': tokenData.access_token,
        'stocktwits.username': tokenData.user?.username || null,
        'stocktwits.connectedAt': new Date(),
      },
    })
    res.redirect('/settings?stocktwits=connected')
  } catch (err) {
    console.error('GET /api/auth/stocktwits/callback failed:', err)
    res.status(500).send('StockTwits login failed.')
  }
})

// POST /api/auth/stocktwits/disconnect
router.post('/disconnect', requireAuth, async (req, res) => {
  req.user.stocktwits = { accessToken: null, username: null, connectedAt: null }
  await req.user.save()
  res.json({ ok: true })
})

router.get('/status', requireAuth, (req, res) => {
  res.json({
    ok: true,
    configured: configured(),
    connected: !!req.user.stocktwits?.accessToken,
    username: req.user.stocktwits?.username || null,
  })
})

export default router
