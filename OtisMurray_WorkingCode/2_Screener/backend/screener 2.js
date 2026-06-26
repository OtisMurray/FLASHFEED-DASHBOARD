import { Router } from 'express'
import Screener from '../models/Screener.js'

const router = Router()

// GET /api/screener
router.get('/', async (req, res) => {
  try {
    const { sector, signal, orderBy = 'ticker', orderDir = 'asc', limit = 50 } = req.query
    const filter = {}
    if (sector) filter.sector = sector
    if (signal === 'social_bullish') filter.social_sentiment = { $gte: 0.3 }
    if (signal === 'social_bearish') filter.social_sentiment = { $lte: -0.3 }
    if (signal === 'unusual_volume') filter.volume = { $gte: 30000000 }

    const sort = { [orderBy]: orderDir === 'asc' ? 1 : -1 }
    const data = await Screener.find(filter).sort(sort).limit(Number(limit)).lean()
    res.json(data)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/screener/upsert  — upsert a single ticker
router.post('/upsert', async (req, res) => {
  try {
    const doc = await Screener.findOneAndUpdate(
      { ticker: req.body.ticker },
      { $set: { ...req.body, updated_at: new Date() } },
      { upsert: true, new: true }
    )
    res.json(doc)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

export default router
