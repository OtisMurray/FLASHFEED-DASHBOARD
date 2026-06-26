import mongoose from 'mongoose'

const CorrelationSchema = new mongoose.Schema({
  ticker:      { type: String, required: true, unique: true, index: true },
  correlation: { type: Number, required: true },  // Sentiment/price alignment score (-1 to 1)
  p_value:     Number,
  sample_size: Number,
  window_days: { type: Number, default: 7 },
  news_sentiment: Number,
  price_momentum: Number,
  change_pct: Number,
  bullish_count: Number,
  bearish_count: Number,
  neutral_count: Number,
  article_count: Number,
  confidence: Number,
  direction: String,
  sources: [String],
  generated: Boolean,
  updated_at:  { type: Date, default: Date.now },
}, { timestamps: true, strict: false })

// Auto-delete stale correlation data after 7 days
CorrelationSchema.index({ updated_at: 1 }, { expireAfterSeconds: 604800 })

export default mongoose.model('Correlation', CorrelationSchema)
