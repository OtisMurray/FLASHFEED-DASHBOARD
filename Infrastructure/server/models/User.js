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

  // Pending 2FA challenge for the current login attempt — same code, delivered
  // over whichever channel the account prefers (see routes/auth.js REQUIRE_2FA).
  twoFactorCodeHash:  { type: String, default: null },
  twoFactorExpiresAt: { type: Date, default: null },
  twoFactorAttempts:  { type: Number, default: 0 },
  twoFactorMethod:    { type: String, enum: ['email', 'sms'], default: 'email' },

  // Phone number (E.164, e.g. +15551234567) — needed for SMS 2FA and/or SMS
  // stock alerts. Optional; both features no-op without it.
  phone: { type: String, default: null },
  // Legacy SMS news-alert settings. Superseded by alertPreferences below, but
  // kept and still read (see effectiveAlertPreferences) so an existing opted-in
  // user does not lose their choice on deploy.
  smsAlertsOptIn:  { type: Boolean, default: false },
  smsAlertTickers: { type: [String], default: [] },

  // Trading alerts (Entry / Exit / News). Deliberately a nested subdocument
  // rather than a dozen more top-level fields, and deliberately SEPARATE from
  // twoFactorMethod above: changing where alerts are delivered must never move
  // where login codes are delivered. Validation lives in lib/alertPreferences.js
  // — this schema is storage shape only.
  alertPreferences: {
    alertEmail:          { type: String, default: null },   // null => use the account email
    emailEnabled:        { type: Boolean, default: false },
    smsEnabled:          { type: Boolean, default: false },
    entryEnabled:        { type: Boolean, default: false },
    exitEnabled:         { type: Boolean, default: false },
    newsEnabled:         { type: Boolean, default: false },
    tickerScope:         { type: String, enum: ['all', 'selected'], default: 'all' },
    tickers:             { type: [String], default: [] },
    newsTickers:         { type: [String], default: [] },
    minAiScore:          { type: Number, default: 50 },
    maxPerDay:           { type: Number, default: 10 },     // null => unlimited
    newsCooldownMinutes: { type: Number, default: 30 },
    // The no-historical-blast watermark. Only canonical events recorded after
    // this instant are ever eligible, so first enabling alerts (or a Railway
    // restart) cannot replay the day's existing positions as new entries.
    updatedAt:           { type: Date, default: null },
  },

  // StockTwits OAuth (see routes/stocktwits.js) — access token only, never the
  // account password (StockTwits uses OAuth2, so FlashFeed never sees it).
  stocktwits: {
    accessToken: { type: String, default: null },
    username:    { type: String, default: null },
    connectedAt: { type: Date, default: null },
  },

  // Reserved for future personalization (saved filters, layout, etc.) — logging
  // in doesn't gate the site today, it just gives a place to persist prefs later.
  preferences: { type: mongoose.Schema.Types.Mixed, default: {} },

  lastLoginAt: { type: Date, default: null },
  createdAt:   { type: Date, default: Date.now },
})

UserSchema.index({ username: 1 }, { unique: true })
UserSchema.index({ email: 1 }, { unique: true })

export default mongoose.model('User', UserSchema)
