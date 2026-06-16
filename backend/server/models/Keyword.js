import mongoose from 'mongoose'

const KeywordSchema = new mongoose.Schema({
  word:   { type: String, required: true, unique: true },
  active: { type: Boolean, default: true },
  hits:   { type: Number, default: 0 },
}, { timestamps: true })

export default mongoose.model('Keyword', KeywordSchema)
