"""Tests for D4 — Near-Duplicate Detection & Spam Filter."""

from datetime import datetime, timezone

import pytest
from bson import ObjectId

from processing.dedup_filter import (
    compute_text_similarity,
    find_duplicates,
    process_unfiltered_posts,
)


# ═══════════════════════════════════════════════════════════════════════════
# Helpers
# ═══════════════════════════════════════════════════════════════════════════

def _make_post(
    _id=None, source="reddit", author="user1", title="", text="",
    published_at=None, **extra,
):
    """Build a minimal post dict for testing."""
    post = {
        "_id": _id or ObjectId(),
        "id": str(_id or ObjectId()),
        "source": source,
        "author": author,
        "title": title,
        "text": text,
        "published_at": published_at or datetime.now(timezone.utc).isoformat(),
    }
    post.update(extra)
    return post


# ═══════════════════════════════════════════════════════════════════════════
# TestComputeTextSimilarity — pure function
# ═══════════════════════════════════════════════════════════════════════════

class TestComputeTextSimilarity:

    def test_identical_strings(self):
        assert compute_text_similarity("hello world", "hello world") == 1.0

    def test_completely_different(self):
        sim = compute_text_similarity("aaaa", "zzzz")
        assert sim < 0.1

    def test_empty_strings(self):
        assert compute_text_similarity("", "") == 1.0

    def test_one_empty(self):
        assert compute_text_similarity("hello", "") == 0.0

    def test_slightly_different(self):
        sim = compute_text_similarity(
            "TSLA to the moon rockets",
            "TSLA to the moon rocket!",
        )
        assert sim > 0.8

    def test_boundary_similarity(self):
        """Two strings near 0.8 — verify we get a float in range."""
        sim = compute_text_similarity(
            "Buy AAPL now before it goes up",
            "Buy AAPL now before it drops down",
        )
        assert 0.0 <= sim <= 1.0


# ═══════════════════════════════════════════════════════════════════════════
# TestFindDuplicates — pure function with post dicts
# ═══════════════════════════════════════════════════════════════════════════

class TestFindDuplicates:

    def test_single_post_is_original(self):
        p = _make_post(title="unique post")
        result = find_duplicates([p])
        assert result[p["_id"]] == {"is_duplicate": False, "is_spam": False}

    def test_identical_pair(self):
        p1 = _make_post(title="same text", published_at="2026-01-01T00:00:00Z")
        p2 = _make_post(title="same text", published_at="2026-01-01T00:01:00Z")
        result = find_duplicates([p1, p2])
        assert result[p1["_id"]] == {"is_duplicate": False, "is_spam": False}
        assert result[p2["_id"]] == {"is_duplicate": True, "is_spam": True}

    def test_different_pair_not_flagged(self):
        p1 = _make_post(title="apples are great")
        p2 = _make_post(title="the weather is nice today")
        result = find_duplicates([p1, p2])
        assert result[p1["_id"]]["is_duplicate"] is False
        assert result[p2["_id"]]["is_duplicate"] is False

    def test_above_threshold_flagged(self):
        base = "TSLA is going to the moon I am so excited about this stock"
        p1 = _make_post(title=base, published_at="2026-01-01T00:00:00Z")
        p2 = _make_post(title=base + "!", published_at="2026-01-01T00:01:00Z")
        result = find_duplicates([p1, p2])
        assert result[p2["_id"]]["is_duplicate"] is True

    def test_at_threshold_not_flagged(self):
        """Exactly 0.8 should NOT be flagged (strictly >0.8)."""
        # Craft strings with exactly 0.8 similarity
        # "abcdefghij" vs "abcdefghXX" = 8/10 matching = 0.8
        p1 = _make_post(title="abcdefghij", published_at="2026-01-01T00:00:00Z")
        p2 = _make_post(title="abcdefghXX", published_at="2026-01-01T00:01:00Z")
        sim = compute_text_similarity(
            "\n" + "abcdefghij", "\n" + "abcdefghXX"
        )
        if sim <= 0.8:
            result = find_duplicates([p1, p2])
            assert result[p2["_id"]]["is_duplicate"] is False

    def test_three_posts_two_dupes(self):
        base = "GME diamond hands forever lets go apes"
        p1 = _make_post(title=base, published_at="2026-01-01T00:00:00Z")
        p2 = _make_post(title=base, published_at="2026-01-01T00:01:00Z")
        p3 = _make_post(title=base, published_at="2026-01-01T00:02:00Z")
        result = find_duplicates([p1, p2, p3])
        assert result[p1["_id"]]["is_duplicate"] is False
        assert result[p2["_id"]]["is_duplicate"] is True
        assert result[p3["_id"]]["is_duplicate"] is True

    def test_ordering_by_published_at(self):
        """Earlier published_at should be the original, regardless of list order."""
        p_later = _make_post(title="same post", published_at="2026-01-02T00:00:00Z")
        p_earlier = _make_post(title="same post", published_at="2026-01-01T00:00:00Z")
        # Pass in reverse order
        result = find_duplicates([p_later, p_earlier])
        assert result[p_earlier["_id"]]["is_duplicate"] is False
        assert result[p_later["_id"]]["is_duplicate"] is True

    def test_existing_originals_considered(self):
        """A new post matching an existing original should be flagged."""
        existing = _make_post(title="old post text", published_at="2026-01-01T00:00:00Z")
        new = _make_post(title="old post text", published_at="2026-01-02T00:00:00Z")
        result = find_duplicates([new], existing_originals=[existing])
        assert result[new["_id"]]["is_duplicate"] is True


# ═══════════════════════════════════════════════════════════════════════════
# TestProcessUnfilteredPosts — integration with mongomock
# ═══════════════════════════════════════════════════════════════════════════

class TestProcessUnfilteredPosts:

    def test_basic_processing(self, mongo_collection):
        mongo_collection.insert_many([
            {"id": "1", "source": "reddit", "author": "u1",
             "title": "unique A", "text": "", "published_at": "2026-01-01T00:00:00Z"},
            {"id": "2", "source": "reddit", "author": "u1",
             "title": "unique B completely different", "text": "",
             "published_at": "2026-01-01T00:01:00Z"},
        ])
        count = process_unfiltered_posts(mongo_collection)
        assert count == 2
        assert mongo_collection.count_documents({"is_duplicate": {"$exists": True}}) == 2

    def test_skips_already_processed(self, mongo_collection):
        mongo_collection.insert_many([
            {"id": "1", "source": "reddit", "author": "u1",
             "title": "already done", "text": "",
             "is_duplicate": False, "is_spam": False,
             "published_at": "2026-01-01T00:00:00Z"},
            {"id": "2", "source": "reddit", "author": "u1",
             "title": "needs processing", "text": "",
             "published_at": "2026-01-01T00:01:00Z"},
        ])
        count = process_unfiltered_posts(mongo_collection)
        assert count == 1

    def test_different_authors_not_compared(self, mongo_collection):
        mongo_collection.insert_many([
            {"id": "1", "source": "reddit", "author": "alice",
             "title": "identical text here", "text": "",
             "published_at": "2026-01-01T00:00:00Z"},
            {"id": "2", "source": "reddit", "author": "bob",
             "title": "identical text here", "text": "",
             "published_at": "2026-01-01T00:01:00Z"},
        ])
        process_unfiltered_posts(mongo_collection)
        assert mongo_collection.count_documents({"is_duplicate": True}) == 0

    def test_different_sources_not_compared(self, mongo_collection):
        mongo_collection.insert_many([
            {"id": "1", "source": "reddit", "author": "user1",
             "title": "identical text here", "text": "",
             "published_at": "2026-01-01T00:00:00Z"},
            {"id": "2", "source": "bluesky", "author": "user1",
             "title": "identical text here", "text": "",
             "published_at": "2026-01-01T00:01:00Z"},
        ])
        process_unfiltered_posts(mongo_collection)
        assert mongo_collection.count_documents({"is_duplicate": True}) == 0

    def test_sets_both_fields(self, mongo_collection):
        mongo_collection.insert_one(
            {"id": "1", "source": "reddit", "author": "u1",
             "title": "solo post", "text": "",
             "published_at": "2026-01-01T00:00:00Z"}
        )
        process_unfiltered_posts(mongo_collection)
        doc = mongo_collection.find_one({"id": "1"})
        assert "is_duplicate" in doc
        assert "is_spam" in doc
        assert doc["is_duplicate"] is False
        assert doc["is_spam"] is False

    def test_idempotent(self, mongo_collection):
        mongo_collection.insert_many([
            {"id": "1", "source": "reddit", "author": "u1",
             "title": "same text", "text": "",
             "published_at": "2026-01-01T00:00:00Z"},
            {"id": "2", "source": "reddit", "author": "u1",
             "title": "same text", "text": "",
             "published_at": "2026-01-01T00:01:00Z"},
        ])
        assert process_unfiltered_posts(mongo_collection) == 2
        assert process_unfiltered_posts(mongo_collection) == 0  # nothing new

    def test_cross_batch_detection(self, mongo_collection):
        """A second batch should detect dupes against earlier originals."""
        # First batch
        mongo_collection.insert_one(
            {"id": "1", "source": "reddit", "author": "u1",
             "title": "original post text here", "text": "",
             "published_at": "2026-01-01T00:00:00Z"}
        )
        process_unfiltered_posts(mongo_collection)

        # Second batch — same author, same text
        mongo_collection.insert_one(
            {"id": "2", "source": "reddit", "author": "u1",
             "title": "original post text here", "text": "",
             "published_at": "2026-01-02T00:00:00Z"}
        )
        process_unfiltered_posts(mongo_collection)

        doc = mongo_collection.find_one({"id": "2"})
        assert doc["is_duplicate"] is True
        assert doc["is_spam"] is True


# ═══════════════════════════════════════════════════════════════════════════
# TestRealWorldExamples — patterns from actual posts
# ═══════════════════════════════════════════════════════════════════════════

class TestRealWorldExamples:

    def test_wsb_copypasta(self):
        """Classic WSB copypasta spam — same text, same author."""
        base = "GME to the moon 🚀🚀🚀 diamond hands baby lets go apes strong together"
        p1 = _make_post(author="wsb_ape", title=base, published_at="2026-01-01T00:00:00Z")
        p2 = _make_post(author="wsb_ape", title=base, published_at="2026-01-01T00:05:00Z")
        p3 = _make_post(author="wsb_ape", title=base + "!!", published_at="2026-01-01T00:10:00Z")
        result = find_duplicates([p1, p2, p3])
        assert result[p1["_id"]]["is_duplicate"] is False
        assert result[p2["_id"]]["is_duplicate"] is True
        assert result[p3["_id"]]["is_duplicate"] is True

    def test_bluesky_cashtag_spam(self):
        """Bluesky bot posting same cashtag content repeatedly."""
        p1 = _make_post(
            source="bluesky", author="bot.bsky.social",
            title="", text="$TSLA is going up buy now! 📈",
            published_at="2026-01-01T12:00:00Z",
        )
        p2 = _make_post(
            source="bluesky", author="bot.bsky.social",
            title="", text="$TSLA is going up buy now! 📈",
            published_at="2026-01-01T12:05:00Z",
        )
        result = find_duplicates([p1, p2])
        assert result[p1["_id"]]["is_duplicate"] is False
        assert result[p2["_id"]]["is_duplicate"] is True

    def test_legitimate_similar_discussion(self):
        """Two different posts about the same topic should NOT be flagged."""
        p1 = _make_post(
            author="analyst1",
            title="AAPL Q4 earnings beat expectations, revenue up 8%",
            text="Apple reported strong Q4 with services growth leading the way.",
            published_at="2026-01-01T00:00:00Z",
        )
        p2 = _make_post(
            author="analyst1",
            title="My take on AAPL earnings — bullish for 2026",
            text="Looking at Apple's margins and guidance, I think the stock runs higher.",
            published_at="2026-01-01T01:00:00Z",
        )
        result = find_duplicates([p1, p2])
        assert result[p1["_id"]]["is_duplicate"] is False
        assert result[p2["_id"]]["is_duplicate"] is False
