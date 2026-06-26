#include "models/NewsArticle.h"
#include <sstream>
#include <iomanip>
#include <functional>
#include <algorithm>
#include <regex>
#include <set>
#include <unordered_set>

NewsArticle::NewsArticle()
    : publish_date(0), fetched_date(0) {}

std::string NewsArticle::extractTickers(const std::string& text) {
    // Common words that look like tickers but aren't
    static const std::unordered_set<std::string> BLOCKLIST = {
        "A", "I", "IT", "US", "UK", "EU", "UN", "BY", "TO", "OF", "IN",
        "ON", "NO", "OR", "AN", "AS", "AT", "BE", "IF", "IS", "AM", "PM",
        "CEO", "CFO", "CTO", "COO", "CMO", "CIO", "IPO", "FDA", "SEC",
        "NYSE", "NASDAQ", "AMEX", "OTC", "ETF", "REIT", "MLP", "SPAC",
        "GDP", "CPI", "PPI", "PCE", "FED", "ECB", "IMF", "WTO", "WHO",
        "ESG", "EPS", "EV", "AR", "VR", "AI", "ML", "VC", "PE", "MA",
        "PR", "RE", "DC", "NY", "CA", "TX", "FL", "OH", "IL",
        "INC", "LLC", "LTD", "CORP", "CO", "PLC",
        "FY", "Q1", "Q2", "Q3", "Q4", "YOY", "QOQ", "YTD",
        "FOR", "AND", "THE", "NEW", "ALL", "NOT", "BUT", "ARE",
        "DOW", "G7", "G20", "ATH", "ATL", "USD", "EUR", "GBP", "JPY",
    };

    std::vector<std::string> tickers;
    std::set<std::string> seen;

    auto addTicker = [&](const std::string& t) {
        if (t.length() < 2 || t.length() > 5) return;
        if (seen.count(t) || BLOCKLIST.count(t)) return;
        seen.insert(t);
        tickers.push_back(t);
    };

    // Pattern 1: exchange-qualified — most reliable: (NYSE: TSLA), (NASDAQ: AAPL)
    static const std::regex exchange_re(
        R"(\((NASDAQ|NYSE|NYSEMKT|NYSEARCA|AMEX|OTC|OTCMKTS|TSX):\s*([A-Z]{1,5})\))");
    auto it = std::sregex_iterator(text.begin(), text.end(), exchange_re);
    for (; it != std::sregex_iterator(); ++it) {
        addTicker((*it)[2].str());
    }

    // Pattern 2: $TICKER prefix — common in financial social media and some wire services
    static const std::regex dollar_re(R"(\$([A-Z]{1,5})\b)");
    it = std::sregex_iterator(text.begin(), text.end(), dollar_re);
    for (; it != std::sregex_iterator(); ++it) {
        addTicker((*it)[1].str());
    }

    // Pattern 3: bare parenthesized 2-5 uppercase letters — e.g., (TSLA)
    // Only match when NOT preceded by a colon (which would be caught by exchange_re already)
    static const std::regex paren_re(R"(\(([A-Z]{2,5})\))");
    it = std::sregex_iterator(text.begin(), text.end(), paren_re);
    for (; it != std::sregex_iterator(); ++it) {
        // Skip if match is right after ": " — that's the exchange pattern already handled
        std::string m = (*it)[0].str();
        std::string ticker_str = (*it)[1].str();
        // Check position in string to avoid double-counting exchange-qualified ones
        auto pos = it->position();
        if (pos >= 2 && text[pos - 2] == ':') continue;
        addTicker(ticker_str);
    }

    std::string result;
    for (size_t i = 0; i < tickers.size(); ++i) {
        if (i > 0) result += ',';
        result += tickers[i];
    }
    return result;
}

std::string NewsArticle::generateId(const std::string& url) {
    // Use std::hash for a simple, consistent hash of the URL
    // Then format as hex string for readability
    std::hash<std::string> hasher;
    size_t hash1 = hasher(url);
    size_t hash2 = hasher(url + "_salt");

    std::ostringstream oss;
    oss << std::hex << std::setfill('0')
        << std::setw(16) << hash1
        << std::setw(16) << hash2;
    return oss.str();
}

nlohmann::json NewsArticle::toJSON() const {
    return nlohmann::json{
        {"id", id},
        {"title", title},
        {"content", content},
        {"url", url},
        {"source", source},
        {"category", category},
        {"ticker", ticker},
        {"publish_date", publish_date},
        {"fetched_date", fetched_date}
    };
}

NewsArticle NewsArticle::fromJSON(const nlohmann::json& j) {
    NewsArticle article;
    if (j.contains("id")) article.id = j["id"].get<std::string>();
    if (j.contains("title")) article.title = j["title"].get<std::string>();
    if (j.contains("content")) article.content = j["content"].get<std::string>();
    if (j.contains("url")) article.url = j["url"].get<std::string>();
    if (j.contains("source")) article.source = j["source"].get<std::string>();
    if (j.contains("category")) article.category = j["category"].get<std::string>();
    if (j.contains("ticker")) article.ticker = j["ticker"].get<std::string>();
    if (j.contains("publish_date")) article.publish_date = j["publish_date"].get<time_t>();
    if (j.contains("fetched_date")) article.fetched_date = j["fetched_date"].get<time_t>();
    return article;
}

bool NewsArticle::isValid() const {
    if (title.empty()) return false;
    if (url.empty()) return false;
    // Basic URL validation: must start with http:// or https://
    if (url.find("http://") != 0 && url.find("https://") != 0) return false;
    return true;
}

std::string NewsArticle::toString() const {
    std::ostringstream oss;

    // Format publish date
    std::string dateStr = "Unknown";
    if (publish_date > 0) {
        struct tm* tm_info = localtime(&publish_date);
        char buf[64];
        strftime(buf, sizeof(buf), "%Y-%m-%d %H:%M", tm_info);
        dateStr = buf;
    }

    oss << "[" << dateStr << "] "
        << title << "\n"
        << "  Source: " << source;
    if (!category.empty()) {
        oss << " | Category: " << category;
    }
    if (!ticker.empty()) {
        oss << " | Tickers: " << ticker;
    }
    oss << "\n  URL: " << url;

    if (!content.empty()) {
        // Show first 200 chars of content
        std::string preview = content.substr(0, 200);
        // Replace newlines with spaces for display
        std::replace(preview.begin(), preview.end(), '\n', ' ');
        if (content.size() > 200) preview += "...";
        oss << "\n  " << preview;
    }

    return oss.str();
}
