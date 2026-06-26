"""Tests for scrapers.db — MongoDB integration layer.

All tests use ``mongomock`` via the ``mongo_collection`` fixture defined in
conftest.py, so no real MongoDB instance is required.
"""

import mongomock
import pytest

from scrapers.db import ensure_indexes, upsert_posts


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_post(post_id: str, title: str = "title", text: str = "body") -> dict:
    """Return a minimal post dict with a unique ``id``."""
    return {
        "id": post_id,
        "source": "reddit",
        "subreddit": "wallstreetbets",
        "author": "user1",
        "title": title,
        "text": text,
    }


# ---------------------------------------------------------------------------
# upsert_posts tests
# ---------------------------------------------------------------------------

class TestUpsertPosts:
    """Tests for the upsert_posts function."""

    def test_insert_new_posts_correct_count(self, mongo_collection):
        """Inserting brand-new posts returns the correct inserted count."""
        posts = [_make_post(f"t3_{i}") for i in range(5)]
        inserted = upsert_posts(mongo_collection, posts)

        assert inserted == 5
        assert mongo_collection.count_documents({}) == 5

    def test_insert_duplicates_skipped(self, mongo_collection):
        """Re-inserting the same posts returns 0 and count is unchanged."""
        posts = [_make_post("t3_dup1"), _make_post("t3_dup2")]
        upsert_posts(mongo_collection, posts)

        # Insert the exact same posts again.
        inserted = upsert_posts(mongo_collection, posts)

        assert inserted == 0
        assert mongo_collection.count_documents({}) == 2

    def test_mixed_new_and_duplicate_batch(self, mongo_collection):
        """A batch with some new + some duplicate posts inserts only the new ones."""
        first_batch = [_make_post("t3_a"), _make_post("t3_b")]
        upsert_posts(mongo_collection, first_batch)

        # Second batch: t3_a is a dup, t3_c and t3_d are new.
        second_batch = [
            _make_post("t3_a"),
            _make_post("t3_c"),
            _make_post("t3_d"),
        ]
        inserted = upsert_posts(mongo_collection, second_batch)

        assert inserted == 2
        assert mongo_collection.count_documents({}) == 4

    def test_empty_list_returns_zero(self, mongo_collection):
        """Calling upsert_posts with an empty list returns 0 without error."""
        inserted = upsert_posts(mongo_collection, [])

        assert inserted == 0
        assert mongo_collection.count_documents({}) == 0


# ---------------------------------------------------------------------------
# ensure_indexes tests
# ---------------------------------------------------------------------------

class TestEnsureIndexes:
    """Tests for the ensure_indexes function."""

    def test_creates_expected_indexes(self):
        """ensure_indexes should create the four expected indexes (plus _id)."""
        client = mongomock.MongoClient()
        collection = client["test_idx"]["posts"]

        ensure_indexes(collection)

        index_info = collection.index_information()

        # MongoDB always creates the _id index automatically.
        expected_names = {
            "_id_",
            "idx_id_unique",
            "idx_source",
            "idx_detected_at",
            "idx_subreddit",
            "idx_source_author",
        }
        assert set(index_info.keys()) == expected_names

    def test_unique_index_on_id(self):
        """The idx_id_unique index must enforce uniqueness."""
        client = mongomock.MongoClient()
        collection = client["test_idx"]["posts"]
        ensure_indexes(collection)

        index_info = collection.index_information()
        assert index_info["idx_id_unique"]["unique"] is True

    def test_idempotent(self):
        """Calling ensure_indexes multiple times does not raise or duplicate indexes."""
        client = mongomock.MongoClient()
        collection = client["test_idx"]["posts"]

        ensure_indexes(collection)
        ensure_indexes(collection)

        index_info = collection.index_information()
        # Still exactly the same six indexes (including _id_).
        assert len(index_info) == 6
