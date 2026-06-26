const topRows = db.screeners.find(
  {
    ticker: { $exists: true, $nin: ["", null] },
    price: { $gt: 0 },
    exchange: { $in: ["NASDAQ", "NYSE", "AMEX"] },
    quote_source: "finviz_elite_screener",
    $or: [
      { change_pct: { $gt: 0 } },
      { change_percent: { $gt: 0 } }
    ]
  },
  { ticker: 1, change_pct: 1, change_percent: 1, rel_volume: 1, volume: 1 }
).sort({ change_pct: -1, change_percent: -1, rel_volume: -1, volume: -1 }).limit(10).toArray();

const blocked = new Set(["AI","CEO","CFO","IPO","ETF","SEC","FDA","USA","USD","THE","FOR","ARE","YOU","CAN","HAS","NEW","NOW","ON","OFF","SC","US","IT"]);

const topTickers = [];
for (const row of topRows) {
  const ticker = String(row.ticker || "").toUpperCase().trim();
  if (!ticker || blocked.has(ticker)) continue;
  if (!/^[A-Z][A-Z0-9]{0,5}$/.test(ticker)) continue;
  if (!topTickers.includes(ticker)) topTickers.push(ticker);
}

if (!topTickers.length) {
  printjson({
    status: "skipped",
    reason: "No FinViz top gainers found; not pruning socials."
  });
  quit();
}

const result = db.socials.deleteMany({
  platform: { $in: ["StockTwits", "Reddit", "Bluesky"] },
  $or: [
    { ticker: { $nin: topTickers } },
    { ticker: { $in: ["", null] } },
    { social_universe: { $ne: "finviz_top_gainers" } }
  ]
});

db.socials.updateMany(
  {
    platform: { $in: ["StockTwits", "Reddit", "Bluesky"] },
    ticker: { $in: topTickers }
  },
  {
    $set: {
      social_universe: "finviz_top_gainers",
      ticker_universe_source: "finviz_elite_screener_top_gainers",
      finviz_top_gainer_source: true
    }
  }
);

printjson({
  top_gainer_tickers: topTickers,
  deleted_non_top_gainer_social_rows: result.deletedCount,
  remaining_social_rows: db.socials.countDocuments({
    platform: { $in: ["StockTwits", "Reddit", "Bluesky"] }
  }),
  remaining_by_platform: db.socials.aggregate([
    { $match: { platform: { $in: ["StockTwits", "Reddit", "Bluesky"] } } },
    { $group: { _id: "$platform", count: { $sum: 1 } } },
    { $sort: { count: -1 } }
  ]).toArray()
});
