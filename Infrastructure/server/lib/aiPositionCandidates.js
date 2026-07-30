const TICKER_RE = /^[A-Z][A-Z0-9.-]{0,7}$/

function finiteNumber(value) {
  if (value == null || value === '' || typeof value === 'boolean') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}
export function selectAiPositionCandidates(rows = [], { limit = 30, minScore = 50 } = {}) {
  const maxRows = Math.max(1, Math.min(50, Math.round(Number(limit) || 30)))
  const floor = Math.max(0, Math.min(100, Number(minScore) || 0))
  const seen = new Set()

  return (Array.isArray(rows) ? rows : [])
    .map((row, index) => {
      const ticker = String(row?.ticker || '').trim().toUpperCase()
      const score = finiteNumber(row?.ai_rank_score)
      const direction = String(row?.direction || 'watch').toLowerCase()
      const predictionDirection = String(row?.prediction_signal?.direction || 'watch').toLowerCase()
      if (!TICKER_RE.test(ticker) || score == null || score < floor) return null
      if (direction === 'bearish' || predictionDirection === 'down') return null
      return {
        ticker,
        company: row?.company || null,
        price: finiteNumber(row?.price),
        ai_rank: finiteNumber(row?.rank) ?? index + 1,
        ai_rank_score: score,
        ai_direction: direction === 'bullish' ? 'bullish' : 'watch',
        ai_probability_up: finiteNumber(row?.prediction_signal?.probability_up),
        ai_entry_ready: row?.prediction_signal?.entry_ready === true,
        ai_model: row?.prediction_signal?.model || null,
        ai_generated_at: row?.generated_at || null,
        candidate_source: 'ai_suggestion',
      }
    })
    .filter(Boolean)
    .filter(row => {
      if (seen.has(row.ticker)) return false
      seen.add(row.ticker)
      return true
    })
    .sort((a, b) => {
      if (a.ai_entry_ready !== b.ai_entry_ready) return a.ai_entry_ready ? -1 : 1
      return b.ai_rank_score - a.ai_rank_score || a.ai_rank - b.ai_rank
    })
    .slice(0, maxRows)
}

export function internalAiRankingsUrl() {
  const explicit = String(process.env.AI_RANKINGS_INTERNAL_URL || '').trim()
  if (explicit) return explicit
  const port = Number(process.env.PORT || 3001)
  return `http://127.0.0.1:${port}/api/ai/rankings`
}

export async function loadAiPositionCandidates({
  limit = 30,
  minScore = Number(process.env.POSITION_AI_MIN_SCORE || 50),
  days = Number(process.env.POSITION_AI_NEWS_DAYS || 3),
  socialWindow = Number(process.env.POSITION_AI_SOCIAL_WINDOW_MINUTES || 1440),
  fetchImpl = globalThis.fetch,
  url = internalAiRankingsUrl(),
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable')
  const requestLimit = Math.max(1, Math.min(100, Math.max(Number(limit) || 30, 50)))
  const endpoint = new URL(url)
  endpoint.searchParams.set('days', String(Math.max(1, Math.min(14, Number(days) || 3))))
  endpoint.searchParams.set('limit', String(requestLimit))
  endpoint.searchParams.set('window_minutes', String(Math.max(5, Math.min(4320, Number(socialWindow) || 1440))))
  endpoint.searchParams.set('min_score', '0')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30_000)
  try {
    const response = await fetchImpl(endpoint, { signal: controller.signal })
    if (!response.ok) throw new Error(`AI rankings responded ${response.status}`)
    const payload = await response.json()
    if (payload?.ok !== true || !Array.isArray(payload?.rows)) {
      throw new Error(payload?.error || 'AI rankings returned an invalid payload')
    }
    return {
      candidates: selectAiPositionCandidates(payload.rows, { limit, minScore }),
      generated_at: payload.generated_at || null,
      model: payload.model || null,
      source_rows: payload.rows.length,
      min_score: Number(minScore),
    }
  } finally {
    clearTimeout(timer)
  }
}
