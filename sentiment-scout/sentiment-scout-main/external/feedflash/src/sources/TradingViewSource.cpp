#include "sources/TradingViewSource.h"
#include "models/NewsArticle.h"
#include "utils/Logger.h"
#include <nlohmann/json.hpp>
#include <sstream>

using json = nlohmann::json;

// ── Constructor ───────────────────────────────────────────────────────────────

TradingViewSource::TradingViewSource(const TradingViewConfig& config,
                                     std::shared_ptr<IHttpClient> httpClient,
                                     const std::string& category)
    : NewsSource("TradingView", category)
    , config_(config)
    , httpClient_(std::move(httpClient))
{}

// ── JSON parsing ──────────────────────────────────────────────────────────────

std::vector<NewsArticle> TradingViewSource::parseJson(const std::string& body) {
    std::vector<NewsArticle> articles;
    if (body.empty()) return articles;

    try {
        json root = json::parse(body);

        // Response shape:
        //   { "items": [ { "id", "title", "published", "source", "urgency", "link",
        //                  "story_path", "provider", "permission", "related_symbols": [...] } ] }
        const json* items = nullptr;
        if (root.contains("items") && root["items"].is_array()) {
            items = &root["items"];
        } else if (root.is_array()) {
            items = &root;
        } else {
            LOG_ERROR("TradingView: unexpected JSON shape — no 'items' array");
            return articles;
        }

        time_t now = time(nullptr);

        for (const auto& item : *items) {
            if (!item.is_object()) continue;

            std::string title = item.value("title", "");
            std::string url   = item.value("link",  "");

            // Fallback URL patterns used by TradingView
            if (url.empty() && item.contains("story_path")) {
                url = "https://www.tradingview.com" + item.value("story_path", "");
            }

            if (title.empty() || url.empty()) continue;

            // published is a Unix timestamp (integer seconds)
            time_t pub = now;
            if (item.contains("published") && item["published"].is_number()) {
                pub = static_cast<time_t>(item["published"].get<long long>());
            }

            // Source name — prefer "provider" over "source" (more descriptive)
            std::string src = item.value("provider", item.value("source", "TradingView"));
            if (src.empty()) src = "TradingView";

            // Extract tickers from related_symbols if present
            std::string tickers = NewsArticle::extractTickers(title);
            if (tickers.empty() && item.contains("related_symbols") && item["related_symbols"].is_array()) {
                std::string joined;
                for (const auto& sym : item["related_symbols"]) {
                    std::string s = sym.is_string() ? sym.get<std::string>()
                                                    : sym.value("symbol", "");
                    // Strip exchange prefix: "NASDAQ:AAPL" -> "AAPL"
                    auto colon = s.rfind(':');
                    if (colon != std::string::npos) s = s.substr(colon + 1);
                    if (!s.empty() && s.size() <= 5) {
                        if (!joined.empty()) joined += ',';
                        joined += s;
                    }
                }
                if (!joined.empty()) tickers = joined;
            }

            NewsArticle article;
            article.id           = NewsArticle::generateId(url);
            article.title        = title;
            article.content      = item.value("description", "");
            article.url          = url;
            article.source       = "TradingView-" + src;
            article.category     = category;
            article.ticker       = tickers;
            article.publish_date = pub;
            article.fetched_date = now;

            if (article.isValid()) {
                articles.push_back(std::move(article));
            }
        }
    } catch (const json::exception& e) {
        LOG_ERROR("TradingView: JSON parse error — " + std::string(e.what()));
    }

    return articles;
}

// ── fetch ─────────────────────────────────────────────────────────────────────

std::vector<NewsArticle> TradingViewSource::fetch() {
    // TradingView's internal news headlines API (no auth required, TLS impersonation needed)
    std::string url = "https://news-headlines.tradingview.com/v2/headlines/"
                      "?client=web&lang=en&streaming=true"
                      "&limit=" + std::to_string(config_.fetchLimit);

    if (!config_.symbol.empty()) {
        // Symbol-specific news, e.g. "NASDAQ:AAPL"
        url += "&symbol=" + config_.symbol;
    }

    // Must look like a Chrome browser to pass TLS fingerprint check
    httpClient_->setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36");

    std::string body = httpClient_->get(url);

    if (body.empty()) {
        LOG_ERROR("TradingView: empty response — enable curl-impersonate in config.json");
        return {};
    }

    if (body.find("Just a moment") != std::string::npos
        || body.find("Checking your browser") != std::string::npos) {
        LOG_ERROR("TradingView: Cloudflare challenge page received");
        return {};
    }

    auto articles = parseJson(body);
    LOG_INFO("TradingView: fetched " + std::to_string(articles.size()) + " articles");
    return articles;
}
