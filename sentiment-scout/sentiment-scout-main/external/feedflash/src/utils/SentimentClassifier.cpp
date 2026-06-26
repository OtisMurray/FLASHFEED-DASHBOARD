#include "utils/SentimentClassifier.h"
#include <algorithm>
#include <cctype>

// ── Dictionaries ──────────────────────────────────────────────────────────────
// Keep entries lowercase. Sorted shortest-first for early exit.

static const char* BULLISH[] = {
    // 2-4 char
    "ipo", "beat", "deal", "gain", "hire", "rose", "grew", "soar",
    // 5-7 char
    "beats", "surge", "rally", "jumps", "rises", "buyback", "record",
    "profit", "growth", "strong", "raised", "expand", "upgrade", "dividend",
    "approved", "approval", "acquire", "exceeds", "outperform", "breakout",
    // 8+ char
    "earnings beat", "revenue beat", "guidance raised", "guidance raise",
    "raises guidance", "stock split", "share buyback", "record revenue",
    "record profit", "partnership", "new contract", "wins contract",
};
static const int N_BULLISH = sizeof(BULLISH) / sizeof(BULLISH[0]);

static const char* BEARISH[] = {
    // 2-4 char
    "miss", "loss", "drop", "halt", "fine", "sued", "fell", "sank",
    // 5-7 char
    "misses", "recall", "layoff", "layoffs", "plunge", "tumble", "slides",
    "declines", "warning", "cutback", "deficit", "downgrade", "shortfall",
    "bankrupt", "subpoena", "probe", "fraud", "penalty", "suspend",
    // 8+ char
    "earnings miss", "revenue miss", "guidance cut", "cuts guidance",
    "lowers guidance", "misses estimates", "below expectations",
    "investigation", "class action", "bankruptcy", "restructuring",
    "workforce reduction", "job cuts", "revenue decline", "profit warning",
};
static const int N_BEARISH = sizeof(BEARISH) / sizeof(BEARISH[0]);

// ── Helpers ───────────────────────────────────────────────────────────────────

static std::string toLower(const std::string& s) {
    std::string out;
    out.reserve(s.size());
    for (unsigned char c : s) out.push_back(static_cast<char>(std::tolower(c)));
    return out;
}

static int countHits(const std::string& lowerText, const char** dict, int n) {
    int hits = 0;
    for (int i = 0; i < n; ++i) {
        if (lowerText.find(dict[i]) != std::string::npos) ++hits;
    }
    return hits;
}

// ── Public API ────────────────────────────────────────────────────────────────

SentimentClassifier::Label SentimentClassifier::classify(
    const std::string& title, const std::string& content)
{
    // Score headline (weighted 2×) + first 300 chars of content (1×)
    std::string lowerTitle = toLower(title);
    int bull = countHits(lowerTitle, BULLISH, N_BULLISH) * 2;
    int bear = countHits(lowerTitle, BEARISH, N_BEARISH) * 2;

    if (!content.empty()) {
        std::string snippet = toLower(content.substr(0, 300));
        bull += countHits(snippet, BULLISH, N_BULLISH);
        bear += countHits(snippet, BEARISH, N_BEARISH);
    }

    if (bull == bear) return Label::NEUTRAL;
    return bull > bear ? Label::BULLISH : Label::BEARISH;
}

const char* SentimentClassifier::toString(Label l) {
    switch (l) {
        case Label::BULLISH: return "bullish";
        case Label::BEARISH: return "bearish";
        default:             return "neutral";
    }
}
