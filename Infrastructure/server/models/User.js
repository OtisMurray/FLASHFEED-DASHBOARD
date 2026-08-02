import mongoose from 'mongoose'

// Accounts + email-based 2FA. Passwords are bcrypt hashes only — the plaintext
// password never touches the database. 2FA codes are also hashed at rest (like
// a password) so a database read alone can't be used to log in as someone else;
// they're short-lived (see TWO_FACTOR_TTL_MS in routes/auth.js) and single-use.
const UserSchema = new mongoose.Schema({
  username:     { type: String, required: true, unique: true, trim: true },
  email:        { type: String, required: true, unique: true, trim: true, lowercase: true },
  passwordHash: { type: String, required: true },
  role:         { type: String, enum: ['admin', 'user'], default: 'user' },

  // Pending email 2FA challenge for the current login attempt.
  twoFactorCodeHash:  { type: String, default: null },
  twoFactorExpiresAt: { type: Date, default: null },
  twoFactorAttempts:  { type: Number, default: 0 },

  // Reserved for future personalization (saved filters, layout, etc.) — logging
  // in doesn't gate the site today, it just gives a place to persist prefs later.
  preferences: { type: mongoose.Schema.Types.Mixed, default: {} },

  lastLoginAt: { type: Date, default: null },
  createdAt:   { type: Date, default: Date.now },
})

UserSchema.index({ username: 1 }, { unique: true })
UserSchema.index({ email: 1 }, { unique: true })

export default mongoose.model('User', UserSchema)
