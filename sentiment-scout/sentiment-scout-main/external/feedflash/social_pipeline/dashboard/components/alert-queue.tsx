"use client";

import { useState } from "react";
import { X } from "lucide-react";
import type { Alert } from "@/lib/types";
import { getRelativeTime } from "@/lib/utils";

interface AlertQueueProps {
  alerts: Alert[];
  onTickerClick: (ticker: string) => void;
}

export function AlertQueue({ alerts, onTickerClick }: AlertQueueProps) {
  const [dismissed, setDismissed] = useState<Set<number>>(new Set());

  if (alerts.length === 0) {
    return (
      <div className="px-3 pb-3 text-[11px] text-faint">
        No active alerts
      </div>
    );
  }

  const visibleAlerts = alerts
    .filter((_, i) => !dismissed.has(i))
    .slice(0, 10);

  if (visibleAlerts.length === 0) {
    return (
      <div className="px-3 pb-3 text-[11px] text-faint">
        All alerts dismissed
      </div>
    );
  }

  return (
    <div className="px-3 pb-2 space-y-1.5">
      {visibleAlerts.map((alert, idx) => {
        const borderColor =
          alert.type === "volume_spike" ? "border-l-red-500" : "border-l-amber-500";
        const originalIdx = alerts.indexOf(alert);

        return (
          <div
            key={originalIdx}
            className={`relative bg-muted/50 rounded-r border-l-2 ${borderColor} p-2 group`}
          >
            <button
              onClick={() => setDismissed((prev) => new Set(prev).add(originalIdx))}
              className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 text-faint hover:text-muted-foreground"
            >
              <X className="h-3 w-3" />
            </button>
            <div className="flex items-center gap-1.5 mb-0.5">
              <span
                className="font-mono font-bold text-xs text-blue-400 cursor-pointer hover:underline"
                onClick={() => onTickerClick(alert.ticker)}
              >
                {alert.ticker}
              </span>
              <span className={`text-[10px] font-bold ${
                alert.type === "volume_spike" ? "text-red-400" : "text-amber-400"
              }`}>
                {alert.type === "volume_spike" ? "VOL SPIKE" : "SENT SHIFT"}
              </span>
            </div>
            <div className="text-[11px] text-muted-foreground leading-tight">
              {alert.message}
            </div>
            <div className="text-[10px] text-faint mt-0.5">
              {getRelativeTime(new Date(alert.detected_at))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
