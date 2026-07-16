const allowed = [
  "TradingView News Flow",
  "TradingView News",
  "Finviz News Flow",
  "Finviz News",
  "PR Newswire",
  "PR Newswire Financial",
  "GlobeNewswire Public Companies",
  "GlobeNewswire Earnings",
  "GlobeNewswire M&A",
  "ACCESS Newswire",
  "AccessWire",
  "Business Wire",
  "BusinessWire",
  "Benzinga",
  "Dow Jones Newswires",
  "SEC EDGAR",
  "FDA",
  "FDA Press Releases",
  "FDA Recalls",
  "FDA Drug Approvals",
  "FDA MedWatch Safety Alerts",
  "Interactive Brokers News",
  "Schwab News",
  "Charles Schwab / TD Ameritrade News"
];

const now = new Date();
const archiveName =
  "articles_archive_bad_sources_" +
  now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);

const allowedRegex = new RegExp("^(" + allowed.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")", "i");
const blockedRegex = /marketwatch|yahoo finance|cnbc|seeking alpha|motley fool|bbc business|oilprice|bloomberg|reuters|federal reserve/i;

const badMatch = {
  $or: [
    { source: { $not: allowedRegex } },
    { source: blockedRegex }
  ]
};

const badCount = db.articles.countDocuments(badMatch);
const totalBefore = db.articles.countDocuments({});

print("=== NEWS SOURCE POLICY ===");
printjson({
  allowed_sources: allowed,
  total_before: totalBefore,
  non_approved_source_count: badCount,
  archive_collection: archiveName
});

if (badCount > 0) {
  db.articles.aggregate([
    { $match: badMatch },
    { $out: archiveName }
  ]);

  const archived = db[archiveName].countDocuments({});
  print("Archived non-approved articles:");
  printjson({ archive_collection: archiveName, archived });

  if (archived === badCount) {
    const deleted = db.articles.deleteMany(badMatch);
    print("Deleted non-approved articles:");
    printjson(deleted);
  } else {
    print("Archive count did not match. Did NOT delete.");
  }
}

print("");
print("=== AFTER SOURCE CLEANUP ===");
printjson({
  total_after: db.articles.countDocuments({}),
  by_source: db.articles.aggregate([
    { $group: { _id: "$source", count: { $sum: 1 } } },
    { $sort: { count: -1 } }
  ]).toArray()
});
