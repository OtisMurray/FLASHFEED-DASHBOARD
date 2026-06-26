const KEEP_DAYS = 3;
const DELETE_UNKNOWN_DATES = false; // keep false so we do not accidentally delete articles with weird/missing date fields

const cutoff = new Date(Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000);

const dateFields = [
  "published_at",
  "publishedAt",
  "published",
  "pubDate",
  "date",
  "created_at",
  "createdAt",
  "fetched_at",
  "fetchedAt",
  "inserted_at",
  "insertedAt"
];

function getArticleDate(doc) {
  for (const field of dateFields) {
    const value = doc[field];
    if (!value) continue;

    const parsed = value instanceof Date ? value : new Date(value);
    if (!isNaN(parsed.getTime())) return parsed;
  }

  if (doc._id && typeof doc._id.getTimestamp === "function") {
    return doc._id.getTimestamp();
  }

  return null;
}

const totalBefore = db.articles.countDocuments();

let deleteIds = [];
let oldCount = 0;
let unknownDateCount = 0;

db.articles.find({}).forEach(doc => {
  const articleDate = getArticleDate(doc);

  if (!articleDate) {
    unknownDateCount++;
    if (DELETE_UNKNOWN_DATES) deleteIds.push(doc._id);
    return;
  }

  if (articleDate < cutoff) {
    oldCount++;
    deleteIds.push(doc._id);
  }
});

let deleted = 0;

while (deleteIds.length > 0) {
  const chunk = deleteIds.splice(0, 1000);
  const result = db.articles.deleteMany({ _id: { $in: chunk } });
  deleted += result.deletedCount;
}

const totalAfter = db.articles.countDocuments();

printjson({
  keep_days: KEEP_DAYS,
  cutoff,
  total_before: totalBefore,
  old_articles_found: oldCount,
  unknown_date_articles_kept: unknownDateCount,
  deleted,
  total_after: totalAfter
});
