"use client";

import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";
import type { HistoryPoint } from "@/lib/types";

interface VelocityChartProps {
  history: HistoryPoint[];
  timeRange: string;
}

export function VelocityChart({ history, timeRange }: VelocityChartProps) {
  const hoursMap: Record<string, number> = { "1hr": 1, "6hr": 6, "24hr": 24 };
  const hours = hoursMap[timeRange] || 24;

  const chartData = history.map((point) => ({
    time: new Date(point.window_end).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: hours <= 6 ? "2-digit" : undefined,
      hour12: true,
    }),
    messages: point.message_count,
  }));

  const avgMessages =
    chartData.length > 0
      ? chartData.reduce((sum, d) => sum + d.messages, 0) / chartData.length
      : 0;

  if (chartData.length === 0) {
    return (
      <div className="flex items-center justify-center h-48 text-sm text-dim">
        No history data
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={200}>
      <AreaChart data={chartData}>
        <defs>
          <linearGradient id="msgGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
            <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
        <XAxis
          dataKey="time"
          stroke="#475569"
          style={{ fontSize: "10px" }}
          tick={{ fill: "#64748b" }}
        />
        <YAxis
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
          formatter={(value) => [String(value), "Messages"]}
        />
        <ReferenceLine
          y={avgMessages}
          stroke="#f59e0b"
          strokeDasharray="3 3"
          strokeOpacity={0.5}
        />
        <Area
          type="monotone"
          dataKey="messages"
          stroke="#3b82f6"
          fill="url(#msgGradient)"
          strokeWidth={2}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
