"use client";

import { ScrollArea } from "./ui/scroll-area";
import { AlertQueue } from "./alert-queue";
import { EventFeed } from "./event-feed";
import type { Alert, Post } from "@/lib/types";

interface RightPanelProps {
  alerts: Alert[];
  posts: Post[];
  selectedTicker: string | null;
  onSelectTicker: (ticker: string) => void;
}

export function RightPanel({ alerts, posts, selectedTicker, onSelectTicker }: RightPanelProps) {
  // If a ticker is selected, filter posts to that ticker
  const filteredPosts = selectedTicker
    ? posts.filter((p) =>
        p.tickers_mentioned.includes(selectedTicker.toUpperCase())
      )
    : posts;

  return (
    <div className="w-[300px] border-l border-border bg-card/30 flex flex-col shrink-0 overflow-hidden">
      {/* Alerts section */}
      <div className="panel-section">
        <div className="px-3 py-2">
          <h3 className="text-[11px] font-bold text-dim uppercase tracking-wider">
            Alerts
          </h3>
        </div>
        <ScrollArea className="max-h-48">
          <AlertQueue alerts={alerts} onTickerClick={onSelectTicker} />
        </ScrollArea>
      </div>

      {/* Event Feed */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="px-3 py-2 shrink-0">
          <h3 className="text-[11px] font-bold text-dim uppercase tracking-wider">
            {selectedTicker ? `${selectedTicker} Feed` : "Live Feed"}
          </h3>
        </div>
        <ScrollArea className="flex-1">
          <EventFeed posts={filteredPosts} />
        </ScrollArea>
      </div>
    </div>
  );
}
