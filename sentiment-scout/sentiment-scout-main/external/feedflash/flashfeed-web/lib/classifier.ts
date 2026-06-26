// ─── Dictionary sentiment (mirrors C++ SentimentClassifier) ──────────────────
export const BULLISH_KW = [
  'ipo', 'beat', 'deal', 'gain', 'hire', 'rose', 'grew', 'soar',
  'beats', 'surge', 'rally', 'jumps', 'rises', 'buyback', 'record',
  'profit', 'growth', 'strong', 'raised', 'expand', 'upgrade', 'dividend',
  'approved', 'approval', 'acquire', 'exceeds', 'outperform', 'breakout',
  'earnings beat', 'revenue beat', 'guidance raised', 'guidance raise',
  'raises guidance', 'stock split', 'share buyback', 'record revenue',
  'record profit', 'partnership', 'new contract', 'wins contract',
]
export const BEARISH_KW = [
  'miss', 'loss', 'drop', 'halt', 'fine', 'sued', 'fell', 'sank',
  'misses', 'recall', 'layoff', 'layoffs', 'plunge', 'tumble', 'slides',
  'declines', 'warning', 'cutback', 'deficit', 'downgrade', 'shortfall',
  'bankrupt', 'subpoena', 'probe', 'fraud', 'penalty', 'suspend',
  'earnings miss', 'revenue miss', 'guidance cut', 'cuts guidance',
  'lowers guidance', 'misses estimates', 'below expectations',
  'investigation', 'class action', 'bankruptcy', 'restructuring',
  'workforce reduction', 'job cuts', 'revenue decline', 'profit warning',
]

export function dictionarySentiment(title: string, content = ''): 'bullish' | 'bearish' | 'neutral' {
  const t = (title + ' ' + content.slice(0, 300)).toLowerCase()
  const bull = BULLISH_KW.filter(k => t.includes(k)).length * 2
  const bear = BEARISH_KW.filter(k => t.includes(k)).length * 2
  if (bull === bear) return 'neutral'
  return bull > bear ? 'bullish' : 'bearish'
}
