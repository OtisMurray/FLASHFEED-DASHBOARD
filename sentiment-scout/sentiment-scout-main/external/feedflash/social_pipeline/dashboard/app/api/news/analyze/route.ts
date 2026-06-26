import { NextRequest } from "next/server";
import { getSQL } from "@/lib/postgres";

/**
 * POST /api/news/analyze
 *
 * Runs unanalyzed articles through the FinBERT sentiment service.
 * Requires SENTIMENT_SERVICE_URL env var (deployed sentiment_service/service.py).
 *
 * Body: { limit?: number }
 * Returns: { analyzed: number, total: number }
 */
export async function POST(request: NextRequest) {
  const body  = await request.json().catch(() => ({}));
  const limit = Math.min(Number(body?.limit ?? 50), 200);

  const serviceUrl = (process.env.SENTIMENT_SERVICE_URL ?? "").trim();
  if (!serviceUrl) {
    return Response.json(
      {
        error:
          "SENTIMENT_SERVICE_URL not configured. " +
          "Deploy sentiment_service/service.py (Railway / Render) and set the env var.",
      },
      { status: 503 },
    );
  }

  const sql = getSQL();

  const rows = (await sql`
     SELECT id, title, content FROM articles
     WHERE sentiment IS NULL
     ORDER BY COALESCE(publish_date, fetched_date) DESC
     LIMIT ${limit}
  `) as Array<{ id: string; title: string; content: string }>;

  if (!rows.length) return Response.json({ analyzed: 0, total: 0 });

  // Forward to FinBERT service
  let results: Array<{ id: string; sentiment: string; confidence: number }> = [];
  try {
    const res = await fetch(`${serviceUrl.replace(/\/$/, "")}/analyze-articles`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ articles: rows }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return Response.json(err, { status: res.status });
    }
    results = ((await res.json()) as { results?: typeof results }).results ?? [];
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 502 });
  }

  const now = Math.floor(Date.now() / 1000);
  let updated = 0;
  for (const r of results) {
    if (r.id && r.sentiment) {
      await sql`
        UPDATE articles 
        SET sentiment=${r.sentiment}, ml_confidence=${r.confidence ?? null}, sentiment_at=${now} 
        WHERE id=${r.id}
      `;
      updated++;
    }
  }

  return Response.json({ analyzed: updated, total: results.length });
}
