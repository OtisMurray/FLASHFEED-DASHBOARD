"use client";

import { Card, CardContent } from "./ui/card";
import type { TickerData, HistoryPoint } from "@/lib/types";
import {
  LineChart,
  Line,
  ResponsiveContainer,
} from "recharts";

interface SentimentBreakdownCardsProps {
  tickerData: TickerData;
  history: HistoryPoint[];
}

export function SentimentBreakdownCards({ tickerData, history }: SentimentBreakdownCardsProps) {
  const totalMessages = tickerData.message_count || 1;
  const bullishPct = (tickerData.bullish_count / totalMessages) * 100;
  const bearishPct = (tickerData.bearish_count / totalMessages) * 100;
  const neutralPct = (tickerData.neutral_count / totalMessages) * 100;

  // Last 12 history points for sparklines
  const sparkData = history.slice(-12).map((p) => ({
    bull: p.bullish_count,
    bear: p.bearish_count,
    neutral: p.neutral_count,
  }));

  const cards = [
    {
      label: "Bullish",
      count: tickerData.bullish_count,
      pct: bullishPct,
      color: "#10b981",
      bgColor: "bg-emerald-500/10",
      borderColor: "border-emerald-500/20",
      dataKey: "bull" as const,
    },
    {
      label: "Bearish",
      count: tickerData.bearish_count,
      pct: bearishPct,
      color: "#ef4444",
      bgColor: "bg-red-500/10",
      borderColor: "border-red-500/20",
      dataKey: "bear" as const,
    },
    {
      label: "Neutral",
      count: tickerData.neutral_count,
      pct: neutralPct,
      color: "#94a3b8",
      bgColor: "bg-muted",
      borderColor: "border-border",
      dataKey: "neutral" as const,
    },
  ];

  return (
    <div className="grid grid-cols-3 gap-3">
      {cards.map((card) => (
        <Card key={card.label} className={`${card.bgColor} border ${card.borderColor}`}>
          <CardContent className="p-3">
            <div className="flex items-start justify-between">
              <div>
                <div className="text-[11px] text-muted-foreground">{card.label}</div>
                <div className="text-xl font-bold font-mono" style={{ color: card.color }}>
                  {card.count}
                </div>
                <div className="text-[11px] text-dim">{card.pct.toFixed(1)}%</div>
              </div>
              {sparkData.length > 1 && (
                <div className="w-16 h-8">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={sparkData}>
                      <Line
                        type="monotone"
                        dataKey={card.dataKey}
                        stroke={card.color}
                        strokeWidth={1.5}
                        dot={false}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
