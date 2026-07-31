export interface Article {
  id:             string
  article_id?:    string
  title:          string
  source:         string
  category?:      string | null
  publish_date:   number
  fetched_date?:  number
  detected_at?:   number
  ticker?:        string | null
  tickers?:       string[]
  company?:       string | null
  sentiment?:     'bullish' | 'bearish' | 'neutral' | null
  ml_confidence?: number | null
  url?:           string
  content?:       string
  positive_mover_match?: boolean
  matched_mover_tickers?: string[]
  ticker_match_method?: string
  ticker_match_confidence?: number
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
  message_density_now?: number
  message_density_5m?: number
  message_density_15m?: number
  message_density_30m?: number
  message_density_60m?: number
  message_density_prev_window?: number
  message_density_change?: number
  message_density_change_pct?: number
  message_density_trend?: string
  message_density_rising?: boolean
  message_density_supported?: boolean
  message_density_score?: number
  message_density_live_score?: number
  message_density_carry_score?: number
  message_density_session_count?: number
  message_density_session_minutes?: number
  message_density_session_density?: number
  message_density_last_event_age_minutes?: number | null
  message_density_active_15m?: number
  message_density_active_60m?: number
  short_squeeze_score?: number
  short_squeeze_available?: boolean
  short_squeeze_reason?: string
  short_squeeze_components?: Record<string, unknown>
  float_or_short_interest_available?: boolean
  squeeze_proxy_used?: boolean
  squeeze_signal?: string
  structured_news_score?: number
  structured_news_available?: boolean
  best_structured_catalyst_headline?: string | null
  best_structured_catalyst_source?: string | null
  best_structured_catalyst_age_minutes?: number | null
  structured_catalyst_type?: string | null
  structured_catalyst_sentiment?: number | null
  structured_catalyst_confidence?: number | null
  stocktwits_message_sentiment?: number
  stocktwits_message_density?: number
  stocktwits_message_count?: number
  reddit_message_count?: number
  bluesky_message_count?: number
  twitter_message_count?: number
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
  // high_52w / low_52w were declared here but NOTHING in the tree ever wrote
  // them — the only readers were the dead ScreenerTable mirrors. Removed rather
  // than left as a decoy beside the real week_52_high / week_52_low fields.
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
  prediction_status?:    'available' | 'no_prediction' | string
  prediction_direction?: string | null
  predicted_return?:     number | null
  stored_predicted_return?: number | null
  final_predicted_percent?: number | null
  prediction_confidence?: number | null
  prediction_debug?: Record<string, unknown> | null
  prediction_scorecard?: {
    probability_up?: number | null
    expected_move_pct?: number | null
    expected_move_low_pct?: number | null
    expected_move_high_pct?: number | null
    confidence?: number | null
    signal_quality_score?: number
    signal_quality?: string
    catalyst_quality_score?: number
    catalyst_quality_tier?: string
    timing_quality_score?: number
    timing_quality?: string
    liquidity_risk_score?: number
    liquidity_risk?: string
    reversal_risk_score?: number
    reversal_risk?: string
    evidence_completeness_score?: number
    evidence_completeness?: string
    primary_reasons?: string[]
    primary_cautions?: string[]
    dollar_volume?: number | null
    inputs_present?: Record<string, boolean>
  } | null
  prediction_explanation?: string | null
  prediction_source_code?: string | null
  prediction_source_label?: string | null
  prediction_source_tone?: string | null
  prediction_trade_ready?: boolean
  prediction_readiness_level?: string | null
  prediction_readiness_label?: string | null
  prediction_readiness_tone?: string | null
  prediction_waiting_for?: string[]
  prediction_blocked_reasons?: string[]
  prediction_tier?: string | null
  prediction_decision_reason?: string | null
  reason_included_detail?: string | null
  catalyst_quality_score?: number | null
  catalyst_quality_tier?: string | null
  catalyst_quality?: {
    score?: number
    tier?: string
    class?: string
    source_score?: number
    specificity_score?: number
    freshness_score?: number
    recognized_source?: boolean
    ticker_specific?: boolean
    weak_generic?: boolean
    bearish?: boolean
    is_filing?: boolean
    reasons?: string[]
    title?: string
    source?: string | null
  } | null
  pending_open_confirmed?: boolean | null
  pending_open_payoff_override?: boolean | null
  pending_open_confirmation?: {
    is_pending_open?: boolean
    passes?: boolean
    support_reasons?: string[]
    blocked_reasons?: string[]
    payoff_margin?: number | null
    thresholds?: Record<string, unknown>
  } | null
  prediction_readiness?: {
    level?: string
    label?: string
    tone?: string
    trade_ready?: boolean
    high_conviction_ready?: boolean
    waiting_for?: string[]
    blocked_reasons?: string[]
    reaction?: Record<string, unknown>
  } | null
  catalyst_reaction_summary?: {
    available?: boolean
    state?: string
    label?: string
    tone?: string
    rejection?: string | null
    pending_market_reaction?: boolean
    first_reaction_state?: string
    event_sec?: number | null
    market_session?: string | null
    event_in_session_window?: boolean
    minutes_since_catalyst?: number | null
    runup_pct?: number | null
    latest_return_pct?: number | null
    giveback_from_high_pct?: number | null
    anchor_price?: number | null
    latest_close?: number | null
    high_after_catalyst?: number | null
    source?: string | null
    thresholds?: Record<string, unknown>
  } | null
  prediction_horizon_requested?: string
  prediction_generated_at?: number | string | null
  prediction?: {
    horizon?: string
    requested_horizon?: string
    horizon_supported?: boolean
    is_next_day_proxy?: boolean
    predictedReturn?: number | null
    predictedDirection?: string | null
    confidence?: number | null
    probabilityUp?: number | null
    modelVersion?: string | number | null
    model?: string | null
    generatedAt?: number | string | null
    generatedAtSec?: number | null
    source?: string
    decision?: string
  } | null
  catalysts?: Array<{
    type?: string
    source?: string
    title?: string
    publishedAt?: number | null
    url?: string
    sentiment?: string
    sentimentScore?: number
    relevanceScore?: number
    isSecFiling?: boolean
    filingContentStatus?: string | null
    filingContentLength?: number | null
    accessionNumber?: string | null
    formType?: string | null
  }>
  main_catalyst?: {
    type?: string
    source?: string
    title?: string
    publishedAt?: number | null
    sentiment?: string
    sentimentScore?: number
    isSecFiling?: boolean
    filingContentStatus?: string | null
  } | null
  filing_sentiment?: number
  filing_article_count?: number
  filing_used_count?: number
  sec_filing_contributed?: boolean
  final_prediction_score?: number
  signal_quality?: string
  signal_quality_score?: number
  timing_quality?: string
  timing_quality_score?: number
  liquidity_risk?: string
  liquidity_risk_score?: number
  reversal_risk?: string
  reversal_risk_score?: number
  evidence_completeness?: string
  evidence_completeness_score?: number
  expected_move_low_pct?: number | null
  expected_move_high_pct?: number | null
  primary_reasons?: string[]
  primary_cautions?: string[]
  risk_flags?: string[]
  high_conviction?: boolean
  high_conviction_rank?: number
  high_conviction_fallback?: boolean
  isFallback?: boolean
  is_fallback?: boolean
  fallbackReason?: string | null
  fallback_reason?: string | null
  watchScore?: number | null
  watch_score?: number | null
  predictionDate?: string | null
  targetDate?: string | null
  predictionTimestamp?: number | string | null
  predictedDirection?: string | null
  predictedReturnPct?: number | null
  convictionScore?: number | null
  dataQuality?: string | null
  data_quality?: string | null
  session?: string | null
  fallback_prediction_direction?: string | null
  fallback_confidence?: number | null
  evidence_score?: number | null
  model_mode?: string | null
  // prediction_source_code / _label / _tone were declared twice in this same
  // interface with identical `?: string | null` types — TS2300 x3 x2. The
  // surviving declaration lives with the other prediction_* fields above
  // (next to prediction_explanation), which is where it belongs.
  entry_signal?: Record<string, unknown> | null
  threshold_setup_status?: string | null
  threshold_setup_score?: number | null
  threshold_setup_distance_to_entry?: number | null
  price_density_correlation?: number | null
  previous_price_density_correlation?: number | null
  threshold_pre_return_60m_pct?: number | null
  threshold_trailing_60m_messages?: number | null
  reason_included?: string | null
  catalyst_summary?: string | null
  generated_at?: number | string | null
  screener_snapshot_at?: number | string | null
  cache_status?: string | null
  change_percent?: number | null
  // Both spellings are real and the API is not consistent about them: the
  // screener emits `rel_volume` (live rows carry e.g. 0.57 while
  // relative_volume is null), and decisionMap.js reads
  // `doc.rel_volume ?? doc.relative_volume`. ChartsGridPage and MirrorPage were
  // already reading the one the API actually sends; only the type was missing
  // it, so this is a type correction — the RelVol cells were never broken.
  relative_volume?: number | null
  rel_volume?:      number | null
  decision_candidate?: boolean
  decision_candidate_score?: number
  decision_candidate_source?: string
  professor_sendable?: boolean
  score_breakdown?: Record<string, unknown>
  dashboard_assessment?: Record<string, unknown>
  momentum_score?: number
  ai_score?: number
  correlation_score?: number
  ai_context?: Record<string, unknown> | null
  momentum_context?: Record<string, unknown> | null
  correlation_context?: Record<string, unknown> | null
  news_sentiment?: number
  stocktwits_sentiment?: number
  stocktwits_density?: number
}

export interface MomentumRow {
  ticker:           string
  company?:         string
  price?:           number | null
  change_pct?:      number
  active_session?:  string
  session_price?:   number | null
  session_change_pct?: number | null
  session_volume?:  number | null
  regular_change_pct?: number | null
  premarket_change_pct?: number | null
  postmarket_change_pct?: number | null
  market_cap?:      number | null
  market_cap_bucket?: string
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
  latest_publish?:   number | string | null
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
    score_breakdown?: {
      price_action?: number
      relative_volume?: number
      evidence?: number
      agreement?: number
      freshness?: number
      penalties?: number
    }
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

// v11 Screener (experimental) — postmortem replay of one fixed backtest profile
// over the catalyst-enriched set. Rows from /api/v11-screener.
export interface V11EvidenceGate {
  required: boolean
  ok: boolean
  status: string
  shortSupport?: boolean
  catalystSupport?: boolean
  socialSupport?: boolean
}

export interface V11ScreenerRow {
  ticker: string
  company?: string
  tier?: string
  prediction_date?: string | null
  session_date?: string | null
  catalyst_reason?: string
  status: 'entered' | 'no_entry' | 'insufficient_bars' | 'missing_session_date' | 'bad_session_date' | 'error' | string
  evidence?: V11EvidenceGate
  entry?: {
    price?: number | null
    signal_sec?: number | null
    entry_sec?: number | null
    corr?: number | null
    prev_corr?: number | null
    pre_return_60m_pct?: number | null
    active_move_pct?: number | null
    trailing_60m_messages?: number | null
    gate_reason?: string
  }
  legs?: {
    partial?: { filled?: boolean; price?: number | null; pnl_pct?: number | null; exit_sec?: number | null }
    runner?: { price?: number | null; pnl_pct?: number | null; exit_sec?: number | null; exit_reason?: string }
  }
  outcome?: {
    realized_return_pct?: number | null
    gross_return_pct?: number | null
    won?: boolean
    max_forward_return_pct?: number | null
    min_forward_return_pct?: number | null
  }
  reject?: { reason?: string; gate_reason?: string; active_move_pct?: number | null; evidence_status?: string }
  note?: string
  bars?: number
}

export interface V11Profile {
  label: string
  windowMinutes: number
  thresholdC: number
  maxPreSignalReturn60mPct: number
  minTrailing60Messages: number
  activeMoveMinPct: number
  activeMoveMaxPct: number
  partialExitFraction: number
  partialProfitTargetPct: number
  profitGivebackPct: number
  profitGivebackActivationPct: number
  protectiveStopPct: number
  exitPlan: string
}

export interface V11ScreenerResponse {
  ok: boolean
  profile: V11Profile
  universe: string
  mode: string
  experimental: boolean
  candidates_scanned?: number
  count: number
  entered: number
  rows: V11ScreenerRow[]
  note?: string
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

// Exit Screener — one row per simulated position derived live by the
// chart-service strategy sim (/api/exit-screener).
export interface ExitScreenerRow {
  ticker:               string
  company?:             string
  date?:                string | null
  entry_price?:         number | null
  entry_time?:          string | null
  entry_epoch?:         number | null
  entry_corr?:          number | null
  current_price?:       number | null
  pnl_pct?:             number | null
  trailing_stop_pct?:   number
  peak_price?:          number | null
  stop_price?:          number | null
  distance_to_stop_pct?: number | null
  status?:              'Holding' | 'Stopped Out' | string
  exit_price?:          number | null
  exit_time?:           string | null
  exit_reason?:         'price_trailing_stop' | 'correlation_break' | 'session_end' | string
  exit_corr?:           number | null
  corr_status?:         string
}

// Entry Screener — ranked rows from /api/entry-screener (rolling price×density
// correlation joined with Mongo quote rows).
export interface EntryScreenerRow {
  ticker:                  string
  company?:                string
  market_cap?:             number | null
  price?:                  number | null
  change_pct?:             number | null
  msg_density_rolling?:    number | null
  session_messages?:       number
  stocktwits_count_window?: number
  price_density_corr?:     number | null
  entry_score?:            number | null
  passes_threshold?:       boolean
  corr_status?:            string
  corr_date?:              string | null
}

// Long-Term Fundamentals — rows from /api/long-term-fundamentals. Unlike every other
// screener in this app (which run on 120-360 min intraday correlation windows),
// this one is multi-month/multi-year and reads only Finviz Elite fundamentals.
export interface LongTermScoreComponents {
  range_position:  number | null   // where price sits in its 52-week range
  return_1y:       number | null   // realized trailing 1-year return
  trend_200d:      number | null   // price vs its 200-day average
  analyst_rating:  number | null   // sell-side consensus (Finviz 1..5, 1 = best)
  fundamentals:    number | null   // profitability / leverage / valuation blend
}

export interface LongTermFundamentalsRow {
  ticker:               string
  company?:             string
  sector?:              string
  market_cap?:          number | null
  market_cap_bucket?:   string
  price?:               number | null
  change_pct?:          number | null

  // long_term_score is the honest renormalized value shown to the user;
  // ranked_score is that value shrunk toward neutral by evidence coverage and is
  // what the server sorts on, so thin rows cannot top the board on missing data.
  long_term_score?:     number | null
  ranked_score?:        number | null
  long_term_label?:     string
  components:           LongTermScoreComponents
  components_available?: number
  components_total?:    number
  score_coverage?:      number

  horizon_return?:      number | null
  perf_week?:           number | null
  perf_month?:          number | null
  perf_quarter?:        number | null
  perf_half?:           number | null
  perf_ytd?:            number | null
  perf_year?:           number | null

  // PRICE LEVELS in dollars, from either ingest. The Finviz Elite export gives
  // percent distance from the extreme; that ingest converts before writing, and
  // keeps the raw percentages in the *_pct fields below.
  week_52_high?:        number | null
  week_52_low?:         number | null
  week_52_high_pct?:    number | null   // negative = % below the 52-week high
  week_52_low_pct?:     number | null   // positive = % above the 52-week low
  sma50?:               number | null
  sma200?:              number | null
  analyst?:             string | null
  target_price?:        number | null

  pe_ratio?:            number | null
  forward_pe?:          number | null
  peg?:                 number | null
  roe?:                 number | null
  debt_equity?:         number | null
  profit_margin?:       number | null
  dividend_yield?:      number | null
  inst_own?:            number | null
}

// ── Short Squeeze screener (GET /api/squeeze-screener) ───────────────────────
// Surfaces the EXISTING squeeze-evidence gate in routes/screener.js against live
// rows, joined with the short-interest snapshots the FINRA estimator writes. No
// score of its own — `gate` is a report of predictionEvidenceValidation's verdict.

// One leg of the gate: what was required, what was observed, did it clear.
export interface SqueezeGateCheck {
  key:             'squeeze_score' | 'verified_short_interest' | 'social' | 'not_bearish_catalyst'
  label:           string
  ok:              boolean
  observed:        number | string | null
  required:        number | null
  window_minutes?: number
}

export interface SqueezeGate {
  passed:  boolean
  status:  'squeeze_catalyst_confirmed' | 'blocked' | 'blocked_upstream'
  checks:  SqueezeGateCheck[]
  failed:  string[]
  reason:  string
  // False when the per-check thresholds mirrored in squeezeScreener.js no longer
  // reproduce screener.js's verdict. `passed` stays authoritative; the per-check
  // breakdown does not, and the UI must say so rather than showing both as equals.
  trace_in_sync: boolean
}

// Where this row's short-interest number actually came from. These are not
// interchangeable and the page must never blur them.
export type SqueezeSiCoverage = 'live_estimate' | 'settlement_only' | 'finviz_only' | 'none'

export interface SqueezeScreenerRow {
  ticker:              string
  company?:            string
  sector?:             string
  market_cap?:         number | null
  market_cap_bucket?:  string
  price?:              number | null
  change_pct?:         number | null
  rel_volume?:         number | null

  squeeze_score?:      number | null
  squeeze_signal?:     string | null
  squeeze_reason?:     string | null

  short_interest_official_pct?: number | null
  short_interest_live_estimate?: number | null
  short_interest_delta_pct?:    number | null
  short_interest_pct?:          number | null
  short_interest_shares?:       number | null
  short_interest_change_pct?:   number | null
  short_covering_signal?:       string | null

  si_coverage:         SqueezeSiCoverage
  si_data_mode?:       string | null
  si_uncalibrated?:    boolean | null
  si_calibration_status?: string | null
  si_sanity_band_clamped?: boolean | null
  si_baseline_is_ticker_specific?: boolean | null
  si_observed_days?:   number | null
  si_source?:          string | null
  si_as_of_date?:      string | null
  si_settlement_date?: string | null
  si_note?:            string | null

  days_to_cover?:      number | null
  float_shares?:       number | null
  float_short_pct?:    number | null

  social_messages?:    number
  social_window_minutes?: number
  stocktwits_watcher_count?: number | null
  news_article_count?: number
  catalyst?:           string | null

  gate:                SqueezeGate
  evidence_primary?:   string
  evidence_labels?:    string[]
  risk_flags?:         string[]
}

export interface SqueezeScreenerResponse {
  ok:                  boolean
  limit?:              number
  passing_only?:       boolean
  window_minutes?:     number | null
  universe_size?:      number
  candidate_pool?:     number
  no_short_interest_data?: number
  count?:              number
  passing?:            number
  near_misses?:        number
  rows?:               SqueezeScreenerRow[]
  sorted_by?:          string
  si_coverage_counts?: Partial<Record<SqueezeSiCoverage, number>>
  si_uncalibrated_rows?: number
  si_live_estimate_rows?: number
  si_all_uncalibrated?: boolean
  gate_trace_out_of_sync_rows?: number
  gate_note?:          string
  si_note?:            string
  social_note?:        string
  trace_warning?:      string
  note?:               string
  error?:              string
}

// Positions — the unified Entry/Exit/P&L view from /api/position-screener.
// Rows come from TWO sources that must not be conflated: `live` rows are
// today's session re-simulated at the caller's parameters, `recorded` rows are
// prior sessions read back from screener_position_history, which only exists at
// the canonical parameters. Hence per-row `threshold`/`stop_pct`.
export type PositionGroup = 'open' | 'closed_today' | 'closed_earlier' | 'watch'
export type PositionProvenance = 'live' | 'recorded'
export type PositionDataStatus =
  | 'live'                        // simulated this request
  | 'recorded'                    // read back from history, settled
  | 'stale'                       // recorded but never finalized — a mid-session mark, not a result
  | 'warming'                     // still collecting StockTwits messages
  | 'no_bars'                     // no intraday bars for this ticker/session
  | 'chart_service_unavailable'

export interface PositionScreenerRow {
  group:                 PositionGroup
  provenance:            PositionProvenance
  data_status:           PositionDataStatus
  ticker:                string
  company?:              string | null
  date?:                 string | null
  entry_price?:          number | null
  entry_time?:           string | null
  entry_epoch?:          number | null
  entry_corr?:           number | null
  exit_price?:           number | null
  exit_time?:            string | null
  exit_reason?:          'price_trailing_stop' | 'correlation_break' | 'session_end' | string | null
  exit_corr?:            number | null
  current_price?:        number | null
  peak_price?:           number | null
  stop_price?:           number | null
  distance_to_stop_pct?: number | null
  pnl_pct?:              number | null
  pnl_is_realized?:      boolean | null
  // True when an open position entered on the newest real bar, so its mark IS
  // its fill and pnl_pct is 0 by construction rather than by outcome. Rendered
  // as a label, never as a flat percentage.
  pnl_pending?:          boolean | null
  bars_since_entry?:     number | null
  threshold?:            number | null
  stop_pct?:             number | null
  // watch rows only
  price?:                number | null
  price_density_corr?:   number | null
  msg_density_rolling?:  number | null
  session_messages?:     number | null
  // recorded rows only
  snapshots?:            number | null
  recorded_at?:          string | null
  // Candidate provenance captured when the AI Rankings feed admitted the ticker.
  candidate_source?:     'ai_suggestion' | 'tracked_open_position' | 'recorded_ai_suggestion' | string
  ai_rank?:              number | null
  ai_rank_score?:        number | null
  ai_direction?:         'bullish' | 'watch' | string | null
  ai_probability_up?:    number | null
  ai_entry_ready?:       boolean
  ai_model?:             string | null
}

export interface PositionScreenerResponse {
  ok:                    boolean
  threshold:             number
  stopPct:               number
  canonical:             { threshold: number; stop_pct: number }
  is_canonical:          boolean
  corr_window_minutes:   number
  chart_service_ok:      boolean
  tickers_scanned:       number
  universe_size:         number
  candidate_policy?:     string
  ai_status?:            {
    ok: boolean
    generated_at?: string | null
    source_rows?: number
    min_score?: number
    model?: { name?: string; status?: string } | null
    error?: string | null
  }
  coverage:              Record<string, number>
  tickers_warming:       number
  tickers_no_bars:       number
  counts:                Record<PositionGroup, number>
  history_days:          number
  history_rows:          number
  history_dates:         number
  history_truncated:     boolean
  newest_history_date:   string | null
  stale_rows:            number
  superseded_rows:       number
  // Live rows dropped because recorded history already described the same trade.
  live_rows_superseded_by_history?: number
  // The session the simulator actually covered. Between midnight ET and the next
  // premarket open this is YESTERDAY, not today — which is why the page must not
  // assume the live sim describes the current calendar day.
  live_session_date?:    string | null
  live_session_is_today?: boolean | null
  count:               number
  rows:                PositionScreenerRow[]
  simulation_note:     string
  parameter_note:      string
  note?:               string
}
