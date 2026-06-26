import { NextRequest } from "next/server";
import { getDb } from "@/lib/mongodb";
import type { SubredditHealth } from "@/lib/types";

const ALL_SUBREDDITS = [
  "wallstreetbets", "wallstreetbets2", "wallstreetbets_wins", "wallstreetbetsELITE",
  "wallstreetbetsnew", "wallstreetelite", "wallstreetsmallcap", "smallstreetbets",
  "thewallstreet", "pennystocks", "pennystock", "10xpennystocks", "stockmarket",
  "stocks", "stocks_picks", "stocksandtrading", "stockstobuytoday",
  "stocktradingalerts", "swingtrading", "trading", "trakstocks", "shortsqueeze",
  "stockaday", "options",
];

export async function GET(request: NextRequest) {
  const minutes = parseInt(request.nextUrl.searchParams.get("minutes") || "60", 10);

  try {
    const db = await getDb();
    const cutoff = new Date(Date.now() - minutes * 60 * 1000);

    // Aggregate Reddit posts by subreddit
    const redditResults = await db
      .collection("posts")
      .aggregate([
        {
          $match: {
            source: "reddit",
            published_at: { $gte: cutoff },
            is_duplicate: { $ne: true },
          },
        },
        {
          $group: {
            _id: "$subreddit",
            post_count: { $sum: 1 },
            latest_post: { $max: "$published_at" },
          },
        },
      ])
      .toArray();

    const redditMap = new Map(
      redditResults.map((r) => [r._id, { count: r.post_count, latest: r.latest_post }])
    );

    // Build Reddit health entries
    const results: SubredditHealth[] = ALL_SUBREDDITS.map((sub) => {
      const data = redditMap.get(sub);
      return {
        source: "reddit" as const,
        subreddit: sub,
        post_count: data?.count || 0,
        latest_post: data?.latest
          ? (data.latest instanceof Date ? data.latest.toISOString() : String(data.latest))
          : null,
      };
    });

    // Aggregate Bluesky posts
    const blueskyResult = await db
      .collection("posts")
      .aggregate([
        {
          $match: {
            source: "bluesky",
            published_at: { $gte: cutoff },
            is_duplicate: { $ne: true },
          },
        },
        {
          $group: {
            _id: null,
            post_count: { $sum: 1 },
            latest_post: { $max: "$published_at" },
          },
        },
      ])
      .toArray();

    const bskyData = blueskyResult[0];
    results.push({
      source: "bluesky",
      subreddit: "bluesky",
      post_count: bskyData?.post_count || 0,
      latest_post: bskyData?.latest_post
        ? (bskyData.latest_post instanceof Date
            ? bskyData.latest_post.toISOString()
            : String(bskyData.latest_post))
        : null,
    });

    return Response.json(results);
  } catch (err) {
    console.error("Failed to fetch subreddit health:", err);
    return Response.json([], { status: 500 });
  }
}
