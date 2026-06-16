"""
Phase 6: Cross-Source Deduplication & Rumor Detection

Two standalone utilities that plug into the pipeline:
  1. cross_source_dedup  — hash-based dedup across different sources
  2. detect_rumors       — phrase-matching to flag unconfirmed claims

Both operate on the MongoDB posts collection.
"""

from __future__ import annotations

import hashlib
import logging
import re
from typing import Optional
from datetime import datetime, timezone

log = logging.getLogger(__name__)

# ── Rumor phrases ──────────────────────────────────────────────────────────

RUMOR_PHRASES = [
    r"\brumou?red?\b",
    r"\ballegedly\b",
    r"\bunconfirmed\b",
    r"\bunverified\b",
    r"\bsources?\s+say\b",
    r"\baccording\s+to\s+sources?\b",
    r"\breportedly\b",
    r"\bmay\s+be\s+(?:planning|considering|exploring)\b",
    r"\bis\s+(?:said|believed|thought)\s+to\b",
    r"\bwhisper(?:s|ed)?\b",
    r"\bspeculat(?:ion|ed|ing)\b",
    r"\bin\s+talks?\b",
    r"\bnot\s+(?:yet\s+)?confirmed\b",
    r"\bcould\s+(?:soon|potentially)\b",
    r"\bpeople?\s+familiar\s+with\b",
    r"\bnot\s+(?:been\s+)?verified\b",
]

_RUMOR_PATTERN = re.compile("|".join(RUMOR_PHRASES), re.IGNORECASE)


# ── Cross-source title hashing ────────────────────────────────────────────

def _normalize_title(title: str) -> str:
    """Strip punctuation, lowercase, collapse whitespace for fingerprinting."""
    text = re.sub(r"[^\w\s]", "", title.lower())
    return re.sub(r"\s+", " ", text).strip()


def _title_hash(title: str) -> str:
    """SHA1 hash of normalized title — used for cross-source dedup."""
    return hashlib.sha1(_normalize_title(title).encode()).hexdigest()[:16]


# ── Dedup logic ───────────────────────────────────────────────────────────

def cross_source_dedup(collection, lookback_hours: int = 24) -> int:
    """
    Find posts from the last `lookback_hours` that have near-identical titles
    across different sources. The earliest post is kept; later duplicates get
    `is_cross_dup = True`.

    Returns number of posts flagged.
    """
    from datetime import timedelta
    cutoff = datetime.now(timezone.utc) - timedelta(hours=lookback_hours)

    posts = list(collection.find(
        {
            "published_at": {"$gte": cutoff},
            "is_duplicate": {"$ne": True},       # skip already-flagged same-source dupes
        },
        {"_id": 1, "id": 1, "title": 1, "source": 1, "published_at": 1},
    ).sort("published_at", 1))

    # Group posts by title hash
    groups: dict[str, list] = {}
    for p in posts:
        title = p.get("title", "")
        if len(title) < 15:
            continue
        h = _title_hash(title)
        groups.setdefault(h, []).append(p)

    flagged = 0
    for h, group in groups.items():
        if len(group) < 2:
            continue

        # Check that at least 2 different sources exist (cross-source)
        sources = set(p.get("source") for p in group)
        if len(sources) < 2:
            continue

        # Keep the first one (earliest), flag the rest
        for dup in group[1:]:
            collection.update_one(
                {"_id": dup["_id"]},
                {"$set": {
                    "is_cross_dup": True,
                    "cross_dup_original": group[0]["id"],
                }},
            )
            flagged += 1

    log.info("Cross-source dedup flagged %d posts (from %d candidates)", flagged, len(posts))
    return flagged


# ── Rumor detection ───────────────────────────────────────────────────────

def detect_rumors(collection, batch_size: int = 500) -> int:
    """
    Scan unprocessed posts for rumor-indicating phrases.
    Sets `is_rumor = True` on matches, `is_rumor = False` on clean posts.
    Only processes posts where `is_rumor` is not yet set.

    Returns number of posts flagged as rumors.
    """
    posts = list(collection.find(
        {"is_rumor": {"$exists": False}},
        {"_id": 1, "title": 1, "text": 1},
    ).limit(batch_size))

    if not posts:
        return 0

    flagged = 0
    for p in posts:
        combined = f"{p.get('title', '')} {p.get('text', '')}".strip()
        is_rumor = bool(_RUMOR_PATTERN.search(combined))

        collection.update_one(
            {"_id": p["_id"]},
            {"$set": {"is_rumor": is_rumor}},
        )
        if is_rumor:
            flagged += 1

    log.info("Rumor detection: %d flagged / %d scanned", flagged, len(posts))
    return flagged
