// Lightweight in-process log capture for the admin Logs tab. Not a real log
// store — it only reflects this server process since its last restart, and
// resets on every deploy. There is no Railway API token wired up, so this is
// the self-contained alternative: wrap console output as it already happens.

const MAX_ENTRIES = 500
const buffer = []
let installed = false

function push(level, args) {
  const message = args
    .map(a => {
      if (typeof a === "string") return a
      try { return JSON.stringify(a) } catch (_) { return String(a) }
    })
    .join(" ")
  buffer.push({ ts: Date.now(), level, message })
  if (buffer.length > MAX_ENTRIES) buffer.shift()
}

export function installConsoleCapture() {
  if (installed) return
  installed = true
  const original = { log: console.log, warn: console.warn, error: console.error }
  console.log = (...args) => { push("info", args); original.log(...args) }
  console.warn = (...args) => { push("warn", args); original.warn(...args) }
  console.error = (...args) => { push("error", args); original.error(...args) }
}

export function getLogEntries({ level = "", limit = 200 } = {}) {
  const wantLevel = String(level || "").toLowerCase()
  const capped = Math.max(1, Math.min(MAX_ENTRIES, Number(limit) || 200))
  const filtered = wantLevel ? buffer.filter(e => e.level === wantLevel) : buffer
  return filtered.slice(-capped).reverse()
}
