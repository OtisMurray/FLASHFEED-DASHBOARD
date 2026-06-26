"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { TickerData } from "@/lib/types";
import {
    formatPrice,
    formatSentiment,
    getSentimentColor,
    getAnalystLabel,
    formatNumber,
} from "@/lib/utils";

// ── Sort logic ─────────────────────────────────────────────────────────────

type SortKey = keyof TickerData;
type SortDir = "asc" | "desc";

function compareRows(a: TickerData, b: TickerData, key: SortKey, dir: SortDir): number {
    let va: unknown = a[key];
    let vb: unknown = b[key];

    if (va == null) va = dir === "asc" ? Infinity : -Infinity;
    if (vb == null) vb = dir === "asc" ? Infinity : -Infinity;

    if (typeof va === "string" && typeof vb === "string") {
        return dir === "asc" ? va.localeCompare(vb) : vb.localeCompare(va);
    }
    const na = Number(va);
    const nb = Number(vb);
    return dir === "asc" ? na - nb : nb - na;
}

// ── Time windows ───────────────────────────────────────────────────────────

const WINDOWS = [
    { label: "1m", value: "1" },
    { label: "3m", value: "3" },
    { label: "5m", value: "5" },
    { label: "10m", value: "10" },
    { label: "15m", value: "15" },
    { label: "30m", value: "30" },
    { label: "1hr", value: "60" },
];

// ── Filter options (Finviz-style) ──────────────────────────────────────────

const EARNINGS_OPTS = [
    { label: "Any", value: "" },
    { label: "Today", value: "today" },
    { label: "Tomorrow", value: "tomorrow" },
    { label: "This Week", value: "this_week" },
    { label: "Next Week", value: "next_week" },
    { label: "This Month", value: "this_month" },
];

const AVG_VOL_OPTS = [
    { label: "Any", value: "" },
    { label: "Over 50K", value: "50000" },
    { label: "Over 100K", value: "100000" },
    { label: "Over 500K", value: "500000" },
    { label: "Over 1M", value: "1000000" },
    { label: "Over 2M", value: "2000000" },
];

const CHANGE_OPTS = [
    { label: "Any", value: "" },
    { label: "Up", value: "up" },
    { label: "Down", value: "down" },
    { label: "Up 2%+", value: "up2" },
    { label: "Up 5%+", value: "up5" },
    { label: "Up 10%+", value: "up10" },
    { label: "Down 2%+", value: "down2" },
    { label: "Down 5%+", value: "down5" },
];

const CAP_OPTS = [
    { label: "Any", value: "" },
    { label: "Micro (<$300M)", value: "micro" },
    { label: "Small (<$2B)", value: "small" },
    { label: "Mid (<$10B)", value: "mid" },
    { label: "Large (<$200B)", value: "large" },
    { label: "Mega (>$200B)", value: "mega" },
];

const SENTIMENT_OPTS = [
    { label: "Any", value: "" },
    { label: "Bullish", value: "bullish" },
    { label: "Bearish", value: "bearish" },
    { label: "Neutral", value: "neutral" },
];

// ── Filter logic ───────────────────────────────────────────────────────────

interface Filters {
    earnings: string;
    avgVol: string;
    change: string;
    cap: string;
    sentiment: string;
    sector: string;
    search: string;
}

function getToday() {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function parseEarningsDate(dateStr: string | null): Date | null {
    if (!dateStr) return null;
    const d = new Date(dateStr);
    return isNaN(d.getTime()) ? null : new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function applyFilters(rows: TickerData[], filters: Filters): TickerData[] {
    const today = getToday();
    const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
    const weekEnd = new Date(today); weekEnd.setDate(weekEnd.getDate() + 7);
    const nextWeekStart = new Date(today); nextWeekStart.setDate(nextWeekStart.getDate() + 7);
    const nextWeekEnd = new Date(today); nextWeekEnd.setDate(nextWeekEnd.getDate() + 14);
    const monthEnd = new Date(today); monthEnd.setDate(monthEnd.getDate() + 30);

    return rows.filter((r) => {
        // Ticker / company search
        if (filters.search) {
            const q = filters.search.toUpperCase();
            const match =
                r.ticker?.toUpperCase().includes(q) ||
                r.company?.toUpperCase().includes(q) ||
                r.sector?.toUpperCase().includes(q) ||
                r.industry?.toUpperCase().includes(q);
            if (!match) return false;
        }

        // Earnings date
        if (filters.earnings) {
            const ed = parseEarningsDate(r.earnings_date);
            if (!ed) return false;
            if (filters.earnings === "today" && ed.getTime() !== today.getTime()) return false;
            if (filters.earnings === "tomorrow" && ed.getTime() !== tomorrow.getTime()) return false;
            if (filters.earnings === "this_week" && (ed < today || ed > weekEnd)) return false;
            if (filters.earnings === "next_week" && (ed < nextWeekStart || ed > nextWeekEnd)) return false;
            if (filters.earnings === "this_month" && (ed < today || ed > monthEnd)) return false;
        }

        // Avg volume
        if (filters.avgVol) {
            const minVol = parseInt(filters.avgVol, 10);
            if (!r.avg_volume || r.avg_volume < minVol) return false;
        }

        // Change direction
        if (filters.change) {
            const pct = r.change_pct ?? 0;
            if (filters.change === "up" && pct <= 0) return false;
            if (filters.change === "down" && pct >= 0) return false;
            if (filters.change === "up2" && pct < 2) return false;
            if (filters.change === "up5" && pct < 5) return false;
            if (filters.change === "up10" && pct < 10) return false;
            if (filters.change === "down2" && pct > -2) return false;
            if (filters.change === "down5" && pct > -5) return false;
        }

        // Market cap
        if (filters.cap) {
            const rawCap = r.market_cap;
            // Parse the formatted string back to a number for comparison
            const capNum = parseMarketCapStr(rawCap);
            if (filters.cap === "micro" && capNum >= 300_000_000) return false;
            if (filters.cap === "small" && (capNum < 300_000_000 || capNum >= 2_000_000_000)) return false;
            if (filters.cap === "mid" && (capNum < 2_000_000_000 || capNum >= 10_000_000_000)) return false;
            if (filters.cap === "large" && (capNum < 10_000_000_000 || capNum >= 200_000_000_000)) return false;
            if (filters.cap === "mega" && capNum < 200_000_000_000) return false;
        }

        // Sentiment
        if (filters.sentiment) {
            const ss = r.social_sentiment ?? r.avg_sentiment ?? 0;
            if (filters.sentiment === "bullish" && ss <= 0.05) return false;
            if (filters.sentiment === "bearish" && ss >= -0.05) return false;
            if (filters.sentiment === "neutral" && (ss > 0.05 || ss < -0.05)) return false;
        }

        // Sector
        if (filters.sector && r.sector !== filters.sector) return false;

        return true;
    });
}

function parseMarketCapStr(s: string): number {
    if (!s || s === "-") return 0;
    const n = parseFloat(s);
    if (s.endsWith("T")) return n * 1e12;
    if (s.endsWith("B")) return n * 1e9;
    if (s.endsWith("M")) return n * 1e6;
    if (s.endsWith("K")) return n * 1e3;
    return n || 0;
}

// ── Mini components ────────────────────────────────────────────────────────

function SentimentBar({ value }: { value: number | null }) {
    if (value == null) return <span className="text-muted-foreground">—</span>;
    const pct = ((value + 1) / 2) * 100;
    const color =
        value > 0.2 ? "bg-emerald-500" : value < -0.2 ? "bg-red-500" : "bg-amber-400";
    return (
        <div className="flex items-center gap-2">
            <div className="w-16 h-1.5 bg-muted rounded-full overflow-hidden">
                <div className={`h-full ${color} rounded-full`} style={{ width: `${pct}%` }} />
            </div>
            <span className={getSentimentColor(value)}>{formatSentiment(value)}</span>
        </div>
    );
}

function SentimentBadge({ value }: { value: number | null }) {
    if (value == null) return null;
    const label = value > 0.05 ? "Bullish" : value < -0.05 ? "Bearish" : "Neutral";
    const icon = value > 0.05 ? "▲" : value < -0.05 ? "▼" : "◆";
    const cls =
        value > 0.05
            ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30"
            : value < -0.05
                ? "bg-red-500/10 text-red-400 border-red-500/30"
                : "bg-amber-400/10 text-amber-400 border-amber-400/30";
    return (
        <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-bold border ${cls} whitespace-nowrap`}>
            {icon} {label}
        </span>
    );
}

function ChangeCell({ value }: { value: number | null }) {
    if (value == null) return <span className="text-muted-foreground">—</span>;
    const color = value > 0 ? "text-emerald-500" : value < 0 ? "text-red-500" : "text-muted-foreground";
    const sign = value > 0 ? "+" : "";
    return <span className={`font-mono font-medium ${color}`}>{sign}{value.toFixed(2)}%</span>;
}

function SortHeader({
    label,
    sortKey,
    currentSort,
    currentDir,
    onSort,
}: {
    label: string;
    sortKey: SortKey;
    currentSort: SortKey;
    currentDir: SortDir;
    onSort: (key: SortKey) => void;
}) {
    const active = currentSort === sortKey;
    return (
        <th
            className="px-3 py-2 text-left text-xs font-medium text-dim uppercase tracking-wide cursor-pointer hover:text-foreground select-none whitespace-nowrap"
            onClick={() => onSort(sortKey)}
        >
            {label}
            {active && (
                <span className="ml-1 text-primary">{currentDir === "asc" ? "▲" : "▼"}</span>
            )}
        </th>
    );
}

// ── Filter dropdown ────────────────────────────────────────────────────────

function FilterSelect({
    label,
    value,
    opts,
    onChange,
}: {
    label: string;
    value: string;
    opts: { label: string; value: string }[];
    onChange: (v: string) => void;
}) {
    const active = value !== "";
    return (
        <div className="flex flex-col gap-0.5">
            <span className="text-[10px] font-medium text-dim uppercase tracking-wide">{label}</span>
            <select
                value={value}
                onChange={(e) => onChange(e.target.value)}
                className={`text-xs px-2 py-1 rounded border bg-card cursor-pointer transition-colors ${active
                    ? "border-primary text-primary"
                    : "border-border text-muted-foreground hover:border-border/70"
                    }`}
            >
                {opts.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                ))}
            </select>
        </div>
    );
}

// ── Main component ─────────────────────────────────────────────────────────

export default function ScreenerPage() {
    const [tickers, setTickers] = useState<TickerData[]>([]);
    const [loading, setLoading] = useState(true);
    const [lastSync, setLastSync] = useState<string | null>(null);
    const [window, setWindow] = useState("60");
    const [sortKey, setSortKey] = useState<SortKey>("change_pct");
    const [sortDir, setSortDir] = useState<SortDir>("desc");
    const [uploading, setUploading] = useState(false);
    const [uploadMsg, setUploadMsg] = useState<string | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    // Finviz-style filters
    const [filters, setFilters] = useState<Filters>({
        earnings: "",
        avgVol: "",
        change: "",
        cap: "",
        sentiment: "",
        sector: "",
        search: "",
    });

    const setFilter = (key: keyof Filters, val: string) =>
        setFilters((f) => ({ ...f, [key]: val }));

    const activeFilterCount = Object.values(filters).filter(Boolean).length;

    // Derive unique sectors from loaded data
    const sectors = [...new Set(tickers.map((t) => t.sector).filter(Boolean) as string[])].sort();

    // Fetch screener data
    const fetchData = useCallback(async () => {
        try {
            const res = await fetch(`/api/screener?window=${window}`);
            const json = await res.json();
            setTickers(json.data || []);
            setLastSync(json.lastSync || null);
        } catch {
            console.error("Failed to fetch screener data");
        } finally {
            setLoading(false);
        }
    }, [window]);

    useEffect(() => {
        fetchData();
        const id = setInterval(fetchData, 10_000);
        return () => clearInterval(id);
    }, [fetchData]);

    // Sort handler
    const handleSort = (key: SortKey) => {
        if (key === sortKey) {
            setSortDir((d) => (d === "asc" ? "desc" : "asc"));
        } else {
            setSortKey(key);
            setSortDir("desc");
        }
    };

    const filtered = applyFilters(tickers, filters);
    const sorted = [...filtered].sort((a, b) => compareRows(a, b, sortKey, sortDir));

    // CSV upload
    const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        setUploading(true);
        setUploadMsg(null);

        const formData = new FormData();
        formData.append("file", file);

        try {
            const res = await fetch("/api/screener/upload", {
                method: "POST",
                body: formData,
            });
            const json = await res.json();
            if (res.ok) {
                setUploadMsg(`✓ ${json.message}`);
                fetchData();
            } else {
                setUploadMsg(`✗ ${json.error}`);
            }
        } catch {
            setUploadMsg("✗ Upload failed");
        } finally {
            setUploading(false);
            if (fileInputRef.current) fileInputRef.current.value = "";
        }
    };

    const colSpan = 16;

    return (
        <div className="flex flex-col h-full overflow-hidden bg-background">

            {/* ── Filter Bar (Finviz-style) ────────────────────────────────── */}
            <div className="flex-shrink-0 px-4 py-2 border-b border-border bg-card/50">
                <div className="flex items-end gap-3 flex-wrap">
                    {/* Search */}
                    <div className="flex flex-col gap-0.5">
                        <span className="text-[10px] font-medium text-dim uppercase tracking-wide">Search</span>
                        <input
                            type="text"
                            placeholder="Ticker / company…"
                            value={filters.search}
                            onChange={(e) => setFilter("search", e.target.value)}
                            className="text-xs px-2 py-1 rounded border border-border bg-card text-foreground placeholder:text-muted-foreground w-36"
                        />
                    </div>

                    <FilterSelect label="Earnings Date" value={filters.earnings} opts={EARNINGS_OPTS} onChange={(v) => setFilter("earnings", v)} />
                    <FilterSelect label="Avg Volume" value={filters.avgVol} opts={AVG_VOL_OPTS} onChange={(v) => setFilter("avgVol", v)} />
                    <FilterSelect label="Change" value={filters.change} opts={CHANGE_OPTS} onChange={(v) => setFilter("change", v)} />
                    <FilterSelect label="Market Cap" value={filters.cap} opts={CAP_OPTS} onChange={(v) => setFilter("cap", v)} />
                    <FilterSelect label="Sentiment" value={filters.sentiment} opts={SENTIMENT_OPTS} onChange={(v) => setFilter("sentiment", v)} />

                    {/* Sector */}
                    <div className="flex flex-col gap-0.5">
                        <span className="text-[10px] font-medium text-dim uppercase tracking-wide">Sector</span>
                        <select
                            value={filters.sector}
                            onChange={(e) => setFilter("sector", e.target.value)}
                            className={`text-xs px-2 py-1 rounded border bg-card cursor-pointer transition-colors ${filters.sector ? "border-primary text-primary" : "border-border text-muted-foreground"}`}
                        >
                            <option value="">Any</option>
                            {sectors.map((s) => <option key={s} value={s}>{s}</option>)}
                        </select>
                    </div>

                    {/* Reset */}
                    {activeFilterCount > 0 && (
                        <button
                            onClick={() => setFilters({ earnings: "", avgVol: "", change: "", cap: "", sentiment: "", sector: "", search: "" })}
                            className="self-end text-xs px-2 py-1 rounded border border-border text-muted-foreground hover:text-foreground hover:border-foreground transition-colors"
                        >
                            ✕ Reset ({activeFilterCount})
                        </button>
                    )}
                </div>
            </div>

            {/* ── Toolbar ──────────────────────────────────────────────────── */}
            <div className="flex-shrink-0 px-4 py-2 border-b border-border flex items-center gap-4 flex-wrap">
                <h1 className="text-sm font-bold text-foreground">Screener</h1>

                {/* Time window */}
                <div className="flex items-center gap-1 bg-muted rounded-lg p-0.5">
                    {WINDOWS.map((w) => (
                        <button
                            key={w.value}
                            onClick={() => setWindow(w.value)}
                            className={`text-xs px-2.5 py-1 rounded-md transition-colors ${window === w.value
                                ? "bg-primary text-primary-foreground font-medium"
                                : "text-muted-foreground hover:text-foreground"
                                }`}
                        >
                            {w.label}
                        </button>
                    ))}
                </div>

                {/* Result count */}
                <span className="text-xs text-faint">
                    {sorted.length} / {tickers.length} tickers
                </span>

                {/* CSV upload */}
                <div className="flex items-center gap-2 ml-auto">
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept=".csv"
                        onChange={handleUpload}
                        className="hidden"
                        id="csv-upload"
                    />
                    <button
                        onClick={() => fileInputRef.current?.click()}
                        disabled={uploading}
                        className="text-xs px-3 py-1.5 bg-card border border-border rounded-md text-foreground hover:bg-muted transition-colors disabled:opacity-50"
                    >
                        {uploading ? "Uploading…" : "Upload Finviz CSV"}
                    </button>
                    {uploadMsg && <span className="text-xs text-dim">{uploadMsg}</span>}
                </div>

                {/* Last sync */}
                {lastSync && (
                    <span className="text-xs text-faint">
                        {new Date(lastSync).toLocaleTimeString()}
                    </span>
                )}
            </div>

            {/* ── Table ────────────────────────────────────────────────────── */}
            <div className="flex-1 overflow-auto">
                {loading ? (
                    <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
                        Loading…
                    </div>
                ) : sorted.length === 0 ? (
                    <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
                        {tickers.length === 0
                            ? "No active tickers. Upload a Finviz CSV or wait for the pipeline to run."
                            : "No tickers match the current filters."}
                    </div>
                ) : (
                    <table className="w-full text-xs">
                        <thead className="sticky top-0 bg-card z-10 border-b border-border">
                            <tr>
                                <SortHeader label="Ticker" sortKey="ticker" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} />
                                <SortHeader label="Price" sortKey="price" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} />
                                <SortHeader label="Change" sortKey="change_pct" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} />
                                <SortHeader label="Volume" sortKey="volume" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} />
                                <SortHeader label="Avg Vol" sortKey="avg_volume" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} />
                                <SortHeader label="Mkt Cap" sortKey="market_cap" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} />
                                <SortHeader label="P/E" sortKey="pe_ratio" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} />
                                <th className="px-3 py-2 text-left text-xs font-medium text-dim uppercase tracking-wide whitespace-nowrap">Sector</th>
                                <th className="px-3 py-2 text-left text-xs font-medium text-dim uppercase tracking-wide whitespace-nowrap">Earnings</th>
                                <SortHeader label="Analyst" sortKey="analyst_recom" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} />
                                <SortHeader label="News Sent." sortKey="structured_sentiment" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} />
                                <SortHeader label="Social Sent." sortKey="social_sentiment" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} />
                                <SortHeader label="Msg Density" sortKey="message_density" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} />
                                <SortHeader label="Bull" sortKey="bullish_count" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} />
                                <SortHeader label="Bear" sortKey="bearish_count" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} />
                                <th className="px-3 py-2 text-left text-xs font-medium text-dim uppercase tracking-wide whitespace-nowrap">Sources</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                            {sorted.map((row) => {
                                const analyst = getAnalystLabel(row.analyst_recom);
                                const earningsStr = row.earnings_date
                                    ? formatEarningsDate(row.earnings_date)
                                    : "—";
                                return (
                                    <tr key={row.ticker} className="hover:bg-muted/50 transition-colors cursor-default">
                                        {/* Ticker */}
                                        <td className="px-3 py-2">
                                            <span className="font-mono font-bold text-foreground">{row.ticker}</span>
                                            {row.company && (
                                                <div className="text-[10px] text-muted-foreground truncate max-w-[120px]" title={row.company}>
                                                    {row.company}
                                                </div>
                                            )}
                                        </td>
                                        {/* Price */}
                                        <td className="px-3 py-2 text-foreground tabular-nums">
                                            {row.price > 0 ? formatPrice(row.price) : "—"}
                                        </td>
                                        {/* Change % */}
                                        <td className="px-3 py-2 tabular-nums">
                                            <ChangeCell value={row.change_pct} />
                                        </td>
                                        {/* Volume */}
                                        <td className="px-3 py-2 text-dim tabular-nums">
                                            {row.volume != null ? formatNumber(row.volume) : "—"}
                                        </td>
                                        {/* Avg Volume */}
                                        <td className="px-3 py-2 text-dim tabular-nums">
                                            {row.avg_volume != null ? formatNumber(row.avg_volume) : "—"}
                                        </td>
                                        {/* Mkt Cap */}
                                        <td className="px-3 py-2 text-dim tabular-nums">{row.market_cap}</td>
                                        {/* P/E */}
                                        <td className="px-3 py-2 text-dim tabular-nums">
                                            {row.pe_ratio != null ? row.pe_ratio.toFixed(1) : "—"}
                                        </td>
                                        {/* Sector */}
                                        <td className="px-3 py-2 text-dim max-w-[100px] truncate" title={row.sector ?? ""}>
                                            {row.sector ?? "—"}
                                        </td>
                                        {/* Earnings */}
                                        <td className="px-3 py-2 tabular-nums whitespace-nowrap">
                                            <EarningsCell dateStr={row.earnings_date} />
                                        </td>
                                        {/* Analyst */}
                                        <td className="px-3 py-2">
                                            <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${analyst.variant === "default"
                                                ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/30"
                                                : analyst.variant === "destructive"
                                                    ? "bg-red-500/10 text-red-400 border border-red-500/30"
                                                    : "bg-muted text-dim"
                                                }`}>
                                                {analyst.label}
                                            </span>
                                        </td>
                                        {/* News Sentiment */}
                                        <td className="px-3 py-2">
                                            <div className="flex flex-col gap-1">
                                                <SentimentBadge value={row.structured_sentiment} />
                                                <SentimentBar value={row.structured_sentiment} />
                                            </div>
                                        </td>
                                        {/* Social Sentiment */}
                                        <td className="px-3 py-2">
                                            <div className="flex flex-col gap-1">
                                                <SentimentBadge value={row.social_sentiment} />
                                                <SentimentBar value={row.social_sentiment} />
                                            </div>
                                        </td>
                                        {/* Msg Density */}
                                        <td className="px-3 py-2 tabular-nums">
                                            <span className="text-foreground font-medium">{row.message_density}</span>
                                            {row.news_article_count > 0 && (
                                                <span className="text-faint ml-1">+{row.news_article_count}</span>
                                            )}
                                        </td>
                                        {/* Bull */}
                                        <td className="px-3 py-2 text-emerald-500 tabular-nums font-medium">
                                            {row.bullish_count}
                                        </td>
                                        {/* Bear */}
                                        <td className="px-3 py-2 text-red-500 tabular-nums font-medium">
                                            {row.bearish_count}
                                        </td>
                                        {/* Sources */}
                                        <td className="px-3 py-2">
                                            <div className="flex gap-1">
                                                {(row.sources || []).map((s) => (
                                                    <span key={s} className={`inline-block px-1.5 py-0.5 rounded text-[10px] uppercase font-bold ${s === "reddit"
                                                        ? "bg-orange-500/10 text-orange-400"
                                                        : s === "bluesky"
                                                            ? "bg-blue-500/10 text-blue-400"
                                                            : "bg-gray-500/10 text-gray-400"
                                                        }`}>
                                                        {s === "reddit" ? "R" : s === "bluesky" ? "B" : "X"}
                                                    </span>
                                                ))}
                                            </div>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                )}
            </div>
        </div>
    );
}

// ── Earnings date helpers ──────────────────────────────────────────────────

function formatEarningsDate(dateStr: string): string {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return "—";
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function EarningsCell({ dateStr }: { dateStr: string | null }) {
    if (!dateStr) return <span className="text-muted-foreground">—</span>;
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return <span className="text-muted-foreground">—</span>;

    const today = new Date(); today.setHours(0, 0, 0, 0);
    const target = new Date(d); target.setHours(0, 0, 0, 0);
    const diffDays = Math.round((target.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));

    const label = formatEarningsDate(dateStr);
    const urgency =
        diffDays < 0 ? "text-muted-foreground" :
            diffDays === 0 ? "text-yellow-400 font-bold" :
                diffDays === 1 ? "text-amber-400 font-medium" :
                    diffDays <= 7 ? "text-foreground" : "text-dim";

    const badge =
        diffDays === 0 ? " Today" :
            diffDays === 1 ? " Tomorrow" : "";

    return (
        <span className={`text-xs ${urgency}`}>
            {label}{badge}
        </span>
    );
}
