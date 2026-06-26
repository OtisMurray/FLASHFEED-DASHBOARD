"use client";

import { useState } from "react";
import { Plus, X, ChevronDown, ChevronRight, Activity, Newspaper, Filter, Settings } from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { ScrollArea } from "./ui/scroll-area";
import type { TickerData, SubredditHealth } from "@/lib/types";
import { formatSentiment, getSentimentColor } from "@/lib/utils";

const TIME_WINDOWS = ["1", "3", "5", "10", "15", "30", "60"];

interface LeftSidebarProps {
  activeView: string;
  onViewChange: (view: any) => void;
  watchlist: string[];
  tickers: TickerData[];
  subredditHealth: SubredditHealth[];
  timeWindow: string;
  onTimeWindowChange: (w: string) => void;
  onSelectTicker: (ticker: string) => void;
  selectedTicker: string | null;
  onAddToWatchlist: (ticker: string) => void;
  onRemoveFromWatchlist: (ticker: string) => void;
}

export function LeftSidebar({
  activeView,
  onViewChange,
  watchlist,
  tickers,
  subredditHealth,
  timeWindow,
  onTimeWindowChange,
  onSelectTicker,
  selectedTicker,
  onAddToWatchlist,
  onRemoveFromWatchlist,
}: LeftSidebarProps) {
  const [addInput, setAddInput] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [healthExpanded, setHealthExpanded] = useState(false);

  const tickerMap = new Map(tickers.map((t) => [t.ticker, t]));

  const handleAddTicker = () => {
    const ticker = addInput.trim().toUpperCase();
    if (ticker) {
      onAddToWatchlist(ticker);
      setAddInput("");
      setShowAdd(false);
    }
  };

  const getHealthColor = (count: number) => {
    if (count > 10) return "bg-emerald-500";
    if (count >= 1) return "bg-amber-500";
    return "bg-faint";
  };

  const navItems = [
    { id: "dashboard", label: "Dashboard", icon: Activity },
    { id: "news", label: "News Feed", icon: Newspaper },
    { id: "screener", label: "Screener", icon: Filter },
  ];

  return (
    <>
      <div className="w-[260px] border-r border-border bg-card/50 flex flex-col shrink-0 overflow-hidden">
        {/* Navigation Tabs */}
        <div className="p-3 border-b border-border">
          <div className="flex items-center gap-2 mb-4 px-1 text-primary">
            <span className="text-sm font-bold tracking-tight">⚡ FlashFeed</span>
          </div>
          <nav className="space-y-1">
            {navItems.map((item) => {
              const Icon = item.icon;
              const isActive = activeView === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => onViewChange(item.id)}
                  className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors ${
                    isActive
                      ? "bg-primary/10 text-primary border border-primary/20"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground border border-transparent"
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" />
                  {item.label}
                </button>
              );
            })}
          </nav>
        </div>

        <ScrollArea className="flex-1">
          <div className="p-3">
            {/* Watchlist */}
            <div className="mb-4">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-[11px] font-bold text-dim uppercase tracking-wider">
                  Watchlist
                </h3>
                <button
                  onClick={() => setShowAdd(!showAdd)}
                  className="text-dim hover:text-secondary-foreground transition-colors"
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
              </div>

              {showAdd && (
                <div className="flex gap-1 mb-2">
                  <Input
                    value={addInput}
                    onChange={(e) => setAddInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleAddTicker()}
                    placeholder="AAPL"
                    className="h-6 text-xs bg-background border-border px-2"
                  />
                  <Button
                    size="sm"
                    onClick={handleAddTicker}
                    className="h-6 px-2 text-xs bg-blue-600 hover:bg-blue-500"
                  >
                    Add
                  </Button>
                </div>
              )}

              {watchlist.length === 0 ? (
                <div className="text-[11px] text-faint py-2 px-1">
                  No tickers watched
                </div>
              ) : (
                <div className="space-y-0.5">
                  {watchlist.map((ticker) => {
                    const data = tickerMap.get(ticker);
                    const sentiment = data?.avg_sentiment ?? 0;
                    return (
                      <div
                        key={ticker}
                        onClick={() => onSelectTicker(ticker)}
                        className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer group text-xs transition-colors ${
                          selectedTicker === ticker && activeView === "dashboard"
                            ? "bg-blue-500/15 text-blue-400"
                            : "hover:bg-muted text-secondary-foreground"
                        }`}
                      >
                        <span className="font-mono font-bold flex-1">{ticker}</span>
                        {data && (
                          <>
                            <div className="w-12 h-1.5 bg-muted rounded-full overflow-hidden">
                              <div
                                className={`h-full rounded-full transition-all duration-300 ${
                                  sentiment > 0 ? "bg-emerald-500" : sentiment < 0 ? "bg-red-500" : "bg-dim"
                                }`}
                                style={{ width: `${Math.abs(sentiment) * 100}%` }}
                              />
                            </div>
                            <span className={`font-mono text-[10px] ${getSentimentColor(sentiment)}`}>
                              {formatSentiment(sentiment)}
                            </span>
                          </>
                        )}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onRemoveFromWatchlist(ticker);
                          }}
                          className="opacity-0 group-hover:opacity-100 text-dim hover:text-red-400 transition-opacity"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Source Health */}
            <div className="mb-4 pb-3 border-b border-border/50">
              <button
                onClick={() => setHealthExpanded(!healthExpanded)}
                className="flex items-center gap-1 mb-2 w-full group"
              >
                {healthExpanded ? (
                  <ChevronDown className="h-3 w-3 text-dim group-hover:text-foreground transition-colors" />
                ) : (
                  <ChevronRight className="h-3 w-3 text-dim group-hover:text-foreground transition-colors" />
                )}
                <h3 className="text-[11px] font-bold text-dim uppercase tracking-wider group-hover:text-foreground transition-colors">
                  Source Health
                </h3>
              </button>

              {healthExpanded && (
                <div className="space-y-1">
                  {subredditHealth.length === 0 ? (
                    <div className="text-[11px] text-faint py-1 px-1">Loading...</div>
                  ) : (
                    subredditHealth.map((item) => (
                      <div
                        key={`${item.source}-${item.subreddit}`}
                        className="flex items-center gap-2 px-2 py-0.5 text-[11px]"
                      >
                        <div className={`h-1.5 w-1.5 rounded-full shrink-0 ${getHealthColor(item.post_count)}`} />
                        <span className="text-muted-foreground truncate flex-1">
                          {item.source === "bluesky" ? "Bluesky" : item.source === "twitter" ? "Twitter/X" : `r/${item.subreddit}`}
                        </span>
                        <span className="text-dim font-mono">{item.post_count}</span>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>

            {/* Time Window */}
            <div className="mb-4">
              <h3 className="text-[11px] font-bold text-dim uppercase tracking-wider mb-2">
                Window
              </h3>
              <div className="flex flex-wrap gap-1">
                {TIME_WINDOWS.map((w) => (
                  <button
                    key={w}
                    onClick={() => onTimeWindowChange(w)}
                    className={`px-2 py-1 rounded text-[11px] font-mono transition-colors ${
                      timeWindow === w
                        ? "bg-blue-600 text-white"
                        : "bg-muted text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                    }`}
                  >
                    {w}m
                  </button>
                ))}
              </div>
            </div>
          </div>
        </ScrollArea>

        {/* Settings button */}
        <div className="border-t border-border p-3">
          <button
            onClick={() => onViewChange("settings")}
            className={`flex items-center gap-2 px-2.5 py-1.5 w-full rounded-md text-xs font-medium transition-colors ${
              activeView === "settings"
                ? "bg-primary/10 text-primary border border-primary/20"
                : "text-muted-foreground hover:bg-muted hover:text-foreground border border-transparent"
            }`}
          >
            <Settings className="h-3.5 w-3.5" />
            Admin Settings
          </button>
        </div>
      </div>
    </>
  );
}
