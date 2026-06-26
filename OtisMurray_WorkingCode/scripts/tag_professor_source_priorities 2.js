const now = new Date();
const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);

const newswireQuery = {
  $or: [
    { source: { $regex: "PR Newswire", $options: "i" } },
    { source: { $regex: "Business Wire", $options: "i" } },
    { source: { $regex: "GlobeNewswire", $options: "i" } },
    { source: { $regex: "ACCESS", $options: "i" } },
    { source: { $regex: "AccessWire", $options: "i" } },
    { source: { $regex: "Benzinga", $options: "i" } }
  ]
};

const fdaQuery = {
  $or: [
    { source: { $regex: "FDA", $options: "i" } },
    { category: { $regex: "FDA|MedWatch|drug|approval|safety", $options: "i" } }
  ]
};

const secQuery = {
  $or: [
    { source: { $regex: "SEC", $options: "i" } },
    { source: { $regex: "EDGAR", $options: "i" } },
    { category: { $regex: "SEC|EDGAR|filing|current report", $options: "i" } },
    { title: { $regex: "SEC EDGAR|CURRENT REPORTS|Filer|Issuer|Subject|Reporting Owner", $options: "i" } },
    { title: { $regex: "^\\s*(3|4|5|8-K|10-Q|10-K|424B2|424B3|S-1|S-3|SC 13G|SC 13D|DEF 14A|POS AM)\\s*-", $options: "i" } }
  ]
};

const platformNewsQuery = {
  $or: [
    { source: { $regex: "FinViz|Finviz", $options: "i" } },
    { source: { $regex: "TradingView", $options: "i" } },
    { source: { $regex: "Interactive Brokers|IBKR|Schwab|TD Ameritrade", $options: "i" } }
  ]
};

const marketIndicatorQuery = {
  $or: [
    { source: { $regex: "OilPrice|OilPrice News", $options: "i" } },
    { url: { $regex: "oilprice\\.com", $options: "i" } }
  ]
};

// 1) Press releases / global newswires: main sentiment priority
const newswireResult = db.articles.updateMany(
  newswireQuery,
  {
    $set: {
      source_group: "global_newswire",
      article_kind: "press_release_or_newswire",
      is_press_release_source: true,
      suppress_from_main_news: false,
      main_feed_priority: 100
    }
  }
);

// 2) FDA: regulatory news, still useful for main feed
const fdaResult = db.articles.updateMany(
  fdaQuery,
  {
    $set: {
      source_group: "regulatory_alert",
      article_kind: "fda_or_regulatory_news",
      suppress_from_main_news: false,
      main_feed_priority: 85
    }
  }
);

// 3) Platform / broker news if present
const platformResult = db.articles.updateMany(
  platformNewsQuery,
  {
    $set: {
      source_group: "platform_or_broker_news",
      article_kind: "platform_news",
      suppress_from_main_news: false,
      main_feed_priority: 75
    }
  }
);

// 4) SEC filings: saved, but not main sentiment feed
const secResult = db.articles.updateMany(
  secQuery,
  {
    $set: {
      source_group: "sec_filings",
      article_kind: "sec_filing",
      is_sec_filing: true,
      feed_visibility: "filings",
      suppress_from_main_news: true,
      main_feed_priority: 0
    }
  }
);

// 5) Commodity/market indicator sources: retained, but hidden from main news
const indicatorResult = db.articles.updateMany(
  marketIndicatorQuery,
  {
    $set: {
      source_group: "market_indicator",
      article_kind: "commodity_indicator",
      feed_visibility: "indicators",
      suppress_from_main_news: true,
      main_feed_priority: 0
    }
  }
);

// 6) Everything else visible gets normal priority
const defaultResult = db.articles.updateMany(
  {
    main_feed_priority: { $exists: false },
    suppress_from_main_news: { $ne: true }
  },
  {
    $set: {
      source_group: "general_news",
      article_kind: "general_news",
      main_feed_priority: 50
    }
  }
);

print("=== PRIORITY TAGGING COMPLETE ===");
printjson({
  updated_newswires: newswireResult.modifiedCount,
  updated_fda: fdaResult.modifiedCount,
  updated_platform_or_broker: platformResult.modifiedCount,
  updated_sec_hidden: secResult.modifiedCount,
  updated_market_indicators_hidden: indicatorResult.modifiedCount,
  updated_default_general: defaultResult.modifiedCount
});

print("=== MAIN FEED SOURCE BREAKDOWN: LAST 24 HOURS, SEC HIDDEN ===");
db.articles.aggregate([
  {
    $match: {
      suppress_from_main_news: { $ne: true },
      cache_article_date: { $gte: oneDayAgo }
    }
  },
  {
    $group: {
      _id: {
        source_group: "$source_group",
        source: "$source"
      },
      count: { $sum: 1 }
    }
  },
  { $sort: { "_id.source_group": 1, count: -1 } }
]).forEach(printjson);

print("=== 3-DAY REQUIRED SOURCE COVERAGE ===");
db.articles.aggregate([
  {
    $match: {
      cache_article_date: { $gte: threeDaysAgo }
    }
  },
  {
    $group: {
      _id: "$source_group",
      count: { $sum: 1 },
      visible_in_main_feed: {
        $sum: {
          $cond: [{ $ne: ["$suppress_from_main_news", true] }, 1, 0]
        }
      },
      hidden_from_main_feed: {
        $sum: {
          $cond: [{ $eq: ["$suppress_from_main_news", true] }, 1, 0]
        }
      }
    }
  },
  { $sort: { count: -1 } }
]).forEach(printjson);
