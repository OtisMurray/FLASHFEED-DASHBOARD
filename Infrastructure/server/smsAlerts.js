import { runNewsAlertCheck } from './lib/alertEvents.js'

// Ticker news alerts.
//
// The behaviour this file has always had — read the articles the existing news
// pipeline already wrote, never hook into or modify that pipeline, and never
// double-send the same article to the same user — is unchanged. What moved is
// where it lives: runNewsAlertCheck in lib/alertEvents.js now owns the send,
// so news shares one preference model, one durable dedupe collection, one daily
// cap and one delivery audit with Entry/Exit alerts.
//
// Two things that genuinely changed, both deliberate:
//   - news can now be delivered by email as well as SMS, per the user's channel
//     preferences, instead of being SMS-only;
//   - a per-ticker cooldown damps repeats on the same name. The cooldown is
//     scoped to news only and cannot delay an Entry or Exit alert.
export async function runSmsAlertCheck(db, options = {}) {
  if (!db) return { sent: 0, skipped: 'no_db' }
  if (!options.mailerReady && !options.smsReady) return { sent: 0, skipped: 'no_delivery_configured' }
  if (!options.users?.length) return { sent: 0, skipped: 'no_subscribers' }
  return runNewsAlertCheck(db, options)
}
