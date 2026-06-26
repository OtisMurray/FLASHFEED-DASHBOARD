#pragma once
#include <string>
#include <vector>
#include <unordered_set>

// Fast headline keyword filter using a pre-built lowercase dictionary.
// Matching is O(k * title_len) where k is the number of keywords (~25).
// For short headlines this is sub-microsecond.
class KeywordFilter {
public:
    enum class Mode {
        HEADLINE_ONLY,   // Only check article title (default, fastest)
        HEADLINE_CONTENT // Check title + content
    };

    KeywordFilter() = default;

    // Load keywords; stored lowercase for case-insensitive matching.
    void setKeywords(const std::vector<std::string>& keywords);

    // Set matching mode.
    void setMode(Mode mode);

    // Returns true if the article passes the filter (should be kept).
    // When filter is disabled (no keywords), every article passes.
    bool passes(const std::string& title, const std::string& content = "") const;

    bool isEnabled() const { return !keywords_.empty(); }
    size_t size()    const { return keywords_.size(); }

private:
    std::vector<std::string> keywords_;  // lowercase, sorted shortest-first for early exit
    Mode mode_ = Mode::HEADLINE_ONLY;

    static std::string toLower(const std::string& s);
    bool matchesText(const std::string& lowerText) const;
};
