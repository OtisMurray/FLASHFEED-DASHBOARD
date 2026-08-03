import mongoose from 'mongoose'

// Public API keys (for /api/v1/*). Like the User model's passwords, the raw
// key is never stored — only a SHA-256 hash. SHA-256 (not bcrypt) is the
// standard choice for API keys specifically: they're already high-entropy
// random strings (not human-chosen passwords), so there's no dictionary/
// brute-force risk to slow down, and a fast hash keeps every /api/v1/* call
// from paying bcrypt's cost on every request.
const ApiKeySchema = new mongoose.Schema({
  user:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  label:      { type: String, default: 'API key' },
  keyHash:    { type: String, required: true, unique: true },
  keyPrefix:  { type: String, required: true },   // shown in the UI so a key is identifiable without exposing it
  revoked:    { type: Boolean, default: false },
  lastUsedAt: { type: Date, default: null },
  createdAt:  { type: Date, default: Date.now },
})

ApiKeySchema.index({ keyHash: 1 }, { unique: true })

export default mongoose.model('ApiKey', ApiKeySchema)
