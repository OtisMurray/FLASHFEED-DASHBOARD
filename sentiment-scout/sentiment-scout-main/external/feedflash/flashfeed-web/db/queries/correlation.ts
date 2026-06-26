import { openDb } from '../index.ts'

export function getCorrelationData(): { stats: any; breakdown: any[] } {
  const d = openDb()
  if (!d) return { stats: null, breakdown: [] }
  try {
    // Overall accuracy
    const stats1h = d.query(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN prediction_correct_1h = 1 THEN 1 ELSE 0 END) as correct,
        SUM(CASE WHEN prediction_correct_1h = 0 THEN 1 ELSE 0 END) as incorrect
      FROM articles
      WHERE prediction_correct_1h IS NOT NULL
    `).get({}) as any

    const stats24h = d.query(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN prediction_correct_24h = 1 THEN 1 ELSE 0 END) as correct,
        SUM(CASE WHEN prediction_correct_24h = 0 THEN 1 ELSE 0 END) as incorrect
      FROM articles
      WHERE prediction_correct_24h IS NOT NULL
    `).get({}) as any

    // Per-ticker breakdown
    const breakdown = d.query(`
      SELECT
        ticker,
        company,
        COUNT(*) as total,
        SUM(CASE WHEN prediction_correct_1h = 1 THEN 1 ELSE 0 END) as correct_1h,
        SUM(CASE WHEN prediction_correct_24h = 1 THEN 1 ELSE 0 END) as correct_24h,
        AVG(CASE WHEN price_after_1h IS NOT NULL AND price_at > 0
              THEN (price_after_1h - price_at) / price_at * 100 END) as avg_move_1h_pct,
        AVG(CASE WHEN price_after_24h IS NOT NULL AND price_at > 0
              THEN (price_after_24h - price_at) / price_at * 100 END) as avg_move_24h_pct
      FROM articles
      WHERE ticker IS NOT NULL AND ticker != '' AND prediction_correct_1h IS NOT NULL
      GROUP BY ticker
      ORDER BY total DESC
      LIMIT 30
    `).all({}) as any[]

    // Pending articles (have ticker+sentiment, no price data yet)
    const pendingRow = d.query(`
      SELECT COUNT(*) as cnt FROM articles
      WHERE ticker IS NOT NULL AND ticker != '' AND sentiment IS NOT NULL AND price_at IS NULL
    `).get({}) as any

    const stats = {
      h1: {
        total: stats1h?.total ?? 0,
        correct: stats1h?.correct ?? 0,
        accuracy: stats1h?.total > 0 ? Math.round((stats1h.correct / stats1h.total) * 100) : null,
      },
      h24: {
        total: stats24h?.total ?? 0,
        correct: stats24h?.correct ?? 0,
        accuracy: stats24h?.total > 0 ? Math.round((stats24h.correct / stats24h.total) * 100) : null,
      },
      pending: pendingRow?.cnt ?? 0,
    }

    return {
      stats,
      breakdown: breakdown.map((r: any) => ({
        ticker: r.ticker,
        company: r.company ?? null,
        total: r.total,
        accuracy_1h: r.total > 0 ? Math.round((r.correct_1h / r.total) * 100) : null,
        accuracy_24h: r.total > 0 ? Math.round((r.correct_24h / r.total) * 100) : null,
        avg_move_1h_pct: r.avg_move_1h_pct != null ? +r.avg_move_1h_pct.toFixed(2) : null,
        avg_move_24h_pct: r.avg_move_24h_pct != null ? +r.avg_move_24h_pct.toFixed(2) : null,
      })),
    }
  } catch {
    return { stats: null, breakdown: [] }
  } finally { d.close() }
}
