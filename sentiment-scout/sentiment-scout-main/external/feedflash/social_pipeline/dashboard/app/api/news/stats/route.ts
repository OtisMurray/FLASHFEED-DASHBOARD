import { getSQL } from "@/lib/postgres";

export async function GET() {
  const sql = getSQL();

  const [totRows, sources, categories, sentiment, recency] = await Promise.all([
    sql`SELECT COUNT(*)::int AS total FROM articles`,
    sql`SELECT source, COUNT(*)::int AS count FROM articles GROUP BY source ORDER BY count DESC`,
    sql`SELECT COALESCE(category, 'uncategorized') AS category, COUNT(*)::int AS count FROM articles GROUP BY category ORDER BY count DESC`,
    sql`
      SELECT
        COUNT(*) FILTER (WHERE sentiment = 'bullish')::int AS bullish,
        COUNT(*) FILTER (WHERE sentiment = 'bearish')::int AS bearish,
        COUNT(*) FILTER (WHERE sentiment = 'neutral')::int AS neutral,
        COUNT(*) FILTER (WHERE sentiment IS NULL)::int     AS unanalyzed
      FROM articles
    `,
    sql`SELECT MAX(fetched_date) AS last_fetch, MIN(publish_date) AS oldest, MAX(publish_date) AS newest FROM articles`,
  ]);

  return Response.json({
    total:     (totRows[0] as { total: number })?.total ?? 0,
    sources,
    categories,
    sentiment: sentiment[0] ?? null,
    recency:   recency[0] ?? null,
  });
}
