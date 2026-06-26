"use client";

import { useState, useEffect, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { TopBar } from "@/components/top-bar";
import { AlertBanner } from "@/components/alert-banner";
import { LeftSidebar } from "@/components/left-sidebar";
import { CenterPanel } from "@/components/center-panel";
import { RightPanel } from "@/components/right-panel";
import { useDashboardData } from "@/lib/hooks/use-dashboard-data";
import { useWatchlist } from "@/lib/hooks/use-watchlist";

import NewsView from "@/components/views/news-view";
import ScreenerView from "@/components/views/screener-view";
import SettingsView from "@/components/views/settings-view";

type ActiveView = "dashboard" | "news" | "screener" | "settings";

function DashboardContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryView = searchParams.get("view") as ActiveView;

  const [activeView, setActiveView] = useState<ActiveView>(
    ["dashboard", "news", "screener", "settings"].includes(queryView)
      ? queryView
      : "dashboard"
  );

  const [selectedTicker, setSelectedTicker] = useState<string | null>(null);
  const [timeWindow, setTimeWindow] = useState("60");
  const [searchQuery, setSearchQuery] = useState("");
  const [timeRange, setTimeRange] = useState("24hr");

  const { watchlist, addTicker, removeTicker, isWatched } = useWatchlist();

  const data = useDashboardData(selectedTicker, timeWindow, timeRange);

  // Sync URL to view
  useEffect(() => {
    if (activeView === "dashboard") {
      router.replace("/");
    } else {
      router.replace(`/?view=${activeView}`);
    }
  }, [activeView, router]);

  // If a user selects a ticker, we force switch them back to the dashboard explicitly
  // so they can see the ticker breakdown.
  const handleSelectTicker = (t: string | null) => {
    setSelectedTicker(t);
    if (t) setActiveView("dashboard");
  };

  return (
    <>
      <TopBar
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        lastSync={data.lastSync}
        alertCount={data.alerts.length}
      />
      <AlertBanner alerts={data.alerts} />
      <div className="dashboard-grid flex-1">
        {/* Persistent left sidebar */}
        <LeftSidebar
          activeView={activeView}
          onViewChange={setActiveView}
          watchlist={watchlist}
          tickers={data.tickers}
          subredditHealth={data.subredditHealth}
          timeWindow={timeWindow}
          onTimeWindowChange={setTimeWindow}
          onSelectTicker={handleSelectTicker}
          selectedTicker={selectedTicker}
          onAddToWatchlist={addTicker}
          onRemoveFromWatchlist={removeTicker}
        />

        {/* Dynamic center panel */}
        {activeView === "dashboard" && (
          <CenterPanel
            selectedTicker={selectedTicker}
            onSelectTicker={setSelectedTicker}
            tickers={data.tickers}
            tickersLoading={data.tickersLoading}
            searchQuery={searchQuery}
            selectedTickerData={data.selectedTickerData}
            history={data.history}
            posts={data.posts}
            phrases={data.phrases}
            detailLoading={data.detailLoading}
            timeRange={timeRange}
            onTimeRangeChange={setTimeRange}
            onAddToWatchlist={addTicker}
            isWatched={isWatched}
          />
        )}
        {activeView === "news" && (
          <div className="flex-1 overflow-hidden bg-background">
            <NewsView />
          </div>
        )}
        {activeView === "screener" && (
          <div className="flex-1 overflow-hidden bg-background">
            <ScreenerView />
          </div>
        )}
        {activeView === "settings" && (
          <div className="flex-1 overflow-hidden bg-background">
            <SettingsView />
          </div>
        )}

        {/* Persistent right panel */}
        <RightPanel
          alerts={data.alerts}
          posts={data.globalPosts}
          selectedTicker={selectedTicker}
          onSelectTicker={handleSelectTicker}
        />
      </div>
    </>
  );
}

export default function Home() {
  return (
    <Suspense fallback={<div className="p-8 text-dim">Loading app...</div>}>
      <DashboardContent />
    </Suspense>
  );
}
