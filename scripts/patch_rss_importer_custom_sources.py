from pathlib import Path
import re

path = Path("1_News/pipeline/fetch_rss_to_mongo.py")
text = path.read_text()

marker = "# FEEDFLASH_CUSTOM_RSS_SOURCES_PATCH_V1"
if marker not in text:
    insert_after = 'articles_col = db["articles"]'
    block = r'''

# FEEDFLASH_CUSTOM_RSS_SOURCES_PATCH_V1
def _runtime_rss_feeds():
    """Return hardcoded feeds plus dashboard-added Mongo rss_sources."""
    feeds = list(RSS_FEEDS)
    seen = {(name.lower(), url) for name, url, _cat in feeds}

    try:
        for row in db["rss_sources"].find({"enabled": {"$ne": False}}):
            name = str(row.get("name") or row.get("source") or "").strip()
            url = str(row.get("url") or "").strip()
            category = str(row.get("category") or "custom").strip() or "custom"
            if not name or not url:
                continue
            key = (name.lower(), url)
            if key in seen:
                continue
            feeds.append((name, url, category))
            seen.add(key)
    except Exception as exc:
        print(f"[WARN] could not load custom rss_sources from Mongo: {exc}")

    return feeds
'''
    if insert_after not in text:
        raise SystemExit("Could not find articles_col = db[\"articles\"]")
    text = text.replace(insert_after, insert_after + block, 1)

# Replace direct RSS_FEEDS run list with runtime feed list.
if "feeds_to_run = _runtime_rss_feeds()" not in text:
    text = text.replace(
        'print(f"Starting parallel RSS import with {MAX_WORKERS} workers...")',
        'feeds_to_run = _runtime_rss_feeds()\\nprint(f"Starting parallel RSS import with {MAX_WORKERS} workers across {len(feeds_to_run)} feeds...")'
    )
    text = text.replace(
        'futures = [executor.submit(process_feed, feed) for feed in RSS_FEEDS]',
        'futures = [executor.submit(process_feed, feed) for feed in feeds_to_run]'
    )
    text = text.replace(
        'f"Cooldown active for {len(cooldown_skips)}/{len(RSS_FEEDS)} feeds. "',
        'f"Cooldown active for {len(cooldown_skips)}/{len(feeds_to_run)} feeds. "'
    )

path.write_text(text)
print("Patched 1_News/pipeline/fetch_rss_to_mongo.py for Mongo rss_sources")
