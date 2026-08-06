export const DEFAULT_ALLOWED_NEWS_SOURCES = [
  "tradingview news",
  "tradingview news flow",
  "finviz news",
  "finviz news flow",
  "pr newswire",
  "pr newswire financial",
  "business wire",
  "businesswire",
  "globenewswire public companies",
  "globenewswire earnings",
  "globenewswire m&a",
  "globenewswire",
  "access newswire",
  "accesswire",
  "benzinga",
  "fda",
  "interactive brokers news",
  "schwab news",
  "charles schwab",
  "td ameritrade",
  "dow jones newswires",
  "sec edgar"
];

export const DEFAULT_ALLOWED_SOCIAL_SOURCES = [
  "stocktwits",
  "reddit",
  "r/",
  "bluesky",
  "x/twitter",
  "twitter"
];

const DEFAULT_ALLOWED_SOURCES = [
  ...DEFAULT_ALLOWED_NEWS_SOURCES,
  ...DEFAULT_ALLOWED_SOCIAL_SOURCES
];

const DEFAULT_BLOCKED_SOURCES = [
  "cnbc",
  "marketwatch",
  "yahoo finance",
  "seeking alpha",
  "the motley fool",
  "business insider",
  "zerohedge",
  "forbes",
  "coindesk",
  "cointelegraph",
  "oilprice",
  "bbc business",
  "bloomberg",
  "reuters",
  "federal reserve"
];

const DEFAULT_ALLOWED_CATEGORIES = [
  "press_releases",
  "markets",
  "fda",
  "structured_news",
  "public_news",
  "public_market_news",
  "broker_news",
  "filings",
  "sec_filing",
  "social"
];

const DEFAULT_BLOCKED_CATEGORIES = [
  "crypto",
  "commodities"
];

const RESERVED_API_OBJECT_KEYS = new Set([
  "ok",
  "status",
  "time",
  "db",
  "database",
  "articles",
  "data",
  "items",
  "rows",
  "results",
  "total",
  "total_recent",
  "total_all",
  "count",
  "working_count",
  "ready_count",
  "blocked_count",
  "planned_count",
  "available",
  "enabled",
  "configured",
  "retention_days",
  "by_bucket",
  "presence",
  "auto_fetch",
  "site_open",
  "last_presence_at",
  "onsite_enabled",
  "onsite_interval_min",
  "onsite_last_at",
  "onsite_retention_days",
  "away_enabled",
  "away_interval_min",
  "away_retention_days",
  "manual",
  "auto",
  "fetch",
  "display",
  "news",
  "data_dir",
  "file",
  "size_bytes",
  "mode",
  "policy",
  "used_memory_bytes",
  "peak_memory_bytes",
  "max_memory_bytes",
  "used_pct",
  "total_keys",
  "keyspace_hits",
  "keyspace_misses",
  "hit_rate_pct",
  "total_commands",
  "uptime_seconds",
  "version",
  "connected_clients",
  "error",
  "detail",
  "message",
  "last_checked_at",
  "latest_fetch",
  "latest_publish",
  "sources",
  "categories",
  "sentiment",
  "ticker_mentions",
  "tracked_market_count",
  "tracked_markets",
  "tracked_exchanges",
  "tracked_indices",
  "tracked_ticker_count",
  "tracked_tickers",
  "tracked_market_ticker_count",
  "tracked_market_tickers",
  "market_universe_label",
  "symbol",
  "name",
  "category",
  "collection",
  "type",
  "auth_required",
  "env_var",
  "bullish",
  "bearish",
  "neutral",
  "unknown",
]);

function splitEnv(name, fallback) {
  const raw = String(process.env[name] || "").trim();
  if (!raw) return fallback;
  return raw.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
}

function narrowedByEnv(name, fallback) {
  const requested = splitEnv(name, []);
  if (!requested.length) return fallback;
  return fallback.filter(source => requested.some(req => source.includes(req) || req.includes(source)));
}

const enabledSources = narrowedByEnv("ENABLED_NEWS_SOURCES", DEFAULT_ALLOWED_SOURCES);
const disabledSources = Array.from(new Set([...DEFAULT_BLOCKED_SOURCES, ...splitEnv("DISABLED_NEWS_SOURCES", [])]));
const enabledCategories = splitEnv("ENABLED_NEWS_CATEGORIES", DEFAULT_ALLOWED_CATEGORIES);
const disabledCategories = splitEnv("DISABLED_NEWS_CATEGORIES", DEFAULT_BLOCKED_CATEGORIES);

function clean(v) {
  return String(v || "").trim().toLowerCase();
}

function sourceOf(row) {
  return clean(
    row?.source ||
    row?.feed ||
    row?.source_name ||
    row?.sourceName ||
    row?.provider ||
    row?.publisher ||
    row?.name ||
    row?.label
  );
}

function categoryOf(row) {
  return clean(row?.category || row?.type || row?.news_category);
}

function titleOf(row) {
  return clean(row?.title || row?.headline || row?.summary || row?.description);
}

export function allowedSource(src) {
  src = clean(src);
  if (!src) return true;

  if (disabledSources.some(x => src.includes(x) || x.includes(src))) {
    return false;
  }

  // Sources switched off in Settings. Needed here as well as in the Mongo
  // filter below: routes like /api/articles/recent-lite deliberately keep their
  // query minimal and lean on this middleware for source policy, so a check
  // that only lived in the query would leave the Overview news feed still
  // showing a source an admin had turned off.
  //
  // Safe only because /api/settings and /api/sources bypass this middleware
  // entirely — see shouldBypassSourceFilter. Without that, disabling a source
  // would remove it from the very page that has to offer the switch back.
  if (runtimeDisabledSources.some(x => src.includes(x) || x.includes(src))) {
    return false;
  }

  if (enabledSources.length) {
    return enabledSources.some(x => src.includes(x) || x.includes(src));
  }

  return true;
}

export function allowedCategory(cat) {
  cat = clean(cat);
  if (!cat) return true;

  if (disabledCategories.some(x => cat.includes(x) || x.includes(cat))) {
    return false;
  }

  if (enabledCategories.length) {
    return enabledCategories.some(x => cat.includes(x) || x.includes(cat));
  }

  return true;
}

function regexForSource(value) {
  return new RegExp(`^${String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i");
}

// Sources an admin switched off in Settings, pushed in by lib/sourceEnabled.js
// whenever the toggle state is read. Kept here rather than imported so this
// module stays synchronous and dependency-free — it is called inside request
// paths that cannot await a Mongo read.
//
// DELIBERATELY NOT CONSULTED BY allowedSource(). That function drives the
// response-shaping middleware, which also covers /api/settings/sources and
// /api/sources/health — the two endpoints whose entire job is to list a source
// so an admin can switch it back on. Filtering a disabled source out of those
// would make the switch one-way. The disable is enforced at query level
// instead, which is where rankings and summaries are actually computed.
let runtimeDisabledSources = [];

export function setRuntimeDisabledSources(names = []) {
  runtimeDisabledSources = Array.from(new Set(
    (names || []).map(n => String(n || "").trim().toLowerCase()).filter(Boolean)
  ));
}

export function runtimeDisabledSourceList() {
  return [...runtimeDisabledSources];
}

/**
 * Mongo filter excluding only the sources switched off in Settings, or null
 * when none are.
 *
 * Separate from approvedNewsSourceMongoFilter because it is far narrower. Some
 * feeds — /api/articles/recent-lite most of all — deliberately keep their query
 * to a single index scan and carry no source policy. Handing them the full
 * policy would change what they return today; handing them this changes nothing
 * until an admin disables something, which is the only reason it is safe to add
 * to a working feed.
 */
export function disabledSourceMongoFilter(field = "source") {
  if (!runtimeDisabledSources.length) return null;
  const pattern = runtimeDisabledSources
    .map(x => String(x).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  return { [field]: { $not: new RegExp(pattern, "i") } };
}

export function approvedNewsSourceMongoFilter(field = "source") {
  const allow = narrowedByEnv("ENABLED_NEWS_SOURCES", DEFAULT_ALLOWED_NEWS_SOURCES);
  const block = Array.from(new Set([
    ...DEFAULT_BLOCKED_SOURCES,
    ...splitEnv("DISABLED_NEWS_SOURCES", []),
    ...runtimeDisabledSources,
  ]));
  const parts = [];

  if (allow.length) {
    parts.push({ $or: allow.map(source => ({ [field]: { $regex: regexForSource(source) } })) });
  }

  if (block.length) {
    parts.push({ [field]: { $not: new RegExp(block.map(x => String(x).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "i") } });
  }

  return parts.length === 1 ? parts[0] : { $and: parts };
}

function isLegalSpam(row) {
  const combined = `${titleOf(row)} ${sourceOf(row)} ${clean(row?.publisher)} ${clean(row?.company)}`;

  return /shareholder alert|stockholder alert|investor alert|securities fraud|securities class action|class action|lead plaintiff|substantial losses|losses in excess|secure counsel|your rights|deadline|rosen law|hagens berman|kirby mcinerney|robbins llp|pomerantz|bragar eagel|levi korsinsky|glancy prongay|the law offices|law firm|investor counsel/i.test(combined);
}

function isArticleLike(row) {
  return row && typeof row === "object" && (
    "title" in row ||
    "headline" in row ||
    "summary" in row ||
    "description" in row ||
    "ticker" in row ||
    "tickers" in row ||
    "published_at" in row ||
    "publish_date" in row ||
    "fetched_date" in row
  );
}

function isSourceSummaryLike(row) {
  return row && typeof row === "object" && (
    ("source" in row && ("count" in row || "total" in row || "articles" in row)) ||
    ("name" in row && ("count" in row || "total" in row || "articles" in row)) ||
    ("label" in row && ("count" in row || "total" in row || "articles" in row))
  );
}

function keepRow(row) {
  const src = sourceOf(row);
  const cat = categoryOf(row);

  if (!allowedSource(src)) return false;
  if (!allowedCategory(cat)) return false;
  if (isArticleLike(row) && isLegalSpam(row)) return false;

  return true;
}

function filterCountObject(obj) {
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    const k = clean(key);

    if (!allowedSource(k)) continue;
    if (!allowedCategory(k)) continue;

    out[key] = filterDeep(value);
  }
  return out;
}

function filterDeep(value) {
  if (Array.isArray(value)) {
    const shouldFilter = value.some(x => isArticleLike(x) || isSourceSummaryLike(x));

    const arr = shouldFilter
      ? value.filter(keepRow)
      : value;

    return arr.map(filterDeep);
  }

  if (value && typeof value === "object") {
    const keys = Object.keys(value);

    const hasReservedApiShape = keys.some(k => RESERVED_API_OBJECT_KEYS.has(k));
    const looksLikeSourceCountMap =
      !hasReservedApiShape &&
      keys.length > 0 &&
      keys.some(k => !RESERVED_API_OBJECT_KEYS.has(k)) &&
      Object.values(value).every(v => typeof v === "number" || typeof v === "string" || typeof v === "object");

    if (looksLikeSourceCountMap && keys.some(k => !allowedSource(k) || !allowedCategory(k))) {
      return filterCountObject(value);
    }

    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = filterDeep(v);
    }

    return out;
  }

  return value;
}

function shouldBypassSourceFilter(path) {
  return [
    "/api/momentum",
    "/api/ai",
    "/api/trade-watch",
    "/api/finviz",
    "/api/screener",
    "/api/alerts",
    "/api/prices",
    "/api/charts",
    "/api/chart",
    "/api/social",
    "/api/ticker",
    "/api/prediction",
    "/api/market",
    "/api/dashboard",
    "/api/auto-refresh",
    "/api/status",
    "/api/health",
    // Configuration surfaces, not article feeds. These exist to list every
    // source — including the ones this filter blocks — so an operator can see
    // and change its state. Shaping their responses by source policy would make
    // the switch one-way: disable a source and it vanishes from the page that
    // offers the only way to re-enable it.
    //
    // Listed defensively. applySourceFilterMiddleware is not installed by this
    // service today, so nothing here currently runs; the entries exist so that
    // installing it later cannot quietly break the settings page.
    "/api/settings",
    "/api/sources",
  ].some(prefix => path === prefix || path.startsWith(`${prefix}/`));
}

export function applySourceFilterMiddleware(app) {
  app.use((req, res, next) => {
    const originalJson = res.json.bind(res);
    const originalSend = res.send.bind(res);

    const filtered = body => {
      if (!req.path.startsWith("/api/")) return body;
      if (shouldBypassSourceFilter(req.path)) return body;
      return filterDeep(body);
    };

    res.json = body => {
      try {
        return originalJson(filtered(body));
      } catch (e) {
        console.warn("source filter skipped:", e?.message || e);
      }

      return originalJson(body);
    };

    res.send = body => {
      try {
        if (req.path.startsWith("/api/")) {
          if (Buffer.isBuffer(body)) {
            const text = body.toString("utf8");
            if (/^\s*[\[{]/.test(text)) {
              return originalSend(JSON.stringify(filtered(JSON.parse(text))));
            }
          }

          if (typeof body === "string" && /^\s*[\[{]/.test(body)) {
            return originalSend(JSON.stringify(filtered(JSON.parse(body))));
          }

          if (body && typeof body === "object") {
            return originalSend(filtered(body));
          }
        }
      } catch (e) {
        console.warn("source filter send skipped:", e?.message || e);
      }

      return originalSend(body);
    };

    next();
  });
}
