import { Hono } from 'hono'
import { ms } from '../../lib/helpers.ts'
import {
  getKeywords, addKeyword, updateKeyword, deleteKeyword,
  getAccounts, addAccount, updateAccount, deleteAccount,
} from '../../db/queries/settings.ts'

export const settingsRoutes = new Hono()

// ─── Keywords ─────────────────────────────────────────────────────────────────

settingsRoutes.get('/api/settings/keywords', (c) => {
  const t = ms()
  const keywords = getKeywords()
  return c.json({ keywords, ms: t() })
})

settingsRoutes.post('/api/settings/keywords', async (c) => {
  const t = ms()
  const { word, category = 'general' } = await c.req.json()
  if (!word?.trim()) return c.json({ error: 'word is required' }, 400)
  try {
    addKeyword(word.trim(), category.trim() || 'general')
    return c.json({ success: true, ms: t() })
  } catch (e) { return c.json({ error: String(e) }, 500) }
})

settingsRoutes.patch('/api/settings/keywords/:id', async (c) => {
  const t = ms()
  const id = +c.req.param('id')
  const { active } = await c.req.json()
  try {
    updateKeyword(id, !!active)
    return c.json({ success: true, ms: t() })
  } catch (e) { return c.json({ error: String(e) }, 500) }
})

settingsRoutes.delete('/api/settings/keywords/:id', (c) => {
  const t = ms()
  const id = +c.req.param('id')
  try {
    deleteKeyword(id)
    return c.json({ success: true, ms: t() })
  } catch (e) { return c.json({ error: String(e) }, 500) }
})

// ─── Accounts ─────────────────────────────────────────────────────────────────

settingsRoutes.get('/api/settings/accounts', (c) => {
  const t = ms()
  const accounts = getAccounts()
  return c.json({ accounts, ms: t() })
})

settingsRoutes.post('/api/settings/accounts', async (c) => {
  const t = ms()
  const { platform, handle } = await c.req.json()
  if (!platform?.trim() || !handle?.trim()) return c.json({ error: 'platform and handle are required' }, 400)
  try {
    addAccount(platform.trim(), handle.trim().replace(/^@/, ''))
    return c.json({ success: true, ms: t() })
  } catch (e) { return c.json({ error: String(e) }, 500) }
})

settingsRoutes.patch('/api/settings/accounts/:id', async (c) => {
  const t = ms()
  const id = +c.req.param('id')
  const { active } = await c.req.json()
  try {
    updateAccount(id, !!active)
    return c.json({ success: true, ms: t() })
  } catch (e) { return c.json({ error: String(e) }, 500) }
})

settingsRoutes.delete('/api/settings/accounts/:id', (c) => {
  const t = ms()
  const id = +c.req.param('id')
  try {
    deleteAccount(id)
    return c.json({ success: true, ms: t() })
  } catch (e) { return c.json({ error: String(e) }, 500) }
})
