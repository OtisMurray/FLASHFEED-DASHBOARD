function finiteNumber(value) {
  if (value == null || value === '' || typeof value === 'boolean') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function clamp(value, min = 0, max = 1) {
  const n = Number(value)
  if (!Number.isFinite(n)) return min
  return Math.max(min, Math.min(max, n))
}

function normalizedText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

const NEGATIVE_NEWS_RE = /\b(negative outlook|outlooks to negative|downgrade|cuts guidance|cut guidance|guidance cut|bankruptcy|going concern|delisting|delist|halted|sec charges|subpoena|class action|lawsuit|securities fraud|investigating whether|shareholder alert|lead plaintiff|registered direct offering|public offering|atm offering|warrant exercise|convertible notes?|reverse split|pricing of offering|announces offering|miss(?:es|ed)? estimates|fda rejection|clinical hold)\b/i
const POSITIVE_NEWS_RE = /\b(launch|launches|agreement|partnership|partners with|contract|award|wins|approval|clearance|fda clearance|breakthrough|raises guidance|record revenue|acquires|acquisition|strategic investment|share repurchase|buyback|selected by|expands|collaboration|positive topline|patent granted)\b/i
const ROUTINE_NEWS_RE = /\b(date for .*earnings|earnings conference call|regular quarterly common stock dividend|declares regular quarterly|monthly update|ratings? affirmed|senior leadership promotion|leadership transition)\b/i

export function aiArticleSentiment(article = {}) {
  const text = normalizedText(`${article.title || ''} ${article.summary || ''} ${article.content || ''}`)
  const direct = finiteNumber(article.sentiment_score ?? article.finbert_score ?? article.vader_score ?? article.gemini_sentiment)
  const label = String(article.sentiment || '').toLowerCase()
  let score = direct
  if (score == null) {
    if (/bull|positive/.test(label)) score = 0.58
    else if (/bear|negative/.test(label)) score = -0.58
    else if (/neutral/.test(label)) score = 0
  }
  if (score == null) return null
  score = clamp(score, -1, 1)

  // These headline rules intentionally run after model/source labels. They fix
  // common finance-specific cases where generic sentiment models misread legal
  // alerts, offerings, and routine announcements.
  if (text && NEGATIVE_NEWS_RE.test(text)) return -0.72
  if (text && ROUTINE_NEWS_RE.test(text)) return Math.abs(score) > 0.35 ? 0 : score
  if (text && POSITIVE_NEWS_RE.test(text) && score > -0.25) return Math.max(score, 0.62)
  return score
}

export function scoreAiRankingEvidence(input = {}) {
  const tradeScore = clamp(input.tradeScore)
  const newsAvg = clamp(input.newsAvg ?? 0, -1, 1)
  const newsScore = clamp((newsAvg + 1) / 2)
  const evidenceScore = clamp(input.evidenceScore)
  const socialCount = Math.max(0, Number(input.socialCount || 0))
  const socialSentiment = clamp(input.socialSentiment ?? 0, -1, 1)
  const predictionScore = clamp(input.predictionScore ?? 0.5)
  const quoteFreshness = clamp(input.quoteFreshness ?? 0.5)
  const densityCorrelation = input.densityCorrelation == null ? null : clamp(input.densityCorrelation, -1, 1)
  const densityCorrelationComponent = densityCorrelation == null ? 0.5 : (densityCorrelation + 1) / 2
  const validationCorrelation = clamp(input.validationCorrelation ?? 0, -1, 1)
  const validationAccuracy = finiteNumber(input.validationAccuracy)
  const validationReturn = finiteNumber(input.validationReturn)
  const validationSamples = finiteNumber(input.validationSamples)
  const densitySetupScore = clamp(input.densitySetupScore ?? 0)
  const densityStatus = String(input.densityStatus || '')
  const densitySetupActive = ['entry_passed', 'active_setup_already_above_threshold', 'near_threshold_setup'].includes(densityStatus)
  const changePct = Number(input.changePct || 0)
  const relVolume = Number(input.relVolume || 0)
  const activeSignalDirection = String(input.activeSignalDirection || '').toLowerCase()
  const bullishNews = Math.max(0, Number(input.bullishNews || 0))
  const bearishNews = Math.max(0, Number(input.bearishNews || 0))
  const newsArticleCount = Math.max(0, Number(input.newsArticleCount || 0))

  const validationEdge = clamp(
    (Number.isFinite(validationAccuracy) ? Math.max(0, validationAccuracy - 0.5) * 1.4 : 0) +
    Math.max(0, validationCorrelation) * 0.25 +
    (Number.isFinite(validationReturn) ? Math.max(0, validationReturn) / 3 : 0),
    0,
    1,
  )

  const socialDensity = clamp(Math.log1p(socialCount) / Math.log1p(80))
  const positiveCatalyst = Boolean(
    (newsArticleCount > 0 && newsAvg > 0.05 && bullishNews >= bearishNews) ||
    (socialCount > 0 && socialSentiment > 0.08) ||
    densitySetupActive ||
    (densityCorrelation != null && densityCorrelation > 0.34) ||
    validationEdge > 0.10 ||
    Number(input.isNewsCatalyst || 0) === 1
  )

  const negativeNewsPressure = newsArticleCount > 0 && newsAvg <= -0.12 && bearishNews >= Math.max(1, bullishNews)
  const negativeSocialPressure = socialCount >= 3 && socialSentiment <= -0.18
  const downModelPressure = activeSignalDirection === 'down' && predictionScore <= 0.46
  const negativeValidationPressure = Number.isFinite(validationReturn) && validationReturn <= -0.35 && (validationSamples == null || validationSamples >= 5)
  const negativeCorrelationPressure = densityCorrelation != null && densityCorrelation <= -0.25 && socialCount >= 3 && changePct < 0
  const bearishEvidence = Boolean(
    negativeNewsPressure ||
    negativeSocialPressure ||
    downModelPressure ||
    negativeValidationPressure ||
    negativeCorrelationPressure
  )
  const strongNegativeEvidence = Boolean(
    (negativeNewsPressure && newsAvg <= -0.28) ||
    (negativeSocialPressure && socialSentiment <= -0.32) ||
    (downModelPressure && predictionScore <= 0.40) ||
    (negativeValidationPressure && validationReturn <= -0.75)
  )

  const technicalConfirmation = positiveCatalyst && !strongNegativeEvidence ? clamp(
    (Number(input.rsi || 50) >= 38 && Number(input.rsi || 50) <= 68 ? 0.35 : 0) +
    (Number(input.rsiOversold || 0) * 0.20) +
    (changePct >= -4 && changePct <= 12 ? 0.20 : 0) +
    (relVolume >= 1.25 ? 0.25 : 0),
    0,
    1,
  ) : 0

  const modelDirectionBoost = activeSignalDirection === 'up' ? 0.08 : activeSignalDirection === 'down' ? -0.08 : 0
  const bearishPressure = clamp(
    (negativeNewsPressure ? 0.34 : 0) +
    (negativeSocialPressure ? 0.24 : 0) +
    (downModelPressure ? 0.24 : 0) +
    (negativeValidationPressure ? 0.14 : 0) +
    (negativeCorrelationPressure ? 0.12 : 0) +
    (changePct <= -2 ? 0.08 : 0),
    0,
    1,
  )

  const blended = clamp(
    tradeScore * 0.20 + newsScore * 0.16 + evidenceScore * 0.13 + socialDensity * 0.08 +
    predictionScore * 0.15 + quoteFreshness * 0.05 + densityCorrelationComponent * 0.08 +
    densitySetupScore * 0.06 + validationEdge * 0.05 + technicalConfirmation * 0.04 +
    modelDirectionBoost - bearishPressure * 0.10
  )
  const aiRankScore = Number((blended * 100).toFixed(1))

  const bullishEvidence = positiveCatalyst &&
    !strongNegativeEvidence &&
    changePct >= -1.5 &&
    (aiRankScore >= 60 || tradeScore >= 0.68 || (densitySetupActive && aiRankScore >= 56))
  const bearishDirection = bearishEvidence &&
    (activeSignalDirection === 'down' || aiRankScore <= 45 || changePct <= -2 || strongNegativeEvidence)
  const direction = bullishEvidence ? 'bullish' : bearishDirection ? 'bearish' : 'watch'

  return {
    blended,
    aiRankScore,
    direction,
    confidence: Number(Math.abs(blended - 0.5).toFixed(3)),
    positiveCatalyst,
    bullishEvidence,
    bearishEvidence,
    strongNegativeEvidence,
    bearishPressure: Number(bearishPressure.toFixed(3)),
    socialDensity,
    densityCorrelationComponent,
    validationEdge,
    densitySetupActive,
    technicalConfirmation,
    modelDirectionBoost,
  }
}
