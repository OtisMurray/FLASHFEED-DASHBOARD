import mongoose from 'mongoose'

let isConnected = false

export async function connectDB() {
  if (isConnected) return

  const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/feedflash'

  try {
    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 5000,  // Fail fast if MongoDB not running
    })
    isConnected = true
    const host = mongoose.connection.host
    const db   = mongoose.connection.name
    console.log(`MongoDB connected  →  ${host}/${db}`)
  } catch (err) {
    console.error('MongoDB connection failed:', err.message)
    console.error('Make sure MongoDB is running:  mongod  or  start the MongoDB service')
    process.exit(1)
  }
}

// Graceful shutdown
process.on('SIGINT', async () => {
  await mongoose.connection.close()
  console.log('MongoDB connection closed.')
  process.exit(0)
})
