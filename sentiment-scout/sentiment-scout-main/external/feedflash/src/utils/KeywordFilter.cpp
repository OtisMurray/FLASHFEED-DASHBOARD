#include "utils/KeywordFilter.h"
#include <algorithm>
#include <cctype>

void KeywordFilter::setKeywords(const std::vector<std::string>& keywords) {
    keywords_.clear();
    keywords_.reserve(keywords.size());
    for (const auto& kw : keywords) {
        if (!kw.empty()) {
            keywords_.push_back(toLower(kw));
        }
    }
    // Sort shortest-first: shorter keywords hit sooner on average → early exit
    std::sort(keywords_.begin(), keywords_.end(),
              [](const std::string& a, const std::string& b) {
                  return a.size() < b.size();
              });
}

void KeywordFilter::setMode(Mode mode) {
    mode_ = mode;
}

bool KeywordFilter::passes(const std::string& title, const std::string& content) const {
    if (keywords_.empty()) return true;  // filter disabled → let everything through

    std::string lowerTitle = toLower(title);
    if (matchesText(lowerTitle)) return true;

    if (mode_ == Mode::HEADLINE_CONTENT && !content.empty()) {
        std::string lowerContent = toLower(content);
        if (matchesText(lowerContent)) return true;
    }

    return false;
}

bool KeywordFilter::matchesText(const std::string& lowerText) const {
    for (const auto& kw : keywords_) {
        if (lowerText.find(kw) != std::string::npos) {
            return true;  // early exit on first match
        }
    }
    return false;
}

std::string KeywordFilter::toLower(const std::string& s) {
    std::string out;
    out.reserve(s.size());
    for (unsigned char c : s) {
        out.push_back(static_cast<char>(std::tolower(c)));
    }
    return out;
}
