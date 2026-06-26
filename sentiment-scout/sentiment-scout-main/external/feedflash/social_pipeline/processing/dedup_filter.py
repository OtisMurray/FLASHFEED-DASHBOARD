"""D4: Near-Duplicate Detection & Spam Filter.

Flags posts as duplicates when the same author on the same source posts
content with >80% text similarity.  Earlier posts (by ``published_at``)
are kept as originals; later ones are marked ``is_duplicate=True`` and
``is_spam=True``.
"""

from __future__ import annotations

import logging
from collections import defaultdict
from difflib import SequenceMatcher
from typing import Optional
import sys
import os

# Temporary path injection until Phase 2
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', 'sentiment_analyzer')))
from db_sqlite import get_engine, execute_update
from sqlalchemy import text

log = logging.getLogger(__name__)

DEFAULT_THRESHOLD = 0.8

# ---------------------------------------------------------------------------
# Pure functions
# ---------------------------------------------------------------------------

def compute_text_similarity(text_a: str, text_b: str) -> float:
    return SequenceMatcher(None, text_a, text_b).ratio()

def _post_sort_key(post: dict) -> tuple:
    return (post.get("published_at", ""), str(post.get("_id", "")))

def _combined_text(post: dict) -> str:
    title = post.get("title", "") or ""
    text_content = post.get("text", "") or ""
    return f"{title}\n{text_content}"

def find_duplicates(
    posts: list[dict],
    existing_originals: Optional[list[dict]] = None,
    threshold: float = DEFAULT_THRESHOLD,
) -> dict:
    if existing_originals is None:
        existing_originals = []

    originals: list[dict] = list(existing_originals)
    sorted_posts = sorted(posts, key=_post_sort_key)
    results: dict = {}

    for post in sorted_posts:
        post_text = _combined_text(post)
        is_dup = False

        for orig in originals:
            sim = compute_text_similarity(post_text, _combined_text(orig))
            if sim > threshold:
                is_dup = True
                break

        pid = post["_id"]
        results[pid] = {"is_duplicate": is_dup, "is_spam": is_dup}

        if not is_dup:
            originals.append(post)

    return results

# ---------------------------------------------------------------------------
# Batch processor
# ---------------------------------------------------------------------------

def process_unfiltered_posts(engine) -> int:
    with engine.connect() as conn:
        cursor = conn.execute(text("SELECT id, title, content, source, author, publish_date FROM articles WHERE is_duplicate IS NULL"))
        rows = cursor.fetchall()

    if not rows:
        log.info("No unfiltered posts to process")
        return 0

    unprocessed = []
    for r in rows:
        unprocessed.append({
            "_id": r[0],
            "title": r[1],
            "text": r[2],
            "source": r[3],
            "author": r[4],
            "published_at": r[5] or 0
        })

    groups: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for post in unprocessed:
        key = (post.get("source", ""), post.get("author", ""))
        groups[key].append(post)

    count = 0

    for (source, author), posts in groups.items():
        with engine.connect() as conn:
            orig_cursor = conn.execute(text("SELECT id, title, content, source, author, publish_date FROM articles WHERE source = :s AND author = :a AND is_duplicate = 0"), {"s": source, "a": author})
            orig_rows = orig_cursor.fetchall()
            
        existing_originals = []
        for r in orig_rows:
            existing_originals.append({
                "_id": r[0],
                "title": r[1],
                "text": r[2],
                "source": r[3],
                "author": r[4],
                "published_at": r[5] or 0
            })

        results = find_duplicates(posts, existing_originals)

        for pid, flags in results.items():
            execute_update(
                "UPDATE articles SET is_duplicate = :dup, is_spam = :spam WHERE id = :id",
                {"dup": 1 if flags["is_duplicate"] else 0, "spam": 1 if flags["is_spam"] else 0, "id": pid}
            )
            count += 1

            if count % 500 == 0:
                log.info("Processed %d posts so far…", count)

    log.info("Dedup filter complete — %d post(s) processed", count)
    return count

# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s  %(name)-30s  %(levelname)-8s  %(message)s",
    )

    engine = get_engine()
    if not engine:
        log.error("Failed to connect to SQLite")
        return

    try:
        with engine.connect() as conn:
            total = conn.execute(text("SELECT COUNT(*) FROM articles")).scalar()
            unfiltered = conn.execute(text("SELECT COUNT(*) FROM articles WHERE is_duplicate IS NULL")).scalar()
            
        log.info("Posts in DB: %d total, %d unfiltered", total, unfiltered)

        processed = process_unfiltered_posts(engine)

        with engine.connect() as conn:
            duplicates = conn.execute(text("SELECT COUNT(*) FROM articles WHERE is_duplicate = 1")).scalar()
            
        log.info("Done — %d processed, %d flagged as duplicate", processed, duplicates)
    except Exception as e:
        log.error(f"Error during dedup filtering: {e}")

if __name__ == "__main__":
    main()
