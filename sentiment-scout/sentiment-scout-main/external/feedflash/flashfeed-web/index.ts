import { createApp } from './api/index.ts'
import { migrateSentimentSchema, migrateSettingsSchema } from './db/migrations.ts'
import { stampNullSentiment } from './db/queries/articles.ts'
import { startSentimentWorker } from './workers/sentiment-worker.ts'
import { startCorrelationWorker } from './workers/correlation-worker.ts'
import { PORT, ROOT, BIN, DB, CFG, WEB_LOG } from './lib/config.ts'
import { log } from './lib/logger.ts'
import { existsSync } from 'fs'

migrateSentimentSchema()   // idempotent — runs every start, no-ops if already migrated (includes correlation columns)
migrateSettingsSchema()    // keywords + watched_accounts tables
stampNullSentiment()       // instantly score any articles that have no sentiment label yet

log('INFO', '─────────────────────────────────────')
log('INFO', `FlashFeed Web starting on port ${PORT}`)
log('INFO', `Root:    ${ROOT}`)
log('INFO', `Binary:  ${existsSync(BIN) ? '✓' : '✗ NOT FOUND'}  ${BIN}`)
log('INFO', `DB:      ${existsSync(DB) ? '✓' : '✗ not found'}  ${DB}`)
log('INFO', `Config:  ${CFG}`)
log('INFO', `Web log: ${WEB_LOG}`)
log('INFO', '─────────────────────────────────────')

const app = createApp()

startSentimentWorker(30_000)   // score unanalyzed articles every 30s in background
startCorrelationWorker(30_000) // check price correlation every 30 secs in background

const server = Bun.serve({ port: PORT, fetch: app.fetch, idleTimeout: 120 })
log('INFO', `FlashFeed running at http://localhost:${PORT}`)

console.log(`\n⚡ FlashFeed Web  →  http://localhost:${PORT}\n`)
