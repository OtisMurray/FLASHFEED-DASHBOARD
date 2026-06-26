const secFilingQuery = {
  $or: [
    { source: { $regex: "SEC EDGAR", $options: "i" } },
    { title: { $regex: "^\\s*(3|4|5|8-K|10-Q|10-K|424B2|424B3|S-1|S-3|SC 13G|SC 13D|DEF 14A|POS AM)\\s*-", $options: "i" } },
    { title: { $regex: "\\((Filer|Issuer|Subject|Reporting Owner)\\)", $options: "i" } }
  ]
};

const result = db.articles.updateMany(
  secFilingQuery,
  {
    $set: {
      is_sec_filing: true,
      feed_visibility: "filings",
      suppress_from_main_news: true,
      main_feed_priority: 0
    }
  }
);

printjson({
  modified_now: result.modifiedCount,
  total_suppressed_from_main_news: db.articles.countDocuments({ suppress_from_main_news: true }),
  total_sec_filings_saved: db.articles.countDocuments({ is_sec_filing: true }),
  sample_hidden_filings: db.articles.find(
    { suppress_from_main_news: true },
    { title: 1, source: 1, ticker: 1, feed_visibility: 1 }
  ).sort({ cache_article_date: -1 }).limit(5).toArray()
});
