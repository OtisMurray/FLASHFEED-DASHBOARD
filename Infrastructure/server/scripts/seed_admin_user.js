#!/usr/bin/env node
// One-off seed script — creates or updates the Admin account. The password is
// read from the ADMIN_SEED_PASSWORD env var at run time only; it is never
// written to a file or committed, so it never lands in git history.
//
// Usage (against whichever MONGODB_URI is in the environment):
//   ADMIN_SEED_PASSWORD='...' node scripts/seed_admin_user.js

import mongoose from 'mongoose'
import bcrypt from 'bcryptjs'
import User from '../models/User.js'

const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/feedflash'
const ADMIN_USERNAME = process.env.ADMIN_SEED_USERNAME || 'Admin'
const ADMIN_EMAIL = process.env.ADMIN_SEED_EMAIL || 'timeresolutiontrading@gmail.com'
const ADMIN_PASSWORD = process.env.ADMIN_SEED_PASSWORD

async function main() {
  if (!ADMIN_PASSWORD) {
    console.error('ADMIN_SEED_PASSWORD env var is required (not passed as an argument, so it never appears in shell history/logs as a flag).')
    process.exit(1)
  }
  await mongoose.connect(MONGODB_URI)
  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 12)

  const existing = await User.findOne({ username: ADMIN_USERNAME })
  if (existing) {
    existing.passwordHash = passwordHash
    existing.email = ADMIN_EMAIL
    existing.role = 'admin'
    await existing.save()
    console.log(`Updated existing admin account "${ADMIN_USERNAME}" (${ADMIN_EMAIL}).`)
  } else {
    await User.create({ username: ADMIN_USERNAME, email: ADMIN_EMAIL, passwordHash, role: 'admin' })
    console.log(`Created admin account "${ADMIN_USERNAME}" (${ADMIN_EMAIL}).`)
  }

  await mongoose.disconnect()
}

main().catch(err => { console.error('Seed failed:', err); process.exit(1) })
