from pathlib import Path
import json
import re

ROOT = Path.cwd()

RSS_FILES = [
    ROOT / "1_News/pipeline/fetch_rss.py",
    ROOT / "backend/pipeline/news/fetch_rss.py",
]

NEW_FEEDS = [
    ('Benzinga', 'https://www.benzinga.com/latest?feed=rss&page=1', 'markets'),
    ('FDA Press Releases', 'https://www.fda.gov/about-fda/contact-fda/stay-informed/rss-feeds/press-releases/rss.xml', 'fda'),
    ('FDA Recalls', 'https://www.fda.gov/about-fda/contact-fda/stay-informed/rss-feeds/recalls/rss.xml', 'fda'),
    ("FDA What's New Drugs", 'https://www.fda.gov/about-fda/contact-fda/stay-informed/rss-feeds/drugs/rss.xml', 'fda'),
    ('FDA MedWatch Safety Alerts', 'https://www.fda.gov/AboutFDA/ContactFDA/StayInformed/RSSFeeds/MedWatch/rss.xml', 'fda'),
]

def tuple_line(feed):
    name, url, category = feed
    return f'    ("{name}", "{url}", "{category}"),'

def has_active_feed(text, name):
    return re.search(rf'^\s*\("{re.escape(name)}"\s*,', text, flags=re.MULTILINE) is not None

for path in RSS_FILES:
    if not path.exists():
        print(f"SKIP missing {path}")
        continue

    text = path.read_text()

    # Keep disabled comments, but add active entries if missing.
    insert_lines = []
    for feed in NEW_FEEDS:
        name = feed[0]
        if not has_active_feed(text, name):
            insert_lines.append(tuple_line(feed))

    if insert_lines:
        marker = '    ("CoinDesk",'
        if marker in text:
            text = text.replace(marker, "\n".join(insert_lines) + "\n" + marker, 1)
        else:
            text = text.replace("]\n", "\n".join(insert_lines) + "\n]\n", 1)

    path.write_text(text)
    print(f"patched {path}")

registry_path = ROOT / "config/source_registry.json"
registry = {
  "news": [
    {"source": "PR Newswire", "status": "public_feed", "method": "rss"},
    {"source": "GlobeNewswire", "status": "public_feed", "method": "rss"},
    {"source": "Business Wire", "status": "public_feed", "method": "rss"},
    {"source": "ACCESS Newswire / AccessWire", "status": "public_feed", "method": "rss"},
    {"source": "SEC EDGAR", "status": "public_api", "method": "official_sec_atom"},
    {"source": "FDA", "status": "public_feed", "method": "official_fda_rss"},
    {"source": "Benzinga", "status": "public_feed_needs_runtime_verify", "method": "rss_or_api"},
    {"source": "Dow Jones Newswires", "status": "contract_required", "method": "licensed_api"},
    {"source": "TradingView News Flow", "status": "official_access_required", "method": "approved_api_only"},
    {"source": "Interactive Brokers News", "status": "broker_api_required", "method": "broker_api"},
    {"source": "Charles Schwab / TD Ameritrade News", "status": "broker_api_required", "method": "broker_api"}
  ],
  "social": [
    {"source": "Reddit", "status": "working_public_feed_limited", "method": "subreddit_new_rss_finance_only"},
    {"source": "StockTwits", "status": "working_public_endpoint_or_limited_public_access", "method": "public_symbol_streams"},
    {"source": "Bluesky", "status": "working_public_endpoint_or_limited_public_access", "method": "public_appview_search"},
    {"source": "X/Twitter", "status": "requires_official_api_access", "method": "x_api_recent_search_with_bearer_token"}
  ]
}
registry_path.write_text(json.dumps(registry, indent=2) + "\n")
print(f"updated {registry_path}")
