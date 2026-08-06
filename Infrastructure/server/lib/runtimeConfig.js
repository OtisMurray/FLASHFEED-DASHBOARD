// Admin-editable operational settings that would otherwise require a Railway
// env var change + redeploy. Stored as a single Mongo document holding only
// the keys that have been explicitly overridden — everything else falls back
// to its env var, then its hardcoded default, exactly like today.
//
// The Python fetch pipeline reads the same collection at the start of each
// cycle (see 1_News/pipeline/fetch_rss_to_mongo.py:load_runtime_config_overrides),
// so a saved override reaches it on the next run without a redeploy.

export const RUNTIME_CONFIG_COLLECTION = "runtime_config"
const OVERRIDES_DOC_ID = "overrides"

export const RUNTIME_CONFIG_SCHEMA = [
  {
    key: "article_cache_days",
    label: "Article cache window",
    description: "How many days of articles the RSS pipeline keeps/considers recent.",
    type: "number",
    envVar: "ARTICLE_CACHE_DAYS",
    default: 3,
    min: 1,
    max: 30,
  },
  {
    key: "market_window_filter",
    label: "Regular-hours market filter",
    description: "Restrict the RSS pipeline to the regular trading-hours window.",
    type: "boolean",
    envVar: "MARKET_WINDOW_FILTER",
    default: true,
  },
  {
    key: "rss_fast_mode",
    label: "RSS fast mode",
    description: "Trade thoroughness for speed on newswire fetch cycles.",
    type: "boolean",
    envVar: "RSS_FAST_MODE",
    default: false,
  },
  {
    key: "auth_require_2fa",
    label: "Require email 2FA on login",
    description: "Ask for an emailed code after a correct password. Needs mailer configured.",
    type: "boolean",
    envVar: "AUTH_REQUIRE_2FA",
    default: false,
  },
  {
    key: "tracked_market_ticker_limit",
    label: "Tracked market ticker limit",
    description: "How many US-exchange tickers (by volume) count toward the tracked market universe used to scope Total Articles.",
    type: "number",
    envVar: "TRACKED_MARKET_TICKER_LIMIT",
    default: 5000,
    min: 100,
    max: 10000,
  },
]

const SCHEMA_BY_KEY = new Map(RUNTIME_CONFIG_SCHEMA.map(s => [s.key, s]))

function envDefault(schemaEntry) {
  const raw = process.env[schemaEntry.envVar]
  if (raw === undefined || raw === "") return schemaEntry.default
  if (schemaEntry.type === "boolean") return String(raw).toLowerCase() === "true"
  const n = Number(raw)
  return Number.isFinite(n) ? n : schemaEntry.default
}

function coerceAndValidate(schemaEntry, value) {
  if (schemaEntry.type === "boolean") {
    if (typeof value !== "boolean") throw new Error(`${schemaEntry.key} must be true or false`)
    return value
  }
  const n = Number(value)
  if (!Number.isFinite(n)) throw new Error(`${schemaEntry.key} must be a number`)
  if (schemaEntry.min !== undefined && n < schemaEntry.min) throw new Error(`${schemaEntry.key} must be at least ${schemaEntry.min}`)
  if (schemaEntry.max !== undefined && n > schemaEntry.max) throw new Error(`${schemaEntry.key} must be at most ${schemaEntry.max}`)
  return n
}

export async function getRuntimeConfigOverrides(db) {
  const doc = await db.collection(RUNTIME_CONFIG_COLLECTION).findOne({ _id: OVERRIDES_DOC_ID })
  return (doc && doc.values) || {}
}

/** Resolves every known key to {value, source} — override > env > default. Used by the Config tab. */
export async function resolveRuntimeConfig(db) {
  const overrides = await getRuntimeConfigOverrides(db)
  const out = {}
  for (const schemaEntry of RUNTIME_CONFIG_SCHEMA) {
    const { key } = schemaEntry
    if (Object.prototype.hasOwnProperty.call(overrides, key)) {
      out[key] = { ...schemaEntry, value: overrides[key], source: "override" }
    } else if (process.env[schemaEntry.envVar] !== undefined && process.env[schemaEntry.envVar] !== "") {
      out[key] = { ...schemaEntry, value: envDefault(schemaEntry), source: "env" }
    } else {
      out[key] = { ...schemaEntry, value: schemaEntry.default, source: "default" }
    }
  }
  return out
}

/** Resolves a single key's effective value. Used by call sites that just need the number/boolean. */
export async function getRuntimeConfigValue(db, key) {
  const schemaEntry = SCHEMA_BY_KEY.get(key)
  if (!schemaEntry) throw new Error(`Unknown runtime config key: ${key}`)
  const overrides = await getRuntimeConfigOverrides(db)
  if (Object.prototype.hasOwnProperty.call(overrides, key)) return overrides[key]
  return envDefault(schemaEntry)
}

export async function setRuntimeConfigOverride(db, key, value) {
  const schemaEntry = SCHEMA_BY_KEY.get(key)
  if (!schemaEntry) throw new Error(`Unknown runtime config key: ${key}`)
  const clean = coerceAndValidate(schemaEntry, value)
  await db.collection(RUNTIME_CONFIG_COLLECTION).updateOne(
    { _id: OVERRIDES_DOC_ID },
    { $set: { [`values.${key}`]: clean, updated_at: Math.floor(Date.now() / 1000) } },
    { upsert: true },
  )
  return clean
}

export async function clearRuntimeConfigOverride(db, key) {
  if (!SCHEMA_BY_KEY.has(key)) throw new Error(`Unknown runtime config key: ${key}`)
  await db.collection(RUNTIME_CONFIG_COLLECTION).updateOne(
    { _id: OVERRIDES_DOC_ID },
    { $unset: { [`values.${key}`]: "" }, $set: { updated_at: Math.floor(Date.now() / 1000) } },
  )
}
