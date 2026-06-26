"use client";

import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Skeleton } from "./ui/skeleton";
import { Star } from "lucide-react";
import { ScoreGauge } from "./score-gauge";
import { SentimentBreakdownCards } from "./sentiment-breakdown-cards";
import { VelocityChart } from "./velocity-chart";
import { SentimentTimeline } from "./sentiment-timeline";
import { HotPhrases } from "./hot-phrases";
import { SourceBadge } from "./source-badge";
import type { TickerData, HistoryPoint, Post, HotPhrase } from "@/lib/types";
import {
  formatPrice,
  formatSentiment,
  getSentimentColor,
  getRelativeTime,
} from "@/lib/utils";

interface TickerBreakdownProps {
  tickerData: TickerData | null;
  history: HistoryPoint[];
  posts: Post[];
  phrases: HotPhrase[];
  loading: boolean;
  timeRange: string;
  onTimeRangeChange: (range: string) => void;
  onAddToWatchlist: (ticker: string) => void;
  isWatched: (ticker: string) => boolean;
}

export function TickerBreakdown({
  tickerData,
  history,
  posts,
  phrases,
  loading,
  timeRange,
  onTimeRangeChange,
  onAddToWatchlist,
  isWatched,
}: TickerBreakdownProps) {
  if (loading) {
    return (
      <div className="p-4 space-y-4">
        <Skeleton className="h-6 w-48 bg-muted" />
        <div className="grid grid-cols-2 gap-4">
          <Skeleton className="h-48 bg-muted" />
          <Skeleton className="h-48 bg-muted" />
        </div>
        <Skeleton className="h-32 bg-muted" />
      </div>
    );
  }

  if (!tickerData) {
    return (
      <div className="flex items-center justify-center h-48 text-dim text-sm">
        Ticker data not available
      </div>
    );
  }

  const watched = isWatched(tickerData.ticker);

  return (
    <div className="p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center gap-3 flex-wrap">
        <h2 className="text-2xl font-bold font-mono text-foreground">
          {tickerData.ticker}
        </h2>
        {tickerData.price > 0 && (
          <span className="text-lg text-secondary-foreground font-mono">
            {formatPrice(tickerData.price)}
          </span>
        )}
        <Badge
          className={`text-xs ${
            tickerData.avg_sentiment > 0.2
              ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/30"
              : tickerData.avg_sentiment < -0.2
                ? "bg-red-500/20 text-red-400 border-red-500/30"
                : "bg-muted text-muted-foreground border-border"
          }`}
        >
          {formatSentiment(tickerData.avg_sentiment)}
        </Badge>
        <span className="text-xs text-dim">
          {tickerData.message_count} posts
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onAddToWatchlist(tickerData.ticker)}
          className={`h-7 px-2 text-xs ${
            watched ? "text-amber-400" : "text-dim hover:text-amber-400"
          }`}
        >
          <Star className={`h-3.5 w-3.5 mr-1 ${watched ? "fill-amber-400" : ""}`} />
          {watched ? "Watched" : "Watch"}
        </Button>
      </div>

      {/* Time range tabs */}
      <div className="flex gap-1">
        {["1hr", "6hr", "24hr"].map((range) => (
          <button
            key={range}
            onClick={() => onTimeRangeChange(range)}
            className={`px-3 py-1 rounded text-xs font-mono ${
              timeRange === range
                ? "bg-blue-600 text-white"
                : "bg-muted text-muted-foreground hover:bg-accent"
            }`}
          >
            {range}
          </button>
        ))}
      </div>

      {/* Gauge + Breakdown */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card className="bg-card/50 border-border">
          <CardContent className="p-4 flex justify-center">
            <ScoreGauge sentiment={tickerData.avg_sentiment} size={180} />
          </CardContent>
        </Card>
        <div>
          <SentimentBreakdownCards tickerData={tickerData} history={history} />
        </div>
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card className="bg-card/50 border-border">
          <CardHeader className="p-3 pb-1">
            <CardTitle className="text-sm text-secondary-foreground">Sentiment Over Time</CardTitle>
          </CardHeader>
          <CardContent className="p-3 pt-0">
            <SentimentTimeline history={history} timeRange={timeRange} />
          </CardContent>
        </Card>

        <Card className="bg-card/50 border-border">
          <CardHeader className="p-3 pb-1">
            <CardTitle className="text-sm text-secondary-foreground">Message Velocity</CardTitle>
          </CardHeader>
          <CardContent className="p-3 pt-0">
            <VelocityChart history={history} timeRange={timeRange} />
          </CardContent>
        </Card>
      </div>

      {/* Hot Phrases */}
      {phrases.length > 0 && (
        <Card className="bg-card/50 border-border">
          <CardHeader className="p-3 pb-1">
            <CardTitle className="text-sm text-secondary-foreground">Hot Phrases</CardTitle>
          </CardHeader>
          <CardContent className="p-3 pt-0">
            <HotPhrases phrases={phrases} />
          </CardContent>
        </Card>
      )}

      {/* Recent Posts */}
      <Card className="bg-card/50 border-border">
        <CardHeader className="p-3 pb-1">
          <CardTitle className="text-sm text-secondary-foreground">Recent Posts</CardTitle>
        </CardHeader>
        <CardContent className="p-3 pt-0">
          {posts.length === 0 ? (
            <div className="text-dim text-sm text-center py-6">
              No posts found
            </div>
          ) : (
            <div className="space-y-1">
              {posts.map((post) => (
                <div
                  key={post.id}
                  onClick={() => window.open(post.url, "_blank")}
                  className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-muted cursor-pointer"
                >
                  <SourceBadge source={post.source} />
                  <span className="text-xs text-dim w-20 truncate shrink-0">
                    {post.source === "reddit" && post.subreddit
                      ? `r/${post.subreddit}`
                      : post.source === "twitter"
                      ? `@${post.author || "twitter"}`
                      : post.source === "bluesky"
                      ? "Bluesky"
                      : post.source}
                  </span>
                  <span className="text-xs text-secondary-foreground flex-1 truncate">
                    {post.title || post.text.slice(0, 80)}
                  </span>
                  {post.is_rumor && (
                    <span className="text-[9px] px-1 py-0.5 rounded bg-amber-500/20 text-amber-400 font-medium shrink-0">
                      RUMOR
                    </span>
                  )}
                  <span className={`text-[11px] font-mono shrink-0 ${getSentimentColor(post.sentiment_score)}`}>
                    {formatSentiment(post.sentiment_score)}
                  </span>
                  <span className="text-[10px] text-faint w-16 text-right shrink-0">
                    {getRelativeTime(new Date(post.published_at))}
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
