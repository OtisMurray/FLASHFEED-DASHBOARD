// Alert message bodies. Pure formatting — no sending, no database — so the
// wording is testable and the delivery layer stays free of presentation.
//
// Every line is emitted ONLY when the underlying field is actually present on
// the canonical record. A trade with no recorded AI score simply has no
// "AI score" line, rather than an invented 0 or an "N/A" that reads like data.

// The deployed Positions route, as registered in app/src/App.tsx
// (<Route path="/positions" element={<PositionsPage />} />). Not guessed.
export const POSITIONS_PATH = '/positions'

// Set PUBLIC_BASE_URL on Railway to make links absolute in email/SMS. Falls
// back to the known deployment rather than emitting a relative path that is
// useless inside a text message.
const BASE_URL = String(process.env.PUBLIC_BASE_URL || 'https://backend-production-da72.up.railway.app').replace(/\/+$/, '')

export const positionsUrl = () => `${BASE_URL}${POSITIONS_PATH}`

// The strategy's own exit reasons, in plain language. Anything unrecognised
// falls through as-is rather than being dropped or relabelled — this module
// reports the canonical reason, it does not decide it.
const EXIT_REASON_LABELS = {
  price_trailing_stop: 'trailing stop',
  correlation_break: 'correlation break',
  rth_close: 'regular-hours close',
  session_end: 'session end',
}

export const exitReasonLabel = (reason) => EXIT_REASON_LABELS[String(reason || '')] || String(reason || '') || null

const money = (value) => {
  const n = Number(value)
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : null
}

const signedPct = (value) => {
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`
}

// Every alert says what it is. These are simulated strategy positions, not
// brokerage fills, and a message that could be mistaken for an execution
// confirmation would be a genuinely harmful ambiguity.
const DISCLAIMER = 'FlashFeed strategy simulation — not a brokerage order or execution confirmation.'

/** Entry alert. `trade` is a canonical screener_position_history row. */
export function entryMessage(trade = {}) {
  const ticker = String(trade.ticker || '').toUpperCase()
  const lines = [`FlashFeed ENTRY — ${ticker}`]

  const price = money(trade.entry_price)
  if (price) lines.push(`Entry: ${price}${trade.entry_time ? ` at ${trade.entry_time} ET` : ''}`)
  if (trade.ai_rank_score != null && Number.isFinite(Number(trade.ai_rank_score))) {
    lines.push(`AI score: ${Math.round(Number(trade.ai_rank_score))}`)
  }
  lines.push(`Open FlashFeed: ${positionsUrl()}`)

  return {
    subject: `FlashFeed ENTRY — ${ticker}`,
    text: `${lines.join('\n')}\n\n${DISCLAIMER}`,
    sms: `${lines.join('\n')}`,
    html: htmlBody(`ENTRY — ${ticker}`, lines.slice(1, -1), positionsUrl()),
  }
}

/** Exit alert. Reports the strategy's own finalized exit — never re-derives one. */
export function exitMessage(trade = {}) {
  const ticker = String(trade.ticker || '').toUpperCase()
  const lines = [`FlashFeed EXIT — ${ticker}`]

  const price = money(trade.exit_price ?? trade.session_end_price)
  if (price) lines.push(`Exit: ${price}${trade.exit_time ? ` at ${trade.exit_time} ET` : ''}`)
  const result = signedPct(trade.pnl_pct)
  if (result) lines.push(`Result: ${result}`)
  const reason = exitReasonLabel(trade.exit_reason)
  if (reason) lines.push(`Reason: ${reason}`)
  lines.push(`Open FlashFeed: ${positionsUrl()}`)

  return {
    subject: `FlashFeed EXIT — ${ticker}`,
    text: `${lines.join('\n')}\n\n${DISCLAIMER}`,
    sms: `${lines.join('\n')}`,
    html: htmlBody(`EXIT — ${ticker}`, lines.slice(1, -1), positionsUrl()),
  }
}

/** News alert for one article on one watched ticker. */
export function newsMessage(ticker, article = {}) {
  const symbol = String(ticker || '').toUpperCase()
  const headline = String(article.title || '').slice(0, 160)
  const tone = article.sentiment ? ` (${article.sentiment})` : ''
  const lines = [`FlashFeed NEWS — ${symbol}`, `${headline}${tone}`]
  if (article.source) lines.push(`Source: ${article.source}`)

  return {
    subject: `FlashFeed NEWS — ${symbol}`,
    text: `${lines.join('\n')}\n\n${DISCLAIMER}`,
    sms: `FlashFeed $${symbol}: ${headline}${tone}`,
    html: htmlBody(`NEWS — ${symbol}`, lines.slice(1), null),
  }
}

// Deliberately plain inline-styled HTML: email clients strip <style> blocks and
// external CSS, so anything fancier would degrade unpredictably. Every message
// also ships a text/plain fallback (the `text` field above).
function htmlBody(heading, detailLines, linkUrl) {
  const rows = detailLines
    .map(line => `<p style="margin:4px 0;color:#e2e8f0">${escapeHtml(line)}</p>`)
    .join('')
  const link = linkUrl
    ? `<p style="margin:16px 0 0"><a href="${escapeHtml(linkUrl)}" style="color:#38bdf8">Open FlashFeed Positions</a></p>`
    : ''
  return `<div style="font-family:system-ui,sans-serif;background:#0f172a;padding:20px;border-radius:8px">
  <h2 style="margin:0 0 12px;color:#fff;font-size:18px">${escapeHtml(heading)}</h2>
  ${rows}
  ${link}
  <p style="margin:16px 0 0;color:#64748b;font-size:12px">${escapeHtml(DISCLAIMER)}</p>
</div>`
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export { DISCLAIMER }
