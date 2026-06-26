"use client";

export function SourceBadge({ source }: { source: "reddit" | "bluesky" | "twitter" | string }) {
  if (source === "reddit") {
    return (
      <span className="inline-flex items-center justify-center w-5 h-5 rounded text-[10px] font-bold bg-orange-500/20 text-orange-400 border border-orange-500/30">
        R
      </span>
    );
  }
  if (source === "twitter") {
    return (
      <span className="inline-flex items-center justify-center w-5 h-5 rounded text-[10px] font-bold bg-slate-500/20 text-slate-300 border border-slate-500/30">
        𝕏
      </span>
    );
  }
  if (source === "bluesky") {
    return (
      <span className="inline-flex items-center justify-center w-5 h-5 rounded text-[10px] font-bold bg-blue-500/20 text-blue-400 border border-blue-500/30">
        B
      </span>
    );
  }
  // Fallback for RSS or other sources
  return (
    <span className="inline-flex items-center justify-center w-5 h-5 rounded text-[10px] font-bold bg-violet-500/20 text-violet-400 border border-violet-500/30">
      N
    </span>
  );
}
