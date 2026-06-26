import sys
import os
import logging
from typing import Any

# Temporary path injection until Phase 2
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', 'sentiment_analyzer')))
from db_sqlite import get_engine, ensure_articles_table, bulk_insert_articles

log = logging.getLogger(__name__)

class DummyClient:
    def close(self): pass

def get_client(*args, **kwargs) -> DummyClient:
    return DummyClient()

def get_collection(*args, **kwargs):
    ensure_articles_table()
    return get_engine()

def upsert_posts(engine, posts: list[dict[str, Any]]) -> int:
    if not posts: return 0
    mapped_posts = []
    for p in posts:
        mapped_posts.append({
            "id": str(p.get("id")),
            "title": p.get("title"),
            "content": p.get("text"),
            "source": p.get("source"),
            "category": p.get("subreddit") or p.get("category"),
            "author": p.get("author"),
            "url": p.get("url"),
            "publish_date": p.get("created_utc"),
            "fetched_date": p.get("detected_at"),
            "ticker": ""
        })
    bulk_insert_articles(mapped_posts)
    return len(posts)
