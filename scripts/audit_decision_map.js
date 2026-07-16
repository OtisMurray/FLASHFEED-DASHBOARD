#!/usr/bin/env node

function argValue(name, fallback = '') {
  const prefix = `--${name}=`
  const inline = process.argv.find(arg => arg.startsWith(prefix))
  if (inline) return inline.slice(prefix.length)
  const index = process.argv.indexOf(`--${name}`)
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1]
  return fallback
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { Accept: 'application/json' } })
  const text = await response.text()
  let body = null
  try { body = JSON.parse(text) } catch (_) {}
  if (!response.ok) throw new Error(`${url} HTTP ${response.status}: ${text.slice(0, 500)}`)
  return body
}

function expectedQuadrant(row, positive, negative, priceThreshold) {
  const sent = Number(row.combinedSentiment || 0)
  const change = Number(row.priceChangePct || 0)
  if (sent >= positive && change >= priceThreshold) return 'Q1'
  if (sent <= negative && change <= -priceThreshold) return 'Q3'
  if (sent <= negative && change >= priceThreshold) return 'Q2'
  if (sent >= positive && change <= -priceThreshold) return 'Q4'
  return 'Neutral'
}

async function main() {
  const baseUrl = String(argValue('baseUrl', process.env.FLASHFEED_API_BASE_URL || 'http://localhost:3001')).replace(/\/$/, '')
  const limit = Math.max(1, Math.min(250, Number(argValue('limit', '50'))))
  const minRelVolume = Number(argValue('minRelVolume', '1'))
  const minAbsChange = Number(argValue('minAbsChange', '0.5'))
  const params = new URLSearchParams({
    limit: String(limit),
    min_rel_volume: String(minRelVolume),
    min_abs_change: String(minAbsChange),
    news_window_hours: argValue('newsWindowHours', '24'),
    social_window_hours: argValue('socialWindowHours', '24'),
  })
  const payload = await fetchJson(`${baseUrl}/api/decision-map?${params.toString()}`)
  const rows = payload.rows || []
  const thresholds = payload.thresholds || {}
  const positive = Number(thresholds.positiveSentiment ?? 0.12)
  const negative = Number(thresholds.negativeSentiment ?? -0.12)
  const priceThreshold = Number(thresholds.priceChange ?? minAbsChange)

  const failures = []
  if (!payload.ok) failures.push('endpoint_not_ok')
  if (!payload.screener_first) failures.push('screener_first_flag_missing')
  if (!payload.no_fake_rows) failures.push('no_fake_rows_flag_missing')
  if (!rows.length) failures.push('no_rows_returned')

  const badSource = rows.filter(row => !row.screenerFirst || !row.screenerSource)
  if (badSource.length) failures.push(`rows_missing_screener_source:${badSource.slice(0, 5).map(row => row.ticker).join(',')}`)

  const weakActivity = rows.filter(row =>
    Number(row.relativeVolume || 0) < minRelVolume ||
    Math.abs(Number(row.priceChangePct || 0)) < minAbsChange
  )
  if (weakActivity.length) failures.push(`rows_fail_activity_threshold:${weakActivity.slice(0, 5).map(row => row.ticker).join(',')}`)

  const badQuadrants = rows.filter(row => row.quadrant !== expectedQuadrant(row, positive, negative, priceThreshold))
  if (badQuadrants.length) failures.push(`quadrant_mismatch:${badQuadrants.slice(0, 5).map(row => row.ticker).join(',')}`)

  const sorted = rows.slice(0, 12).map(row => ({
    ticker: row.ticker,
    score: row.convictionScore,
    activity: row.activityScore,
    quadrant: row.quadrant,
    change: row.priceChangePct,
    rel_volume: row.relativeVolume,
    sentiment: row.combinedSentiment,
    catalyst: row.catalystLabel || null,
    risk_flags: row.riskFlags || [],
  }))

  const output = {
    ok: failures.length === 0,
    generated_at: new Date().toISOString(),
    endpoint: '/api/decision-map',
    count: rows.length,
    summary: payload.summary,
    thresholds: payload.thresholds,
    assertions: {
      real_rows_only: Boolean(payload.no_fake_rows),
      screener_first: Boolean(payload.screener_first),
      activity_thresholds_enforced: weakActivity.length === 0,
      quadrant_classification_correct: badQuadrants.length === 0,
      rows_have_screener_source: badSource.length === 0,
    },
    top_rows: sorted,
    failures,
    recommendation: failures.length
      ? 'Do not send this list until failures are resolved.'
      : 'Decision Map passed screener-first audit. Use top aligned rows as the active mover decision list, not as statistically guaranteed next-day predictions.',
  }
  console.log(JSON.stringify(output, null, 2))
  if (failures.length) process.exit(1)
}

main().catch(err => {
  console.error(JSON.stringify({ ok: false, error: String(err.message || err) }, null, 2))
  process.exit(1)
})
