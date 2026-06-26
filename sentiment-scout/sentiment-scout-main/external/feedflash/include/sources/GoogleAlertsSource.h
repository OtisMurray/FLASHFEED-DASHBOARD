#pragma once
#include "RSSSource.h"

class GoogleAlertsSource : public RSSSource {
private:
    // Google Alerts specific content cleaning
    void cleanGoogleAlertsContent(NewsArticle& article);

public:
    GoogleAlertsSource(const std::string& name, const std::string& url,
                       const std::string& category = "general");

    GoogleAlertsSource(const std::string& name, const std::string& url,
                       std::shared_ptr<IHttpClient> client,
                       const std::string& category = "general");

    std::vector<NewsArticle> fetch() override;
};
