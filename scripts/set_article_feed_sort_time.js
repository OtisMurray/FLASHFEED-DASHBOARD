function normalizeTime(value) {
  if (value instanceof Date) return Math.floor(value.getTime() / 1000);
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n > 10000000000 ? Math.floor(n / 1000) : Math.floor(n);
}

function eventTime(doc) {
  return normalizeTime(doc.publish_sec) ||
    normalizeTime(doc.publish_date) ||
    normalizeTime(doc.detected_sec) ||
    normalizeTime(doc.detected_at) ||
    normalizeTime(doc.ingested_sec) ||
    normalizeTime(doc.fetched_date);
}

function marketSessionForSec(sec) {
  if (!sec) return "missing";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    hour12: false
  }).formatToParts(new Date(sec * 1000));
  const byType = Object.fromEntries(parts.map(part => [part.type, part.value]));
  if (byType.weekday === "Sat" || byType.weekday === "Sun") return "weekend";
  const minutes = Number(byType.hour || 0) * 60 + Number(byType.minute || 0);
  if (minutes >= 4 * 60 && minutes < 9 * 60 + 30) return "premarket";
  if (minutes >= 9 * 60 + 30 && minutes < 16 * 60) return "regular";
  if (minutes >= 16 * 60 && minutes < 20 * 60) return "postmarket";
  return "overnight";
}

function bestSortTime(doc) {
  const candidates = [
    doc.event_sec,
    doc.publish_sec,
    doc.ingested_sec,
    doc.detected_sec,
    doc.publish_date,
    doc.fetched_date,
    doc.detected_at
  ]
    .map(normalizeTime)
    .filter(v => Number.isFinite(v) && v > 0);

  if (!candidates.length) return 0;

  // Use the freshest known article time.
  // This lets a newly published article or newly detected article rise to the top.
  return Math.max(...candidates);
}

let bulk = db.articles.initializeUnorderedBulkOp();
let ops = 0;
let scanned = 0;

db.articles.find({}).forEach(doc => {
  scanned++;
  const eventSec = eventTime(doc);
  bulk.find({ _id: doc._id }).updateOne({
    $set: {
      feed_sort_time: bestSortTime(doc),
      event_sec: eventSec,
      publish_sec: normalizeTime(doc.publish_sec) || normalizeTime(doc.publish_date) || null,
      detected_sec: normalizeTime(doc.detected_sec) || normalizeTime(doc.detected_at) || null,
      ingested_sec: normalizeTime(doc.ingested_sec) || normalizeTime(doc.fetched_date) || null,
      market_session: marketSessionForSec(eventSec)
    }
  });
  ops++;

  if (ops >= 1000) {
    bulk.execute();
    bulk = db.articles.initializeUnorderedBulkOp();
    ops = 0;
  }
});

if (ops > 0) bulk.execute();

db.articles.createIndex(
  { suppress_from_main_news: 1, main_feed_priority: -1, feed_sort_time: -1 },
  { name: "idx_main_feed_priority_freshness" }
);

printjson({
  scanned,
  updated_with_feed_sort_time: db.articles.countDocuments({ feed_sort_time: { $exists: true } }),
  newest_visible: db.articles.find(
    { suppress_from_main_news: { $ne: true } },
    { title: 1, source: 1, publish_date: 1, fetched_date: 1, detected_at: 1, feed_sort_time: 1, main_feed_priority: 1 }
  ).sort({ main_feed_priority: -1, feed_sort_time: -1 }).limit(5).toArray()
});
