#pragma once
#include "NewsSource.h"
#include "utils/IHttpClient.h"
#include <pugixml.hpp>
#include <memory>

class RSSSource : public NewsSource {
protected:
    std::string feedUrl;
    std::shared_ptr<IHttpClient> httpClient;

    // Parse RSS 2.0 format
    std::vector<NewsArticle> parseRSS20(const pugi::xml_document& doc);

    // Parse Atom format
    std::vector<NewsArticle> parseAtom(const pugi::xml_document& doc);

    // Detect feed type
    enum FeedType { RSS20, ATOM, UNKNOWN };
    FeedType detectFeedType(const pugi::xml_document& doc);

    // Parse common date formats
    time_t parseRSSDate(const std::string& dateStr);

    // Strip HTML tags from a string
    static std::string stripHtml(const std::string& html);

public:
    RSSSource(const std::string& name, const std::string& url,
              const std::string& category = "general");

    RSSSource(const std::string& name, const std::string& url,
              std::shared_ptr<IHttpClient> client,
              const std::string& category = "general");

    std::vector<NewsArticle> fetch() override;
    std::string getFeedUrl() const { return feedUrl; }
};
