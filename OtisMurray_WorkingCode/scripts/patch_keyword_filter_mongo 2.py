from pathlib import Path

for p in [Path("1_News/pipeline/keyword_filter.py"), Path("backend/pipeline/news/keyword_filter.py")]:
    if not p.exists():
        print(f"skip missing {p}")
        continue

    text = p.read_text()
    marker = "# FEEDFLASH_MONGO_KEYWORDS_PATCH_V1"
    if marker in text:
        print(f"already patched {p}")
        continue

    block = r'''

# FEEDFLASH_MONGO_KEYWORDS_PATCH_V1
# Override load_keywords so the Mongo dashboard Settings page controls active keywords.
def load_keywords(dsn=None):
    import os
    try:
        from pymongo import MongoClient
        mongo_uri = os.environ.get("MONGODB_URI") or os.environ.get("MONGO_URI") or "mongodb://localhost:27017/feedflash"
        db_name = os.environ.get("MONGO_DB", "feedflash")
        client = MongoClient(mongo_uri, serverSelectionTimeoutMS=1500)
        rows = list(client[db_name]["keywords"].find({
            "$or": [{"enabled": {"$ne": False}}, {"active": {"$ne": False}}]
        }))
        out = []
        for r in rows:
            kw = (r.get("keyword") or r.get("word") or "").strip().lower()
            if kw:
                out.append({"keyword": kw, "category": r.get("category", "custom")})
        if out:
            return sorted(out, key=lambda x: len(x["keyword"]), reverse=True)
    except Exception as exc:
        try:
            log.warning("Could not load Mongo keywords (%s) — using defaults", exc)
        except Exception:
            pass

    return [{"keyword": k, "category": c} for k, c in sorted(
        DEFAULT_KEYWORDS, key=lambda x: len(x[0]), reverse=True
    )]
'''
    p.write_text(text + block)
    print(f"patched {p}")
