#pragma once
#include "sources/NewsSource.h"
#include "utils/IHttpClient.h"
#include <memory>
#include <string>
#include <chrono>

/**
 * SchwabSource — fetches market news from the Charles Schwab Developer API.
 *
 * This replaces the TD Ameritrade API after the 2020 Schwab acquisition.
 *
 * Prerequisites:
 *   1. Create an app at https://developer.schwab.com/
 *   2. Note your App Key (client_id) and App Secret (client_secret)
 *   3. Complete the OAuth2 Authorization Code flow once in a browser to
 *      obtain a refresh_token.  The refresh token is valid for 7 days;
 *      after it expires you must re-authorise.
 *   4. Set credentials in config.json under "schwab".
 *
 * OAuth2 token endpoint: POST https://api.schwabapi.com/v1/oauth/token
 * Market data base URL:  https://api.schwabapi.com/marketdata/v1/
 *
 * The Schwab public Market Data API focuses on quotes, price history, and
 * option chains.  News headlines are not part of the standard public REST
 * API; instead they are available via the Schwab Streamer (WebSocket).
 * This source class uses the REST API where possible and falls back to
 * fetching Schwab's public market news page when no REST news endpoint is
 * configured.
 *
 * To use a custom news endpoint (if Schwab exposes one on your account
 * tier), set "news_endpoint" in the config to the full path, e.g.:
 *   "/marketdata/v1/news?symbols=AAPL,TSLA&count=50"
 */

struct SchwabConfig {
    std::string clientId;       // App Key from developer.schwab.com
    std::string clientSecret;   // App Secret
    std::string refreshToken;   // Long-lived refresh token (renew every 7 days)
    std::string newsEndpoint;   // Optional custom REST endpoint for news
    int         fetchLimit;

    SchwabConfig()
        : clientId("")
        , clientSecret("")
        , refreshToken("")
        , newsEndpoint("")
        , fetchLimit(50)
    {}
};

class SchwabSource : public NewsSource {
private:
    SchwabConfig config_;
    std::shared_ptr<IHttpClient> httpClient_;

    std::string accessToken_;
    std::chrono::steady_clock::time_point tokenExpiry_;

    static const std::string API_BASE;
    static const std::string TOKEN_URL;

    // Exchange refresh token for a new access token
    bool refreshAccessToken();

    // Make an authenticated GET to the Schwab API
    std::string apiGet(const std::string& path);

    // Base64-encode a string (for Basic auth header)
    static std::string base64Encode(const std::string& input);

public:
    SchwabSource(const SchwabConfig& config,
                 std::shared_ptr<IHttpClient> httpClient,
                 const std::string& category = "markets");

    std::vector<NewsArticle> fetch() override;
};
