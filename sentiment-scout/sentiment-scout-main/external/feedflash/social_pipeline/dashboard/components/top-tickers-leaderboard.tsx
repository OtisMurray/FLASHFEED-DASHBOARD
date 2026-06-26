"use client";

import { useState, useMemo } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./ui/table";
import { Skeleton } from "./ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./ui/tooltip";
import { ArrowUp, ArrowDown, Minus } from "lucide-react";
import { SourceBadge } from "./source-badge";
import type { TickerData } from "@/lib/types";
import {
  formatPrice,
  formatSentiment,
  getSentimentColor,
  getSentimentBgColor,
} from "@/lib/utils";

type SortField = "ticker" | "price" | "sentiment" | "message_count";
type SortDirection = "asc" | "desc";

interface TopTickersLeaderboardProps {
  tickers: TickerData[];
  loading: boolean;
  searchQuery: string;
  onSelectTicker: (ticker: string) => void;
}

export function TopTickersLeaderboard({
  tickers,
  loading,
  searchQuery,
  onSelectTicker,
}: TopTickersLeaderboardProps) {
  const [sortField, setSortField] = useState<SortField>("message_count");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(sortDirection === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDirection("desc");
    }
  };

  const avgMessageCount = useMemo(() => {
    if (tickers.length === 0) return 0;
    return tickers.reduce((sum, t) => sum + t.message_count, 0) / tickers.length;
  }, [tickers]);

  const filteredAndSorted = useMemo(() => {
    let filtered = tickers.filter((t) =>
      t.ticker.toLowerCase().includes(searchQuery.toLowerCase())
    );

    filtered.sort((a, b) => {
      let aVal: number | string;
      let bVal: number | string;

      if (sortField === "sentiment") {
        aVal = a.avg_sentiment;
        bVal = b.avg_sentiment;
      } else {
        aVal = a[sortField] as number | string;
        bVal = b[sortField] as number | string;
      }

      if (aVal === null || aVal === undefined) return 1;
      if (bVal === null || bVal === undefined) return -1;

      return sortDirection === "asc"
        ? (aVal > bVal ? 1 : -1)
        : (aVal < bVal ? 1 : -1);
    });

    return filtered;
  }, [tickers, searchQuery, sortField, sortDirection]);

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) return null;
    return sortDirection === "asc" ? (
      <ArrowUp className="inline ml-0.5 h-3 w-3" />
    ) : (
      <ArrowDown className="inline ml-0.5 h-3 w-3" />
    );
  };

  if (loading) {
    return (
      <div className="p-4 space-y-2">
        {Array.from({ length: 10 }).map((_, i) => (
          <Skeleton key={i} className="h-8 w-full bg-muted" />
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex-1 overflow-auto">
        <Table>
          <TableHeader className="sticky top-0 bg-card/95 backdrop-blur-sm z-10">
            <TableRow className="border-border hover:bg-transparent">
              <TableHead className="w-8 text-dim text-[11px]">#</TableHead>
              <TableHead
                className="cursor-pointer text-muted-foreground text-[11px] font-bold"
                onClick={() => handleSort("ticker")}
              >
                Ticker <SortIcon field="ticker" />
              </TableHead>
              <TableHead
                className="cursor-pointer text-right text-muted-foreground text-[11px] font-bold"
                onClick={() => handleSort("price")}
              >
                Price <SortIcon field="price" />
              </TableHead>
              <TableHead
                className="cursor-pointer text-muted-foreground text-[11px] font-bold"
                onClick={() => handleSort("sentiment")}
              >
                Sentiment <SortIcon field="sentiment" />
              </TableHead>
              <TableHead
                className="cursor-pointer text-right text-muted-foreground text-[11px] font-bold"
                onClick={() => handleSort("message_count")}
              >
                Msgs <SortIcon field="message_count" />
              </TableHead>
              <TableHead className="text-muted-foreground text-[11px] font-bold">
                Bull/Bear
              </TableHead>
              <TableHead className="text-muted-foreground text-[11px] font-bold w-16">
                Source
              </TableHead>
              <TableHead className="text-muted-foreground text-[11px] font-bold w-10">
                Trend
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredAndSorted.map((ticker, idx) => {
              const totalMessages = ticker.message_count || 1;
              const bullishPct = (ticker.bullish_count / totalMessages) * 100;
              const bearishPct = (ticker.bearish_count / totalMessages) * 100;
              const isAnomaly = ticker.message_count > avgMessageCount * 2;
              const sources = ticker.sources || [];

              return (
                <TableRow
                  key={ticker.ticker}
                  className={`border-border/50 hover:bg-muted/50 cursor-pointer transition-colors ${
                    isAnomaly ? "anomaly-glow" : ""
                  }`}
                  onClick={() => onSelectTicker(ticker.ticker)}
                >
                  <TableCell className="text-faint text-[11px] font-mono py-1.5">
                    {idx + 1}
                  </TableCell>
                  <TableCell className="font-mono font-bold text-foreground text-sm py-1.5">
                    {ticker.ticker}
                  </TableCell>
                  <TableCell className="text-right text-secondary-foreground text-xs font-mono py-1.5">
                    {ticker.price > 0 ? formatPrice(ticker.price) : "-"}
                  </TableCell>
                  <TableCell className="py-1.5">
                    <div className="flex items-center gap-1.5">
                      <div className="w-16 h-4 bg-muted rounded overflow-hidden">
                        <div
                          className={`h-full ${getSentimentBgColor(ticker.avg_sentiment)} opacity-70`}
                          style={{ width: `${Math.abs(ticker.avg_sentiment) * 100}%` }}
                        />
                      </div>
                      <span className={`text-xs font-mono ${getSentimentColor(ticker.avg_sentiment)}`}>
                        {formatSentiment(ticker.avg_sentiment)}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="text-right text-secondary-foreground text-xs font-mono py-1.5">
                    {ticker.message_count}
                  </TableCell>
                  <TableCell className="py-1.5">
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <div className="w-20 h-3 bg-muted rounded overflow-hidden flex">
                            <div className="bg-emerald-500" style={{ width: `${bullishPct}%` }} />
                            <div className="bg-red-500" style={{ width: `${bearishPct}%` }} />
                            <div className="bg-dim flex-1" />
                          </div>
                        </TooltipTrigger>
                        <TooltipContent>
                          <div className="text-[10px] space-y-0.5">
                            <div className="text-emerald-400">Bull: {bullishPct.toFixed(0)}%</div>
                            <div className="text-red-400">Bear: {bearishPct.toFixed(0)}%</div>
                          </div>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </TableCell>
                  <TableCell className="py-1.5">
                    <div className="flex items-center gap-0.5">
                      {sources.includes("reddit") && <SourceBadge source="reddit" />}
                      {sources.includes("bluesky") && <SourceBadge source="bluesky" />}
                      {sources.includes("twitter") && <SourceBadge source="twitter" />}
                      {sources.length === 0 && <span className="text-faint text-[10px]">-</span>}
                    </div>
                  </TableCell>
                  <TableCell className="py-1.5">
                    {ticker.avg_sentiment > 0.1 ? (
                      <ArrowUp className="h-3.5 w-3.5 text-emerald-500" />
                    ) : ticker.avg_sentiment < -0.1 ? (
                      <ArrowDown className="h-3.5 w-3.5 text-red-500" />
                    ) : (
                      <Minus className="h-3.5 w-3.5 text-dim" />
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
            {filteredAndSorted.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="text-center text-dim py-8">
                  {searchQuery ? "No tickers match your search" : "No data available"}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
