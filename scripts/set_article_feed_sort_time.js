function bestTime(doc) {
  const candidates = [
    doc.publish_date,
    doc.fetched_date,
    doc.detected_at
  ]
    .map(v => Number(v || 0))
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
  bulk.find({ _id: doc._id }).updateOne({
    $set: {
      feed_sort_time: bestTime(doc)
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
