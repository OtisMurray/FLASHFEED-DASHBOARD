import { NextRequest } from "next/server";
import { getSQL } from "@/lib/postgres";

export async function GET(request: NextRequest) {
  const sp        = request.nextUrl.searchParams;
  const limit     = Math.min(parseInt(sp.get("limit") || "50"), 200);
  const offset    = parseInt(sp.get("offset") || "0");
  const source    = sp.get("source");
  const category  = sp.get("category");
  const sentiment = sp.get("sentiment");
  const search    = sp.get("search");
  const ticker    = sp.get("ticker");

  const sql = getSQL();

  // Build parameterized WHERE clause
  const conds: string[] = [];
  const params: unknown[] = [];
  let p = 1;

  if (source)   { conds.push(`source = $${p++}`);       params.push(source); }
  if (category) { conds.push(`category = $${p++}`);     params.push(category); }
  if (ticker)   { conds.push(`ticker ILIKE $${p++}`);   params.push(`%${ticker}%`); }

  if (sentiment === "unanalyzed") {
    conds.push("sentiment IS NULL");
  } else if (sentiment) {
    conds.push(`sentiment = $${p++}`);
    params.push(sentiment);
  }

  if (search) {
    conds.push(`(title ILIKE $${p} OR content ILIKE $${p})`);
    params.push(`%${search}%`);
    p++;
  }

  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";

  const [articles, countRows] = await Promise.all([
    (sql as any)(
      `SELECT id, title, content, url, source, category,
              publish_date, fetched_date, ticker,
              sentiment, ml_confidence, sentiment_at
       FROM articles ${where}
       ORDER BY COALESCE(publish_date, fetched_date) DESC
       LIMIT ${limit} OFFSET ${offset}`,
      params,
    ),
    (sql as any)(`SELECT COUNT(*)::int AS total FROM articles ${where}`, params),
  ]);

  return Response.json({
    articles,
    total:  (countRows[0] as { total: number })?.total ?? 0,
    limit,
    offset,
  });
}
