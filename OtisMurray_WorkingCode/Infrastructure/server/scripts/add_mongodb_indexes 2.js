import mongoose from 'mongoose'

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017'
const DB_NAME = process.env.MONGO_DB || 'ds440'

async function addIndexes() {
  await mongoose.connect(MONGO_URI)
  const db = mongoose.connection.db

  console.log('Adding MongoDB indexes...\n')

  // Articles collection - most important for performance
  const articlesIndexes = [
    { keys: { ticker: 1, publish_date: -1 }, name: 'ticker_publish_date' },
    { keys: { ticker: 1, sentiment: 1 }, name: 'ticker_sentiment' },
    { keys: { publish_date: -1 }, name: 'publish_date' },
    { keys: { source: 1, publish_date: -1 }, name: 'source_publish_date' },
    { keys: { sentiment: 1, publish_date: -1 }, name: 'sentiment_publish_date' },
  ]

  for (const idx of articlesIndexes) {
    try {
      await db.collection('articles').createIndex(idx.keys, { name: idx.name, background: true })
      console.log(`✓ Created index: ${idx.name} on articles`)
    } catch (err) {
      if (err.codeName === 'IndexOptionsConflict') {
        console.log(`- Index already exists: ${idx.name}`)
      } else {
        console.error(`✗ Failed to create index ${idx.name}:`, err.message)
      }
    }
  }

  // Social posts collection
  const socialIndexes = [
    { keys: { ticker: 1, fetched_at: -1 }, name: 'ticker_fetched_at' },
    { keys: { platform: 1, fetched_at: -1 }, name: 'platform_fetched_at' },
    { keys: { sentiment: 1, fetched_at: -1 }, name: 'sentiment_fetched_at' },
  ]

  for (const idx of socialIndexes) {
    try {
      await db.collection('socials').createIndex(idx.keys, { name: idx.name, background: true })
      console.log(`✓ Created index: ${idx.name} on socials`)
    } catch (err) {
      if (err.codeName === 'IndexOptionsConflict') {
        console.log(`- Index already exists: ${idx.name}`)
      } else {
        console.error(`✗ Failed to create index ${idx.name}:`, err.message)
      }
    }
  }

  // Screener collection
  try {
    await db.collection('screeners').createIndex({ ticker: 1 }, { unique: true, background: true })
    console.log('✓ Created unique index: ticker on screeners')
  } catch (err) {
    if (err.codeName === 'IndexOptionsConflict') {
      console.log('- Index already exists: ticker on screeners')
    } else {
      console.error('✗ Failed to create index on screeners:', err.message)
    }
  }

  console.log('\n✓ Index setup complete')
  await mongoose.disconnect()
}

addIndexes().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})