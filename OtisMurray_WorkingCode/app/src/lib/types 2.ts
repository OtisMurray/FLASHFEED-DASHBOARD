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
  positive_mover_match?: boolean
  matched_mover_tickers?: string[]
}

export interface ScreenerRow {
  ticker:               string
  company?:             string
  price?:               number | null
  change_pct?:          number
  volume?:              number
  market_cap?:          number
  market_cap_bucket?:   string
  sector?:              string
  industry?:            string
  country?:             string
  exchange?:            string
  index?:               string
  avg_sentiment?:       number
  social_sentiment?:    number
  social_message_sentiment?: number
  social_message_density?: number
  stocktwits_message_count?: number
  structured_sentiment?: number
  message_count?:       number
  news_article_count?:  number
  bullish_count?:       number
  bearish_count?:       number
  neutral_count?:       number
  sources?:             string[]
  avg_volume?:          number
  pe_ratio?:            number | null
  forward_pe?:          number | null
  peg?:                 number | null
  ps_ratio?:            number | null
  pb_ratio?:            number | null
  dividend_yield?:      number | null
  eps_growth_this_y?:   number | null
  eps_growth_next_y?:   number | null
  sales_growth?:        number | null
  gross_margin?:        number | null
  operating_margin?:    number | null
  roe?:                 number | null
  debt_equity?:         number | null
  beta?:                number | null
  rsi?:                 number | null
  sma20?:               number | null
  sma50?:               number | null
  sma200?:              number | null
  perf_week?:           number | null
  perf_month?:          number | null
  perf_quarter?:        number | null
  perf_half?:           number | null
  perf_year?:           number | null
  perf_ytd?:            number | null
  atr?:                 number | null
  gap?:                 number | null
  high_52w?:            number | null
  low_52w?:             number | null
  analyst?:             string | null
  target_price?:        number | null
  inst_own?:            number | null
  insider_own?:         number | null
  float_short?:         number | null
  earnings_date?:       string | null
  quote_status?:        string
  quote_source?:        string | null
  quote_time?:          string | null
  quote_updated_at?:    number | string | null
  rolling_window_minutes?: number
  latest_publish?:      number | string | null
  latest_social?:       number | string | null
}

export interface MomentumRow {
  ticker:           string
  company?:         string
  price?:           number | null
  change_pct?:      number
  volume?:          number
  avg_volume?:      number
  rel_volume?:      number
  sentiment?:       number
  article_sentiment?: number
  structured_sentiment?: number
  unstructured_sentiment?: number
  social_sentiment?: number
  momentum_score?:  number
  article_count?:   number
  structured_article_count?: number
  unstructured_article_count?: number
  message_count?:   number
  bullish_count?:   number
  bearish_count?:   number
  neutral_count?:   number
  sources?:         string[]
  quote_status?:    string
  quote_source?:    string | null
  quote_time?:      string | null
  quote_updated_at?: number | string | null
  discovery_source?: string
  positive_mover?:   boolean
  finviz_rank?:      number
  latest_social?:    number | null
  ai_numeric_rank?:   number
  trade_watch?: {
    trade_watch_score: number
    decision: string
    confidence: number
    agreement: number
    evidence_score: number
    quote_freshness?: number
    quote_age_minutes?: number | null
    support_count?: number
    reasons?: string[]
    risks?: string[]
  }
  bracket_order?: {
    candidate: boolean
    confidence: number
    direction: string
    entry_reference?: number | null
    stop_loss_pct?: number
    take_profit_pct?: number
    support_count?: number
    rationale?: string[]
    status?: string
  }
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
  window_days?: number
  news_sentiment?: number
  social_sentiment?: number
  combined_sentiment?: number
  sentiment_pressure?: number
  news_pressure?: number
  social_pressure?: number
  price_momentum?: number
  robust_price_momentum?: number
  price_move_valid?: boolean
  flat_previous_close?: boolean
  change_pct?: number
  price?: number | null
  previous_close?: number | null
  article_count?: number
  social_count?: number
  evidence_count?: number
  reliability_weight?: number
  signal_score?: number
  confidence?: number
  evidence_quality?: 'high' | 'medium' | 'thin' | string
  direction?: 'aligned' | 'divergent' | string
  generated?: boolean
  signal_type?: string
  quote_source?: string | null
  quote_time?: string | null
  quote_updated_at?: number | string | null
  avg_abs_correlation?: number | null
  pearson_correlation?: number | null
}
