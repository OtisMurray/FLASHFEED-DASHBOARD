"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { Article, NewsStats } from "@/lib/types";

// ── Helpers ────────────────────────────────────────────────────────────────

function timeAgo(ts: number | null): string {
  if (!ts) return "—";
  const s = Math.floor(Date.now() / 1000 - ts);
  if (s < 60)     return "just now";
  if (s < 3600)   return `${Math.floor(s / 60)}m ago`;
  if (s < 86400)  return `${Math.floor(s / 3600)}h ago`;
  if (s < 604800) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ts * 1000).toLocaleDateString();
}

const SENTIMENT_STYLES: Record<string, string> = {
  bullish: "bg-emerald-500/10 text-emerald-400 border border-emerald-500/30",
  bearish: "bg-red-500/10 text-red-400 border border-red-500/30",
  neutral: "bg-slate-500/10 text-slate-400 border border-slate-500/30",
};

const CATEGORY_COLORS: Record<string, string> = {
  markets:        "text-blue-400",
  economy:        "text-violet-400",
  equities:       "text-cyan-400",
  filings:        "text-amber-400",
  press_releases: "text-orange-400",
  crypto:         "text-yellow-400",
  commodities:    "text-lime-400",
  fda:            "text-pink-400",
};

// ── Components ─────────────────────────────────────────────────────────────

function SentimentBadge({ s }: { s: string | null }) {
  if (!s) return <span className="text-xs text-muted-foreground">—</span>;
  return (
    <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${SENTIMENT_STYLES[s] ?? ""}`}>
      {s}
    </span>
  );
}

function TickerChips({ ticker }: { ticker: string }) {
  const tickers = ticker ? ticker.split(",").filter(Boolean) : [];
  if (!tickers.length) return null;
  return (
    <div className="flex flex-wrap gap-1 mt-1">
      {tickers.slice(0, 6).map((t) => (
        <span
          key={t}
          className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary border border-primary/20 font-mono"
        >
          {t}
        </span>
      ))}
      {tickers.length > 6 && (
        <span className="text-[10px] text-muted-foreground">+{tickers.length - 6}</span>
      )}
    </div>
  );
}

function ArticleCard({ article }: { article: Article }) {
  return (
    <a
      href={article.url}
      target="_blank"
      rel="noopener noreferrer"
      className="block p-4 rounded-lg border border-border bg-card hover:bg-card/80 hover:border-border/80 transition-colors group"
    >
      <div className="flex items-start justify-between gap-3 mb-1.5">
        <h3 className="text-sm font-medium leading-snug group-hover:text-primary transition-colors line-clamp-2">
          {article.title}
        </h3>
        <SentimentBadge s={article.sentiment} />
      </div>

      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <span className={`font-medium ${CATEGORY_COLORS[article.category] ?? "text-muted-foreground"}`}>
          {article.source}
        </span>
        <span>·</span>
        <span>{timeAgo(article.publish_date ?? article.fetched_date)}</span>
        {article.ml_confidence != null && (
          <>
            <span>·</span>
            <span>{Math.round(article.ml_confidence * 100)}% conf</span>
          </>
        )}
      </div>

      <TickerChips ticker={article.ticker} />
    </a>
  );
}

function StatsBar({ stats }: { stats: NewsStats | null }) {
  if (!stats) return null;
  const s = stats.sentiment;
  return (
    <div className="flex flex-wrap items-center gap-4 px-4 py-2 border-b border-border bg-muted/20 text-[11px] text-muted-foreground">
      <span><strong className="text-foreground">{stats.total.toLocaleString()}</strong> articles</span>
      {s && (
        <>
          <span className="text-emerald-400">▲ {s.bullish.toLocaleString()} bullish</span>
          <span className="text-red-400">▼ {s.bearish.toLocaleString()} bearish</span>
          <span className="text-slate-400">● {s.neutral.toLocaleString()} neutral</span>
          <span className="text-muted-foreground/60">○ {s.unanalyzed.toLocaleString()} unanalyzed</span>
        </>
      )}
      {stats.recency?.last_fetch && (
        <span className="ml-auto">last fetch {timeAgo(stats.recency.last_fetch)}</span>
      )}
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────

const CATEGORIES = ["markets", "economy", "equities", "filings", "press_releases", "crypto", "commodities", "fda"];
const SENTIMENTS = ["bullish", "bearish", "neutral", "unanalyzed"];
const PAGE_SIZE  = 40;

export default function NewsPage() {
  const [articles,   setArticles]  = useState<Article[]>([]);
  const [stats,      setStats]     = useState<NewsStats | null>(null);
  const [total,      setTotal]     = useState(0);
  const [offset,     setOffset]    = useState(0);
  const [loading,    setLoading]   = useState(false);
  const [analyzing,  setAnalyzing] = useState(false);
  const [analyzeMsg, setAnalyzeMsg] = useState("");

  // Filters
  const [search,    setSearch]    = useState("");
  const [category,  setCategory]  = useState("");
  const [sentiment, setSentiment] = useState("");
  const [ticker,    setTicker]    = useState("");

  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const buildParams = useCallback((off = 0) => {
    const p = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(off) });
    if (search)    p.set("search",    search);
    if (category)  p.set("category",  category);
    if (sentiment) p.set("sentiment", sentiment);
    if (ticker)    p.set("ticker",    ticker);
    return p;
  }, [search, category, sentiment, ticker]);

  const load = useCallback(async (off = 0) => {
    setLoading(true);
    try {
      const res  = await fetch(`/api/news/articles?${buildParams(off)}`);
      const data = await res.json() as { articles: Article[]; total: number };
      setArticles(off === 0 ? data.articles : (prev) => [...prev, ...data.articles]);
      setTotal(data.total);
      setOffset(off);
    } finally {
      setLoading(false);
    }
  }, [buildParams]);

  const loadStats = useCallback(async () => {
    const res  = await fetch("/api/news/stats");
    const data = await res.json() as NewsStats;
    setStats(data);
  }, []);

  // Initial load + re-load on filter changes
  useEffect(() => { load(0); }, [category, sentiment, ticker, load]);

  // Debounce search
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => load(0), 350);
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current); };
  }, [search, load]);

  useEffect(() => { loadStats(); }, [loadStats]);

  async function runAnalyze() {
    setAnalyzing(true);
    setAnalyzeMsg("Sending to FinBERT service…");
    try {
      const res  = await fetch("/api/news/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limit: 50 }),
      });
      const data = await res.json() as { analyzed?: number; error?: string };
      if (!res.ok) {
        setAnalyzeMsg(`✗ ${data.error || "Failed"}`);
      } else {
        setAnalyzeMsg(`✓ Analyzed ${data.analyzed} articles`);
        await Promise.all([load(0), loadStats()]);
      }
    } finally {
      setAnalyzing(false);
    }
  }

  const hasMore = offset + PAGE_SIZE < total;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Stats bar */}
      <StatsBar stats={stats} />

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 border-b border-border bg-background flex-shrink-0">
        {/* Search */}
        <div className="relative">
          <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none"
               viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input
            type="text"
            placeholder="Search headlines…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 pr-3 py-1.5 text-xs bg-muted border border-border rounded-md w-56 focus:outline-none focus:border-primary"
          />
        </div>

        {/* Ticker */}
        <input
          type="text"
          placeholder="Ticker (e.g. AAPL)"
          value={ticker}
          onChange={(e) => setTicker(e.target.value.toUpperCase())}
          className="px-3 py-1.5 text-xs bg-muted border border-border rounded-md w-32 focus:outline-none focus:border-primary font-mono"
        />

        {/* Category chips */}
        <div className="flex gap-1 flex-wrap">
          <button
            onClick={() => setCategory("")}
            className={`text-[11px] px-2.5 py-1 rounded-full border transition-colors ${!category ? "bg-primary/10 text-primary border-primary/30" : "border-border text-muted-foreground hover:text-foreground"}`}
          >
            All
          </button>
          {CATEGORIES.map((c) => (
            <button
              key={c}
              onClick={() => setCategory(c === category ? "" : c)}
              className={`text-[11px] px-2.5 py-1 rounded-full border transition-colors ${c === category ? "bg-primary/10 text-primary border-primary/30" : "border-border text-muted-foreground hover:text-foreground"}`}
            >
              {c.replace("_", " ")}
            </button>
          ))}
        </div>

        {/* Sentiment filter */}
        <select
          value={sentiment}
          onChange={(e) => setSentiment(e.target.value)}
          className="text-xs bg-muted border border-border rounded-md px-2 py-1.5 focus:outline-none focus:border-primary"
        >
          <option value="">All Sentiment</option>
          {SENTIMENTS.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>

        {/* Analyze button */}
        <button
          onClick={runAnalyze}
          disabled={analyzing}
          className="ml-auto text-xs px-3 py-1.5 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors flex items-center gap-1.5"
        >
          {analyzing ? (
            <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
            </svg>
          ) : (
            <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
            </svg>
          )}
          Deep Analyze (FinBERT)
        </button>
      </div>

      {/* Analyze result message */}
      {analyzeMsg && (
        <div className={`px-4 py-1.5 text-[11px] flex-shrink-0 ${analyzeMsg.startsWith("✓") ? "text-emerald-400 bg-emerald-500/5" : analyzeMsg.startsWith("✗") ? "text-red-400 bg-red-500/5" : "text-muted-foreground"}`}>
          {analyzeMsg}
        </div>
      )}

      {/* Article list */}
      <div className="flex-1 overflow-y-auto p-4">
        {loading && articles.length === 0 ? (
          <div className="grid gap-3">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="h-20 rounded-lg border border-border bg-card animate-pulse" />
            ))}
          </div>
        ) : articles.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 text-muted-foreground">
            <svg className="w-8 h-8 mb-3 opacity-40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
              <path d="M4 4h16v16H4z" strokeLinejoin="round"/>
              <path d="M8 9h8M8 13h5"/>
            </svg>
            <p className="text-sm">No articles found</p>
            <p className="text-xs mt-1 opacity-60">
              Check that the GitHub Actions RSS workflow has run at least once.
            </p>
          </div>
        ) : (
          <>
            <div className="grid gap-2">
              {articles.map((a) => <ArticleCard key={a.id} article={a} />)}
            </div>

            {/* Load more */}
            {hasMore && (
              <div className="mt-4 flex justify-center">
                <button
                  onClick={() => load(offset + PAGE_SIZE)}
                  disabled={loading}
                  className="text-xs px-4 py-2 rounded-md border border-border text-muted-foreground hover:text-foreground hover:border-border/80 disabled:opacity-50 transition-colors"
                >
                  {loading ? "Loading…" : `Load more  (${total - offset - PAGE_SIZE} remaining)`}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
