"""D3: Ticker Extraction & Matching Engine.

Extracts stock ticker symbols from post titles and text, validates them
against a known ticker list, and updates SQLite DB with a ticker field.
"""

from __future__ import annotations

import logging
import re
from typing import Optional
import sys
import os

from processing.ticker_data import FALSE_POSITIVE_WORDS, VALID_TICKERS

# Temporary path injection until Phase 2
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', 'sentiment_analyzer')))
from db_sqlite import get_engine, execute_update
from sqlalchemy import text

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Regex patterns
# ---------------------------------------------------------------------------

_RE_CASHTAG = re.compile(r"\$([A-Za-z]{1,5})(?![A-Za-z])")
_RE_PAREN = re.compile(r"\(([A-Z]{1,5})\)")
_RE_BARE = re.compile(r"(?<![$#/\w])([A-Z]{1,5})(?![a-zA-Z/])")
_RE_URL = re.compile(r"https?://\S+")

# ---------------------------------------------------------------------------
# Core extraction function
# ---------------------------------------------------------------------------

def extract_tickers(
    title: str,
    text: str,
    valid_tickers: Optional[frozenset[str]] = None,
) -> list[str]:
    if valid_tickers is None:
        valid_tickers = VALID_TICKERS

    combined = f"{title or ''} {text or ''}"
    combined = _RE_URL.sub("", combined)

    found: set[str] = set()

    for match in _RE_CASHTAG.finditer(combined):
        sym = match.group(1).upper()
        if sym in valid_tickers:
            found.add(sym)

    for match in _RE_PAREN.finditer(combined):
        sym = match.group(1)
        if sym in valid_tickers and sym not in FALSE_POSITIVE_WORDS:
            found.add(sym)

    for match in _RE_BARE.finditer(combined):
        sym = match.group(1)
        if sym in valid_tickers and sym not in FALSE_POSITIVE_WORDS:
            found.add(sym)

    return sorted(found)

# ---------------------------------------------------------------------------
# Batch processor
# ---------------------------------------------------------------------------

def process_untagged_posts(engine) -> int:
    with engine.connect() as conn:
        cursor = conn.execute(text("SELECT id, title, content FROM articles WHERE ticker IS NULL OR ticker = ''"))
        posts = cursor.fetchall()
        
    count = 0
    for post in posts:
        post_id = post[0]
        title = post[1]
        content = post[2]
        
        tickers = extract_tickers(title, content)
        ticker_str = tickers[0] if tickers else "NONE"
        
        execute_update("UPDATE articles SET ticker = :ticker WHERE id = :id", {"ticker": ticker_str, "id": post_id})
        count += 1

        if count % 500 == 0:
            log.info("Processed %d posts so far…", count)

    log.info("Ticker extraction complete — %d post(s) processed", count)
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
            untagged = conn.execute(text("SELECT COUNT(*) FROM articles WHERE ticker IS NULL OR ticker = ''")).scalar()
        
        log.info("Posts in DB: %d total, %d untagged", total, untagged)

        processed = process_untagged_posts(engine)

        with engine.connect() as conn:
            with_tickers = conn.execute(text("SELECT COUNT(*) FROM articles WHERE ticker != '' AND ticker != 'NONE' AND ticker IS NOT NULL")).scalar()
            
        log.info("Done — %d processed, %d posts have ≥1 ticker", processed, with_tickers)
    except Exception as e:
        log.error(f"Error during ticker extraction: {e}")

if __name__ == "__main__":
    main()
