import mongoose from 'mongoose'

const ArticleSchema = new mongoose.Schema({
  article_id:    { type: String, required: true, unique: true },
  title:         { type: String, required: true },
  source:        { type: String, index: true },
  url:           { type: String, default: '#' },
  category:      String,
  publish_date:  { type: Date, required: true, index: true },
  fetched_date:  { type: Date, default: Date.now },
  ticker:        { type: String, index: true, sparse: true },
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
