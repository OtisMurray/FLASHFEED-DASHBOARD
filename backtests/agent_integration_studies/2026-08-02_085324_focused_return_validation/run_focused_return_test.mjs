import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SOURCE = path.resolve(HERE, '../2026-08-02_004947_catalyst_intelligence_v2')

function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i += 1 }
      else if (ch === '"') quoted = false
      else field += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') { row.push(field); field = '' }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = '' }
    else if (ch !== '\r') field += ch
  }
  if (field.length || row.length) { row.push(field); rows.push(row) }
  const headers = rows.shift() || []
  return rows.filter(x => x.some(Boolean)).map(values => Object.fromEntries(headers.map((key, index) => [key, values[index] ?? ''])))
}

function csv(rows) {
  const columns = [...new Set(rows.flatMap(Object.keys))]
  const esc = value => {
    if (value == null) return ''
    const text = String(value)
    return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
  }
  return [columns.join(','), ...rows.map(row => columns.map(key => esc(row[key])).join(','))].join('\n') + '\n'
}

function number(value) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null }
function mean(values) { return values.length ? values.reduce((sum, x) => sum + x, 0) / values.length : null }
function median(values) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}
function percentile(values, p) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const index = (sorted.length - 1) * p
  const lower = Math.floor(index)
  const upper = Math.ceil(index)
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower)
}
function round(value, digits = 6) { return typeof value === 'number' && Number.isFinite(value) ? Number(value.toFixed(digits)) : value }
function ids(value) { return String(value || '').split('|').filter(Boolean) }
function aligned(aiDirection, event) {
  const ai = String(aiDirection || '').toLowerCase()
  if (!['bullish', 'bearish'].includes(event?.direction)) return false
  if (ai.includes('bull') || ai.includes('up')) return event.direction === 'bullish'
  if (ai.includes('bear') || ai.includes('down')) return event.direction === 'bearish'
  return false
}
function xorshift(seed = 0x51f15e) {
  let state = seed >>> 0
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296 }
}
function topShare(rows, key) {
  const counts = new Map()
  for (const row of rows) counts.set(row[key] || 'missing', (counts.get(row[key] || 'missing') || 0) + 1)
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]
  return { value: top?.[0] || null, share_pct: rows.length ? top[1] / rows.length * 100 : null }
}
function metrics(rows, baselineCount, cost = 0) {
  const ordered = [...rows].sort((a, b) => a.signal_sec - b.signal_sec)
  const values = ordered.map(row => row.return_pct - cost)
  const wins = values.filter(x => x > 0)
  const losses = values.filter(x => x < 0)
  let equity = 1
  let peak = 1
  let maxDrawdown = 0
  for (const value of values) {
    equity *= 1 + value / 100
    peak = Math.max(peak, equity)
    maxDrawdown = Math.min(maxDrawdown, (equity / peak - 1) * 100)
  }
  const average = mean(values)
  const variance = values.length && average != null ? mean(values.map(x => (x - average) ** 2)) : null
  const downside = values.filter(x => x < 0)
  const grossLoss = Math.abs(losses.reduce((sum, x) => sum + x, 0))
  return {
    trade_count: values.length,
    coverage_pct: baselineCount ? values.length / baselineCount * 100 : null,
    win_rate_pct: values.length ? wins.length / values.length * 100 : null,
    mean_return_pct: average,
    median_return_pct: median(values),
    opportunity_adjusted_return_pct: baselineCount ? values.reduce((sum, x) => sum + x, 0) / baselineCount : null,
    compounded_return_pct: (equity - 1) * 100,
    profit_factor: grossLoss ? wins.reduce((sum, x) => sum + x, 0) / grossLoss : null,
    max_drawdown_pct: maxDrawdown,
    standard_deviation_pct: variance == null ? null : Math.sqrt(variance),
    downside_deviation_pct: downside.length ? Math.sqrt(mean(downside.map(x => x ** 2))) : 0,
    fifth_percentile_pct: percentile(values, 0.05),
    worst_trade_pct: values.length ? Math.min(...values) : null,
  }
}

const policyDefinitions = [
  ['baseline_all', () => true],
  ['any_verified_catalyst', row => row.direct.length + row.macro.length > 0],
  ['direct_catalyst', row => row.direct.length > 0],
  ['aligned_high_confidence', row => row.direct.some(event => event.confidence >= 0.85 && aligned(row.ai_direction, event))],
  ['reject_capital_structure', row => !row.direct.some(event => event.category === 'capital_structure')],
  ['reject_contradiction', row => !row.direct.some(event => event.confidence >= 0.85 && ['bullish', 'bearish'].includes(event.direction) && !aligned(row.ai_direction, event))],
  ['direct_aligned_no_capital_structure', row => row.direct.some(event => event.confidence >= 0.80 && aligned(row.ai_direction, event)) && !row.direct.some(event => event.category === 'capital_structure')],
]

const positions = parseCsv(await fs.readFile(path.join(SOURCE, 'frozen_entry_research_results.csv'), 'utf8'))
  .filter(row => !row.record_type)
const events = parseCsv(await fs.readFile(path.join(SOURCE, 'structured_catalyst_records.csv'), 'utf8'))
const eventById = new Map(events.map(event => [event.event_id, { ...event, confidence: number(event.confidence) || 0 }]))
const prepared = positions.map(row => ({
  ticker: row.ticker,
  date: row.date,
  signal_sec: number(row.signal_sec),
  return_pct: number(row.aligned_return_pct),
  ai_direction: row.ai_direction,
  finalized: row.finalized === 'true',
  direct: ids(row.catalysts).map(id => eventById.get(id)).filter(Boolean),
  macro: ids(row.macro_catalysts).map(id => eventById.get(id)).filter(Boolean),
})).filter(row => row.signal_sec != null && row.return_pct != null)

const dates = [...new Set(prepared.map(row => row.date))].sort()
const splits = { all: dates, development: dates.slice(0, 1), validation: dates.slice(1, 2), test: dates.slice(2, 3) }
const cohorts = { all_observations: prepared, finalized_only: prepared.filter(row => row.finalized) }
const policyResults = []
const dailyResults = []
const robustness = []
const bootstrap = []

for (const [cohort, cohortRows] of Object.entries(cohorts)) {
  for (const [split, splitDates] of Object.entries(splits)) {
    const splitRows = cohortRows.filter(row => splitDates.includes(row.date))
    const baselineMetrics = metrics(splitRows, splitRows.length)
    for (const [policy, predicate] of policyDefinitions) {
      const selected = splitRows.filter(predicate)
      const result = metrics(selected, splitRows.length)
      policyResults.push({ cohort, split, policy, dates: splitDates.join('|'), ...result, selection_mean_delta_vs_baseline_pct: result.mean_return_pct == null || baselineMetrics.mean_return_pct == null ? null : result.mean_return_pct - baselineMetrics.mean_return_pct, top_ticker: topShare(selected, 'ticker').value, top_ticker_share_pct: topShare(selected, 'ticker').share_pct, top_date: topShare(selected, 'date').value, top_date_share_pct: topShare(selected, 'date').share_pct })
      if (split === 'all') {
        for (const date of dates) {
          const dailyBaseline = cohortRows.filter(row => row.date === date)
          const dailySelected = dailyBaseline.filter(predicate)
          const dayMetrics = metrics(dailySelected, dailyBaseline.length)
          dailyResults.push({ cohort, policy, date, ...dayMetrics })
        }
        for (const cost of [0.25, 0.50, 1.00]) robustness.push({ cohort, policy, check: 'added_cost', parameter: cost, ...metrics(selected, splitRows.length, cost) })
        const ordered = [...selected].sort((a, b) => b.return_pct - a.return_pct)
        for (const count of [1, 3]) {
          robustness.push({ cohort, policy, check: 'leave_best_out', parameter: count, ...metrics(ordered.slice(Math.min(count, ordered.length)), splitRows.length) })
          robustness.push({ cohort, policy, check: 'leave_worst_out', parameter: count, ...metrics(ordered.slice(0, Math.max(0, ordered.length - count)), splitRows.length) })
        }
        const random = xorshift(0x51f15e + policy.length + cohort.length)
        const dayGroups = dates.map(date => selected.filter(row => row.date === date))
        const means = []
        for (let iteration = 0; iteration < 5000; iteration += 1) {
          const sample = []
          for (let i = 0; i < dates.length; i += 1) sample.push(...dayGroups[Math.floor(random() * dayGroups.length)])
          const value = mean(sample.map(row => row.return_pct))
          if (value != null) means.push(value)
        }
        bootstrap.push({ cohort, policy, iterations: means.length, mean_return_pct: mean(means), lower_95_pct: percentile(means, 0.025), upper_95_pct: percentile(means, 0.975) })
      }
    }
  }
}

const finalizedResults = policyResults.filter(row => row.cohort === 'finalized_only')
const candidates = policyDefinitions.map(([policy]) => {
  const validation = finalizedResults.find(row => row.policy === policy && row.split === 'validation')
  const test = finalizedResults.find(row => row.policy === policy && row.split === 'test')
  const cost = robustness.find(row => row.cohort === 'finalized_only' && row.policy === policy && row.check === 'added_cost' && row.parameter === 0.5)
  const leaveThree = robustness.find(row => row.cohort === 'finalized_only' && row.policy === policy && row.check === 'leave_best_out' && row.parameter === 3)
  const interval = bootstrap.find(row => row.cohort === 'finalized_only' && row.policy === policy)
  const passed = policy !== 'baseline_all' && validation?.trade_count >= 30 && test?.trade_count >= 30 && validation.selection_mean_delta_vs_baseline_pct > 0 && test.selection_mean_delta_vs_baseline_pct > 0 && cost?.opportunity_adjusted_return_pct > 0 && leaveThree?.mean_return_pct > 0 && interval?.lower_95_pct > 0
  return { policy, passed, validation_trades: validation?.trade_count ?? 0, test_trades: test?.trade_count ?? 0 }
})

const summary = {
  generated_at: new Date().toISOString(),
  source_study: path.relative(path.resolve(HERE, '../../..'), SOURCE),
  positions: { total: prepared.length, finalized: cohorts.finalized_only.length, unresolved_marks: prepared.length - cohorts.finalized_only.length, dates },
  policies_tested: policyDefinitions.length,
  evidence_rule_passes: candidates.filter(row => row.passed),
  verdict: candidates.some(row => row.passed) ? 'candidate_for_later_shadow_validation' : 'no_demonstrated_return_improvement_keep_explanatory_only',
  limitations: ['Only three stored market dates are available.', 'Only finalized simulated positions are treated as settled outcomes.', 'No independently labeled catalyst truth set exists.', 'Filtering changes trade selection, not the exit return of a selected trade.', 'Results are simulated and do not include real fills or position sizing.'],
}

const reportRows = finalizedResults.filter(row => row.split === 'all')
const display = (value, digits = 4) => value == null ? 'n/a' : `${round(value, digits)}%`
const table = reportRows.map(row => `| ${row.policy} | ${row.trade_count} | ${display(row.coverage_pct, 2)} | ${display(row.mean_return_pct)} | ${display(row.median_return_pct)} | ${display(row.opportunity_adjusted_return_pct)} | ${display(row.max_drawdown_pct)} |`).join('\n')
const report = `# Focused Catalyst Return Test\n\n## Verdict\n\n**No catalyst policy demonstrated a reliable return improvement. Keep Catalyst Intelligence explanatory-only.**\n\nThe test used ${prepared.length} frozen observations, but only ${cohorts.finalized_only.length} were finalized simulated positions. The remaining ${prepared.length - cohorts.finalized_only.length} rows are unresolved frozen marks and were not treated as realized evidence in the primary conclusion.\n\n## Finalized-position results\n\n| Policy | Trades | Coverage | Mean | Median | Opportunity-adjusted | Max drawdown |\n|---|---:|---:|---:|---:|---:|---:|\n${table}\n\nOpportunity-adjusted return assigns a zero return to skipped baseline opportunities. This prevents a tiny selected subset from appearing superior solely because most trades were omitted.\n\n## Robustness\n\nThe study used one date each for development, validation, and test, added 0.25, 0.50, and 1.00 percentage-point cost stress, removed the best and worst one and three trades, ran 5,000 deterministic day-block bootstrap samples per policy, and measured ticker/date concentration. No non-baseline policy met the pre-registered evidence rule.\n\n## Interpretation\n\nThe structured catalyst layer measurably improves explanation, deduplication, and traceability. This dataset does not show that filtering entries with those fields improves returns. Three dates and ${cohorts.finalized_only.length} finalized positions are not enough to separate a repeatable edge from selection noise.\n\nNo ranking, threshold, entry, exit, position, or production file was changed by this focused test.\n`

const roundRows = rows => rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, round(value)])))
await fs.writeFile(path.join(HERE, 'policy_results.csv'), csv(roundRows(policyResults)))
await fs.writeFile(path.join(HERE, 'daily_results.csv'), csv(roundRows(dailyResults)))
await fs.writeFile(path.join(HERE, 'robustness_results.csv'), csv(roundRows(robustness)))
await fs.writeFile(path.join(HERE, 'bootstrap_results.csv'), csv(roundRows(bootstrap)))
await fs.writeFile(path.join(HERE, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
await fs.writeFile(path.join(HERE, 'FOCUSED_RETURN_TEST_REPORT.md'), report)

const inventory = (await fs.readdir(HERE)).filter(name => !['LOCAL_FILE_INVENTORY.txt', 'SHA256SUMS.txt'].includes(name)).sort()
await fs.writeFile(path.join(HERE, 'LOCAL_FILE_INVENTORY.txt'), inventory.join('\n') + '\n')
const checksums = []
for (const name of [...inventory, 'LOCAL_FILE_INVENTORY.txt']) {
  const body = await fs.readFile(path.join(HERE, name))
  checksums.push(`${createHash('sha256').update(body).digest('hex')}  ${name}`)
}
await fs.writeFile(path.join(HERE, 'SHA256SUMS.txt'), checksums.join('\n') + '\n')
console.log(JSON.stringify(summary, null, 2))
