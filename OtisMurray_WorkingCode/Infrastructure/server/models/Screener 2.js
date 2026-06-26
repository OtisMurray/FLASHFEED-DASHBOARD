import mongoose from 'mongoose'

const ScreenerSchema = new mongoose.Schema(
  {
    ticker: { type: String, required: true, index: true },
    company: String,
    sector: String,
    price: Number,
    change_percent: Number,
    volume: Number,
    market_cap: Number,
    social_sentiment: Number,
    news_sentiment: Number,
    signal_score: Number,
    updated_at: { type: Date, default: Date.now },
  },
  {
    timestamps: true,
    strict: false,
  }
)

export default mongoose.models.Screener || mongoose.model('Screener', ScreenerSchema)
