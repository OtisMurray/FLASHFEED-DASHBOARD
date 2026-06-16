import { Router } from 'express'

const router = Router()

router.get('/', (req, res) => {
  res.json({
    appName: 'FeedFlash',
    environment: process.env.NODE_ENV || 'development',
    features: {
      articles: true,
      screener: true,
      social: true,
      correlation: true,
    },
  })
})

export default router
