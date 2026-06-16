"""D5: Sentiment Scoring Engine.

Rule-based sentiment scoring using weighted lexicon matching.  Phrases,
single words (with word boundaries), and emojis each carry a signal
strength weight.  Score formula:

    (bullish_sum - bearish_sum) / (bullish_sum + bearish_sum)

clamped to [-1.0, +1.0].  Zero signals → VADER fallback.

Three-tier approach:
- 0 lexicon signals: VADER compound * 0.5 (lower confidence)
- 1-2 lexicon signals: 70% lexicon + 30% VADER blend
- 3+ lexicon signals: Pure lexicon (original behavior)
"""

from __future__ import annotations

import logging
import os
import re
import sys

from processing.sentiment_data import (
    BULLISH_PHRASES,
    BEARISH_PHRASES,
    BULLISH_WORDS,
    BEARISH_WORDS,
    BULLISH_EMOJIS,
    BEARISH_EMOJIS,
)

# Temporary path injection until Phase 2
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', 'sentiment_analyzer')))
from db_sqlite import get_engine, execute_update
from sqlalchemy import text

# ---------------------------------------------------------------------------
# Lazy-loaded VADER singleton
# ---------------------------------------------------------------------------

_vader_analyzer = None

def _get_vader():
    global _vader_analyzer
    if _vader_analyzer is None:
        from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer
        _vader_analyzer = SentimentIntensityAnalyzer()
    return _vader_analyzer

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Lazy-loaded ISA SentimentScorer (VADER + FinBERT)
# ---------------------------------------------------------------------------

_ISA_DIR = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "sentiment_analyzer")
)
_isa_scorer = None
_isa_tried  = False

def _get_isa_scorer():
    global _isa_scorer, _isa_tried
    if _isa_tried:
        return _isa_scorer
    _isa_tried = True
    if not os.path.isdir(_ISA_DIR):
        return None
    try:
        sys.path.insert(0, _ISA_DIR)
        _saved_cwd = os.getcwd()
        os.chdir(_ISA_DIR)
        from sentiment_scorer import SentimentScorer
        _isa_scorer = SentimentScorer(use_cuda=False)
        os.chdir(_saved_cwd)
        log.info("ISA SentimentScorer loaded (VADER + FinBERT)")
    except Exception as _e:
        log.warning("ISA SentimentScorer not available: %s", _e)
    return _isa_scorer


# ---------------------------------------------------------------------------
# Pre-compiled word-boundary patterns for single words
# ---------------------------------------------------------------------------

_BULLISH_WORD_RE: list[tuple[re.Pattern, float]] = [
    (re.compile(rf"\b{re.escape(w)}\b", re.IGNORECASE), weight)
    for w, weight in BULLISH_WORDS.items()
]

_BEARISH_WORD_RE: list[tuple[re.Pattern, float]] = [
    (re.compile(rf"\b{re.escape(w)}\b", re.IGNORECASE), weight)
    for w, weight in BEARISH_WORDS.items()
]


# ---------------------------------------------------------------------------
# Core functions
# ---------------------------------------------------------------------------

def count_signals(text: str) -> tuple[float, float, int]:
    if not text:
        return 0.0, 0.0, 0

    lower = text.lower()
    bullish_sum = 0.0
    bearish_sum = 0.0
    signal_count = 0

    for phrase, weight in BULLISH_PHRASES.items():
        if phrase in lower:
            bullish_sum += weight
            signal_count += 1

    for phrase, weight in BEARISH_PHRASES.items():
        if phrase in lower:
            bearish_sum += weight
            signal_count += 1

    for pattern, weight in _BULLISH_WORD_RE:
        if pattern.search(text):
            bullish_sum += weight
            signal_count += 1

    for pattern, weight in _BEARISH_WORD_RE:
        if pattern.search(text):
            bearish_sum += weight
            signal_count += 1

    for emoji, weight in BULLISH_EMOJIS.items():
        if emoji in text:
            bullish_sum += weight
            signal_count += 1

    for emoji, weight in BEARISH_EMOJIS.items():
        if emoji in text:
            bearish_sum += weight
            signal_count += 1

    return bullish_sum, bearish_sum, signal_count


def score_sentiment(title: str, text: str) -> dict:
    combined = f"{title or ''} {text or ''}"
    bullish_sum, bearish_sum, signal_count = count_signals(combined)

    total = bullish_sum + bearish_sum
    if total == 0:
        lexicon_score = 0.0
    else:
        lexicon_score = (bullish_sum - bearish_sum) / total
        lexicon_score = max(-1.0, min(1.0, lexicon_score))

    if signal_count == 0:
        if not combined.strip():
            score = 0.0
            method = "vader_fallback"
        else:
            vader = _get_vader()
            vader_compound = vader.polarity_scores(combined)["compound"]
            score = vader_compound * 0.5  # scale down for lower confidence
            method = "vader_fallback"
    elif signal_count <= 2:
        vader = _get_vader()
        vader_compound = vader.polarity_scores(combined)["compound"]
        score = 0.7 * lexicon_score + 0.3 * vader_compound
        method = "rule_based+vader"
    else:
        score = lexicon_score
        method = "rule_based"

    score = max(-1.0, min(1.0, score))

    isa = _get_isa_scorer()
    if isa is not None:
        try:
            result  = isa.score(combined[:512])
            finbert = result.finbert if result.finbert is not None else 0.0
            vader_s = result.vader   if result.vader   is not None else 0.0
            isa_score = finbert * 0.7 + vader_s * 0.3
            score  = max(-1.0, min(1.0, 0.5 * score + 0.5 * isa_score))
            method = method + "+isa"
        except Exception as _e:
            log.debug("ISA scoring failed: %s", _e)

    label = "bullish" if score > 0.05 else "bearish" if score < -0.05 else "neutral"

    return {
        "sentiment_score":  round(score, 4),
        "sentiment_category": method,
        "sentiment_combined": round(score, 4),
        "sentiment_label":  label,
    }


# ---------------------------------------------------------------------------
# Batch processor
# ---------------------------------------------------------------------------

def process_unscored_posts(engine) -> int:
    with engine.connect() as conn:
        cursor = conn.execute(text("SELECT id, title, content FROM articles WHERE sentiment_score IS NULL"))
        posts = cursor.fetchall()

    count = 0
    for post in posts:
        post_id = post[0]
        title = post[1]
        content = post[2]

        result = score_sentiment(title, content)
        
        # Build update query dynamically based on returned keys
        execute_update(
            "UPDATE articles SET sentiment_score = :sentiment_score, sentiment_category = :sentiment_category, sentiment_combined = :sentiment_combined WHERE id = :id",
            {
                "sentiment_score": result["sentiment_score"],
                "sentiment_category": result["sentiment_category"],
                "sentiment_combined": result["sentiment_combined"],
                "id": post_id
            }
        )
        count += 1

        if count % 500 == 0:
            log.info("Scored %d posts so far…", count)

    log.info("Sentiment scoring complete — %d post(s) processed", count)
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
            unscored = conn.execute(text("SELECT COUNT(*) FROM articles WHERE sentiment_score IS NULL")).scalar()
            
        log.info("Posts in DB: %d total, %d unscored", total, unscored)

        processed = process_unscored_posts(engine)

        with engine.connect() as conn:
            scored = conn.execute(text("SELECT COUNT(*) FROM articles WHERE sentiment_score IS NOT NULL")).scalar()
            
        log.info("Done — %d processed, %d total scored", processed, scored)
    except Exception as e:
        log.error(f"Error during sentiment scoring: {e}")


if __name__ == "__main__":
    main()
