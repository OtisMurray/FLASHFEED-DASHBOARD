export interface Article {
  id:             string
  article_id?:    string
  title:          string
  source:         string
  category?:      string | null
  publish_date:   number
  ticker?:        string | null
  company?:       string | null
  sentiment?:     'bullish' | 'bearish' | 'neutral' | null
  ml_confidence?: number | null
  url?:           string
  content?:       string
}

export interface ScreenerRow {
  ticker:               string
  company:              string
  price:                number
  change_pct:           number
  volume:               number
  market_cap?:          number
  sector?:              string
  industry?:            string
  avg_sentiment:        number
  social_sentiment:     number
  structured_sentiment: number
  message_count:        number
  // AI/social breakdown the backend already merges into every row (declared so
  // the row renderer is type-clean — previously read via `as any`).
  bullish_count:         number
  bearish_count:         number
  neutral_count:         number
  news_article_count:    number
  sources:               string[]
  direction?:            string | null
  conviction?:           number | null
  news_catalyst?:        string | null
  // Computed screener columns (additive). Null when the source has no data for
  // the ticker — render as "—", excluded from thresholds, sorted last.
  news_sentiment:        number | null   // FeedFlash FinBERT/VADER mean, last 3d
  news_article_count_3d: number | null   // scored articles backing news_sentiment
  stocktwits_sentiment:  number | null   // Stocktwits (bull−bear)/tagged, 72h
  stocktwits_density:    number | null   // Stocktwits message count, 72h
}

export interface SocialPost {
  id?:        string
  post_id?:   string
  platform:   'reddit' | 'twitter' | 'stocktwits' | 'bluesky'
  author:     string
  content:    string
  created_at: string
  ticker?:    string | null
  sentiment?: number | null
  url?:       string
}

export interface CorrelationEntry {
  ticker:      string
  correlation: number
  p_value:     number
  sample_size: number
}
