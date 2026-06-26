"use client";

import { useState, useEffect, useCallback } from "react";

interface UseWatchlistReturn {
  watchlist: string[];
  addTicker: (ticker: string) => void;
  removeTicker: (ticker: string) => void;
  isWatched: (ticker: string) => boolean;
}

const STORAGE_KEY = "stockSentimentWatchlist";

export function useWatchlist(): UseWatchlistReturn {
  const [watchlist, setWatchlist] = useState<string[]>([]);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) setWatchlist(JSON.parse(saved));
    } catch {
      // ignore parse errors
    }
  }, []);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(watchlist));
  }, [watchlist]);

  const addTicker = useCallback((ticker: string) => {
    setWatchlist((prev) =>
      prev.includes(ticker.toUpperCase()) ? prev : [...prev, ticker.toUpperCase()]
    );
  }, []);

  const removeTicker = useCallback((ticker: string) => {
    setWatchlist((prev) => prev.filter((t) => t !== ticker.toUpperCase()));
  }, []);

  const isWatched = useCallback(
    (ticker: string) => watchlist.includes(ticker.toUpperCase()),
    [watchlist]
  );

  return { watchlist, addTicker, removeTicker, isWatched };
}
