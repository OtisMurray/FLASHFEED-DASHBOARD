#pragma once
#include "sources/NewsSource.h"
#include "utils/IHttpClient.h"
#include <memory>
#include <string>

/**
 * TradingViewSource — fetches news from TradingView's internal headlines API.
 *
 * Endpoint: https://news-headlines.tradingview.com/v2/headlines/
 * Returns JSON — no login required, but needs TLS fingerprint impersonation
 * to bypass Cloudflare (enable curl-impersonate in config.json).
 *
 * Optional: filter by ticker symbol to get symbol-specific news.
 *
 * Enable in config.json:
 *   "tradingview": {
 *     "enabled": true,
 *     "symbol": "",          // leave empty for general market news
 *     "fetch_limit": 50      // max headlines per fetch
 *   }
 */

struct TradingViewConfig {
    std::string symbol;     // e.g. "NASDAQ:AAPL" — empty = all market news
    int         fetchLimit; // max items per request

    TradingViewConfig()
        : symbol("")
        , fetchLimit(50)
    {}
};

class TradingViewSource : public NewsSource {
public:
    TradingViewSource(const TradingViewConfig& config,
                      std::shared_ptr<IHttpClient> httpClient,
                      const std::string& category = "markets");

    std::vector<NewsArticle> fetch() override;

private:
    TradingViewConfig          config_;
    std::shared_ptr<IHttpClient> httpClient_;

    // Parse the JSON response from the headlines API
    std::vector<NewsArticle> parseJson(const std::string& json);
};
