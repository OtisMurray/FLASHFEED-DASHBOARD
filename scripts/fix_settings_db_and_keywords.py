from pathlib import Path
import re

index_path = Path("backend/server/index.js")
text = index_path.read_text()

# 1) Inside the real backend settings patch, replace accidental db.collection usage.
marker = "// FEEDFLASH_REAL_BACKEND_SETTINGS_PATCH_V1"
if marker in text:
    start = text.index(marker)
    end_match = re.search(r"\napp\.listen\s*\(", text[start:])
    end = start + end_match.start() if end_match else len(text)

    block = text[start:end]
    block = block.replace("db.collection(", "settingsDb().collection(")
    text = text[:start] + block + text[end:]

# 2) Add non-conflicting editable keyword routes if missing.
kw_marker = "// FEEDFLASH_SETTINGS_KEYWORDS_ALIAS_PATCH_V1"
if kw_marker not in text:
    alias_block = r'''

// FEEDFLASH_SETTINGS_KEYWORDS_ALIAS_PATCH_V1
app.get('/api/settings/keywords', async (req, res) => {
  try {
    await seedDefaultKeywordsIfEmpty()

    const rows = await settingsDb().collection('keywords')
      .find({})
      .sort({ enabled: -1, category: 1, keyword: 1, word: 1 })
      .toArray()

    res.json({
      ok: true,
      keywords: rows.map(r => ({
        id: String(r._id),
        keyword: r.keyword || r.word,
        word: r.word || r.keyword,
        category: r.category || 'custom',
        enabled: r.enabled !== false && r.active !== false,
        active: r.enabled !== false && r.active !== false,
        hits: r.hits || 0
      }))
    })
  } catch (err) {
    console.error('GET /api/settings/keywords failed:', err)
    res.status(500).json({ ok: false, error: String(err.message || err) })
  }
})

app.post('/api/settings/keywords', async (req, res) => {
  try {
    const keyword = cleanKeyword(req.body?.keyword || req.body?.word)
    const category = cleanSettingText(req.body?.category || 'custom').toLowerCase()

    if (!keyword) return res.status(400).json({ ok: false, error: 'keyword is required' })

    const now = Math.floor(Date.now() / 1000)
    await settingsDb().collection('keywords').updateOne(
      { keyword },
      {
        $set: { keyword, word: keyword, category, enabled: true, active: true, updated_at: now },
        $setOnInsert: { hits: 0, created_at: now }
      },
      { upsert: true }
    )

    res.json({ ok: true, keyword, category })
  } catch (err) {
    console.error('POST /api/settings/keywords failed:', err)
    res.status(500).json({ ok: false, error: String(err.message || err) })
  }
})

app.patch('/api/settings/keywords/:keyword', async (req, res) => {
  try {
    const keyword = cleanKeyword(decodeURIComponent(req.params.keyword))
    const enabled = req.body?.enabled !== false && req.body?.active !== false

    const result = await settingsDb().collection('keywords').updateOne(
      { $or: [{ keyword }, { word: keyword }] },
      { $set: { enabled, active: enabled, updated_at: Math.floor(Date.now() / 1000) } }
    )

    res.json({ ok: true, matched: result.matchedCount, modified: result.modifiedCount })
  } catch (err) {
    console.error('PATCH /api/settings/keywords failed:', err)
    res.status(500).json({ ok: false, error: String(err.message || err) })
  }
})

app.delete('/api/settings/keywords/:keyword', async (req, res) => {
  try {
    const keyword = cleanKeyword(decodeURIComponent(req.params.keyword))

    const result = await settingsDb().collection('keywords').deleteOne({
      $or: [{ keyword }, { word: keyword }]
    })

    res.json({ ok: true, deleted: result.deletedCount })
  } catch (err) {
    console.error('DELETE /api/settings/keywords failed:', err)
    res.status(500).json({ ok: false, error: String(err.message || err) })
  }
})
'''
    # Insert alias routes right before app.listen.
    m = re.search(r"\napp\.listen\s*\(", text)
    if not m:
        raise SystemExit("Could not find app.listen")
    text = text[:m.start()] + alias_block + text[m.start():]

index_path.write_text(text)

# 3) Update SettingsPage to use /api/settings/keywords instead of /api/keywords.
settings_path = Path("app/src/pages/SettingsPage.tsx")
if settings_path.exists():
    s = settings_path.read_text()
    s = s.replace("jsonFetch('/api/keywords')", "jsonFetch('/api/settings/keywords')")
    s = s.replace("jsonFetch('/api/keywords',", "jsonFetch('/api/settings/keywords',")
    s = s.replace("`/api/keywords/${encodeURIComponent(keyword)}`", "`/api/settings/keywords/${encodeURIComponent(keyword)}`")
    settings_path.write_text(s)
    print("patched SettingsPage keyword URLs")

print("patched backend/server/index.js")
