import { NextRequest } from "next/server";
import { getSQL } from "@/lib/postgres";
import type { HistoryPoint } from "@/lib/types";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ symbol: string }> }
) {
  const { symbol } = await params;
  const ticker = symbol.toUpperCase();
  const hours = parseInt(request.nextUrl.searchParams.get("hours") || "24", 10);
  const windowMinutes = parseInt(
    request.nextUrl.searchParams.get("window") || "60",
    10
  );

  const sql = getSQL();
  const rows = await sql`
    SELECT ticker, window_minutes, avg_sentiment, message_count,
           bullish_count, bearish_count, neutral_count,
           window_start, window_end, computed_at
    FROM window_history
    WHERE ticker = ${ticker}
      AND window_minutes = ${windowMinutes}
      AND computed_at >= NOW() - INTERVAL '1 hour' * ${hours}
    ORDER BY computed_at ASC
  `;

  const data: HistoryPoint[] = rows.map((row) => ({
    ticker: row.ticker,
    window_minutes: row.window_minutes,
    avg_sentiment: row.avg_sentiment,
    message_count: row.message_count,
    bullish_count: row.bullish_count,
    bearish_count: row.bearish_count,
    neutral_count: row.neutral_count,
    window_start: row.window_start,
    window_end: row.window_end,
    computed_at: row.computed_at,
  }));

  return Response.json(data);
}
