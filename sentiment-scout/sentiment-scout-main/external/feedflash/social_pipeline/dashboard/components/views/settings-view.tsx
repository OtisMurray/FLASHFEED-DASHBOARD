"use client";

import { useState, useEffect, useCallback } from "react";

// ── Types ──────────────────────────────────────────────────────────────────

interface Keyword {
    id: number;
    keyword: string;
    category: string;
    enabled: boolean;
}

interface RSSSource {
    id: number;
    name: string;
    url: string;
    category: string;
    enabled: boolean;
}

interface WatchedAccount {
    id: number;
    platform: string;
    handle: string;
    enabled: boolean;
}

type Tab = "keywords" | "sources" | "accounts";

// ── Toggle switch ──────────────────────────────────────────────────────────

function Toggle({
    enabled,
    onToggle,
}: {
    enabled: boolean;
    onToggle: () => void;
}) {
    return (
        <button
            onClick={onToggle}
            className={`relative w-9 h-5 rounded-full transition-colors ${enabled ? "bg-emerald-500" : "bg-muted-foreground/30"
                }`}
        >
            <span
                className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform ${enabled ? "translate-x-4" : "translate-x-0"
                    }`}
            />
        </button>
    );
}

// ── Keywords tab ───────────────────────────────────────────────────────────

function KeywordsTab() {
    const [keywords, setKeywords] = useState<Keyword[]>([]);
    const [newKeyword, setNewKeyword] = useState("");
    const [newCategory, setNewCategory] = useState("general");
    const [loading, setLoading] = useState(true);

    const fetchKeywords = useCallback(async () => {
        const res = await fetch("/api/settings/keywords");
        const json = await res.json();
        setKeywords(json.data || []);
        setLoading(false);
    }, []);

    useEffect(() => {
        fetchKeywords();
    }, [fetchKeywords]);

    const handleAdd = async () => {
        if (!newKeyword.trim()) return;
        await fetch("/api/settings/keywords", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ keyword: newKeyword, category: newCategory }),
        });
        setNewKeyword("");
        fetchKeywords();
    };

    const handleToggle = async (id: number, enabled: boolean) => {
        await fetch("/api/settings/keywords", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id, enabled: !enabled }),
        });
        fetchKeywords();
    };

    const handleDelete = async (id: number) => {
        await fetch(`/api/settings/keywords?id=${id}`, { method: "DELETE" });
        fetchKeywords();
    };

    if (loading) return <div className="p-4 text-dim">Loading keywords…</div>;

    const categories = [...new Set(keywords.map((k) => k.category))].sort();

    return (
        <div className="space-y-4">
            {/* Add form */}
            <div className="flex gap-2 items-end">
                <div className="flex-1">
                    <label className="block text-xs text-dim mb-1">Keyword</label>
                    <input
                        type="text"
                        value={newKeyword}
                        onChange={(e) => setNewKeyword(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && handleAdd()}
                        placeholder="e.g. earnings"
                        className="w-full px-3 py-1.5 text-xs bg-input-background border border-border rounded-md text-foreground placeholder:text-faint"
                    />
                </div>
                <div>
                    <label className="block text-xs text-dim mb-1">Category</label>
                    <select
                        value={newCategory}
                        onChange={(e) => setNewCategory(e.target.value)}
                        className="px-3 py-1.5 text-xs bg-input-background border border-border rounded-md text-foreground"
                    >
                        <option>general</option>
                        <option>fundamental</option>
                        <option>regulatory</option>
                        <option>analyst</option>
                        <option>momentum</option>
                    </select>
                </div>
                <button
                    onClick={handleAdd}
                    className="px-3 py-1.5 text-xs bg-primary text-primary-foreground rounded-md hover:opacity-90 transition-opacity"
                >
                    + Add
                </button>
            </div>

            {/* Table grouped by category */}
            {categories.map((cat) => (
                <div key={cat}>
                    <h3 className="text-xs font-medium text-dim uppercase tracking-wide mb-2">
                        {cat}
                    </h3>
                    <div className="border border-border rounded-md overflow-hidden">
                        {keywords
                            .filter((k) => k.category === cat)
                            .map((kw) => (
                                <div
                                    key={kw.id}
                                    className="flex items-center justify-between px-3 py-2 border-b border-border last:border-0 hover:bg-muted/50"
                                >
                                    <span
                                        className={`text-xs font-mono ${kw.enabled ? "text-foreground" : "text-faint line-through"
                                            }`}
                                    >
                                        {kw.keyword}
                                    </span>
                                    <div className="flex items-center gap-3">
                                        <Toggle
                                            enabled={kw.enabled}
                                            onToggle={() => handleToggle(kw.id, kw.enabled)}
                                        />
                                        <button
                                            onClick={() => handleDelete(kw.id)}
                                            className="text-xs text-red-400 hover:text-red-300 transition-colors"
                                        >
                                            ✕
                                        </button>
                                    </div>
                                </div>
                            ))}
                    </div>
                </div>
            ))}

            <p className="text-xs text-faint">
                {keywords.length} keywords total · {keywords.filter((k) => k.enabled).length} enabled
            </p>
        </div>
    );
}

// ── Sources tab ────────────────────────────────────────────────────────────

function SourcesTab() {
    const [sources, setSources] = useState<RSSSource[]>([]);
    const [newName, setNewName] = useState("");
    const [newUrl, setNewUrl] = useState("");
    const [newCategory, setNewCategory] = useState("markets");
    const [loading, setLoading] = useState(true);

    const fetchSources = useCallback(async () => {
        const res = await fetch("/api/settings/sources");
        const json = await res.json();
        setSources(json.data || []);
        setLoading(false);
    }, []);

    useEffect(() => {
        fetchSources();
    }, [fetchSources]);

    const handleAdd = async () => {
        if (!newName.trim() || !newUrl.trim()) return;
        await fetch("/api/settings/sources", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: newName, url: newUrl, category: newCategory }),
        });
        setNewName("");
        setNewUrl("");
        fetchSources();
    };

    const handleToggle = async (id: number, enabled: boolean) => {
        await fetch("/api/settings/sources", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id, enabled: !enabled }),
        });
        fetchSources();
    };

    const handleDelete = async (id: number) => {
        await fetch(`/api/settings/sources?id=${id}`, { method: "DELETE" });
        fetchSources();
    };

    if (loading) return <div className="p-4 text-dim">Loading sources…</div>;

    const categories = [...new Set(sources.map((s) => s.category))].sort();

    return (
        <div className="space-y-4">
            {/* Add form */}
            <div className="flex gap-2 items-end flex-wrap">
                <div className="flex-1 min-w-[140px]">
                    <label className="block text-xs text-dim mb-1">Name</label>
                    <input
                        type="text"
                        value={newName}
                        onChange={(e) => setNewName(e.target.value)}
                        placeholder="e.g. CNBC Markets"
                        className="w-full px-3 py-1.5 text-xs bg-input-background border border-border rounded-md text-foreground placeholder:text-faint"
                    />
                </div>
                <div className="flex-[2] min-w-[200px]">
                    <label className="block text-xs text-dim mb-1">RSS URL</label>
                    <input
                        type="text"
                        value={newUrl}
                        onChange={(e) => setNewUrl(e.target.value)}
                        placeholder="https://..."
                        className="w-full px-3 py-1.5 text-xs bg-input-background border border-border rounded-md text-foreground placeholder:text-faint"
                    />
                </div>
                <div>
                    <label className="block text-xs text-dim mb-1">Category</label>
                    <select
                        value={newCategory}
                        onChange={(e) => setNewCategory(e.target.value)}
                        className="px-3 py-1.5 text-xs bg-input-background border border-border rounded-md text-foreground"
                    >
                        <option>markets</option>
                        <option>equities</option>
                        <option>economy</option>
                        <option>filings</option>
                        <option>press_releases</option>
                        <option>crypto</option>
                        <option>commodities</option>
                        <option>fda</option>
                    </select>
                </div>
                <button
                    onClick={handleAdd}
                    className="px-3 py-1.5 text-xs bg-primary text-primary-foreground rounded-md hover:opacity-90 transition-opacity"
                >
                    + Add
                </button>
            </div>

            {/* Table grouped by category */}
            {categories.map((cat) => (
                <div key={cat}>
                    <h3 className="text-xs font-medium text-dim uppercase tracking-wide mb-2">
                        {cat}
                    </h3>
                    <div className="border border-border rounded-md overflow-hidden">
                        {sources
                            .filter((s) => s.category === cat)
                            .map((src) => (
                                <div
                                    key={src.id}
                                    className="flex items-center justify-between px-3 py-2 border-b border-border last:border-0 hover:bg-muted/50"
                                >
                                    <div className="flex-1 min-w-0">
                                        <span
                                            className={`text-xs font-medium ${src.enabled ? "text-foreground" : "text-faint line-through"
                                                }`}
                                        >
                                            {src.name}
                                        </span>
                                        <span className="text-[10px] text-faint ml-2 truncate" title={src.url}>
                                            {src.url.slice(0, 60)}…
                                        </span>
                                    </div>
                                    <div className="flex items-center gap-3 ml-2">
                                        <Toggle
                                            enabled={src.enabled}
                                            onToggle={() => handleToggle(src.id, src.enabled)}
                                        />
                                        <button
                                            onClick={() => handleDelete(src.id)}
                                            className="text-xs text-red-400 hover:text-red-300 transition-colors"
                                        >
                                            ✕
                                        </button>
                                    </div>
                                </div>
                            ))}
                    </div>
                </div>
            ))}

            <p className="text-xs text-faint">
                {sources.length} sources · {sources.filter((s) => s.enabled).length} enabled
            </p>
        </div>
    );
}

// ── Accounts tab ───────────────────────────────────────────────────────────

function AccountsTab() {
    const [accounts, setAccounts] = useState<WatchedAccount[]>([]);
    const [newPlatform, setNewPlatform] = useState("twitter");
    const [newHandle, setNewHandle] = useState("");
    const [loading, setLoading] = useState(true);

    const fetchAccounts = useCallback(async () => {
        const res = await fetch("/api/settings/accounts");
        const json = await res.json();
        setAccounts(json.data || []);
        setLoading(false);
    }, []);

    useEffect(() => {
        fetchAccounts();
    }, [fetchAccounts]);

    const handleAdd = async () => {
        if (!newHandle.trim()) return;
        await fetch("/api/settings/accounts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ platform: newPlatform, handle: newHandle }),
        });
        setNewHandle("");
        fetchAccounts();
    };

    const handleToggle = async (id: number, enabled: boolean) => {
        await fetch("/api/settings/accounts", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id, enabled: !enabled }),
        });
        fetchAccounts();
    };

    const handleDelete = async (id: number) => {
        await fetch(`/api/settings/accounts?id=${id}`, { method: "DELETE" });
        fetchAccounts();
    };

    if (loading) return <div className="p-4 text-dim">Loading accounts…</div>;

    const platforms = [...new Set(accounts.map((a) => a.platform))].sort();

    const platformIcons: Record<string, string> = {
        twitter: "𝕏",
        bluesky: "🦋",
        reddit: "📡",
    };

    return (
        <div className="space-y-4">
            {/* Add form */}
            <div className="flex gap-2 items-end">
                <div>
                    <label className="block text-xs text-dim mb-1">Platform</label>
                    <select
                        value={newPlatform}
                        onChange={(e) => setNewPlatform(e.target.value)}
                        className="px-3 py-1.5 text-xs bg-input-background border border-border rounded-md text-foreground"
                    >
                        <option value="twitter">Twitter / X</option>
                        <option value="bluesky">Bluesky</option>
                        <option value="reddit">Reddit</option>
                    </select>
                </div>
                <div className="flex-1">
                    <label className="block text-xs text-dim mb-1">Handle</label>
                    <input
                        type="text"
                        value={newHandle}
                        onChange={(e) => setNewHandle(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && handleAdd()}
                        placeholder={newPlatform === "reddit" ? "subreddit name" : "@handle"}
                        className="w-full px-3 py-1.5 text-xs bg-input-background border border-border rounded-md text-foreground placeholder:text-faint"
                    />
                </div>
                <button
                    onClick={handleAdd}
                    className="px-3 py-1.5 text-xs bg-primary text-primary-foreground rounded-md hover:opacity-90 transition-opacity"
                >
                    + Add
                </button>
            </div>

            {/* Grouped by platform */}
            {platforms.map((plat) => (
                <div key={plat}>
                    <h3 className="text-xs font-medium text-dim uppercase tracking-wide mb-2">
                        {platformIcons[plat] || "🔗"} {plat}
                    </h3>
                    <div className="border border-border rounded-md overflow-hidden">
                        {accounts
                            .filter((a) => a.platform === plat)
                            .map((acc) => (
                                <div
                                    key={acc.id}
                                    className="flex items-center justify-between px-3 py-2 border-b border-border last:border-0 hover:bg-muted/50"
                                >
                                    <span
                                        className={`text-xs font-mono ${acc.enabled ? "text-foreground" : "text-faint line-through"
                                            }`}
                                    >
                                        {plat === "reddit" ? `r/${acc.handle}` : `@${acc.handle}`}
                                    </span>
                                    <div className="flex items-center gap-3">
                                        <Toggle
                                            enabled={acc.enabled}
                                            onToggle={() => handleToggle(acc.id, acc.enabled)}
                                        />
                                        <button
                                            onClick={() => handleDelete(acc.id)}
                                            className="text-xs text-red-400 hover:text-red-300 transition-colors"
                                        >
                                            ✕
                                        </button>
                                    </div>
                                </div>
                            ))}
                    </div>
                </div>
            ))}

            <p className="text-xs text-faint">
                {accounts.length} accounts · {accounts.filter((a) => a.enabled).length} enabled
            </p>
        </div>
    );
}

// ── Preferences tab ──────────────────────────────────────────────────────────

interface SettingsState {
  dataSources: {
    wsbVariants: boolean;
    pennyStocks: boolean;
    generalTrading: boolean;
    squeezeMomentum: boolean;
    bluesky: boolean;
  };
  defaultTimeWindow: string;
  refreshInterval: number;
  showSparklines: boolean;
}

const defaultSettings: SettingsState = {
  dataSources: {
    wsbVariants: true,
    pennyStocks: true,
    generalTrading: true,
    squeezeMomentum: true,
    bluesky: true,
  },
  defaultTimeWindow: "60",
  refreshInterval: 60,
  showSparklines: true,
};

function PreferencesTab() {
  const [settings, setSettings] = useState<SettingsState>(defaultSettings);

  useEffect(() => {
    const saved = localStorage.getItem("stockSentimentSettings");
    if (saved) {
      try {
        setSettings(JSON.parse(saved));
      } catch {
        // ignore
      }
    }
  }, []);

  useEffect(() => {
    localStorage.setItem("stockSentimentSettings", JSON.stringify(settings));
  }, [settings]);

  const updateDataSource = (
    key: keyof SettingsState["dataSources"],
    value: boolean
  ) => {
    setSettings((prev) => ({
      ...prev,
      dataSources: { ...prev.dataSources, [key]: value },
    }));
  };

  return (
    <div className="space-y-6 max-w-xl">
      {/* Data Sources */}
      <div>
        <h3 className="text-xs font-medium text-dim uppercase tracking-wide mb-3">
          Local Data Sources
        </h3>
        <div className="space-y-3 bg-muted/20 p-4 rounded-lg border border-border">
          {[
            { key: "wsbVariants" as const, label: "WSB Variants", desc: "wallstreetbets, wsb2, etc." },
            { key: "pennyStocks" as const, label: "Small/Penny Stocks", desc: "pennystocks, smallstreetbets" },
            { key: "generalTrading" as const, label: "General Trading", desc: "stocks, trading, etc." },
            { key: "squeezeMomentum" as const, label: "Squeeze/Momentum", desc: "shortsqueeze, options" },
            { key: "bluesky" as const, label: "Bluesky", desc: "Cashtag search data" },
          ].map((item) => (
            <div key={item.key} className="flex items-center justify-between">
              <div>
                <label className="text-sm font-medium text-secondary-foreground">{item.label}</label>
                <div className="text-[10px] text-dim">{item.desc}</div>
              </div>
              <Toggle
                enabled={settings.dataSources[item.key]}
                onToggle={() => updateDataSource(item.key, !settings.dataSources[item.key])}
              />
            </div>
          ))}
        </div>
      </div>

      {/* Preferences */}
      <div>
        <h3 className="text-xs font-medium text-dim uppercase tracking-wide mb-3">
          UI Preferences
        </h3>
        <div className="space-y-4 bg-muted/20 p-4 rounded-lg border border-border">
          <div className="flex items-center justify-between">
            <div>
              <label className="text-sm font-medium text-secondary-foreground">Show Sparklines</label>
              <div className="text-[10px] text-dim">Trend lines in screener</div>
            </div>
            <Toggle
              enabled={settings.showSparklines}
              onToggle={() =>
                setSettings((prev) => ({ ...prev, showSparklines: !prev.showSparklines }))
              }
            />
          </div>
          
          <div className="flex items-center justify-between">
            <div>
              <label className="text-sm font-medium text-secondary-foreground">Default Time Window</label>
              <div className="text-[10px] text-dim">Initial window on load</div>
            </div>
            <select
              value={settings.defaultTimeWindow}
              onChange={(e) =>
                setSettings((prev) => ({ ...prev, defaultTimeWindow: e.target.value }))
              }
              className="px-3 py-1.5 text-xs bg-input-background border border-border rounded-md text-foreground"
            >
              {["1", "3", "5", "10", "15", "30", "60"].map((v) => (
                <option key={v} value={v}>{v} min</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <p className="text-[10px] text-faint text-center">
        Preferences are saved automatically to your local browser storage.
      </p>
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────

type TabMenu = Tab | "preferences";

export default function SettingsView() {
    const [tab, setTab] = useState<TabMenu>("keywords");

    const tabs: { key: TabMenu; label: string; icon: string }[] = [
        { key: "keywords", label: "Keywords", icon: "🔍" },
        { key: "sources", label: "RSS Sources", icon: "📰" },
        { key: "accounts", label: "Accounts", icon: "👤" },
        { key: "preferences", label: "Preferences", icon: "⚙️" },
    ];

    return (
        <div className="flex flex-col h-full overflow-hidden bg-background">
            {/* Header */}
            <div className="flex-shrink-0 px-4 py-3 border-b border-border">
                <h1 className="text-sm font-bold text-foreground mb-3">Admin Settings</h1>
                <div className="flex gap-1 bg-muted rounded-lg p-0.5 w-fit">
                    {tabs.map((t) => (
                        <button
                            key={t.key}
                            onClick={() => setTab(t.key)}
                            className={`text-xs px-3 py-1.5 rounded-md transition-colors ${tab === t.key
                                    ? "bg-primary text-primary-foreground font-medium"
                                    : "text-muted-foreground hover:text-foreground"
                                }`}
                        >
                            {t.icon} {t.label}
                        </button>
                    ))}
                </div>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-auto p-4 max-w-4xl">
                {tab === "keywords" && <KeywordsTab />}
                {tab === "sources" && <SourcesTab />}
                {tab === "accounts" && <AccountsTab />}
                {tab === "preferences" && <PreferencesTab />}
            </div>
        </div>
    );
}
