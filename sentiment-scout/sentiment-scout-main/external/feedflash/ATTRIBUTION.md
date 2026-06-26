# FeedFlash — Priyanshu's component

This `external/feedflash` directory vendors **Priyanshu's FeedFlash codebase**, a
teammate's component integrated into Sentiment Scout. It provides the news
headline scraping and FinBERT/VADER sentiment scoring pipeline
(`sentiment_analyzer/`) that produces the scored articles the dashboard's News
view reads.

- **Author:** Priyanshu (teammate)
- **Integration:** `priyanshu_adapter.py` in the project root runs
  `sentiment_analyzer/phase1` + `phase2` and reads the resulting `feedflash.db`.
- **Runtime data is not tracked:** the SQLite DB (`feedflash.db`), logs, caches,
  and large CSV snapshots are gitignored / live in the gitignored `var/` runtime
  dir; only the source is vendored here.

Vendored into the repo so a fresh clone is self-contained. One local integration
shim was added to `sentiment_analyzer/db_sqlite.py` (a `FEEDFLASH_DB` env var so
the writable DB can live outside this tracked tree); otherwise this is Priyanshu's
code as-is.
