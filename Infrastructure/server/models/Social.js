import mongoose from 'mongoose'

const SocialSchema = new mongoose.Schema(
  {
    platform: { type: String, index: true },
    ticker: { type: String, index: true },
    author: String,
    text: String,
    sentiment: String,
    sentiment_score: Number,
    created_at: { type: Date, default: Date.now },
    url: String,
  },
  {
    timestamps: true,
    strict: false,
  }
)

export default mongoose.models.Social || mongoose.model('Social', SocialSchema)
