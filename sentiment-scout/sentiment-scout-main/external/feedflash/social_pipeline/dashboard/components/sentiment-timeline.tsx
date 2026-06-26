"use client";

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";
import type { HistoryPoint } from "@/lib/types";

interface SentimentTimelineProps {
  history: HistoryPoint[];
  timeRange: string;
}

export function SentimentTimeline({ history, timeRange }: SentimentTimelineProps) {
  const hoursMap: Record<string, number> = { "1hr": 1, "6hr": 6, "24hr": 24 };
  const hours = hoursMap[timeRange] || 24;

  const chartData = history.map((point) => ({
    time: new Date(point.window_end).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: hours <= 6 ? "2-digit" : undefined,
      hour12: true,
    }),
    sentiment: point.avg_sentiment,
  }));

  if (chartData.length === 0) {
    return (
      <div className="flex items-center justify-center h-48 text-sm text-dim">
        No history data
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={200}>
      <LineChart data={chartData}>
        <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
        <XAxis
          dataKey="time"
          stroke="#475569"
          style={{ fontSize: "10px" }}
          tick={{ fill: "#64748b" }}
        />
        <YAxis
          domain={[-1, 1]}
          stroke="#475569"
          style={{ fontSize: "10px" }}
          tick={{ fill: "#64748b" }}
        />
        <Tooltip
          contentStyle={{
            backgroundColor: "#0f172a",
            border: "1px solid #1e293b",
            borderRadius: "6px",
            color: "#f8fafc",
            fontSize: "12px",
          }}
          formatter={(value) => [Number(value).toFixed(2), "Sentiment"]}
        />
        <ReferenceLine y={0} stroke="#475569" strokeDasharray="3 3" />
        <Line
          type="monotone"
          dataKey="sentiment"
          stroke="#10b981"
          strokeWidth={2}
          dot={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
