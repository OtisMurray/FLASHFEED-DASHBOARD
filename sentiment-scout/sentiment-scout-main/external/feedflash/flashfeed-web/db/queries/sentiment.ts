import { openDb } from '../index.ts'

export function getReports(params: { asset?: string | null; date?: string | null; limit: number }): any[] {
  const d = openDb()
  if (!d) return []

  try {
    const { asset, date, limit } = params
    const conds: string[] = []
    const p: Record<string, any> = {}
    if (asset) { conds.push('asset = $asset'); p.$asset = asset }
    if (date) { conds.push('date  = $date'); p.$date = date }
    const where = conds.length ? ' WHERE ' + conds.join(' AND ') : ''

    return d.query(
      `SELECT id, asset, date, sentiment, report, created_at FROM asset_reports${where} ORDER BY created_at DESC LIMIT $limit`
    ).all({ ...p, $limit: limit })
  } catch {
    return []
  } finally {
    d.close()
  }
}

export function saveReport(asset: string, sentiment: string, counts: Record<string, number>) {
  const dw = openDb(true)
  if (!dw) return
  try {
    const today = new Date().toISOString().slice(0, 10)
    dw.run(
      `INSERT INTO asset_reports (asset, date, sentiment, report, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(asset, date) DO UPDATE SET sentiment=excluded.sentiment, report=excluded.report, created_at=excluded.created_at`,
      [asset, today, sentiment, JSON.stringify(counts), Math.floor(Date.now() / 1000)]
    )
  } finally {
    dw.close()
  }
}
