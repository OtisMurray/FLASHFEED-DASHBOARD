import mongoose from 'mongoose'

const CorrelationSchema = new mongoose.Schema({
  ticker:      { type: String, required: true, unique: true, index: true },
  correlation: { type: Number, required: true },  // Pearson r (-1 to 1)
  p_value:     Number,
  sample_size: Number,
  window_days: { type: Number, default: 7 },
  updated_at:  { type: Date, default: Date.now },
}, { timestamps: true })

// Auto-delete stale correlation data after 7 days
CorrelationSchema.index({ updated_at: 1 }, { expireAfterSeconds: 604800 })

export default mongoose.model('Correlation', CorrelationSchema)
