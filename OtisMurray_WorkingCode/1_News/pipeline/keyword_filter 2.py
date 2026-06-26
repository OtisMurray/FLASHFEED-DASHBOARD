"""
Keyword filtering module — filters articles by financial signal keywords
before they are passed to the LLM/sentiment pipeline.

Keywords are loaded from the PostgreSQL filter_keywords table (editable via
the dashboard settings). Falls back to a hardcoded default set if DB is
unavailable.

Usage:
    from processing.keyword_filter import load_keywords, matches_keyword

    keywords = load_keywords(postgres_dsn)
    match = matches_keyword(article_title, article_content, keywords)
    if match:
        # article is financially significant — pass to sentiment scoring
"""

from __future__ import annotations

import logging
import re
import time
from typing import Optional

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Default keywords (used if DB is unreachable)
# ---------------------------------------------------------------------------

DEFAULT_KEYWORDS: list[tuple[str, str]] = [
    ("earnings",       "fundamental"),
    ("ipo",            "fundamental"),
    ("listing",        "fundamental"),
    ("delisting",      "fundamental"),
    ("dividend",       "fundamental"),
    ("merger",         "fundamental"),
    ("acquisition",    "fundamental"),
    ("buyout",         "fundamental"),
    ("contract",       "fundamental"),
    ("partnership",    "fundamental"),
    ("fda approval",   "regulatory"),
    ("fda rejection",  "regulatory"),
    ("clinical trial", "regulatory"),
    ("sec filing",     "regulatory"),
    ("short squeeze",  "momentum"),
    ("price target",   "analyst"),
    ("downgrade",      "analyst"),
    ("upgrade",        "analyst"),
    ("beat estimates", "fundamental"),
    ("miss estimates", "fundamental"),
    ("guidance",       "fundamental"),
    ("recall",         "regulatory"),
    ("bankruptcy",     "fundamental"),
    ("layoffs",        "fundamental"),
    ("restructuring",  "fundamental"),
]


# ---------------------------------------------------------------------------
# DB loading
# ---------------------------------------------------------------------------

def load_keywords(dsn: Optional[str] = None) -> list[dict]:
    """
    Load enabled keywords from PostgreSQL.
    Returns list of {keyword, category} dicts, sorted longest-first
    so multi-word phrases match before single words.
    Falls back to DEFAULT_KEYWORDS if DB unavailable.
    """
    if dsn:
        try:
            import psycopg
            with psycopg.connect(dsn) as conn:
                rows = conn.execute(
                    "SELECT keyword, category FROM filter_keywords WHERE enabled = TRUE ORDER BY LENGTH(keyword) DESC"
                ).fetchall()
            return [{"keyword": r[0], "category": r[1]} for r in rows]
        except Exception as exc:
            log.warning("Could not load keywords from DB (%s) — using defaults", exc)

    return [{"keyword": k, "category": c} for k, c in sorted(
        DEFAULT_KEYWORDS, key=lambda x: len(x[0]), reverse=True
    )]


# ---------------------------------------------------------------------------
# Matching
# ---------------------------------------------------------------------------

def matches_keyword(
    title: str,
    content: str,
    keywords: list[dict],
) -> Optional[str]:
    """
    Check whether the article title or content contains any enabled keyword.

    Returns the first matching keyword string, or None if no match.
    Title matches are checked first (higher signal value).
    Matching is case-insensitive word-boundary aware.
    """
    text_title   = (title   or "").lower()
    text_content = (content or "")[:500].lower()

    for kw in keywords:
        word = kw["keyword"]
        # Word-boundary pattern (handles multi-word phrases too)
        pattern = r"(?<!\w)" + re.escape(word) + r"(?!\w)"
        if re.search(pattern, text_title) or re.search(pattern, text_content):
            return word

    return None


def filter_articles(
    articles: list[dict],
    keywords: list[dict],
    *,
    require_match: bool = False,
) -> list[dict]:
    """
    Add `keyword_match` field to each article.
    If require_match=True, returns only articles that matched at least one keyword.
    """
    result = []
    for a in articles:
        match = matches_keyword(a.get("title", ""), a.get("content", ""), keywords)
        a["keyword_match"] = match
        if not require_match or match is not None:
            result.append(a)
    return result


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
