import { Hono } from 'hono'
import { ms, activeKeywords } from '../../lib/helpers.ts'

export const keywordsRoutes = new Hono()

// GET /api/keywords/active — return the in-memory Set as an array (instant, no DB round-trip)
keywordsRoutes.get('/api/keywords/active', (c) => {
  const t = ms()
  const kws = [...activeKeywords()]
  return c.json({ keywords: kws, count: kws.length, ms: t() })
})
