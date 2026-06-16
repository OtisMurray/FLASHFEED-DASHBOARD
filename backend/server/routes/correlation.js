import { Router } from 'express'
import Correlation from '../models/Correlation.js'

const router = Router()

router.get('/', async (req, res) => {
  try {
    const data = await Correlation.find({})
      .sort({ created_at: -1 })
      .limit(100)
      .lean()

    res.json({
      results: data,
      count: data.length,
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.post('/run', async (req, res) => {
  res.json({
    success: true,
    message: 'Correlation endpoint connected. Python tracker can be wired in later.',
  })
})

export default router
