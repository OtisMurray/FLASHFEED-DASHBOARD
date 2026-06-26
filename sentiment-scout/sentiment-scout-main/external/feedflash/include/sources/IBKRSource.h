#pragma once
#include "sources/NewsSource.h"
#include "utils/IHttpClient.h"
#include <memory>
#include <string>

/**
 * IBKRSource — fetches news from the Interactive Brokers Client Portal Gateway.
 *
 * Prerequisites:
 *   1. Download the IBKR Client Portal Gateway:
 *      https://www.interactivebrokers.com/en/trading/ib-api.php
 *   2. Start the gateway:
 *      java -jar root/dist/ibgroup.web.api.ibcwebapi.latest.jar root/conf.yaml
 *   3. Authenticate by visiting https://localhost:5000 in your browser.
 *   4. Enable in config.json:  "ibkr": { "enabled": true }
 *
 * The gateway runs on localhost and uses a self-signed SSL certificate.
 * SSL verification is therefore disabled for these requests.
 *
 * Key IBKR news source codes:
 *   BZ  = Benzinga        DJ  = Dow Jones
 *   BRFUPDN = Briefing    DJNL = Dow Jones Newsletters
 *   Reuters, AP, etc. can be discovered via /v1/api/iserver/news/sources
 */

struct IBKRConfig {
    std::string gatewayUrl;      // e.g. "https://localhost:5000"
    std::string newsFilters;     // comma-separated source codes, e.g. "BZ,DJ"
    int         fetchLimit;      // max headlines per poll
    bool        fetchBody;       // whether to fetch full article body (slower)

    IBKRConfig()
        : gatewayUrl("https://localhost:5000")
        , newsFilters("")        // empty = all available sources
        , fetchLimit(50)
        , fetchBody(false)
    {}
};

class IBKRSource : public NewsSource {
private:
    IBKRConfig config_;

    // Raw libcurl GET to gateway (SSL verification disabled for localhost)
    std::string gatewayGet(const std::string& path);

    // Keep the CP API session alive
    void tickle();

    // Fetch full article body for a headline
    std::string fetchBody(const std::string& articleId, const std::string& source);

public:
    IBKRSource(const IBKRConfig& config, const std::string& category = "markets");

    std::vector<NewsArticle> fetch() override;
};
