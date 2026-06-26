#pragma once
#include <string>
#include <ctime>
#include <nlohmann/json.hpp>

class NewsArticle {
public:
    std::string id;           // SHA256-style hash of URL for unique identification
    std::string title;        // Article headline
    std::string content;      // Full article content or summary
    std::string url;          // Original article URL
    std::string source;       // Source name (e.g., "Google Alerts - AI News")
    std::string category;     // Category tag (e.g., "technology", "finance")
    std::string ticker;       // Comma-separated stock tickers found in headline/content (e.g., "AAPL,TSLA")
    std::string sentiment;    // "bullish" | "bearish" | "neutral" (set at fetch time)
    time_t publish_date;      // When article was published
    time_t fetched_date;      // When we fetched it

    NewsArticle();

    // Extract stock ticker symbols from text using common patterns:
    // (NYSE: TSLA), (NASDAQ: AAPL), $TSLA, (TSLA)
    static std::string extractTickers(const std::string& text);

    // Generate unique ID from URL using a simple hash
    static std::string generateId(const std::string& url);

    // JSON serialization
    nlohmann::json toJSON() const;
    static NewsArticle fromJSON(const nlohmann::json& j);

    // Validation
    bool isValid() const;

    // Display
    std::string toString() const;
};
