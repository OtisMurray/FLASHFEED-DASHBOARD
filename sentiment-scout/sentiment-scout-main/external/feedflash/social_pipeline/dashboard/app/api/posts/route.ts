import { NextRequest } from "next/server";
import { getDb } from "@/lib/mongodb";
import type { Post } from "@/lib/types";

export async function GET(request: NextRequest) {
  const ticker = request.nextUrl.searchParams.get("ticker");
  const limit = parseInt(request.nextUrl.searchParams.get("limit") || "20", 10);
  const source = request.nextUrl.searchParams.get("source");
  const subreddit = request.nextUrl.searchParams.get("subreddit");

  const db = await getDb();

  const filter: Record<string, unknown> = {
    is_duplicate: { $ne: true },
  };

  // ticker is now optional — omit for global feed
  if (ticker) {
    filter.tickers_mentioned = ticker.toUpperCase();
  }

  if (source) {
    filter.source = source;
  }

  if (subreddit) {
    filter.subreddit = subreddit;
  }

  const docs = await db
    .collection("posts")
    .find(filter)
    .sort({ published_at: -1 })
    .limit(limit)
    .toArray();

  const posts: Post[] = docs.map((doc) => ({
    id: doc.id,
    source: doc.source,
    subreddit: doc.subreddit || undefined,
    author: doc.author,
    title: doc.title || "",
    text: doc.text || "",
    url: doc.url,
    score: doc.score || 0,
    num_comments: doc.num_comments || 0,
    published_at:
      doc.published_at instanceof Date
        ? doc.published_at.toISOString()
        : String(doc.published_at),
    detected_at:
      doc.detected_at instanceof Date
        ? doc.detected_at.toISOString()
        : String(doc.detected_at),
    tickers_mentioned: doc.tickers_mentioned || [],
    sentiment_score: doc.sentiment_score ?? 0,
    is_duplicate: doc.is_duplicate || false,
    is_spam: doc.is_spam || false,
  }));

  return Response.json(posts);
}
