import fs from "fs/promises";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import path from "path";

const DATA_DIR = process.env.DISK_DATA_DIR || path.resolve(process.cwd(), "data");
const NEWS_FILE = path.join(DATA_DIR, "news_snapshot.json");
const DAILY_ARCHIVE_FILE = path.join(DATA_DIR, "news_daily_archive.json");

async function ensureDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function readJson(file, fallback) {
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJson(file, data) {
  await ensureDir();
  await fs.writeFile(file, JSON.stringify(data, null, 2));
}

function keyForArticle(a) {
  return String(
    a?._id ||
    a?.id ||
    a?.url ||
    a?.link ||
    `${a?.ticker || ""}:${a?.title || ""}:${a?.published_at || a?.publish_date || a?.fetched_date || ""}`
  );
}

function ensureDirSync() {
  mkdirSync(DATA_DIR, { recursive: true });
}

function readJsonSync(file, fallback) {
  try {
    if (!existsSync(file)) return fallback;
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonSync(file, data) {
  ensureDirSync();
  writeFileSync(file, JSON.stringify(data, null, 2));
}

function unixSeconds(value) {
  if (!value) return 0;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric > 1_000_000_000_000 ? Math.floor(numeric / 1000) : Math.floor(numeric);
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
}

function dayKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
}

function articleDay(row) {
  const ts = unixSeconds(row?.published_at || row?.publish_date || row?.fetched_date || row?._stored_at);
  return ts ? dayKey(ts * 1000) : dayKey();
}

function retentionDays() {
  return {
    manual: Number(process.env.DISK_MANUAL_RETENTION_DAYS || 3),
    auto: Number(process.env.DISK_AUTO_RETENTION_DAYS || 2),
    fetch: Number(process.env.DISK_FETCH_RETENTION_DAYS || 3),
    daily: Number(process.env.DISK_DAILY_ARCHIVE_RETENTION_DAYS || 31),
    display: Number(process.env.DISK_DISPLAY_RETENTION_DAYS || 3),
    news: Number(process.env.DISK_NEWS_RETENTION_DAYS || 3),
    articles: Number(process.env.DISK_ARTICLES_RETENTION_DAYS || 3)
  };
}

async function collectArticles(input, days = 3, limit = 5000) {
  if (Array.isArray(input)) return input;

  if (input?.articles && Array.isArray(input.articles)) {
    return input.articles;
  }

  if (input?.collection) {
    const since = new Date(Date.now() - Number(days || 3) * 24 * 60 * 60 * 1000);

    try {
      return await input.collection("articles")
        .find({
          $or: [
            { published_at: { $gte: since } },
            { publish_date: { $gte: since } },
            { fetched_date: { $gte: since } },
            { created_at: { $gte: since } }
          ]
        })
        .sort({ published_at: -1, publish_date: -1, fetched_date: -1, created_at: -1 })
        .limit(Number(limit || 5000))
        .toArray();
    } catch {
      try {
        return await input.collection("articles")
          .find({})
          .sort({ published_at: -1, publish_date: -1, fetched_date: -1, created_at: -1 })
          .limit(Number(limit || 5000))
          .toArray();
      } catch {
        return [];
      }
    }
  }

  return [];
}

async function genericResult(name, args = []) {
  return {
    ok: true,
    name,
    data_dir: DATA_DIR,
    file: NEWS_FILE,
    args_count: args.length
  };
}

export async function init() {
  await ensureDir();
  return { ok: true, data_dir: DATA_DIR, file: NEWS_FILE };
}

export async function initDiskDb() {
  return init();
}

export async function ensureDiskDb() {
  return init();
}

export async function saveArticlesToDisk(input = [], days = 3) {
  await ensureDir();

  const incoming = await collectArticles(input, days);
  const existing = await readJson(NEWS_FILE, []);

  const map = new Map();

  for (const article of [...existing, ...incoming]) {
    map.set(keyForArticle(article), article);
  }

  const merged = Array.from(map.values());

  await writeJson(NEWS_FILE, merged);

  return {
    ok: true,
    saved_count: incoming.length,
    total_count: merged.length,
    data_dir: DATA_DIR,
    file: NEWS_FILE
  };
}

export async function save(input = [], days = 3) {
  return saveArticlesToDisk(input, days);
}

export async function saveNews(input = [], days = 3) {
  return saveArticlesToDisk(input, days);
}

export async function saveArticles(input = [], days = 3) {
  return saveArticlesToDisk(input, days);
}

export async function saveNewsToDisk(input = [], days = 3) {
  return saveArticlesToDisk(input, days);
}

export async function saveRecentNewsToDisk(input = [], days = 3) {
  return saveArticlesToDisk(input, days);
}

export async function saveNewsFromMongo(db, days = 3) {
  return saveArticlesToDisk(db, days);
}

export async function backupArticlesToDisk(input = [], days = 3) {
  return saveArticlesToDisk(input, days);
}

export async function backupNewsToDisk(input = [], days = 3) {
  return saveArticlesToDisk(input, days);
}

export async function saveDiskSnapshot(input = [], days = 3) {
  return saveArticlesToDisk(input, days);
}

export async function loadArticlesFromDisk(options = {}) {
  const limit = Number(options?.limit || 5000);
  const articles = await readJson(NEWS_FILE, []);
  return Array.isArray(articles) ? articles.slice(0, limit) : [];
}

export async function load() {
  return loadArticlesFromDisk();
}

export async function loadNews(options = {}) {
  return loadArticlesFromDisk(options);
}

export async function loadArticles(options = {}) {
  return loadArticlesFromDisk(options);
}

export async function loadNewsFromDisk(options = {}) {
  return loadArticlesFromDisk(options);
}

export async function readArticlesFromDisk(options = {}) {
  return loadArticlesFromDisk(options);
}

export async function readNewsFromDisk(options = {}) {
  return loadArticlesFromDisk(options);
}

export async function getDiskStats() {
  await ensureDir();

  const articles = await readJson(NEWS_FILE, []);
  let size_bytes = 0;

  try {
    const stat = await fs.stat(NEWS_FILE);
    size_bytes = stat.size;
  } catch {}

  return {
    ok: true,
    data_dir: DATA_DIR,
    file: NEWS_FILE,
    news_count: Array.isArray(articles) ? articles.length : 0,
    articles_count: Array.isArray(articles) ? articles.length : 0,
    total_count: Array.isArray(articles) ? articles.length : 0,
    size_bytes
  };
}

export function stats() {
  ensureDirSync();
  const rows = readJsonSync(NEWS_FILE, []);
  const dailyArchive = readJsonSync(DAILY_ARCHIVE_FILE, { days: [] });
  const news = Array.isArray(rows) ? rows : [];
  const byBucket = news.reduce((acc, row) => {
    const bucket = row._bucket || "manual";
    acc[bucket] = (acc[bucket] || 0) + 1;
    return acc;
  }, { manual: 0, auto: 0, fetch: 0, daily: 0 });
  let sizeBytes = 0;
  try { sizeBytes = statSync(NEWS_FILE).size; } catch {}
  let dailySizeBytes = 0;
  try { dailySizeBytes = statSync(DAILY_ARCHIVE_FILE).size; } catch {}
  const dailyDays = Array.isArray(dailyArchive?.days) ? dailyArchive.days : [];
  return {
    ok: true,
    available: isEnabled(),
    total: news.length,
    by_bucket: byBucket,
    data_dir: DATA_DIR,
    file: NEWS_FILE,
    daily_archive_file: DAILY_ARCHIVE_FILE,
    size_bytes: sizeBytes,
    retention_days: retentionDays(),
    daily_archive: {
      enabled: true,
      file: DAILY_ARCHIVE_FILE,
      days: dailyDays.length,
      max_days: retentionDays().daily,
      total_articles: dailyDays.reduce((sum, day) => sum + Number(day.count || 0), 0),
      oldest_day: dailyDays[0]?.date || null,
      newest_day: dailyDays[dailyDays.length - 1]?.date || null,
      size_bytes: dailySizeBytes
    }
  };
}

export async function getStats() {
  return getDiskStats();
}

export async function getDiskDbStats() {
  return getDiskStats();
}

export async function diskStats() {
  return getDiskStats();
}

export async function health() {
  return getDiskStats();
}

export async function diskHealth() {
  return getDiskStats();
}

const base = {
  init,
  initDiskDb,
  ensureDiskDb,
  save,
  saveNews,
  saveArticles,
  saveArticlesToDisk,
  saveNewsToDisk,
  saveRecentNewsToDisk,
  saveNewsFromMongo,
  backupArticlesToDisk,
  backupNewsToDisk,
  saveDiskSnapshot,
  load,
  loadNews,
  loadArticles,
  loadArticlesFromDisk,
  loadNewsFromDisk,
  readArticlesFromDisk,
  readNewsFromDisk,
  storeDailyArchive,
  listDailyArchive,
  stats,
  getStats,
  getDiskStats,
  getDiskDbStats,
  diskStats,
  health,
  diskHealth
};

const diskdb = new Proxy(base, {
  get(target, prop) {
    if (prop in target) return target[prop];

    if (typeof prop === "string") {
      return async (...args) => genericResult(prop, args);
    }

    return undefined;
  }
});

export default diskdb;

// Extra compatibility named exports for index.js namespace imports
export function isEnabled() {
  return String(process.env.DISKDB_ENABLED || "1") === "1";
}

export function enabled() {
  return isEnabled();
}

export function isReady() {
  return true;
}

export function config() {
  return {
    enabled: isEnabled(),
    retention_days: retentionDays()
  };
}

export function storeNews(news = [], bucket = "manual") {
  const incoming = Array.isArray(news) ? news : [];
  const existing = readJsonSync(NEWS_FILE, []);
  const now = Math.floor(Date.now() / 1000);
  const rows = Array.isArray(existing) ? existing : [];
  const map = new Map();

  for (const row of rows) {
    map.set(keyForArticle(row), row);
  }

  for (const row of incoming) {
    const next = {
      ...row,
      _bucket: bucket || "manual",
      _stored_at: now
    };
    map.set(keyForArticle(next), next);
  }

  const merged = Array.from(map.values()).sort((a, b) => {
    return unixSeconds(b.published_at || b.publish_date || b.fetched_date || b._stored_at) -
      unixSeconds(a.published_at || a.publish_date || a.fetched_date || a._stored_at);
  });
  writeJsonSync(NEWS_FILE, merged);
  return { ok: true, stored: incoming.length, total: merged.length, bucket: bucket || "manual" };
}

export function storeDailyArchive(news = [], options = {}) {
  const incoming = Array.isArray(news) ? news : [];
  const retention = retentionDays();
  const maxDays = Math.max(1, Math.min(365, Number(options.maxDays || retention.daily || 31)));
  const date = dayKey(options.date || new Date());
  const now = Math.floor(Date.now() / 1000);
  const existing = readJsonSync(DAILY_ARCHIVE_FILE, { version: 1, days: [] });
  const days = Array.isArray(existing?.days) ? existing.days : [];

  const unique = new Map();
  for (const row of incoming) {
    unique.set(keyForArticle(row), {
      ...row,
      _bucket: "daily",
      _archive_date: date,
      _article_date: articleDay(row),
      _stored_at: now
    });
  }

  const nextDay = {
    date,
    stored_at: now,
    count: unique.size,
    articles: Array.from(unique.values()).sort((a, b) =>
      unixSeconds(b.published_at || b.publish_date || b.fetched_date || b._stored_at) -
      unixSeconds(a.published_at || a.publish_date || a.fetched_date || a._stored_at)
    )
  };

  const byDate = new Map(days.map(day => [day.date, day]));
  byDate.set(date, nextDay);
  const merged = Array.from(byDate.values())
    .filter(day => day?.date)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    .slice(-maxDays);

  writeJsonSync(DAILY_ARCHIVE_FILE, {
    version: 1,
    updated_at: new Date().toISOString(),
    retention_days: maxDays,
    days: merged
  });

  return { ok: true, stored: incoming.length, unique: unique.size, date, total_days: merged.length, max_days: maxDays };
}

export function listDailyArchive(options = {}) {
  const archive = readJsonSync(DAILY_ARCHIVE_FILE, { version: 1, days: [] });
  const days = Array.isArray(archive?.days) ? archive.days : [];
  const date = options.date ? dayKey(options.date) : "";
  if (date) return days.filter(day => day.date === date);
  return days;
}

export function listNews(options = {}) {
  const limit = Math.max(1, Math.min(20000, Number(options.limit || 5000)));
  const bucket = options.bucket ? String(options.bucket) : "";
  const ticker = options.ticker ? String(options.ticker).toUpperCase() : "";
  const rows = readJsonSync(NEWS_FILE, []);

  return (Array.isArray(rows) ? rows : [])
    .filter(row => !bucket || row._bucket === bucket)
    .filter(row => !ticker || String(row.ticker || "").toUpperCase() === ticker)
    .sort((a, b) => unixSeconds(b.published_at || b.publish_date || b.fetched_date || b._stored_at) -
      unixSeconds(a.published_at || a.publish_date || a.fetched_date || a._stored_at))
    .slice(0, limit);
}

export function recentForExport(days = 3, bucket = null) {
  const cutoff = Math.floor((Date.now() - Math.max(1, Number(days || 3)) * 86_400_000) / 1000);
  return listNews({ bucket, limit: 20000 })
    .filter(row => unixSeconds(row.published_at || row.publish_date || row.fetched_date || row._stored_at) >= cutoff);
}

export async function compact(...args) {
  return { ok: true, skipped: true, reason: "diskdb compact compatibility stub", args_count: args.length };
}

export function sweep() {
  const rows = readJsonSync(NEWS_FILE, []);
  if (!Array.isArray(rows) || !rows.length) return 0;
  const now = Math.floor(Date.now() / 1000);
  const retention = retentionDays();
  const keep = rows.filter(row => {
    const bucket = row._bucket || "manual";
    const days = retention[bucket] ?? retention.manual ?? 3;
    const ts = unixSeconds(row._stored_at || row.published_at || row.publish_date || row.fetched_date);
    return !ts || now - ts <= Math.max(1, Number(days)) * 86_400;
  });
  writeJsonSync(NEWS_FILE, keep);
  const archive = readJsonSync(DAILY_ARCHIVE_FILE, { version: 1, days: [] });
  const archivedDays = Array.isArray(archive?.days) ? archive.days : [];
  const maxDays = Math.max(1, Number(retention.daily || 31));
  const keptDays = archivedDays
    .filter(day => day?.date)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    .slice(-maxDays);
  if (keptDays.length !== archivedDays.length) {
    writeJsonSync(DAILY_ARCHIVE_FILE, { ...archive, updated_at: new Date().toISOString(), retention_days: maxDays, days: keptDays });
  }
  return (rows.length - keep.length) + (archivedDays.length - keptDays.length);
}

export async function prune(...args) {
  return { ok: true, skipped: true, reason: "diskdb prune compatibility stub", args_count: args.length };
}

export async function cleanup(...args) {
  return { ok: true, skipped: true, reason: "diskdb cleanup compatibility stub", args_count: args.length };
}

export async function start(...args) {
  return { ok: true, skipped: true, reason: "diskdb start compatibility stub", args_count: args.length };
}

export async function stop(...args) {
  return { ok: true, skipped: true, reason: "diskdb stop compatibility stub", args_count: args.length };
}
