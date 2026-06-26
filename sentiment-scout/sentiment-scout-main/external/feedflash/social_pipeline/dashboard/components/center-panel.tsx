"use client";

import { Button } from "./ui/button";
import { ArrowLeft } from "lucide-react";
import { TopTickersLeaderboard } from "./top-tickers-leaderboard";
import { TickerBreakdown } from "./ticker-breakdown";
import type { TickerData, HistoryPoint, Post, HotPhrase } from "@/lib/types";

interface CenterPanelProps {
  selectedTicker: string | null;
  onSelectTicker: (ticker: string | null) => void;
  tickers: TickerData[];
  tickersLoading: boolean;
  searchQuery: string;
  selectedTickerData: TickerData | null;
  history: HistoryPoint[];
  posts: Post[];
  phrases: HotPhrase[];
  detailLoading: boolean;
  timeRange: string;
  onTimeRangeChange: (range: string) => void;
  onAddToWatchlist: (ticker: string) => void;
  isWatched: (ticker: string) => boolean;
}

export function CenterPanel({
  selectedTicker,
  onSelectTicker,
  tickers,
  tickersLoading,
  searchQuery,
  selectedTickerData,
  history,
  posts,
  phrases,
  detailLoading,
  timeRange,
  onTimeRangeChange,
  onAddToWatchlist,
  isWatched,
}: CenterPanelProps) {
  if (selectedTicker) {
    return (
      <div className="flex flex-col h-full overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-2 border-b border-border bg-card/30 shrink-0">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onSelectTicker(null)}
            className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5 mr-1" />
            Back
          </Button>
          <span className="font-mono font-bold text-foreground">{selectedTicker}</span>
        </div>
        <div className="flex-1 overflow-auto">
          <TickerBreakdown
            tickerData={selectedTickerData}
            history={history}
            posts={posts}
            phrases={phrases}
            loading={detailLoading}
            timeRange={timeRange}
            onTimeRangeChange={onTimeRangeChange}
            onAddToWatchlist={onAddToWatchlist}
            isWatched={isWatched}
          />
        </div>
      </div>
    );
  }

  return (
    <TopTickersLeaderboard
      tickers={tickers}
      loading={tickersLoading}
      searchQuery={searchQuery}
      onSelectTicker={(t) => onSelectTicker(t)}
    />
  );
}
