#!/usr/bin/env node

const { spawnSync } = require('child_process')
const path = require('path')

function argValue(name, fallback = '') {
  const prefix = `--${name}=`
  const inline = process.argv.find(arg => arg.startsWith(prefix))
  if (inline) return inline.slice(prefix.length)
  const index = process.argv.indexOf(`--${name}`)
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1]
  return fallback
}

function run(label, script, args) {
  console.log(`\n=== ${label} ===`)
  const result = spawnSync(process.execPath, [path.join(__dirname, script), ...args], {
    cwd: path.join(__dirname, '..'),
    stdio: 'inherit',
    env: process.env,
  })
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status}`)
  }
}

function main() {
  const common = []
  for (const name of ['mongo', 'baseUrl']) {
    const value = argValue(name, '')
    if (value) common.push(`--${name}`, value)
  }
  const horizon = argValue('horizon', '1d')
  const maxRaw = argValue('maxRaw', '50')
  const maxHighConviction = argValue('maxHighConviction', '5')
  const days = argValue('days', '4')

  run('Refresh improved threshold features', 'update_prediction_threshold_features.js', common)
  run('Refresh correlation evidence', 'update_prediction_correlations.js', [...common, '--days', days])
  run('Save daily prediction snapshot', 'save_daily_prediction_snapshot.js', [...common, '--horizon', horizon, '--maxRaw', maxRaw, '--maxHighConviction', maxHighConviction, '--days', days, '--retentionDays', argValue('retentionDays', '90')])
  run('Label mature next-day outcomes', 'label_next_day_prediction_outcomes.js', [...common, '--limit', argValue('labelLimit', '100')])
  run('Analyze prediction postmortems', 'analyze_prediction_postmortems.js', [...common, '--limit', argValue('postmortemLimit', '1000')])
  run('Train next-session outcome model', 'train_next_session_prediction_model.js', [...common, '--target', argValue('target', 'payoff_capture')])
}

try {
  main()
  console.log('\nPrediction reliability cycle complete.')
} catch (err) {
  console.error(`\nPrediction reliability cycle failed: ${err.message || err}`)
  process.exit(1)
}
