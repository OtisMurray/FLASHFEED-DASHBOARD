import { getSQL } from "@/lib/postgres";
import { redis } from "@/lib/redis";
import type { Alert } from "@/lib/types";

export async function GET() {
  try {
    const sql = getSQL();

    // Get active tickers
    const tickers = await redis.zrange<string[]>("active_tickers", 0, -1, {
      rev: true,
    });

    if (!tickers || tickers.length === 0) {
      return Response.json([]);
    }

    const alerts: Alert[] = [];

    // For each ticker, compare latest window to average of last 6 windows
    for (const ticker of tickers.slice(0, 30)) {
      try {
        const rows = await sql`
          SELECT avg_sentiment, message_count, computed_at
          FROM window_history
          WHERE ticker = ${ticker}
            AND window_minutes = 60
            AND computed_at >= NOW() - INTERVAL '6 hours'
          ORDER BY computed_at DESC
          LIMIT 7
        `;

        if (rows.length < 2) continue;

        const latest = rows[0];
        const previous = rows.slice(1);

        const avgMsgCount =
          previous.reduce((sum: number, r) => sum + Number(r.message_count), 0) /
          previous.length;
        const avgSentiment =
          previous.reduce((sum: number, r) => sum + Number(r.avg_sentiment), 0) /
          previous.length;

        const latestMsgCount = Number(latest.message_count);
        const latestSentiment = Number(latest.avg_sentiment);

        // Volume spike: message count > 2x average
        if (avgMsgCount > 0 && latestMsgCount > avgMsgCount * 2) {
          alerts.push({
            ticker,
            type: "volume_spike",
            message: `${latestMsgCount} msgs vs ${Math.round(avgMsgCount)} avg`,
            severity: latestMsgCount > avgMsgCount * 3 ? "high" : "medium",
            current_value: latestMsgCount,
            average_value: avgMsgCount,
            detected_at: latest.computed_at instanceof Date
              ? latest.computed_at.toISOString()
              : String(latest.computed_at),
          });
        }

        // Sentiment spike: delta > 0.3
        const sentimentDelta = Math.abs(latestSentiment - avgSentiment);
        if (sentimentDelta > 0.3) {
          alerts.push({
            ticker,
            type: "sentiment_spike",
            message: `Sentiment shifted ${sentimentDelta > 0 ? "+" : ""}${sentimentDelta.toFixed(2)} from avg`,
            severity: sentimentDelta > 0.5 ? "high" : "medium",
            current_value: latestSentiment,
            average_value: avgSentiment,
            detected_at: latest.computed_at instanceof Date
              ? latest.computed_at.toISOString()
              : String(latest.computed_at),
          });
        }
      } catch {
        // Skip ticker if query fails
        continue;
      }
    }

    // Sort by severity (high first)
    alerts.sort((a, b) => {
      const order = { high: 0, medium: 1, low: 2 };
      return order[a.severity] - order[b.severity];
    });

    return Response.json(alerts);
  } catch (err) {
    console.error("Failed to compute alerts:", err);
    return Response.json([], { status: 500 });
  }
}
