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

export function approvedNewsSourceMongoFilter(field = "source") {
  const allow = narrowedByEnv("ENABLED_NEWS_SOURCES", DEFAULT_ALLOWED_NEWS_SOURCES);
  const block = Array.from(new Set([...DEFAULT_BLOCKED_SOURCES, ...splitEnv("DISABLED_NEWS_SOURCES", [])]));
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
