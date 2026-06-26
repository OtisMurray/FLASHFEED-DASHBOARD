#pragma once
#include <string>

// Fast dictionary-based headline sentiment classifier.
// Scores bullish/bearish/neutral using two sorted keyword sets.
// Per-headline cost: O(b+s) substring scans on a lowercased title (~150 chars).
// Typical throughput: millions of headlines/sec.
class SentimentClassifier {
public:
    enum class Label { BULLISH, BEARISH, NEUTRAL };

    // Score a headline (+ optional snippet). Returns BULLISH, BEARISH, or NEUTRAL.
    static Label classify(const std::string& title, const std::string& content = "");

    // String form used for DB storage.
    static const char* toString(Label l);
};
