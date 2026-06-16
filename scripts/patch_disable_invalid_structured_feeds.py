from pathlib import Path
import json

ROOT = Path.cwd()

rss_files = [
    ROOT / "1_News/pipeline/fetch_rss.py",
    ROOT / "backend/pipeline/news/fetch_rss.py",
]

disable_names = {
    "Benzinga": "DISABLED: returned HTML, use official Benzinga API/key",
    "BusinessWire": "DISABLED: current RSS URL returns invalid channel ID; needs valid BusinessWire RSS/media feed",
    "AccessWire": "DISABLED: current RSS URL redirects to invalid HTML page; needs verified ACCESS/Newswire feed",
}

for path in rss_files:
    text = path.read_text()
    lines = text.splitlines()
    out = []

    for line in lines:
        stripped = line.strip()
        disabled = False
        for name, reason in disable_names.items():
            if stripped.startswith(f'("{name}"') and not stripped.startswith("#"):
                out.append(f"    # {reason}: {stripped}")
                disabled = True
                break
        if not disabled:
            out.append(line)

    path.write_text("\n".join(out) + "\n")
    print(f"patched {path}")

registry_path = ROOT / "config/source_registry.json"
registry = json.loads(registry_path.read_text())

for row in registry.get("news", []):
    src = row.get("source", "")

    if src == "Business Wire":
        row["status"] = "valid_rss_channel_required"
        row["method"] = "official_businesswire_rss_or_media_partner_feed"
        row["note"] = "Configured URL returned an RSS error saying the channel ID is not available."

    elif src == "ACCESS Newswire / AccessWire":
        row["status"] = "verified_endpoint_required"
        row["method"] = "official_access_or_newswire_feed_required"
        row["note"] = "Configured AccessWire URL redirected to an invalid public message page."

    elif src == "Benzinga":
        row["status"] = "api_key_required"
        row["method"] = "official_benzinga_stock_news_api"
        row["note"] = "Configured public URL returned HTML, not RSS XML."

registry_path.write_text(json.dumps(registry, indent=2) + "\n")
print(f"updated {registry_path}")
