"use client";

import { useState, useEffect, useCallback } from "react";
import type { TickerData, HistoryPoint, Post, Alert, SubredditHealth, HotPhrase } from "@/lib/types";

interface DashboardData {
  tickers: TickerData[];
  lastSync: string | null;
  tickersLoading: boolean;

  selectedTickerData: TickerData | null;
  history: HistoryPoint[];
  posts: Post[];
  detailLoading: boolean;

  alerts: Alert[];
  alertsLoading: boolean;

  subredditHealth: SubredditHealth[];
  healthLoading: boolean;

  phrases: HotPhrase[];
  phrasesLoading: boolean;

  globalPosts: Post[];
  globalPostsLoading: boolean;

  refetch: () => void;
}

export function useDashboardData(
  selectedTicker: string | null,
  timeWindow: string,
  timeRange: string
): DashboardData {
  const [tickers, setTickers] = useState<TickerData[]>([]);
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [tickersLoading, setTickersLoading] = useState(true);

  const [selectedTickerData, setSelectedTickerData] = useState<TickerData | null>(null);
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const [posts, setPosts] = useState<Post[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);

  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [alertsLoading, setAlertsLoading] = useState(true);

  const [subredditHealth, setSubredditHealth] = useState<SubredditHealth[]>([]);
  const [healthLoading, setHealthLoading] = useState(true);

  const [phrases, setPhrases] = useState<HotPhrase[]>([]);
  const [phrasesLoading, setPhrasesLoading] = useState(false);

  const [globalPosts, setGlobalPosts] = useState<Post[]>([]);
  const [globalPostsLoading, setGlobalPostsLoading] = useState(true);

  const fetchScreener = useCallback(async () => {
    try {
      const res = await fetch(`/api/screener?window=${timeWindow}`);
      const json = await res.json();
      setTickers(json.data || []);
      setLastSync(json.lastSync || null);
    } catch (err) {
      console.error("Failed to fetch screener:", err);
    } finally {
      setTickersLoading(false);
    }
  }, [timeWindow]);

  const fetchAlerts = useCallback(async () => {
    try {
      const res = await fetch("/api/alerts");
      const json = await res.json();
      setAlerts(Array.isArray(json) ? json : []);
    } catch (err) {
      console.error("Failed to fetch alerts:", err);
    } finally {
      setAlertsLoading(false);
    }
  }, []);

  const fetchHealth = useCallback(async () => {
    try {
      const res = await fetch("/api/subreddits/health?minutes=60");
      const json = await res.json();
      setSubredditHealth(Array.isArray(json) ? json : []);
    } catch (err) {
      console.error("Failed to fetch health:", err);
    } finally {
      setHealthLoading(false);
    }
  }, []);

  const fetchGlobalPosts = useCallback(async () => {
    try {
      const res = await fetch("/api/posts?limit=30");
      const json = await res.json();
      setGlobalPosts(Array.isArray(json) ? json : []);
    } catch (err) {
      console.error("Failed to fetch global posts:", err);
    } finally {
      setGlobalPostsLoading(false);
    }
  }, []);

  // Fetch screener data
  useEffect(() => {
    setTickersLoading(true);
    fetchScreener();
  }, [fetchScreener]);

  // Auto-refresh screener every 60s
  useEffect(() => {
    const interval = setInterval(fetchScreener, 60000);
    return () => clearInterval(interval);
  }, [fetchScreener]);

  // Fetch alerts, health, global posts on mount
  useEffect(() => {
    fetchAlerts();
    fetchHealth();
    fetchGlobalPosts();
  }, [fetchAlerts, fetchHealth, fetchGlobalPosts]);

  // Refresh alerts every 2 min
  useEffect(() => {
    const interval = setInterval(fetchAlerts, 120000);
    return () => clearInterval(interval);
  }, [fetchAlerts]);

  // Fetch ticker-specific data when selectedTicker changes
  useEffect(() => {
    if (!selectedTicker) {
      setSelectedTickerData(null);
      setHistory([]);
      setPosts([]);
      setPhrases([]);
      return;
    }

    setDetailLoading(true);
    setPhrasesLoading(true);

    const hoursMap: Record<string, number> = { "1hr": 1, "6hr": 6, "24hr": 24 };
    const hours = hoursMap[timeRange] || 24;

    Promise.all([
      fetch(`/api/ticker/${selectedTicker}`).then((r) => r.json()),
      fetch(`/api/ticker/${selectedTicker}/history?hours=${hours}`).then((r) => r.json()),
      fetch(`/api/posts?ticker=${selectedTicker}&limit=20`).then((r) => r.json()),
      fetch(`/api/phrases?ticker=${selectedTicker}&hours=${hours}&limit=15`).then((r) => r.json()),
    ])
      .then(([ticker, hist, postData, phraseData]) => {
        // Ticker API now returns { data: {...} } wrapper
        const tickerPayload = ticker.data || ticker;
        if (!tickerPayload.error) setSelectedTickerData(tickerPayload);
        else setSelectedTickerData(null);
        setHistory(Array.isArray(hist.data) ? hist.data : Array.isArray(hist) ? hist : []);
        setPosts(Array.isArray(postData) ? postData : []);
        setPhrases(Array.isArray(phraseData) ? phraseData : []);
      })
      .catch((err) => console.error("Failed to fetch ticker detail:", err))
      .finally(() => {
        setDetailLoading(false);
        setPhrasesLoading(false);
      });
  }, [selectedTicker, timeRange]);

  const refetch = useCallback(() => {
    fetchScreener();
    fetchAlerts();
    fetchHealth();
    fetchGlobalPosts();
  }, [fetchScreener, fetchAlerts, fetchHealth, fetchGlobalPosts]);

  return {
    tickers,
    lastSync,
    tickersLoading,
    selectedTickerData,
    history,
    posts,
    detailLoading,
    alerts,
    alertsLoading,
    subredditHealth,
    healthLoading,
    phrases,
    phrasesLoading,
    globalPosts,
    globalPostsLoading,
    refetch,
  };
}
