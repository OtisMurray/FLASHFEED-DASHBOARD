import { NextRequest } from "next/server";
import { getDb } from "@/lib/mongodb";
import type { HotPhrase } from "@/lib/types";

// Sentiment lexicon — common financial social media phrases
const SENTIMENT_LEXICON: Record<string, number> = {
  "to the moon": 0.8,
  "diamond hands": 0.7,
  "buy the dip": 0.6,
  "going up": 0.5,
  "bullish": 0.6,
  "calls": 0.4,
  "long": 0.3,
  "undervalued": 0.5,
  "squeeze": 0.5,
  "breakout": 0.5,
  "moon": 0.6,
  "rocket": 0.6,
  "tendies": 0.5,
  "yolo": 0.3,
  "hold": 0.2,
  "hodl": 0.4,
  "paper hands": -0.5,
  "puts": -0.4,
  "short": -0.3,
  "bearish": -0.6,
  "overvalued": -0.5,
  "crash": -0.7,
  "dump": -0.6,
  "sell": -0.4,
  "red": -0.3,
  "bag holding": -0.5,
  "loss porn": -0.4,
  "rip": -0.5,
  "dead cat": -0.6,
  "rug pull": -0.8,
  "scam": -0.7,
  "fud": -0.3,
  "dip": 0.1,
  "green": 0.3,
  "earnings": 0.1,
  "DD": 0.2,
  "due diligence": 0.2,
  "volume": 0.1,
  "gap up": 0.5,
  "gap down": -0.5,
  "support": 0.2,
  "resistance": -0.1,
};

export async function GET(request: NextRequest) {
  const ticker = request.nextUrl.searchParams.get("ticker");
  const hours = parseInt(request.nextUrl.searchParams.get("hours") || "24", 10);
  const limit = parseInt(request.nextUrl.searchParams.get("limit") || "15", 10);

  try {
    const db = await getDb();
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);

    const filter: Record<string, unknown> = {
      published_at: { $gte: cutoff },
      is_duplicate: { $ne: true },
    };

    if (ticker) {
      filter.tickers_mentioned = ticker.toUpperCase();
    }

    const posts = await db
      .collection("posts")
      .find(filter)
      .sort({ published_at: -1 })
      .limit(500)
      .project({ title: 1, text: 1 })
      .toArray();

    // Count phrase occurrences
    const phraseCounts = new Map<string, number>();

    for (const post of posts) {
      const content = `${post.title || ""} ${post.text || ""}`.toLowerCase();
      for (const phrase of Object.keys(SENTIMENT_LEXICON)) {
        if (content.includes(phrase.toLowerCase())) {
          phraseCounts.set(phrase, (phraseCounts.get(phrase) || 0) + 1);
        }
      }
    }

    // Build ranked list
    const results: HotPhrase[] = Array.from(phraseCounts.entries())
      .map(([phrase, count]) => ({
        phrase,
        count,
        sentiment: SENTIMENT_LEXICON[phrase],
        weight: count * Math.abs(SENTIMENT_LEXICON[phrase]),
      }))
      .sort((a, b) => b.weight - a.weight)
      .slice(0, limit);

    return Response.json(results);
  } catch (err) {
    console.error("Failed to compute phrases:", err);
    return Response.json([], { status: 500 });
  }
}
