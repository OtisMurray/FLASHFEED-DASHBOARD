"""Tests for D3 — Ticker Extraction & Matching Engine."""

import pytest

from processing.ticker_extraction import extract_tickers, process_untagged_posts


# A small valid-ticker set used across most tests so results are deterministic
# and don't depend on the full VALID_TICKERS list.
TEST_TICKERS = frozenset({
    "AAPL", "TSLA", "GOOG", "GOOGL", "AMZN", "MSFT", "GME", "AMC",
    "NVDA", "META", "SPY", "QQQ", "AMD", "INTC", "NFLX", "DIS",
    "CPB", "RDDT", "PLTR", "SOFI", "NIO", "RIVN", "COIN", "BB",
    "A", "F", "T", "X", "V", "C",  # single-letter tickers
})


# ═══════════════════════════════════════════════════════════════════════════
# TestExtractTickers — pure function, no DB
# ═══════════════════════════════════════════════════════════════════════════

class TestExtractTickers:
    """Unit tests for the extract_tickers() pure function."""

    # --- Cashtag patterns ---

    def test_single_cashtag(self):
        assert extract_tickers("$TSLA mooning", "", TEST_TICKERS) == ["TSLA"]

    def test_multiple_cashtags(self):
        result = extract_tickers("$TSLA and $AAPL", "", TEST_TICKERS)
        assert result == ["AAPL", "TSLA"]

    def test_lowercase_cashtag(self):
        assert extract_tickers("$tsla is up", "", TEST_TICKERS) == ["TSLA"]

    def test_cashtag_end_of_string(self):
        assert extract_tickers("buy $NVDA", "", TEST_TICKERS) == ["NVDA"]

    def test_single_letter_cashtag(self):
        """$A is Agilent Technologies — $ prefix makes single-letter OK."""
        assert extract_tickers("$A looks good", "", TEST_TICKERS) == ["A"]

    def test_dollar_amount_rejected(self):
        """$150M should not extract a ticker."""
        assert extract_tickers("lost $150M today", "", TEST_TICKERS) == []

    def test_dollar_amount_with_ticker(self):
        """$150 should not match, but $TSLA should."""
        assert extract_tickers("$150 on $TSLA", "", TEST_TICKERS) == ["TSLA"]

    # --- Parenthesized patterns ---

    def test_parenthesized_ticker(self):
        assert extract_tickers("Campbells (CPB) surge", "", TEST_TICKERS) == ["CPB"]

    def test_parenthesized_false_positive_rejected(self):
        """(NFA) should be rejected as a false positive."""
        assert extract_tickers("not financial advice (NFA)", "", TEST_TICKERS) == []

    def test_multiple_parenthesized(self):
        result = extract_tickers("Apple (AAPL) and Tesla (TSLA)", "", TEST_TICKERS)
        assert result == ["AAPL", "TSLA"]

    # --- Bare word patterns ---

    def test_bare_word_valid_ticker(self):
        assert extract_tickers("TSLA is up 5%", "", TEST_TICKERS) == ["TSLA"]

    def test_bare_word_common_word_rejected(self):
        """IT, AM, etc. should be rejected as false positives."""
        assert extract_tickers("IT IS working", "", TEST_TICKERS) == []

    def test_bare_word_colon_suffix(self):
        """TSLA: should still match — colon is not a letter or /."""
        assert extract_tickers("TSLA: Elon Musk says", "", TEST_TICKERS) == ["TSLA"]

    def test_bare_word_min_length(self):
        """Single bare letters (no $) should NOT match — too noisy."""
        assert extract_tickers("I think A is good", "", TEST_TICKERS) == []

    # --- URL exclusion ---

    def test_url_tickers_ignored(self):
        text = "check https://reddit.com/r/TSLA/comments/abc"
        assert extract_tickers(text, "", TEST_TICKERS) == []

    def test_ticker_outside_url_captured(self):
        text = "AAPL is great, see https://example.com/TSLA for more"
        assert extract_tickers(text, "", TEST_TICKERS) == ["AAPL"]

    # --- Deduplication ---

    def test_dedup_cashtag_and_bare(self):
        """$TSLA and TSLA in same text should produce one entry."""
        assert extract_tickers("$TSLA ... TSLA again", "", TEST_TICKERS) == ["TSLA"]

    # --- Invalid tickers ---

    def test_invalid_ticker_rejected(self):
        assert extract_tickers("$ZZZZ is fake", "", TEST_TICKERS) == []

    def test_custom_valid_set(self):
        custom = frozenset({"FOO", "BAR"})
        assert extract_tickers("$FOO and $BAR", "", custom) == ["BAR", "FOO"]

    # --- Edge cases ---

    def test_empty_strings(self):
        assert extract_tickers("", "", TEST_TICKERS) == []

    def test_hashtag_not_matched(self):
        """#TSLA should not match (# prefix blocks Pattern C, not a cashtag)."""
        assert extract_tickers("#TSLA trending", "", TEST_TICKERS) == []

    def test_title_and_text_combined(self):
        result = extract_tickers("$AAPL in title", "NVDA in body", TEST_TICKERS)
        assert result == ["AAPL", "NVDA"]

    def test_ticker_in_path_rejected(self):
        """/TSLA/ should not match (/ prefix blocks Pattern C)."""
        assert extract_tickers("see /TSLA/ for info", "", TEST_TICKERS) == []


# ═══════════════════════════════════════════════════════════════════════════
# TestProcessUntaggedPosts — integration with mongomock
# ═══════════════════════════════════════════════════════════════════════════

class TestProcessUntaggedPosts:
    """Integration tests using mongomock for process_untagged_posts()."""

    def test_processes_untagged_posts(self, mongo_collection):
        mongo_collection.insert_many([
            {"id": "1", "title": "$TSLA moon", "text": ""},
            {"id": "2", "title": "random post", "text": "no tickers here"},
        ])
        count = process_untagged_posts(mongo_collection)
        assert count == 2
        # Both posts should now have tickers_mentioned
        assert mongo_collection.count_documents(
            {"tickers_mentioned": {"$exists": True}}
        ) == 2

    def test_skips_already_tagged(self, mongo_collection):
        mongo_collection.insert_many([
            {"id": "1", "title": "$TSLA", "text": "", "tickers_mentioned": ["TSLA"]},
            {"id": "2", "title": "$AAPL", "text": ""},
        ])
        count = process_untagged_posts(mongo_collection)
        assert count == 1  # only the untagged post

    def test_empty_list_for_no_tickers(self, mongo_collection):
        mongo_collection.insert_one(
            {"id": "1", "title": "just vibes", "text": "no stocks here"}
        )
        process_untagged_posts(mongo_collection)
        doc = mongo_collection.find_one({"id": "1"})
        assert doc["tickers_mentioned"] == []

    def test_correct_tickers_extracted(self, mongo_collection):
        mongo_collection.insert_one(
            {"id": "1", "title": "$TSLA and $AAPL", "text": ""}
        )
        process_untagged_posts(mongo_collection)
        doc = mongo_collection.find_one({"id": "1"})
        assert "TSLA" in doc["tickers_mentioned"]
        assert "AAPL" in doc["tickers_mentioned"]

    def test_returns_correct_count(self, mongo_collection):
        mongo_collection.insert_many([
            {"id": str(i), "title": f"post {i}", "text": ""}
            for i in range(5)
        ])
        assert process_untagged_posts(mongo_collection) == 5

    def test_idempotent(self, mongo_collection):
        mongo_collection.insert_one(
            {"id": "1", "title": "$TSLA", "text": ""}
        )
        assert process_untagged_posts(mongo_collection) == 1
        assert process_untagged_posts(mongo_collection) == 0  # second run: nothing


# ═══════════════════════════════════════════════════════════════════════════
# TestRealWorldExamples — patterns from actual posts
# ═══════════════════════════════════════════════════════════════════════════

class TestRealWorldExamples:
    """Tests modeled on real Reddit/Bluesky post patterns."""

    def test_campbells_parenthesized(self):
        result = extract_tickers(
            "Huge Campbells (CPB) surge today", "", TEST_TICKERS,
        )
        assert result == ["CPB"]

    def test_rddt_cashtag(self):
        result = extract_tickers("$RDDT ticker", "", TEST_TICKERS)
        assert result == ["RDDT"]

    def test_sentiment_cashtag(self):
        result = extract_tickers(
            "Sentiment isn't scored for $TSLA yet", "", TEST_TICKERS,
        )
        assert result == ["TSLA"]

    def test_colon_format(self):
        result = extract_tickers(
            "TSLA: Elon Musk Drops Bombshell", "", TEST_TICKERS,
        )
        assert result == ["TSLA"]

    def test_multiple_formats_mixed(self):
        result = extract_tickers(
            "$AAPL surging! NVDA also up", "Check out (AMD) too", TEST_TICKERS,
        )
        assert result == ["AAPL", "AMD", "NVDA"]

    def test_wsb_style_post(self):
        result = extract_tickers(
            "GME 🚀🚀🚀 to the moon!!!",
            "bought 100 shares of GME and some $AMC calls",
            TEST_TICKERS,
        )
        assert result == ["AMC", "GME"]

    def test_dd_post_multiple_tickers(self):
        result = extract_tickers(
            "Why PLTR is the next big thing",
            "Comparing PLTR to $SOFI and $COIN. All three are solid.",
            TEST_TICKERS,
        )
        assert result == ["COIN", "PLTR", "SOFI"]
