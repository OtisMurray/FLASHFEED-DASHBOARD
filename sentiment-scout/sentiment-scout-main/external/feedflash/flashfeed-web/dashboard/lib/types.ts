export interface Article {
  id: string; title: string; content: string | null; url: string;
  source: string; category: string | null;
  publish_date: number | null; fetched_date: number;
  ticker: string | null; company: string | null;
  sentiment: 'bullish' | 'bearish' | 'neutral' | null;
  sentiment_at: number | null; ml_confidence: number | null;
}

export interface ScreenerRow {
  ticker: string; company: string | null;
  structured_sentiment: number; social_sentiment: number;
  avg_sentiment: number; message_count: number;
  bullish_count: number; bearish_count: number; neutral_count: number;
  news_article_count?: number; sources?: string[];
  price?: number; change_pct?: number; volume?: number;
  sector?: string; industry?: string;
}

export interface MomentumRow {
  ticker: string; company: string | null;
  price: number | null; change_pct: number | null; volume: number | null;
  sentiment: number; article_count: number;
  sparkline?: number[];
}

export interface SocialPost {
  id: string; platform: string; author: string;
  content: string; created_at: string;
  ticker: string | null; sentiment: number | null; url: string | null;
}

export interface CorrelationEntry {
  ticker: string; correlation: number; p_value: number;
  sample_size: number; updated_at: string;
}

export interface WorkerHealth {
  ok: boolean; lastRun: string | null; pid?: number;
}

export interface ApiStatus {
  ok: boolean; articles: number; db: boolean; binary: boolean;
  workers?: { sentiment: WorkerHealth; correlation: WorkerHealth };
}
