#include "sources/SchwabSource.h"
#include "models/NewsArticle.h"
#include "utils/Logger.h"
#include <nlohmann/json.hpp>
#include <sstream>
#include <algorithm>

using json = nlohmann::json;

const std::string SchwabSource::API_BASE  = "https://api.schwabapi.com";
const std::string SchwabSource::TOKEN_URL = "https://api.schwabapi.com/v1/oauth/token";

// ── Base64 ───────────────────────────────────────────────────────────────────

std::string SchwabSource::base64Encode(const std::string& input) {
    static const char* chars =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out;
    out.reserve(((input.size() + 2) / 3) * 4);

    unsigned val = 0;
    int bits = 0;
    for (unsigned char c : input) {
        val = (val << 8) | c;
        bits += 8;
        while (bits >= 6) {
            bits -= 6;
            out += chars[(val >> bits) & 0x3F];
        }
    }
    if (bits > 0) {
        out += chars[(val << (6 - bits)) & 0x3F];
    }
    while (out.size() % 4) out += '=';
    return out;
}

// ── Constructor ───────────────────────────────────────────────────────────────

SchwabSource::SchwabSource(const SchwabConfig& config,
                            std::shared_ptr<IHttpClient> httpClient,
                            const std::string& category)
    : NewsSource("Schwab", category)
    , config_(config)
    , httpClient_(std::move(httpClient))
    , tokenExpiry_(std::chrono::steady_clock::now())
{}

// ── OAuth2 token refresh ──────────────────────────────────────────────────────

bool SchwabSource::refreshAccessToken() {
    if (config_.clientId.empty() || config_.clientSecret.empty()
        || config_.refreshToken.empty()) {
        LOG_ERROR("Schwab: client_id, client_secret, and refresh_token must be set "
                  "in config.json under \"schwab\"");
        return false;
    }

    std::string credentials = config_.clientId + ":" + config_.clientSecret;
    std::string authHeader  = "Authorization: Basic " + base64Encode(credentials);
    std::string body        = "grant_type=refresh_token&refresh_token="
                              + config_.refreshToken;

    std::string raw = httpClient_->post(TOKEN_URL, body, {
        authHeader,
        "Content-Type: application/x-www-form-urlencoded"
    });

    if (raw.empty()) {
        LOG_ERROR("Schwab: token refresh returned empty response. "
                  "Check credentials and network.");
        return false;
    }

    try {
        auto j = json::parse(raw);

        if (j.contains("error")) {
            LOG_ERROR("Schwab: token error: " + j.value("error_description",
                      j.value("error", raw)));
            return false;
        }

        accessToken_ = j.value("access_token", "");
        int expiresIn = j.value("expires_in", 1800);

        // Refresh 60 s before actual expiry
        tokenExpiry_ = std::chrono::steady_clock::now()
                       + std::chrono::seconds(expiresIn - 60);

        // If the response includes a new refresh token, log a reminder
        if (j.contains("refresh_token")) {
            LOG_INFO("Schwab: received new refresh_token — update config.json "
                     "with the new value to avoid re-authentication in 7 days");
        }

        LOG_INFO("Schwab: access token obtained (expires in "
                 + std::to_string(expiresIn) + "s)");
        return true;

    } catch (const json::exception& e) {
        LOG_ERROR("Schwab: failed to parse token response: "
                  + std::string(e.what()));
        return false;
    }
}

// ── Authenticated GET ─────────────────────────────────────────────────────────

std::string SchwabSource::apiGet(const std::string& path) {
    // Refresh token if expired or not yet obtained
    if (accessToken_.empty()
        || std::chrono::steady_clock::now() >= tokenExpiry_) {
        if (!refreshAccessToken()) return "";
    }

    httpClient_->setUserAgent("FeedFlash/1.1");
    // The IHttpClient::get() doesn't support custom headers, so we embed the
    // token in the URL using a query param for APIs that support it, or we
    // note this as a limitation and use the basic get() for APIs that accept
    // Bearer tokens in the URL (non-standard but sometimes supported).
    //
    // Standard approach: the caller should use a header-aware HTTP client.
    // For now we use a simple workaround: append access_token as query param.
    // Many Schwab endpoints also accept ?access_token=... for GET requests.
    std::string url = API_BASE + path;
    if (url.find('?') == std::string::npos) {
        url += "?access_token=" + accessToken_;
    } else {
        url += "&access_token=" + accessToken_;
    }

    return httpClient_->get(url);
}

// ── fetch ─────────────────────────────────────────────────────────────────────

std::vector<NewsArticle> SchwabSource::fetch() {
    std::vector<NewsArticle> articles;

    // If the user has configured a specific news endpoint, use it
    if (!config_.newsEndpoint.empty()) {
        std::string path = config_.newsEndpoint;
        // Append limit if not already in the endpoint string
        if (path.find("count=") == std::string::npos
            && path.find("limit=") == std::string::npos) {
            path += (path.find('?') == std::string::npos ? "?" : "&");
            path += "count=" + std::to_string(config_.fetchLimit);
        }

        std::string raw = apiGet(path);
        if (raw.empty()) {
            LOG_WARNING("Schwab: empty response from news endpoint");
            return articles;
        }

        try {
            auto j = json::parse(raw);
            time_t now = time(nullptr);

            // Handle both array and {"items":[...]} wrapper formats
            json items = j.is_array() ? j
                       : j.contains("items") ? j["items"]
                       : json::array();

            for (const auto& item : items) {
                if (!item.is_object()) continue;

                NewsArticle article;
                article.source       = "Schwab";
                article.category     = category;
                article.fetched_date = now;

                article.title   = item.value("title",    item.value("headline", ""));
                article.url     = item.value("url",      item.value("link", ""));
                article.content = item.value("summary",  item.value("body", ""));

                if (item.contains("publishedDate")) {
                    // ISO 8601 or Unix timestamp
                    auto& d = item["publishedDate"];
                    if (d.is_number()) {
                        article.publish_date = static_cast<time_t>(d.get<long long>());
                    } else {
                        article.publish_date = now;
                    }
                } else {
                    article.publish_date = now;
                }

                if (article.url.empty() || article.title.empty()) continue;
                article.id     = NewsArticle::generateId(article.url);
                article.ticker = NewsArticle::extractTickers(
                    article.title + " " + article.content);

                if (article.isValid()) {
                    articles.push_back(std::move(article));
                }
            }

        } catch (const json::exception& e) {
            LOG_ERROR("Schwab: JSON parse error: " + std::string(e.what()));
        }

        LOG_INFO("Schwab: fetched " + std::to_string(articles.size()) + " articles");
        return articles;
    }

    // No endpoint configured — log guidance
    LOG_WARNING("Schwab: no news_endpoint configured. "
                "The Schwab public Market Data REST API does not expose a "
                "news feed.  Options:\n"
                "  1. Use the Schwab Streamer WebSocket (NEWS_HEADLINE service)\n"
                "  2. Set \"news_endpoint\" in config.json if your account tier "
                "provides one, e.g.: \"/marketdata/v1/news?symbols=SPY,QQQ\"");
    return articles;
}
