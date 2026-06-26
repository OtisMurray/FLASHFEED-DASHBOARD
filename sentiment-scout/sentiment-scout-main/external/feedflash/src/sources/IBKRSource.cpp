#include "sources/IBKRSource.h"
#include "models/NewsArticle.h"
#include "utils/Logger.h"
#include <nlohmann/json.hpp>
#include <curl/curl.h>
#include <sstream>

using json = nlohmann::json;

// ── helpers ──────────────────────────────────────────────────────────────────

static size_t curlWrite(void* data, size_t sz, size_t nmemb, void* userp) {
    static_cast<std::string*>(userp)->append(static_cast<char*>(data), sz * nmemb);
    return sz * nmemb;
}

IBKRSource::IBKRSource(const IBKRConfig& config, const std::string& category)
    : NewsSource("IBKR", category), config_(config) {}

// Raw libcurl GET to the local gateway with SSL verification disabled
// (gateway uses a self-signed certificate).
std::string IBKRSource::gatewayGet(const std::string& path) {
    CURL* curl = curl_easy_init();
    if (!curl) {
        LOG_ERROR("IBKR: failed to init curl");
        return "";
    }

    std::string url = config_.gatewayUrl + path;
    std::string response;

    curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, curlWrite);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &response);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, 15L);
    curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT, 5L);
    // Gateway uses self-signed cert — disable peer verification for localhost only
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYPEER, 0L);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYHOST, 0L);
    curl_easy_setopt(curl, CURLOPT_USERAGENT, "FeedFlash/1.1");

    CURLcode res = curl_easy_perform(curl);
    long httpCode = 0;
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &httpCode);
    curl_easy_cleanup(curl);

    if (res != CURLE_OK) {
        LOG_ERROR("IBKR gateway request failed: " + std::string(curl_easy_strerror(res)));
        return "";
    }
    if (httpCode == 401) {
        LOG_ERROR("IBKR: not authenticated. Log in at " + config_.gatewayUrl);
        return "";
    }
    if (httpCode >= 400) {
        LOG_WARNING("IBKR: HTTP " + std::to_string(httpCode) + " for " + path);
        return "";
    }
    return response;
}

void IBKRSource::tickle() {
    gatewayGet("/v1/api/tickle");
}

std::string IBKRSource::fetchBody(const std::string& articleId,
                                   const std::string& source) {
    std::string path = "/v1/api/iserver/account/newsarticle?id="
                       + articleId + "&source=" + source;
    std::string raw = gatewayGet(path);
    if (raw.empty()) return "";

    try {
        auto j = json::parse(raw);
        return j.value("body", "");
    } catch (...) {
        return "";
    }
}

// ── fetch ─────────────────────────────────────────────────────────────────────

std::vector<NewsArticle> IBKRSource::fetch() {
    std::vector<NewsArticle> articles;

    // Keep session alive
    tickle();

    // Build query string
    std::string path = "/v1/api/iserver/news/latest?limit="
                       + std::to_string(config_.fetchLimit);
    if (!config_.newsFilters.empty()) {
        path += "&filters=" + config_.newsFilters;
    }

    std::string raw = gatewayGet(path);
    if (raw.empty()) {
        LOG_WARNING("IBKR: empty response from news endpoint");
        return articles;
    }

    json arr;
    try {
        arr = json::parse(raw);
    } catch (const json::exception& e) {
        LOG_ERROR("IBKR: JSON parse error: " + std::string(e.what()));
        return articles;
    }

    if (!arr.is_array()) {
        LOG_WARNING("IBKR: unexpected response format (not an array)");
        return articles;
    }

    time_t now = time(nullptr);

    for (const auto& item : arr) {
        if (!item.is_object()) continue;

        NewsArticle article;

        article.title = item.value("headline", "");
        if (article.title.empty()) continue;

        // IBKR article ID format: "BZ$12345678"
        std::string articleId = item.value("id", "");
        std::string source    = item.value("source", "IBKR");

        article.source   = "IBKR-" + source;
        article.category = category;
        article.url      = item.value("url", "");
        article.fetched_date = now;

        // Date is Unix timestamp in milliseconds
        if (item.contains("date") && item["date"].is_number()) {
            article.publish_date = static_cast<time_t>(
                item["date"].get<long long>() / 1000);
        } else {
            article.publish_date = now;
        }

        // If no URL, construct a placeholder so the article has a unique ID
        if (article.url.empty() && !articleId.empty()) {
            article.url = config_.gatewayUrl + "/news/" + articleId;
        }
        if (article.url.empty()) continue;

        article.id = NewsArticle::generateId(article.url);

        // Optionally fetch full body (extra round-trips)
        if (config_.fetchBody && !articleId.empty() && item.value("hasArticle", false)) {
            article.content = fetchBody(articleId, source);
        }

        article.ticker = NewsArticle::extractTickers(
            article.title + " " + article.content);

        if (article.isValid()) {
            articles.push_back(std::move(article));
        }
    }

    LOG_INFO("IBKR: fetched " + std::to_string(articles.size()) + " articles");
    return articles;
}
