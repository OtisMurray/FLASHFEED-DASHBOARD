# Yosef — Yosef's component

This `external/yosef` directory vendors **Yosef's Stocktwits scraper codebase**, a
teammate's component integrated into Sentiment Scout. It scrapes Stocktwits
messages per ticker into MongoDB, which powers the dashboard's social feed and
rumor classification (`/api/social/yosef`).

- **Author:** Yosef (teammate)
- **Integration:** `yosef_adapter.py` in the project root runs
  `src/scraper/scrape_finviz_tickers_curl_mongo.py` (`--once`) on a schedule and
  reads the scraped messages back from MongoDB.
- **Runtime data is not tracked:** the writable ticker CSV
  (`yosef_finviz_input.csv`) lives in the gitignored `var/` runtime dir; the
  scraper writes to MongoDB, not the repo. Caches/logs are gitignored.

Vendored into the repo so a fresh clone is self-contained. This is Yosef's code
as-is (no modifications).
