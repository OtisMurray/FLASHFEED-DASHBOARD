"use client";

import { useState } from "react";
import { X } from "lucide-react";
import type { Alert } from "@/lib/types";

interface AlertBannerProps {
  alerts: Alert[];
}

export function AlertBanner({ alerts }: AlertBannerProps) {
  const [dismissed, setDismissed] = useState(false);

  if (dismissed || alerts.length === 0) return null;

  const severityColor = (severity: string) => {
    if (severity === "high") return "text-red-400";
    if (severity === "medium") return "text-amber-400";
    return "text-blue-400";
  };

  // Double the items for seamless loop
  const items = [...alerts, ...alerts];

  return (
    <div className="relative flex items-center h-7 bg-card/80 border-b border-border overflow-hidden shrink-0">
      <div className="animate-marquee flex items-center gap-8 whitespace-nowrap px-4">
        {items.map((alert, i) => (
          <span key={i} className="flex items-center gap-2 text-xs">
            <span className={`font-bold ${severityColor(alert.severity)}`}>
              {alert.type === "volume_spike" ? "VOL" : "SENT"}
            </span>
            <span className="font-mono text-secondary-foreground">{alert.ticker}</span>
            <span className="text-dim">{alert.message}</span>
          </span>
        ))}
      </div>
      <button
        onClick={() => setDismissed(true)}
        className="absolute right-2 p-0.5 text-faint hover:text-muted-foreground"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}
