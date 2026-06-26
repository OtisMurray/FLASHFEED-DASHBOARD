"use client";

import { useState, useEffect, useCallback } from "react";
import {
    LineChart,
    Line,
    BarChart,
    Bar,
    XAxis,
    YAxis,
    Tooltip,
    ResponsiveContainer,
    CartesianGrid,
    Legend,
    Area,
    ComposedChart,
} from "recharts";

// ── Types ──────────────────────────────────────────────────────────────────

interface TickerDetail {
    ticker: string;
    price?: number;
    market_cap?: number;
    pe?: number;
    analyst_recom?: number;
    last_updated?: string;
    windows?: Record<string, WindowData>;
    recent_posts?: Post[];
}

interface WindowData {
    avg_sentiment: number;
    total_posts: number;
    bullish: number;
    bearish: number;
    neutral: number;
}

interface Post {
    id: string;
    title: string;
    source: string;
    author: string;
    sentiment_label?: string;
    published_at?: string;
    is_rumor?: boolean;
}

interface HistoryPoint {
    timestamp: string;
    avg_sentiment: number;
    total_posts: number;
    bullish: number;
    bearish: number;
}

// ── Helpers ────────────────────────────────────────────────────────────────

const formatSentiment = (v: number) => (v > 0 ? `+${v.toFixed(3)}` : v.toFixed(3));

const sentimentColor = (v: number) =>
    v > 0.05 ? "#10b981" : v < -0.05 ? "#ef4444" : "#6b7280";

const sourceIcon: Record<string, string> = {
    reddit: "📡",
    bluesky: "🦋",
    twitter: "𝕏",
};

// ── Page ───────────────────────────────────────────────────────────────────

export default function TickerDetailPage({
    params,
}: {
    params: Promise<{ symbol: string }>;
}) {
    const [symbol, setSymbol] = useState<string>("");
    const [data, setData] = useState<TickerDetail | null>(null);
    const [history, setHistory] = useState<HistoryPoint[]>([]);
    const [loading, setLoading] = useState(true);

    // Unwrap the params promise
    useEffect(() => {
        params.then((p) => setSymbol(p.symbol.toUpperCase()));
    }, [params]);

    const fetchData = useCallback(async () => {
        if (!symbol) return;
        try {
            const [tickerRes, histRes] = await Promise.all([
                fetch(`/api/ticker/${symbol}`),
                fetch(`/api/ticker/${symbol}/history`),
            ]);
            const tickerJson = await tickerRes.json();
            const histJson = await histRes.json();
            setData(tickerJson.data || tickerJson);
            setHistory(histJson.data || []);
        } catch {
            /* fetch failed */
        } finally {
            setLoading(false);
        }
    }, [symbol]);

    useEffect(() => {
        fetchData();
        const interval = setInterval(fetchData, 15000);
        return () => clearInterval(interval);
    }, [fetchData]);

    if (!symbol) return <div className="p-8 text-dim">Loading…</div>;
    if (loading) return <div className="p-8 text-dim">Loading {symbol}…</div>;
    if (!data) return <div className="p-8 text-dim">No data for {symbol}</div>;

    // Format history for chart
    const chartData = history.map((h) => ({
        time: new Date(h.timestamp).toLocaleTimeString("en-US", {
            hour: "2-digit",
            minute: "2-digit",
        }),
        sentiment: h.avg_sentiment,
        posts: h.total_posts,
        bullish: h.bullish,
        bearish: h.bearish,
    }));

    const windows = data.windows || {};
    const windowKeys = Object.keys(windows).sort();

    return (
        <div className="flex flex-col h-full overflow-auto bg-background p-4 space-y-4 max-w-5xl mx-auto">
            {/* ── Header ─────────────────────── */}
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-xl font-bold text-foreground">{symbol}</h1>
                    <p className="text-xs text-dim">
                        {data.price
                            ? `$${data.price.toFixed(2)}`
                            : "—"}{" "}
                        {data.market_cap
                            ? `· MCap: $${(data.market_cap / 1e9).toFixed(1)}B`
                            : ""}{" "}
                        {data.pe ? `· P/E: ${data.pe.toFixed(1)}` : ""}
                    </p>
                </div>
                <a
                    href={`/`}
                    className="text-xs text-primary hover:underline"
                >
                    ← Back to Dashboard
                </a>
            </div>

            {/* ── Sentiment chart ──────────── */}
            {chartData.length > 2 && (
                <div className="border border-border rounded-lg p-3">
                    <h2 className="text-xs font-medium text-dim mb-2">
                        Sentiment & Volume History
                    </h2>
                    <ResponsiveContainer width="100%" height={260}>
                        <ComposedChart data={chartData}>
                            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                            <XAxis
                                dataKey="time"
                                tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                            />
                            <YAxis
                                yAxisId="sentiment"
                                tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                                tickFormatter={(v: number) => v.toFixed(2)}
                            />
                            <YAxis
                                yAxisId="volume"
                                orientation="right"
                                tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                            />
                            <Tooltip
                                contentStyle={{
                                    backgroundColor: "var(--card)",
                                    border: "1px solid var(--border)",
                                    borderRadius: 8,
                                    fontSize: 11,
                                }}
                            />
                            <Legend
                                wrapperStyle={{ fontSize: 10 }}
                            />
                            <Area
                                yAxisId="volume"
                                dataKey="posts"
                                fill="var(--primary)"
                                fillOpacity={0.1}
                                stroke="none"
                                name="Posts"
                            />
                            <Bar
                                yAxisId="volume"
                                dataKey="bullish"
                                fill="#10b981"
                                opacity={0.5}
                                name="Bullish"
                                stackId="stack"
                            />
                            <Bar
                                yAxisId="volume"
                                dataKey="bearish"
                                fill="#ef4444"
                                opacity={0.5}
                                name="Bearish"
                                stackId="stack"
                            />
                            <Line
                                yAxisId="sentiment"
                                dataKey="sentiment"
                                stroke="var(--primary)"
                                strokeWidth={2}
                                dot={false}
                                name="Avg Sentiment"
                            />
                        </ComposedChart>
                    </ResponsiveContainer>
                </div>
            )}

            {/* ── Window summary cards ─────── */}
            {windowKeys.length > 0 && (
                <div>
                    <h2 className="text-xs font-medium text-dim mb-2">
                        Rolling Windows
                    </h2>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                        {windowKeys.map((key) => {
                            const w = windows[key];
                            return (
                                <div
                                    key={key}
                                    className="border border-border rounded-lg p-3 text-center"
                                >
                                    <div className="text-xs text-dim">{key}</div>
                                    <div
                                        className="text-lg font-mono font-bold"
                                        style={{ color: sentimentColor(w.avg_sentiment) }}
                                    >
                                        {formatSentiment(w.avg_sentiment)}
                                    </div>
                                    <div className="text-[10px] text-faint">
                                        {w.total_posts} posts · {w.bullish}↑ {w.bearish}↓
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}

            {/* ── Recent posts ────────────── */}
            {data.recent_posts && data.recent_posts.length > 0 && (
                <div>
                    <h2 className="text-xs font-medium text-dim mb-2">
                        Recent Posts
                    </h2>
                    <div className="border border-border rounded-lg overflow-hidden">
                        {data.recent_posts.map((post) => (
                            <div
                                key={post.id}
                                className="flex items-start gap-2 px-3 py-2 border-b border-border last:border-0 hover:bg-muted/50"
                            >
                                <span className="text-sm mt-0.5">
                                    {sourceIcon[post.source] || "📄"}
                                </span>
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-1.5">
                                        <span className="text-xs text-foreground truncate">
                                            {post.title}
                                        </span>
                                        {post.is_rumor && (
                                            <span className="text-[9px] px-1 py-0.5 rounded bg-amber-500/20 text-amber-400 shrink-0">
                                                RUMOR
                                            </span>
                                        )}
                                    </div>
                                    <span className="text-[10px] text-faint">
                                        {post.author} ·{" "}
                                        {post.published_at
                                            ? new Date(post.published_at).toLocaleTimeString()
                                            : "—"}
                                        {post.sentiment_label && (
                                            <span
                                                className="ml-1"
                                                style={{
                                                    color:
                                                        post.sentiment_label === "bullish"
                                                            ? "#10b981"
                                                            : post.sentiment_label === "bearish"
                                                                ? "#ef4444"
                                                                : "#6b7280",
                                                }}
                                            >
                                                {post.sentiment_label}
                                            </span>
                                        )}
                                    </span>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}
