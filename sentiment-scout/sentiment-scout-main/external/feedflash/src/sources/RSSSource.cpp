#include "sources/RSSSource.h"
#include "utils/HttpClient.h"
#include "utils/Logger.h"
#include <cstring>
#include <sstream>
#include <algorithm>
#include <regex>
#include <iomanip>

RSSSource::RSSSource(const std::string& name, const std::string& url,
                     const std::string& category)
    : NewsSource(name, category), feedUrl(url),
      httpClient(std::make_shared<HttpClient>()) {}

RSSSource::RSSSource(const std::string& name, const std::string& url,
                     std::shared_ptr<IHttpClient> client,
                     const std::string& category)
    : NewsSource(name, category), feedUrl(url),
      httpClient(std::move(client)) {}

std::vector<NewsArticle> RSSSource::fetch() {
    std::vector<NewsArticle> articles;

    LOG_INFO("Fetching feed: " + name + " from " + feedUrl);

    std::string xmlContent = httpClient->get(feedUrl);
    if (xmlContent.empty()) {
        LOG_ERROR("Empty response from feed: " + name);
        return articles;
    }

    pugi::xml_document doc;
    pugi::xml_parse_result result = doc.load_string(xmlContent.c_str());
    if (!result) {
        LOG_ERROR("XML parse error for feed " + name + ": " + result.description());
        return articles;
    }

    FeedType type = detectFeedType(doc);
    switch (type) {
        case RSS20:
            articles = parseRSS20(doc);
            break;
        case ATOM:
            articles = parseAtom(doc);
            break;
        default:
            LOG_ERROR("Unknown feed type for: " + name);
            break;
    }

    // Extract tickers from each article's title and content
    for (auto& article : articles) {
        article.ticker = NewsArticle::extractTickers(article.title + " " + article.content);
    }

    LOG_INFO("Parsed " + std::to_string(articles.size()) + " articles from " + name);
    return articles;
}

RSSSource::FeedType RSSSource::detectFeedType(const pugi::xml_document& doc) {
    // Check for RSS 2.0: <rss version="2.0"> or just <rss>
    if (doc.child("rss")) {
        return RSS20;
    }
    // Check for Atom: <feed xmlns="http://www.w3.org/2005/Atom">
    if (doc.child("feed")) {
        return ATOM;
    }
    return UNKNOWN;
}

std::vector<NewsArticle> RSSSource::parseRSS20(const pugi::xml_document& doc) {
    std::vector<NewsArticle> articles;
    time_t now = time(nullptr);

    pugi::xml_node channel = doc.child("rss").child("channel");
    if (!channel) {
        LOG_ERROR("No <channel> found in RSS feed: " + name);
        return articles;
    }

    for (pugi::xml_node item = channel.child("item"); item;
         item = item.next_sibling("item")) {

        NewsArticle article;

        article.title = stripHtml(item.child_value("title"));
        article.url = item.child_value("link");
        article.content = stripHtml(item.child_value("description"));
        article.source = name;
        article.category = category;
        article.fetched_date = now;

        // Parse publish date
        const char* pubDate = item.child_value("pubDate");
        if (pubDate && strlen(pubDate) > 0) {
            article.publish_date = parseRSSDate(pubDate);
        } else {
            article.publish_date = now;
        }

        // Generate ID from URL
        if (!article.url.empty()) {
            article.id = NewsArticle::generateId(article.url);
        }

        if (article.isValid()) {
            articles.push_back(std::move(article));
        } else {
            LOG_WARNING("Skipping invalid article in feed: " + name);
        }
    }

    return articles;
}

std::vector<NewsArticle> RSSSource::parseAtom(const pugi::xml_document& doc) {
    std::vector<NewsArticle> articles;
    time_t now = time(nullptr);

    pugi::xml_node feed = doc.child("feed");
    if (!feed) {
        LOG_ERROR("No <feed> element in Atom feed: " + name);
        return articles;
    }

    for (pugi::xml_node entry = feed.child("entry"); entry;
         entry = entry.next_sibling("entry")) {

        NewsArticle article;

        article.title = stripHtml(entry.child_value("title"));
        article.source = name;
        article.category = category;
        article.fetched_date = now;

        // Atom uses <link href="..."/> or <link> with href attribute
        pugi::xml_node link = entry.child("link");
        if (link) {
            const char* href = link.attribute("href").value();
            if (href && strlen(href) > 0) {
                article.url = href;
            } else {
                article.url = link.child_value();
            }
        }

        // Content can be in <content> or <summary>
        const char* content = entry.child_value("content");
        if (!content || strlen(content) == 0) {
            content = entry.child_value("summary");
        }
        if (content) {
            article.content = stripHtml(content);
        }

        // Parse date from <published> or <updated>
        const char* published = entry.child_value("published");
        if (!published || strlen(published) == 0) {
            published = entry.child_value("updated");
        }
        if (published && strlen(published) > 0) {
            article.publish_date = parseRSSDate(published);
        } else {
            article.publish_date = now;
        }

        if (!article.url.empty()) {
            article.id = NewsArticle::generateId(article.url);
        }

        if (article.isValid()) {
            articles.push_back(std::move(article));
        } else {
            LOG_WARNING("Skipping invalid Atom entry in feed: " + name);
        }
    }

    return articles;
}

time_t RSSSource::parseRSSDate(const std::string& dateStr) {
    if (dateStr.empty()) return 0;

    struct tm tm = {};

    // Try RFC 822 format: "Mon, 06 Sep 2009 16:45:00 GMT"
    // Various common patterns
    const char* formats[] = {
        "%a, %d %b %Y %H:%M:%S",    // RFC 822 with day name
        "%d %b %Y %H:%M:%S",         // Without day name
        "%Y-%m-%dT%H:%M:%S",         // ISO 8601
        "%Y-%m-%d %H:%M:%S",         // Simple datetime
        "%Y-%m-%d",                   // Date only
        nullptr
    };

    for (int i = 0; formats[i] != nullptr; i++) {
        memset(&tm, 0, sizeof(tm));
        if (strptime(dateStr.c_str(), formats[i], &tm) != nullptr) {
            // mktime interprets as local time; use timegm for UTC if available
            time_t result = timegm(&tm);
            if (result != -1) {
                return result;
            }
            // Fallback to mktime
            return mktime(&tm);
        }
    }

    LOG_WARNING("Could not parse date: " + dateStr);
    return time(nullptr);  // Fallback to current time
}

std::string RSSSource::stripHtml(const std::string& html) {
    if (html.empty()) return html;

    std::string result;
    result.reserve(html.size());

    bool inTag = false;
    bool inEntity = false;
    std::string entity;

    for (size_t i = 0; i < html.size(); i++) {
        char c = html[i];

        if (c == '<') {
            inTag = true;
            continue;
        }
        if (c == '>') {
            inTag = false;
            continue;
        }
        if (inTag) continue;

        // Handle HTML entities
        if (c == '&') {
            inEntity = true;
            entity = "&";
            continue;
        }
        if (inEntity) {
            entity += c;
            if (c == ';') {
                inEntity = false;
                if (entity == "&amp;") result += '&';
                else if (entity == "&lt;") result += '<';
                else if (entity == "&gt;") result += '>';
                else if (entity == "&quot;") result += '"';
                else if (entity == "&apos;") result += '\'';
                else if (entity == "&#39;") result += '\'';
                else if (entity == "&nbsp;") result += ' ';
                else result += entity;  // Keep unknown entities as-is
                entity.clear();
            }
            continue;
        }

        result += c;
    }

    // Trim whitespace
    size_t start = result.find_first_not_of(" \t\n\r");
    size_t end = result.find_last_not_of(" \t\n\r");
    if (start == std::string::npos) return "";
    return result.substr(start, end - start + 1);
}
