"""Tests for D5: Sentiment Scoring Engine."""

import mongomock
import pytest

from processing.sentiment_engine import count_signals, score_sentiment, process_unscored_posts


# ---------------------------------------------------------------------------
# TestCountSignals
# ---------------------------------------------------------------------------

class TestCountSignals:
    def test_bullish_phrase(self):
        bull, bear, count = count_signals("This is going to the moon!")
        assert bull > 0
        assert bear == 0
        assert count >= 1

    def test_bearish_phrase(self):
        bull, bear, count = count_signals("dead cat bounce incoming")
        assert bear > 0
        assert bull == 0 or bull < bear
        assert count >= 1

    def test_emoji_signal(self):
        bull, bear, count = count_signals("🚀🚀🚀")
        assert bull > 0
        assert count >= 1

    def test_no_signals(self):
        bull, bear, count = count_signals("The weather is nice today")
        assert bull == 0
        assert bear == 0
        assert count == 0

    def test_mixed_signals(self):
        bull, bear, count = count_signals("I'm bullish but could crash")
        assert bull > 0
        assert bear > 0
        assert count >= 2

    def test_case_insensitive(self):
        bull1, _, _ = count_signals("BULLISH on this")
        bull2, _, _ = count_signals("bullish on this")
        assert bull1 == bull2

    def test_word_boundary(self):
        """'sell' should not match inside 'selling' twice — word boundary."""
        _, bear_sell, count_sell = count_signals("I sell now")
        assert bear_sell > 0
        # 'selling' is its own entry, not matched by 'sell' pattern
        _, bear_selling, count_selling = count_signals("selling pressure")
        assert bear_selling > 0

    def test_empty_text(self):
        bull, bear, count = count_signals("")
        assert bull == 0
        assert bear == 0
        assert count == 0


# ---------------------------------------------------------------------------
# TestScoreSentiment
# ---------------------------------------------------------------------------

class TestScoreSentiment:
    def test_strong_bullish(self):
        result = score_sentiment("To the moon! 🚀🚀 Diamond hands!", "")
        assert result["sentiment_score"] > 0.5
        assert result["sentiment_method"] in ("rule_based", "rule_based+vader")
        assert result["sentiment_signals"] >= 3

    def test_strong_bearish(self):
        result = score_sentiment("Crash incoming, rug pull", "going to zero 📉")
        assert result["sentiment_score"] < -0.5
        assert result["sentiment_signals"] >= 3

    def test_neutral_vader_fallback(self):
        """Neutral text with no lexicon matches gets a VADER-based score."""
        result = score_sentiment("The weather is nice", "Nothing about stocks")
        # VADER may assign a small non-zero score; method should be vader_fallback
        assert result["sentiment_method"] == "vader_fallback"
        assert result["sentiment_signals"] == 0
        # Score should be close to 0 but may not be exactly 0
        assert -0.5 <= result["sentiment_score"] <= 0.5

    def test_score_in_range(self):
        """Score must always be in [-1.0, +1.0]."""
        # Extremely bullish
        result = score_sentiment(
            "TO THE MOON 🚀🚀🚀 diamond hands tendies",
            "buy the dip bullish easy money moon mission",
        )
        assert -1.0 <= result["sentiment_score"] <= 1.0

        # Extremely bearish
        result = score_sentiment(
            "CRASH 📉📉📉 rug pull dead cat bounce",
            "going to zero sell everything bearish",
        )
        assert -1.0 <= result["sentiment_score"] <= 1.0

    def test_empty_text(self):
        result = score_sentiment("", "")
        assert result["sentiment_score"] == 0.0
        assert result["sentiment_signals"] == 0
        assert result["sentiment_method"] == "vader_fallback"

    def test_vader_fallback_positive(self):
        """Text with positive general sentiment but no lexicon terms uses VADER."""
        result = score_sentiment("This company is doing really great amazing work", "")
        assert result["sentiment_method"] == "vader_fallback"
        assert result["sentiment_score"] > 0

    def test_blended_score(self):
        """1-2 lexicon signals blend with VADER."""
        result = score_sentiment("bullish", "this stock looks promising")
        assert result["sentiment_method"] == "rule_based+vader"
        assert result["sentiment_signals"] in (1, 2)
        assert result["sentiment_score"] > 0

    def test_mixed_returns_nonzero(self):
        result = score_sentiment("Buy calls", "but also puts")
        assert result["sentiment_score"] != 0.0 or result["sentiment_signals"] >= 2


# ---------------------------------------------------------------------------
# TestProcessUnscoredPosts
# ---------------------------------------------------------------------------

class TestProcessUnscoredPosts:
    @pytest.fixture()
    def collection(self):
        client = mongomock.MongoClient()
        return client["ds440_test"]["posts"]

    def test_scores_posts(self, collection):
        collection.insert_many([
            {"_id": "p1", "title": "TSLA to the moon 🚀", "text": ""},
            {"_id": "p2", "title": "Market crash incoming", "text": "📉"},
        ])
        count = process_unscored_posts(collection)
        assert count == 2

        p1 = collection.find_one({"_id": "p1"})
        assert p1["sentiment_score"] > 0
        assert p1["sentiment_method"] == "rule_based"
        assert p1["sentiment_signals"] >= 1

    def test_skips_scored(self, collection):
        collection.insert_many([
            {"_id": "p1", "title": "test", "text": "",
             "sentiment_score": 0.5, "sentiment_method": "rule_based",
             "sentiment_signals": 1},
            {"_id": "p2", "title": "Bullish!", "text": ""},
        ])
        count = process_unscored_posts(collection)
        assert count == 1

    def test_idempotent(self, collection):
        collection.insert_one({"_id": "p1", "title": "buy buy buy", "text": ""})
        process_unscored_posts(collection)
        count = process_unscored_posts(collection)
        assert count == 0

    def test_sets_all_fields(self, collection):
        collection.insert_one({"_id": "p1", "title": "test", "text": ""})
        process_unscored_posts(collection)

        post = collection.find_one({"_id": "p1"})
        assert "sentiment_score" in post
        assert "sentiment_method" in post
        assert "sentiment_signals" in post

    def test_correct_count(self, collection):
        collection.insert_many([
            {"_id": f"p{i}", "title": f"post {i}", "text": ""}
            for i in range(10)
        ])
        count = process_unscored_posts(collection)
        assert count == 10


# ---------------------------------------------------------------------------
# TestRealWorldExamples
# ---------------------------------------------------------------------------

class TestRealWorldExamples:
    def test_wsb_bullish(self):
        result = score_sentiment(
            "GME to the moon 🚀🚀🚀 diamond hands baby",
            "bought more calls, tendies incoming. HODL!",
        )
        assert result["sentiment_score"] > 0.5
        assert result["sentiment_signals"] >= 5

    def test_bearish_puts(self):
        result = score_sentiment(
            "SPY puts printing, crash incoming",
            "sell everything before it tanks 📉",
        )
        assert result["sentiment_score"] < -0.3

    def test_neutral_headline(self):
        result = score_sentiment(
            "AAPL earnings report tomorrow",
            "What do you think the numbers will be?",
        )
        # May pick up minor signals but should be close to neutral
        assert -0.3 <= result["sentiment_score"] <= 0.3

    def test_emoji_heavy(self):
        result = score_sentiment(
            "🚀🚀🚀🔥🔥💎💎",
            "🐂🐂📈📈📈",
        )
        assert result["sentiment_score"] > 0.5
        assert result["sentiment_signals"] >= 5
