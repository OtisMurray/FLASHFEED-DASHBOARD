export interface TickerData {
  ticker: string;
  company?: string | null;
  avg_sentiment: number;
  message_count: number;
  bullish_count: number;
  bearish_count: number;
  neutral_count: number;
  window_minutes: number;
  price: number;
  market_cap: string;
  pe_ratio: number | null;
  analyst_recom: number | null;
  sources?: ("reddit" | "bluesky" | "twitter")[];
  // Phase 3: Three extra screener columns
  structured_sentiment: number | null;  // news article sentiment
  social_sentiment: number | null;      // social media sentiment (= avg_sentiment)
  message_density: number;              // message count in window
  news_article_count: number;           // count of scored articles for this ticker
  // Finviz-style screening fields
  change_pct: number | null;            // today's % price change
  volume: number | null;                // today's volume
  avg_volume: number | null;            // 50-day avg volume
  sector: string | null;
  industry: string | null;
  earnings_date: string | null;         // ISO date of next earnings
  week_52_high: number | null;
  week_52_low: number | null;
}

export interface HistoryPoint {
  ticker: string;
  window_minutes: number;
  avg_sentiment: number;
  message_count: number;
  bullish_count: number;
  bearish_count: number;
  neutral_count: number;
  window_start: string;
  window_end: string;
  computed_at: string;
}

export interface Post {
  id: string;
  source: "reddit" | "bluesky" | "twitter";
  subreddit?: string;
  author: string;
  title: string;
  text: string;
  url: string;
  score: number;
  num_comments: number;
  published_at: string;
  detected_at: string;
  tickers_mentioned: string[];
  sentiment_score: number;
  is_duplicate: boolean;
  is_spam: boolean;
  is_rumor?: boolean;
}

export interface Alert {
  ticker: string;
  type: "volume_spike" | "sentiment_spike";
  message: string;
  severity: "high" | "medium" | "low";
  current_value: number;
  average_value: number;
  detected_at: string;
}

export interface SubredditHealth {
  source: "reddit" | "bluesky" | "twitter";
  subreddit: string;
  post_count: number;
  latest_post: string | null;
}

export interface HotPhrase {
  phrase: string;
  count: number;
  sentiment: number;
  weight: number;
}

// ── RSS News (FlashFeed integration) ──────────────────────────────────────────

export interface Article {
  id: string;
  title: string;
  content: string;
  url: string;
  source: string;
  category: string;
  publish_date: number | null;
  fetched_date: number;
  ticker: string;
  sentiment: "bullish" | "bearish" | "neutral" | null;
  ml_confidence: number | null;
  sentiment_at: number | null;
}

export interface NewsStats {
  total: number;
  sources: Array<{ source: string; count: number }>;
  categories: Array<{ category: string; count: number }>;
  sentiment: {
    bullish: number;
    bearish: number;
    neutral: number;
    unanalyzed: number;
  } | null;
  recency: {
    last_fetch: number | null;
    oldest: number | null;
    newest: number | null;
  } | null;
}
