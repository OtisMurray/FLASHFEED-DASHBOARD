import { redis } from "@/lib/redis";
import { getDb } from "@/lib/mongodb";
import { formatMarketCap } from "@/lib/utils";

export const dynamic = "force-dynamic";

const WINDOW_SIZES = [1, 5, 15, 60];

export async function GET(
  request: Request,
  { params }: { params: Promise<{ symbol: string }> }
) {
  const { symbol } = await params;
  const ticker = symbol.toUpperCase();

  // Fetch all window sizes from Redis in parallel
  const windowPromises = WINDOW_SIZES.map((w) =>
    redis.hgetall(`window:${ticker}:${w}`)
  );
  const windowResults = await Promise.all(windowPromises);

  // Build windows map
  const windows: Record<string, any> = {};
  WINDOW_SIZES.forEach((w, i) => {
    const d = windowResults[i];
    if (d && Object.keys(d).length > 0) {
      windows[`${w}m`] = {
        avg_sentiment: parseFloat(String(d.avg_sentiment || "0")),
        total_posts: parseInt(String(d.message_count || "0"), 10),
        bullish: parseInt(String(d.bullish_count || "0"), 10),
        bearish: parseInt(String(d.bearish_count || "0"), 10),
        neutral: parseInt(String(d.neutral_count || "0"), 10),
      };
    }
  });

  if (Object.keys(windows).length === 0) {
    return Response.json({ error: "Ticker not found" }, { status: 404 });
  }

  // Finviz metadata
  const db = await getDb();
  const finviz = await db.collection("finviz_screener").findOne({ ticker });

  // Recent posts mentioning this ticker
  const recentPosts = await db
    .collection("posts")
    .find(
      {
        tickers_mentioned: ticker,
        is_duplicate: { $ne: true },
      },
      {
        projection: {
          id: 1,
          title: 1,
          source: 1,
          author: 1,
          sentiment_label: 1,
          published_at: 1,
          is_rumor: 1,
        },
      }
    )
    .sort({ published_at: -1 })
    .limit(30)
    .toArray();

  return Response.json({
    data: {
      ticker,
      price: finviz?.price ?? null,
      market_cap: finviz?.market_cap ?? null,
      pe: finviz?.pe ?? null,
      analyst_recom: finviz?.analyst_recom ?? null,
      last_updated: new Date().toISOString(),
      windows,
      recent_posts: recentPosts.map((p: any) => ({
        id: p.id,
        title: p.title,
        source: p.source,
        author: p.author || "unknown",
        sentiment_label: p.sentiment_label,
        published_at: p.published_at,
        is_rumor: p.is_rumor || false,
      })),
    },
  });
}

