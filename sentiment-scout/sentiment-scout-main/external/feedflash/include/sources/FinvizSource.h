#pragma once
#include "sources/NewsSource.h"
#include "utils/IHttpClient.h"
#include <memory>
#include <string>

/**
 * FinvizSource — scrapes the Finviz news page using Curl Impersonate
 * to bypass Cloudflare protection.
 *
 * Free tier:  https://finviz.com/news.ashx          (~1 min refresh latency)
 * Elite tier: https://elite.finviz.com/news.ashx    (10-second refresh)
 *
 * The news table contains: time, headline, source URL.
 * All found stock tickers are extracted automatically.
 *
 * Enable in config.json:
 *   "finviz": {
 *     "enabled": true,
 *     "elite": false,
 *     "email": "",
 *     "password": ""
 *   }
 * If elite = true, you must supply valid credentials so the scraper
 * can authenticate before fetching.
 */

struct FinvizConfig {
    bool        elite;      // Use elite.finviz.com (requires login)
    std::string email;      // Elite login email
    std::string password;   // Elite login password

    FinvizConfig()
        : elite(false)
        , email("")
        , password("")
    {}
};

class FinvizSource : public NewsSource {
private:
    FinvizConfig config_;
    std::shared_ptr<IHttpClient> httpClient_;

    // Parse the Finviz news HTML table and return articles
    std::vector<NewsArticle> parseNewsHtml(const std::string& html);

    // Convert a Finviz time string to time_t
    // Formats: "09:30AM"  or  "Dec-31-24"
    static time_t parseFinvizTime(const std::string& timeStr);

    // URL-decode a string
    static std::string urlDecode(const std::string& s);

    // Strip HTML tags from a short snippet
    static std::string stripTags(const std::string& s);

public:
    FinvizSource(const FinvizConfig& config,
                 std::shared_ptr<IHttpClient> httpClient,
                 const std::string& category = "markets");

    std::vector<NewsArticle> fetch() override;
};
