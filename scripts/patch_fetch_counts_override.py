from pathlib import Path
import re

path = Path("Infrastructure/server/index.js")
text = path.read_text()

# Ensure mongoose exists because the running backend uses Infrastructure/server.
if "from 'mongoose'" not in text and 'from "mongoose"' not in text:
    lines = text.splitlines()
    insert_at = 0
    while insert_at < len(lines) and lines[insert_at].startswith("import "):
        insert_at += 1
    lines.insert(insert_at, "import mongoose from 'mongoose'")
    text = "\n".join(lines) + "\n"

marker = "// FEEDFLASH_FETCH_COUNTS_OVERRIDE_V1"
if marker not in text:
    block = r'''
// FEEDFLASH_FETCH_COUNTS_OVERRIDE_V1
app.post("/api/fetch", async (req, res) => {
  const started = Date.now()

  try {
    const mongoDb = mongoose.connection.db
    if (!mongoDb) throw new Error("MongoDB connection is not ready")

    const articles = mongoDb.collection("articles")
    const before = await articles.countDocuments()

    const { spawn } = await import("child_process")

    const env = {
      ...process.env,
      MONGO_URI: process.env.MONGO_URI || "mongodb://mongo:27017/feedflash",
      MONGODB_URI: process.env.MONGODB_URI || process.env.MONGO_URI || "mongodb://mongo:27017/feedflash",
      MONGO_DB: process.env.MONGO_DB || "feedflash",
      RSS_COOLDOWN_SECONDS: "0",
      RSS_STATE_FILE: "/tmp/feedflash_rss_dashboard_state.json"
    }

    const proc = spawn("python3", ["1_News/pipeline/fetch_rss_to_mongo.py"], {
      cwd: process.cwd(),
      env
    })

    let stdout = ""
    let stderr = ""

    proc.stdout.on("data", chunk => { stdout += chunk.toString() })
    proc.stderr.on("data", chunk => { stderr += chunk.toString() })

    proc.on("close", async (code) => {
      const after = await articles.countDocuments()

      const summaryMatches = [...stdout.matchAll(/(\d+)\s+new,\s*(\d+)\s+updated,\s*(\d+)\s+unchanged/gi)]
      const last = summaryMatches.length ? summaryMatches[summaryMatches.length - 1] : null

      const parsedNew = last ? Number(last[1]) : Math.max(after - before, 0)
      const parsedUpdated = last ? Number(last[2]) : 0
      const parsedUnchanged = last ? Number(last[3]) : 0

      res.json({
        success: code === 0,
        new_articles: parsedNew,
        updated_articles: parsedUpdated,
        refreshed_articles: parsedUpdated,
        unchanged_articles: parsedUnchanged,
        total_changed: parsedNew + parsedUpdated,
        total_articles: after,
        before_articles: before,
        ms: Date.now() - started,
        output: stdout,
        stderr
      })
    })

    proc.on("error", err => {
      res.status(500).json({
        success: false,
        new_articles: 0,
        updated_articles: 0,
        refreshed_articles: 0,
        unchanged_articles: 0,
        total_changed: 0,
        error: String(err.message || err),
        ms: Date.now() - started
      })
    })
  } catch (err) {
    console.error("Dashboard /api/fetch override failed:", err)
    res.status(500).json({
      success: false,
      new_articles: 0,
      updated_articles: 0,
      refreshed_articles: 0,
      unchanged_articles: 0,
      total_changed: 0,
      error: String(err.message || err),
      ms: Date.now() - started
    })
  }
})

'''

    m = re.search(r'\napp\.post\(["\']/api/fetch["\']', text)
    if not m:
        raise SystemExit("Could not find existing app.post('/api/fetch') route")
    text = text[:m.start()] + "\n" + block + text[m.start():]

path.write_text(text)
print("patched Infrastructure/server/index.js with fetch-count override")
