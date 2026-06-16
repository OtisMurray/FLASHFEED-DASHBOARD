from pathlib import Path
import re

root = Path.cwd()
index_path = root / "Infrastructure/server/index.js"
text = index_path.read_text()

marker = "// FEEDFLASH_SETTINGS_KEYWORDS_SOURCES_PATCH_V1"
if marker in text:
    print("Settings API patch already present")
else:
    block = r'''

// FEEDFLASH_SETTINGS_KEYWORDS_SOURCES_PATCH_V1
const DEFAULT_SIGNAL_KEYWORDS = [
  ["earnings", "fundamental"],
  ["ipo", "fundamental"],
  ["listing", "fundamental"],
  ["delisting", "fundamental"],
  ["dividend", "fundamental"],
  ["merger", "fundamental"],
  ["acquisition", "fundamental"],
  ["buyout", "fundamental"],
  ["contract", "fundamental"],
  ["partnership", "fundamental"],
  ["fda approval", "regulatory"],
  ["fda rejection", "regulatory"],
  ["clinical trial", "regulatory"],
  ["sec filing", "regulatory"],
  ["short squeeze", "momentum"],
  ["price target", "analyst"],
  ["downgrade", "analyst"],
  ["upgrade", "analyst"],
  ["beat estimates", "fundamental"],
  ["miss estimates", "fundamental"],
  ["guidance", "fundamental"],
  ["recall", "regulatory"],
  ["bankruptcy", "fundamental"],
  ["layoffs", "fundamental"],
  ["restructuring", "fundamental"]
];

async function seedDefaultKeywordsIfEmpty() {
  const keywords = db.collection("keywords");
  const count = await keywords.countDocuments();
  if (count > 0) return;

  await keywords.insertMany(DEFAULT_SIGNAL_KEYWORDS.map(([keyword, category]) => ({
    keyword,
    word: keyword,
    category,
    enabled: true,
    active: true,
    hits: 0,
    created_at: Math.floor(Date.now() / 1000),
    updated_at: Math.floor(Date.now() / 1000)
  })));
}

function cleanSettingText(v) {
  return String(v || "").trim();
}

function cleanKeyword(v) {
  return cleanSettingText(v).toLowerCase();
}

app.get("/api/keywords", async (req, res) => {
  try {
    await seedDefaultKeywordsIfEmpty();
    const rows = await db.collection("keywords")
      .find({})
      .sort({ enabled: -1, category: 1, keyword: 1, word: 1 })
      .toArray();

    res.json({
      ok: true,
      keywords: rows.map(r => ({
        id: String(r._id),
        keyword: r.keyword || r.word,
        word: r.word || r.keyword,
        category: r.category || "custom",
        enabled: r.enabled !== false && r.active !== false,
        active: r.enabled !== false && r.active !== false,
        hits: r.hits || 0
      }))
    });
  } catch (err) {
    console.error("GET /api/keywords failed:", err);
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

app.post("/api/keywords", async (req, res) => {
  try {
    const keyword = cleanKeyword(req.body.keyword || req.body.word);
    const category = cleanSettingText(req.body.category || "custom").toLowerCase();

    if (!keyword) return res.status(400).json({ ok: false, error: "keyword is required" });

    const now = Math.floor(Date.now() / 1000);
    await db.collection("keywords").updateOne(
      { keyword },
      {
        $set: { keyword, word: keyword, category, enabled: true, active: true, updated_at: now },
        $setOnInsert: { hits: 0, created_at: now }
      },
      { upsert: true }
    );

    res.json({ ok: true, keyword, category });
  } catch (err) {
    console.error("POST /api/keywords failed:", err);
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

app.patch("/api/keywords/:keyword", async (req, res) => {
  try {
    const keyword = cleanKeyword(decodeURIComponent(req.params.keyword));
    const enabled = req.body.enabled !== false && req.body.active !== false;
    const result = await db.collection("keywords").updateOne(
      { $or: [{ keyword }, { word: keyword }] },
      { $set: { enabled, active: enabled, updated_at: Math.floor(Date.now() / 1000) } }
    );
    res.json({ ok: true, matched: result.matchedCount, modified: result.modifiedCount });
  } catch (err) {
    console.error("PATCH /api/keywords/:keyword failed:", err);
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

app.delete("/api/keywords/:keyword", async (req, res) => {
  try {
    const keyword = cleanKeyword(decodeURIComponent(req.params.keyword));
    const result = await db.collection("keywords").deleteOne({ $or: [{ keyword }, { word: keyword }] });
    res.json({ ok: true, deleted: result.deletedCount });
  } catch (err) {
    console.error("DELETE /api/keywords/:keyword failed:", err);
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

const PROFESSOR_STRUCTURED_SOURCES = [
  { source: "PR Newswire", status: "public_feed", method: "rss", editable: false },
  { source: "GlobeNewswire", status: "public_feed", method: "rss", editable: false },
  { source: "SEC EDGAR", status: "public_api", method: "official_sec_atom", editable: false },
  { source: "FDA", status: "public_feed", method: "official_fda_rss", editable: false },
  { source: "Business Wire", status: "valid_rss_channel_required", method: "official_businesswire_rss_or_media_partner_feed", editable: false },
  { source: "ACCESS Newswire / AccessWire", status: "verified_endpoint_required", method: "official_access_or_newswire_feed_required", editable: false },
  { source: "Benzinga", status: "api_key_required", method: "official_benzinga_stock_news_api", editable: false },
  { source: "Dow Jones Newswires", status: "contract_required", method: "licensed_api", editable: false },
  { source: "TradingView News Flow", status: "official_access_required", method: "approved_api_only", editable: false },
  { source: "Interactive Brokers News", status: "broker_api_required", method: "broker_api", editable: false },
  { source: "Charles Schwab / TD Ameritrade News", status: "broker_api_required", method: "broker_api", editable: false }
];

async function countArticlesForSourceLabel(label) {
  const parts = label.split("/").map(s => s.trim()).filter(Boolean);
  const pattern = parts.length ? parts.join("|") : label;
  return db.collection("articles").countDocuments({ source: new RegExp(pattern, "i") });
}

app.get("/api/settings/sources", async (req, res) => {
  try {
    const custom = await db.collection("rss_sources")
      .find({})
      .sort({ enabled: -1, name: 1 })
      .toArray();

    const structured = [];
    for (const s of PROFESSOR_STRUCTURED_SOURCES) {
      structured.push({
        ...s,
        count: await countArticlesForSourceLabel(s.source)
      });
    }

    res.json({
      ok: true,
      structured,
      custom_rss_sources: custom.map(s => ({
        id: String(s._id),
        name: s.name,
        source: s.name,
        url: s.url,
        category: s.category || "custom",
        enabled: s.enabled !== false,
        status: s.enabled === false ? "disabled" : "enabled",
        editable: true
      }))
    });
  } catch (err) {
    console.error("GET /api/settings/sources failed:", err);
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

app.post("/api/settings/sources", async (req, res) => {
  try {
    const name = cleanSettingText(req.body.name || req.body.source);
    const url = cleanSettingText(req.body.url);
    const category = cleanSettingText(req.body.category || "custom").toLowerCase();

    if (!name || !url) return res.status(400).json({ ok: false, error: "name and url are required" });
    if (!/^https?:\/\//i.test(url)) return res.status(400).json({ ok: false, error: "url must start with http:// or https://" });

    const now = Math.floor(Date.now() / 1000);
    await db.collection("rss_sources").updateOne(
      { name },
      {
        $set: { name, url, category, enabled: true, updated_at: now },
        $setOnInsert: { created_at: now }
      },
      { upsert: true }
    );

    res.json({ ok: true, name, url, category });
  } catch (err) {
    console.error("POST /api/settings/sources failed:", err);
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

app.patch("/api/settings/sources/:name", async (req, res) => {
  try {
    const name = cleanSettingText(decodeURIComponent(req.params.name));
    const enabled = req.body.enabled !== false;
    const result = await db.collection("rss_sources").updateOne(
      { name },
      { $set: { enabled, updated_at: Math.floor(Date.now() / 1000) } }
    );
    res.json({ ok: true, matched: result.matchedCount, modified: result.modifiedCount });
  } catch (err) {
    console.error("PATCH /api/settings/sources/:name failed:", err);
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

app.delete("/api/settings/sources/:name", async (req, res) => {
  try {
    const name = cleanSettingText(decodeURIComponent(req.params.name));
    const result = await db.collection("rss_sources").deleteOne({ name });
    res.json({ ok: true, deleted: result.deletedCount });
  } catch (err) {
    console.error("DELETE /api/settings/sources/:name failed:", err);
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});
'''

    m = re.search(r"\napp\.listen\s*\(", text)
    if not m:
      raise SystemExit("Could not find app.listen(...) in Infrastructure/server/index.js")

    text = text[:m.start()] + block + text[m.start():]
    index_path.write_text(text)
    print("Patched Infrastructure/server/index.js with settings routes")
