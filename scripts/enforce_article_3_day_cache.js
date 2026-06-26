const KEEP_DAYS = 3;
const now = new Date();
const cutoff = new Date(now.getTime() - KEEP_DAYS * 24 * 60 * 60 * 1000);

const dateFields = [
  "published_at",
  "publishedAt",
  "published",
  "published_date",
  "publishedDate",
  "pubDate",
  "date",
  "created_at",
  "createdAt",
  "fetched_at",
  "fetchedAt",
  "ingested_at",
  "ingestedAt",
  "inserted_at",
  "insertedAt",
  "timestamp",
  "time"
];

function parseDate(value) {
  if (!value) return null;
  if (value instanceof Date && !isNaN(value.getTime())) return value;

  const parsed = new Date(value);
  if (!isNaN(parsed.getTime())) return parsed;

  return null;
}

function getBestDate(doc) {
  for (const field of dateFields) {
    const parsed = parseDate(doc[field]);
    if (parsed) return parsed;
  }

  if (doc._id && typeof doc._id.getTimestamp === "function") {
    return doc._id.getTimestamp();
  }

  return now;
}

print("---- BEFORE ----");
printjson({
  total_articles: db.articles.countDocuments(),
  cutoff
});

let bulk = db.articles.initializeUnorderedBulkOp();
let ops = 0;
let scanned = 0;

db.articles.find({}).forEach(doc => {
  scanned++;

  const articleDate = getBestDate(doc);
  const expiresAt = new Date(articleDate.getTime() + KEEP_DAYS * 24 * 60 * 60 * 1000);

  bulk.find({ _id: doc._id }).updateOne({
    $set: {
      cache_article_date: articleDate,
      cache_expires_at: expiresAt
    }
  });

  ops++;

  if (ops >= 1000) {
    bulk.execute();
    bulk = db.articles.initializeUnorderedBulkOp();
    ops = 0;
  }
});

if (ops > 0) {
  bulk.execute();
}

const deletedOld = db.articles.deleteMany({
  cache_article_date: { $lt: cutoff }
});

try {
  db.articles.dropIndex("ttl_articles_cache_expires_at");
} catch (e) {}

db.articles.createIndex(
  { cache_expires_at: 1 },
  {
    expireAfterSeconds: 0,
    name: "ttl_articles_cache_expires_at"
  }
);

db.articles.createIndex(
  { cache_article_date: -1 },
  { name: "idx_articles_cache_article_date" }
);

print("---- AFTER ----");
printjson({
  scanned,
  deleted_old_articles_now: deletedOld.deletedCount,
  total_articles_after: db.articles.countDocuments(),
  last_3_days_count: db.articles.countDocuments({
    cache_article_date: { $gte: cutoff }
  }),
  older_than_3_days_count: db.articles.countDocuments({
    cache_article_date: { $lt: cutoff }
  }),
  note: "Mongo TTL cleanup may also remove expired rows automatically within about 60 seconds."
});
