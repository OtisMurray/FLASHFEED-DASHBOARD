import { Router } from 'express'
import Article from '../models/Article.js'

const router = Router()

// ── GET /api/articles ─────────────────────────────────────
// Query params: sentiment, source, ticker, from, to, limit, skip
router.get('/', async (req, res) => {
  try {
    const { sentiment, source, ticker, from, to, limit = 50, skip = 0 } = req.query
    const filter = {}

    if (sentiment) filter.sentiment = sentiment
    if (source)    filter.source    = source
    if (ticker)    filter.ticker    = ticker.toUpperCase()
    if (from || to) {
      filter.publish_date = {}
      if (from) filter.publish_date.$gte = new Date(from)
      if (to)   filter.publish_date.$lte = new Date(to)
    }

    const [articles, total] = await Promise.all([
      Article.find(filter)
        .sort({ publish_date: -1 })
        .skip(Number(skip))
        .limit(Number(limit))
        .lean(),
      Article.countDocuments(filter),
    ])

    // Map _id to id and convert publish_date to unix timestamp
    const mapped = articles.map(a => ({
      ...a,
      id: a.article_id || String(a._id),
      publish_date: Math.floor(new Date(a.publish_date).getTime() / 1000),
    }))

    res.json({ articles: mapped, total, skip: Number(skip), limit: Number(limit) })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── GET /api/articles/:id ─────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const article = await Article.findOne({ article_id: req.params.id }).lean()
    if (!article) return res.status(404).json({ error: 'Not found' })
    res.json(article)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── POST /api/articles/fetch ──────────────────────────────
// Calls Claude, saves new articles to MongoDB, returns them
router.post('/fetch', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set in .env' })

  const now = Math.floor(Date.now() / 1000)

  try {
    // 1. Call Claude
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        messages: [{
          role: 'user',
          content: `Generate 12 realistic financial news articles for ${new Date().toDateString()}.
Return ONLY a raw JSON array — no markdown, no backticks, no preamble.

Shape: {"id":"1","title":"headline","source":"Reuters","category":"Earnings","publish_date":${now - 300},"ticker":"NVDA","company":"NVIDIA","sentiment":"bullish","ml_confidence":0.91}

Rules:
- Exactly 12 | 5 bullish, 4 bearish, 3 neutral
- Sources: Reuters Bloomberg WSJ CNBC FT MarketWatch
- 8 with tickers (AAPL TSLA NVDA MSFT META AMZN GOOGL NFLX AMD JPM XOM PYPL MRNA PLTR ARM); 4 macro (ticker:null)
- publish_date: unix seconds 5 min to 8 hours ago
- ml_confidence: 0.65-0.98
Return ONLY the JSON array.`,
        }],
      }),
    })

    const claudeData = await claudeRes.json()
    if (claudeData.error) throw new Error(claudeData.error.message)

    const raw = (claudeData.content?.[0]?.text || '')
      .replace(/^```json\s*/, '').replace(/^```\s*/, '').replace(/\s*```$/, '').trim()
    const incoming = JSON.parse(raw)

    // 2. Upsert each article into MongoDB
    const ops = incoming.map(a => ({
      updateOne: {
        filter: { article_id: a.id },
        update: {
          $set: {
            article_id:    a.id,
            title:         a.title,
            source:        a.source,
            category:      a.category,
            publish_date:  new Date((a.publish_date || now) * 1000),
            ticker:        a.ticker || undefined,
            company:       a.company || undefined,
            sentiment:     a.sentiment,
            ml_confidence: a.ml_confidence,
            url:           a.url || '#',
          },
        },
        upsert: true,
      },
    }))
    await Article.bulkWrite(ops)

    // 3. Return articles (keeping unix timestamp format for frontend)
    res.json({ articles: incoming, saved: incoming.length })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── POST /api/articles/bulk ───────────────────────────────
// Save articles that were already fetched by the browser
router.post('/bulk', async (req, res) => {
  try {
    const { articles } = req.body
    if (!Array.isArray(articles)) return res.status(400).json({ error: 'articles must be an array' })

    const ops = articles.map(a => ({
      updateOne: {
        filter: { article_id: a.id },
        update: {
          $set: {
            article_id:    a.id,
            title:         a.title,
            source:        a.source,
            category:      a.category,
            publish_date:  new Date((a.publish_date || Date.now() / 1000) * 1000),
            ticker:        a.ticker || undefined,
            company:       a.company || undefined,
            sentiment:     a.sentiment,
            ml_confidence: a.ml_confidence,
            url:           a.url || '#',
          },
        },
        upsert: true,
      },
    }))
    await Article.bulkWrite(ops)
    res.json({ saved: articles.length })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

export default router
