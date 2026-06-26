"use client";

import type { HotPhrase } from "@/lib/types";

interface HotPhrasesProps {
  phrases: HotPhrase[];
}

export function HotPhrases({ phrases }: HotPhrasesProps) {
  if (phrases.length === 0) {
    return (
      <div className="text-sm text-dim text-center py-4">
        No phrases detected
      </div>
    );
  }

  const maxCount = Math.max(...phrases.map((p) => p.count), 1);

  return (
    <div className="space-y-1">
      {phrases.map((phrase, i) => {
        const barWidth = (phrase.count / maxCount) * 100;
        const color =
          phrase.sentiment > 0.2
            ? "bg-emerald-500/40"
            : phrase.sentiment < -0.2
              ? "bg-red-500/40"
              : "bg-muted";
        const textColor =
          phrase.sentiment > 0.2
            ? "text-emerald-400"
            : phrase.sentiment < -0.2
              ? "text-red-400"
              : "text-muted-foreground";

        return (
          <div key={i} className="flex items-center gap-2">
            <span className="text-[10px] text-faint w-4 text-right font-mono">
              {i + 1}
            </span>
            <div className="flex-1 relative h-6 rounded overflow-hidden">
              <div
                className={`absolute inset-y-0 left-0 ${color} rounded`}
                style={{ width: `${barWidth}%` }}
              />
              <span className={`relative z-10 px-2 text-xs leading-6 ${textColor}`}>
                {phrase.phrase}
              </span>
            </div>
            <span className="text-[11px] text-dim font-mono w-8 text-right">
              {phrase.count}
            </span>
          </div>
        );
      })}
    </div>
  );
}
