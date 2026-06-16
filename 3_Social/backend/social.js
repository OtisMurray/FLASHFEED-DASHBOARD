import { Router } from 'express'
import Social from '../models/Social.js'

const router = Router()

// GET /api/social
router.get('/', async (req, res) => {
  try {
    const { platform, ticker, limit = 50 } = req.query
    const filter = {}
    if (platform && platform !== 'all') filter.platform = platform
    if (ticker) filter.ticker = ticker.toUpperCase()

    const posts = await Social.find(filter)
      .sort({ created_at: -1 })
      .limit(Number(limit))
      .lean()
    res.json(posts)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

export default router
