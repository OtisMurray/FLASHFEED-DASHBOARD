import { NextRequest } from "next/server";
import { redis } from "@/lib/redis";
import { getDb } from "@/lib/mongodb";
import type { TickerData } from "@/lib/types";
import { formatMarketCap } from "@/lib/utils";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const windowMinutes = searchParams.get("window") || "60";

  // Get active tickers from Redis sorted set (scored by message count)
  const [tickers, lastSync] = await Promise.all([
    redis.zrange<string[]>("active_tickers", 0, -1, { rev: true }),
    redis.get("pipeline:last_sync"),
  ]);

  if (!tickers || tickers.length === 0) {
    return Response.json({ data: [], lastSync });
  }

  // Get Finviz data from MongoDB
  const db = await getDb();
  const finvizDocs = await db
    .collection("finviz_screener")
    .find({ ticker: { $in: tickers } })
    .toArray();
  const finvizMap = new Map(finvizDocs.map((d: any) => [d.ticker, d]));

  // Get source info for each ticker — which platforms have posts
  const sourceResults = await db
    .collection("posts")
    .aggregate([
      {
        $match: {
          tickers_mentioned: { $in: tickers },
          is_duplicate: { $ne: true },
          published_at: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        },
      },
      {
        $unwind: "$tickers_mentioned",
      },
      {
        $match: {
          tickers_mentioned: { $in: tickers },
        },
      },
      {
        $group: {
          _id: { ticker: "$tickers_mentioned", source: "$source" },
        },
      },
      {
        $group: {
          _id: "$_id.ticker",
          sources: { $addToSet: "$_id.source" },
        },
      },
    ])
    .toArray();

  const sourcesMap = new Map<string, ("reddit" | "bluesky" | "twitter")[]>(
    sourceResults.map((r: any) => [r._id, r.sources])
  );

  // Batch-fetch news sentiment from Redis for all tickers
  const newsSentimentPipeline = redis.pipeline();
  for (const ticker of tickers) {
    newsSentimentPipeline.hgetall(`news_sentiment:${ticker}`);
  }
  const newsSentimentResults = await newsSentimentPipeline.exec();

  const newsSentimentMap = new Map<string, { avg: number; count: number }>();
  for (let i = 0; i < tickers.length; i++) {
    const data = newsSentimentResults[i] as Record<string, string> | null;
    if (data && Object.keys(data).length > 0) {
      newsSentimentMap.set(tickers[i], {
        avg: parseFloat(String(data.avg_sentiment || "0")),
        count: parseInt(String(data.total_count || "0"), 10),
      });
    }
  }

  // Get window data for each ticker from Redis
  const rows: TickerData[] = [];
  for (const ticker of tickers) {
    const windowData = await redis.hgetall(`window:${ticker}:${windowMinutes}`);
    if (!windowData || Object.keys(windowData).length === 0) continue;

    const finviz = finvizMap.get(ticker);
    const newsSentiment = newsSentimentMap.get(ticker);

    const socialSentiment = parseFloat(String(windowData.avg_sentiment || "0"));
    const messageCount = parseInt(String(windowData.message_count || "0"), 10);

    rows.push({
      ticker,
      company: finviz?.company ?? null,
      avg_sentiment: socialSentiment,
      message_count: messageCount,
      bullish_count: parseInt(String(windowData.bullish_count || "0"), 10),
      bearish_count: parseInt(String(windowData.bearish_count || "0"), 10),
      neutral_count: parseInt(String(windowData.neutral_count || "0"), 10),
      window_minutes: parseInt(windowMinutes, 10),
      price: finviz?.price ?? 0,
      market_cap: finviz?.market_cap != null ? formatMarketCap(finviz.market_cap) : "-",
      pe_ratio: finviz?.pe ?? null,
      analyst_recom: finviz?.analyst_recom ?? null,
      sources: sourcesMap.get(ticker) || [],
      structured_sentiment: newsSentiment?.avg ?? null,
      social_sentiment: socialSentiment,
      message_density: messageCount,
      news_article_count: newsSentiment?.count ?? 0,
      // Finviz-style fields from yfinance enricher
      change_pct: finviz?.change_pct ?? null,
      volume: finviz?.volume ?? null,
      avg_volume: finviz?.avg_volume ?? null,
      sector: finviz?.sector ?? null,
      industry: finviz?.industry ?? null,
      earnings_date: finviz?.earnings_date ?? null,
      week_52_high: finviz?.week_52_high ?? null,
      week_52_low: finviz?.week_52_low ?? null,
    });
  }

  return Response.json({ data: rows, lastSync });
}
