"use client";

import { useState, useEffect } from "react";
import { Search, Bell, Sun, Moon } from "lucide-react";
import { useTheme } from "next-themes";
import { Input } from "./ui/input";

interface TopBarProps {
  searchQuery: string;
  onSearchChange: (query: string) => void;
  lastSync: string | null;
  alertCount: number;
}

export function TopBar({ searchQuery, onSearchChange, lastSync, alertCount }: TopBarProps) {
  const { setTheme, resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const lastSyncText = lastSync
    ? (() => {
        const diff = Date.now() - new Date(lastSync).getTime();
        const mins = Math.floor(diff / 60000);
        return mins < 1 ? "just now" : `${mins}m ago`;
      })()
    : "---";

  return (
    <div className="flex items-center gap-4 px-4 py-2.5 border-b border-border bg-card/95 backdrop-blur-sm shrink-0">
      {/* Branding */}
      <div className="flex items-center gap-2 shrink-0">
        <h1 className="text-base font-bold font-mono text-foreground tracking-tight">
          STOCK SENTIMENT
        </h1>
        <span className="text-xs text-dim font-mono">DASHBOARD</span>
      </div>

      {/* Search */}
      <div className="relative flex-1 max-w-xs">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-dim" />
        <Input
          type="text"
          placeholder="Search ticker..."
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          className="pl-8 h-8 text-sm bg-background border-border placeholder:text-faint"
        />
      </div>

      <div className="flex items-center gap-4 ml-auto">
        {/* Live indicator */}
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <div className="h-2 w-2 rounded-full bg-emerald-500 pulse-live" />
          <span className="font-mono">LIVE</span>
          <span className="text-faint">|</span>
          <span className="text-dim">Last poll: {lastSyncText}</span>
        </div>

        {/* Theme toggle */}
        {mounted && (
          <button
            onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
            className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Toggle theme"
          >
            {resolvedTheme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </button>
        )}

        {/* Alert count */}
        {alertCount > 0 && (
          <div className="relative">
            <Bell className="h-4 w-4 text-muted-foreground" />
            <span className="absolute -top-1.5 -right-1.5 h-4 min-w-4 flex items-center justify-center rounded-full bg-red-500 text-[10px] font-bold text-white px-1">
              {alertCount}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
