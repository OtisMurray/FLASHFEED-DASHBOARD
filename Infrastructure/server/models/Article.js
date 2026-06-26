import mongoose from 'mongoose'

const ArticleSchema = new mongoose.Schema({
  article_id:    { type: String, required: true, unique: true },
  title:         { type: String, required: true },
  source:        { type: String, index: true },
  url:           { type: String, default: '#' },
  category:      String,
  article_kind:  { type: String, enum: ['structured', 'public'], index: true },
  source_type:   String,
  collector:     String,
  publish_date:  { type: Date, required: true },
  publish_time_trusted: { type: Boolean, default: true, index: true },
  first_seen_at: { type: Date, default: Date.now, index: true },
  fetched_date:  { type: Date, default: Date.now },
  ticker:        { type: String, index: true, sparse: true },
  tickers:       [String],
  company:       String,
  sentiment:     { type: String, enum: ['bullish', 'bearish', 'neutral'], index: true },
  ml_confidence: { type: Number, min: 0, max: 1 },
  content:       String,
  keyword_match: [String],
}, {
  timestamps: true,
})

// ── Compound indexes for common query patterns ────────────
ArticleSchema.index({ ticker: 1, publish_date: -1 })
ArticleSchema.index({ source: 1, publish_date: -1 })
ArticleSchema.index({ sentiment: 1, publish_date: -1 })
ArticleSchema.index({ publish_date: -1 })

// ── Auto-delete articles older than 30 days ───────────────
ArticleSchema.index({ publish_date: 1 }, { expireAfterSeconds: 2592000 })

export default mongoose.model('Article', ArticleSchema)
