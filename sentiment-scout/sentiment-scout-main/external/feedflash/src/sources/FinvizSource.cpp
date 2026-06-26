#include "sources/FinvizSource.h"
#include "models/NewsArticle.h"
#include "utils/Logger.h"
#include <regex>
#include <sstream>
#include <algorithm>
#include <cctype>
#include <ctime>
#include <cstring>

// ── Constructor ───────────────────────────────────────────────────────────────

FinvizSource::FinvizSource(const FinvizConfig& config,
                            std::shared_ptr<IHttpClient> httpClient,
                            const std::string& category)
    : NewsSource("Finviz", category)
    , config_(config)
    , httpClient_(std::move(httpClient))
{}

// ── Static helpers ─────────────────────────────────────────────────────────────

std::string FinvizSource::urlDecode(const std::string& s) {
    std::string out;
    out.reserve(s.size());
    for (size_t i = 0; i < s.size(); ++i) {
        if (s[i] == '%' && i + 2 < s.size()) {
            int val = std::stoi(s.substr(i + 1, 2), nullptr, 16);
            out += static_cast<char>(val);
            i += 2;
        } else if (s[i] == '+') {
            out += ' ';
        } else {
            out += s[i];
        }
    }
    return out;
}

std::string FinvizSource::stripTags(const std::string& s) {
    std::string out;
    bool inTag = false;
    for (char c : s) {
        if (c == '<') { inTag = true; continue; }
        if (c == '>') { inTag = false; continue; }
        if (!inTag) out += c;
    }
    // Trim
    size_t start = out.find_first_not_of(" \t\r\n");
    size_t end   = out.find_last_not_of(" \t\r\n");
    return (start == std::string::npos) ? "" : out.substr(start, end - start + 1);
}

time_t FinvizSource::parseFinvizTime(const std::string& timeStr) {
    time_t now = time(nullptr);
    struct tm* lt = localtime(&now);

    // Format 1: "09:30AM" or "09:30PM" — time today
    {
        int hour = 0, minute = 0;
        char ampm[4] = {};
        if (sscanf(timeStr.c_str(), "%d:%d%3s", &hour, &minute, ampm) == 3) {
            std::string ap = ampm;
            std::transform(ap.begin(), ap.end(), ap.begin(), ::toupper);
            if (ap == "PM" && hour != 12) hour += 12;
            if (ap == "AM" && hour == 12) hour = 0;
            lt->tm_hour = hour;
            lt->tm_min  = minute;
            lt->tm_sec  = 0;
            time_t t = mktime(lt);
            // If the computed time is in the future (e.g., clock skew), subtract a day
            if (t > now + 60) t -= 86400;
            return t;
        }
    }

    // Format 2: "Dec-31-24" or "Dec-31-2024"
    {
        char mon[8] = {};
        int  day = 0, year = 0;
        if (sscanf(timeStr.c_str(), "%7[A-Za-z]-%d-%d", mon, &day, &year) == 3) {
            static const char* months[] = {
                "Jan","Feb","Mar","Apr","May","Jun",
                "Jul","Aug","Sep","Oct","Nov","Dec"
            };
            for (int m = 0; m < 12; ++m) {
                if (strncasecmp(mon, months[m], 3) == 0) {
                    lt->tm_mon  = m;
                    lt->tm_mday = day;
                    lt->tm_year = (year < 100) ? year + 100 : year - 1900;
                    lt->tm_hour = 0; lt->tm_min = 0; lt->tm_sec = 0;
                    return mktime(lt);
                }
            }
        }
    }

    return now;
}

// ── HTML parsing ──────────────────────────────────────────────────────────────

std::vector<NewsArticle> FinvizSource::parseNewsHtml(const std::string& html) {
    std::vector<NewsArticle> articles;
    if (html.empty()) return articles;

    time_t now      = time(nullptr);
    time_t lastDate = now;  // carry date forward for rows that only show a time

    // Finviz news table rows look like:
    //
    //   <tr class="nn-tab-contents">               (repeated)
    //     <td ...>                                  (date/time cell)
    //       <span class="nn-date">09:30AM</span>
    //     </td>
    //     <td>
    //       <a class="tab-link-news" href="https://..."
    //          target="_blank">Headline Text</a>
    //       <span class="nn-source">Reuters</span>
    //     </td>
    //   </tr>
    //
    // The v=3 streaming page has the same HTML table underneath.

    // Step 1: find the news table section
    static const std::regex rowRe(
        R"rx(<tr[^>]*class="[^"]*nn-tab-row[^"]*"[^>]*>([\s\S]*?)</tr>)rx",
        std::regex::icase);

    // Fallback: capture any <tr> containing an <a class="tab-link-news">
    static const std::regex rowFallback(
        R"rx(<tr[^>]*>([\s\S]*?tab-link-news[\s\S]*?)</tr>)rx",
        std::regex::icase);

    // Patterns for extracting fields from a row
    static const std::regex dateRe(
        R"rx(<(?:td|span)[^>]*class="[^"]*nn-date[^"]*"[^>]*>([\s\S]*?)</(?:td|span)>)rx",
        std::regex::icase);
    static const std::regex linkRe(
        R"rx(<a[^>]*class="[^"]*tab-link-news[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)</a>)rx",
        std::regex::icase);
    static const std::regex sourceRe(
        R"rx(<span[^>]*class="[^"]*nn-source[^"]*"[^>]*>([\s\S]*?)</span>)rx",
        std::regex::icase);

    auto processRows = [&](const std::regex& re) {
        auto it  = std::sregex_iterator(html.begin(), html.end(), re);
        auto end = std::sregex_iterator();
        for (; it != end; ++it) {
            const std::string row = (*it)[1].str();

            // Extract time/date
            std::smatch dm;
            if (std::regex_search(row, dm, dateRe)) {
                std::string ts = stripTags(dm[1].str());
                if (!ts.empty()) {
                    lastDate = parseFinvizTime(ts);
                }
            }

            // Extract headline and URL
            std::smatch lm;
            if (!std::regex_search(row, lm, linkRe)) continue;

            std::string url      = urlDecode(lm[1].str());
            std::string headline = stripTags(lm[2].str());
            if (url.empty() || headline.empty()) continue;

            // Extract source name
            std::string sourceName = "Finviz";
            std::smatch sm;
            if (std::regex_search(row, sm, sourceRe)) {
                std::string s = stripTags(sm[1].str());
                if (!s.empty()) sourceName = s;
            }

            NewsArticle article;
            article.title        = headline;
            article.url          = url;
            article.source       = "Finviz-" + sourceName;
            article.category     = category;
            article.publish_date = lastDate;
            article.fetched_date = now;
            article.id           = NewsArticle::generateId(url);
            article.ticker       = NewsArticle::extractTickers(headline);

            if (article.isValid()) {
                articles.push_back(std::move(article));
            }
        }
    };

    processRows(rowRe);

    // If the primary pattern found nothing, try the broader fallback
    if (articles.empty()) {
        processRows(rowFallback);
    }

    return articles;
}

// ── fetch ─────────────────────────────────────────────────────────────────────

std::vector<NewsArticle> FinvizSource::fetch() {
    std::string baseUrl = config_.elite
        ? "https://elite.finviz.com/news.ashx"
        : "https://finviz.com/news.ashx";

    // Note: v=3 is the same underlying table served via a streaming/JS layer.
    // The non-JS version at /news.ashx returns the full HTML table directly.
    httpClient_->setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36");

    std::string html = httpClient_->get(baseUrl);

    if (html.empty()) {
        LOG_ERROR("Finviz: empty response — Cloudflare may have blocked the request. "
                  "Ensure curl-impersonate is enabled in config.json.");
        return {};
    }

    // Finviz returns a 200 with a challenge page when blocked
    if (html.find("Just a moment") != std::string::npos
        || html.find("Checking your browser") != std::string::npos) {
        LOG_ERROR("Finviz: Cloudflare challenge page received. "
                  "Enable impersonation in config.json: "
                  "\"impersonation\": { \"enabled\": true }");
        return {};
    }

    auto articles = parseNewsHtml(html);
    LOG_INFO("Finviz: parsed " + std::to_string(articles.size()) + " articles");
    return articles;
}
