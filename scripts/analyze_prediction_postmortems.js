#!/usr/bin/env node

const path = require('path')
let mongoose
try {
  mongoose = require('mongoose')
} catch (_) {
  mongoose = require(path.join(__dirname, '..', 'Infrastructure', 'server', 'node_modules', 'mongoose'))
}

function argValue(name, fallback = '') {
  const prefix = `--${name}=`
  const inline = process.argv.find(arg => arg.startsWith(prefix))
  if (inline) return inline.slice(prefix.length)
  const index = process.argv.indexOf(`--${name}`)
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1]
  return fallback
}

function toNumber(value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function avg(rows, fn) {
  const values = rows.map(fn).map(Number).filter(Number.isFinite)
  return values.length ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(3)) : null
}

function countBy(rows, fn) {
  const out = {}
  for (const row of rows) {
    const key = String(fn(row) || 'unknown')
    out[key] = (out[key] || 0) + 1
  }
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])))
}

function summarize(rows = []) {
  const labeled = rows.filter(row => row.outcome?.outcome_status === 'labeled')
  const classified = labeled.filter(row => row.outcome?.postmortem_primary_label)
  const professorWins = labeled.filter(row => row.outcome?.professor_win)
  const payoffWins = labeled.filter(row => row.outcome?.payoff_capture_win)
  const closeWins = labeled.filter(row => row.outcome?.close_win)
  const misses = classified.filter(row => !row.outcome?.professor_win)
  const labels = {}
  for (const row of classified) {
    for (const label of row.outcome?.postmortem_labels || []) labels[label] = (labels[label] || 0) + 1
  }
  return {
    labeled: labeled.length,
    classified: classified.length,
    professor_win_rate: labeled.length ? Number((professorWins.length / labeled.length).toFixed(3)) : null,
    payoff_capture_win_rate: labeled.length ? Number((payoffWins.length / labeled.length).toFixed(3)) : null,
    close_win_rate: labeled.length ? Number((closeWins.length / labeled.length).toFixed(3)) : null,
    avg_close_return_pct: avg(labeled, row => row.outcome?.close_return_pct),
    avg_high_return_pct: avg(labeled, row => row.outcome?.high_return_pct ?? row.outcome?.max_gain_pct),
    avg_payoff_capture_return_pct: avg(labeled, row => row.outcome?.payoff_capture_return_pct),
    classified_professor_win_rate: classified.length ? Number((classified.filter(row => row.outcome?.professor_win).length / classified.length).toFixed(3)) : null,
    classified_payoff_capture_win_rate: classified.length ? Number((classified.filter(row => row.outcome?.payoff_capture_win).length / classified.length).toFixed(3)) : null,
    classified_close_win_rate: classified.length ? Number((classified.filter(row => row.outcome?.close_win).length / classified.length).toFixed(3)) : null,
    classified_avg_close_return_pct: avg(classified, row => row.outcome?.close_return_pct),
    classified_avg_high_return_pct: avg(classified, row => row.outcome?.high_return_pct ?? row.outcome?.max_gain_pct),
    classified_avg_payoff_capture_return_pct: avg(classified, row => row.outcome?.payoff_capture_return_pct),
    primary_labels: countBy(classified, row => row.outcome?.postmortem_primary_label),
    label_counts: Object.fromEntries(Object.entries(labels).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))),
    miss_examples: misses.slice(0, 12).map(row => ({
      snapshot_id: row.snapshot_id,
      group: row.row_group,
      ticker: row.ticker,
      score: row.final_prediction_score ?? null,
      primary: row.outcome?.postmortem_primary_label || null,
      labels: row.outcome?.postmortem_labels || [],
      close_return_pct: row.outcome?.close_return_pct ?? null,
      high_return_pct: row.outcome?.high_return_pct ?? row.outcome?.max_gain_pct ?? null,
      payoff_capture_return_pct: row.outcome?.payoff_capture_return_pct ?? null,
    })),
  }
}

function summarizeCohorts(rows = [], field, limit = 12) {
  const groups = new Map()
  for (const row of rows) {
    const value = field.split('.').reduce((acc, key) => acc == null ? undefined : acc[key], row)
    const key = String(value ?? 'unknown')
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(row)
  }
  return Object.fromEntries(
    Array.from(groups.entries())
      .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
      .slice(0, limit)
      .map(([key, value]) => [key, summarize(value)])
  )
}

function recommendations(summary = {}) {
  const labels = summary.label_counts || {}
  const total = Math.max(1, Number(summary.classified || summary.labeled || 0))
  const recs = []
  const share = key => Number(labels[key] || 0) / total
  if (share('already_priced_in') >= 0.2) {
    recs.push({
      rule: 'tighten_already_priced_in_gate',
      reason: `${labels.already_priced_in} labeled rows were already priced in.`,
      action: 'Reject large pre-existing moves when the selected catalyst is old or outside the active after-hours/premarket window.',
    })
  }
  if (share('no_fresh_catalyst') >= 0.2) {
    recs.push({
      rule: 'require_fresh_catalyst_window',
      reason: `${labels.no_fresh_catalyst} labeled rows lacked a fresh active-window catalyst.`,
      action: 'Require ticker-specific catalyst evidence inside the current prediction window before allowing high-conviction status.',
    })
  }
  if (share('social_confirmation_failed') >= 0.2) {
    recs.push({
      rule: 'raise_social_confirmation_floor',
      reason: `${labels.social_confirmation_failed} labeled rows lacked direct social/message-density support.`,
      action: 'Require nonzero direct posts or a fresh density cross for micro/nano names unless catalyst quality is exceptional.',
    })
  }
  if (share('density_entry_not_crossed') >= 0.2) {
    recs.push({
      rule: 'enforce_fresh_density_entry_cross',
      reason: `${labels.density_entry_not_crossed} labeled rows did not have a fresh density/correlation entry.`,
      action: 'Keep these as watch candidates; do not promote to high conviction until the density rule crosses.',
    })
  }
  if (summary.payoff_capture_win_rate != null && summary.payoff_capture_win_rate > summary.close_win_rate) {
    recs.push({
      rule: 'prefer_payoff_capture_target',
      reason: `Payoff-capture win rate ${summary.payoff_capture_win_rate} exceeds close win rate ${summary.close_win_rate}.`,
      action: 'Train/rank on payoff_capture outcome, not close-only outcome.',
    })
  }
  if (share('pending_open_unconfirmed_at_signal') >= 0.15) {
    recs.push({
      rule: 'require_pending_open_second_confirmation',
      reason: `${labels.pending_open_unconfirmed_at_signal} labeled rows were pending-open without secondary confirmation.`,
      action: 'Keep pending-open rows broad for tracking, but do not promote them unless catalyst quality plus payoff/social/volume support validates.',
    })
  }
  if (share('weak_catalyst_quality') >= 0.1) {
    recs.push({
      rule: 'lower_weight_weak_catalysts',
      reason: `${labels.weak_catalyst_quality} labeled rows had weak catalyst quality.`,
      action: 'Keep weak/generic catalyst rows out of the prediction pool unless they also have fresh density and payoff confirmation.',
    })
  }
  return recs
}

async function main() {
  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI || argValue('mongo', 'mongodb://localhost:27017/feedflash')
  const limit = Math.max(20, Math.min(5000, toNumber(argValue('limit', '1000'), 1000)))
  const reportId = argValue('reportId', 'latest_prediction_postmortem')

  await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 10000 })
  const db = mongoose.connection.db
  const rows = await db.collection('prediction_outcomes')
    .find({ 'outcome.outcome_status': 'labeled' })
    .sort({ updated_at: -1 })
    .limit(limit)
    .toArray()

  const groups = {
    all: rows,
    raw_rows: rows.filter(row => row.row_group === 'raw_rows'),
    high_conviction_rows: rows.filter(row => row.row_group === 'high_conviction_rows'),
  }
  const summary = Object.fromEntries(Object.entries(groups).map(([key, value]) => [key, summarize(value)]))
  const cohorts = {
    prediction_tier: summarizeCohorts(rows, 'prediction_tier'),
    catalyst_quality_tier: summarizeCohorts(rows, 'catalyst_quality_tier'),
    pending_open_confirmed: summarizeCohorts(rows, 'pending_open_confirmed'),
    pending_open_payoff_override: summarizeCohorts(rows, 'pending_open_payoff_override'),
    first_reaction_state: summarizeCohorts(rows, 'first_reaction_state'),
  }
  const doc = {
    _id: reportId,
    report_id: reportId,
    generated_at: new Date(),
    limit,
    summary,
    cohorts,
    recommendations: recommendations(summary.all),
    note: 'Use this before changing thresholds: it shows whether misses are caused by stale catalysts, priced-in moves, social failure, density failure, pending-open confirmation, catalyst quality, or exit logic.',
  }
  await db.collection('prediction_postmortem_reports').updateOne(
    { _id: reportId },
    { $set: doc, $setOnInsert: { created_at: new Date() } },
    { upsert: true }
  )
  await db.collection('prediction_postmortem_reports').createIndex({ generated_at: -1 })
  console.log(JSON.stringify({ ok: true, report: doc }, null, 2))
  await mongoose.disconnect()
}

main().catch(async err => {
  console.error(JSON.stringify({ ok: false, error: String(err.message || err) }, null, 2))
  try { await mongoose.disconnect() } catch (_) {}
  process.exit(1)
})
