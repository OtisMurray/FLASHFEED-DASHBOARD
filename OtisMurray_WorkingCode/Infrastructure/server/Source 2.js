import mongoose from 'mongoose'

const SourceSchema = new mongoose.Schema({
  url:        { type: String, required: true, unique: true },
  name:       String,
  active:     { type: Boolean, default: true },
  last_fetch: Date,
  article_count: { type: Number, default: 0 },
}, { timestamps: true })

export default mongoose.model('Source', SourceSchema)
