#include "sources/GoogleAlertsSource.h"
#include "utils/Logger.h"
#include <algorithm>

GoogleAlertsSource::GoogleAlertsSource(const std::string& name,
                                       const std::string& url,
                                       const std::string& category)
    : RSSSource(name, url, category) {}

GoogleAlertsSource::GoogleAlertsSource(const std::string& name,
                                       const std::string& url,
                                       std::shared_ptr<IHttpClient> client,
                                       const std::string& category)
    : RSSSource(name, url, std::move(client), category) {}

std::vector<NewsArticle> GoogleAlertsSource::fetch() {
    // Use the base RSSSource fetch (handles both RSS 2.0 and Atom)
    std::vector<NewsArticle> articles = RSSSource::fetch();

    // Apply Google Alerts specific cleaning
    for (auto& article : articles) {
        cleanGoogleAlertsContent(article);
    }

    return articles;
}

void GoogleAlertsSource::cleanGoogleAlertsContent(NewsArticle& article) {
    // Google Alerts often wraps the actual source URL in a redirect
    // e.g., https://www.google.com/url?rct=j&sa=t&url=https://actual-url.com/...
    if (article.url.find("google.com/url") != std::string::npos) {
        // Try to extract the actual URL from the 'url=' parameter
        size_t pos = article.url.find("url=");
        if (pos != std::string::npos) {
            std::string actualUrl = article.url.substr(pos + 4);
            // Remove any trailing parameters after &
            size_t ampPos = actualUrl.find('&');
            if (ampPos != std::string::npos) {
                actualUrl = actualUrl.substr(0, ampPos);
            }
            // URL-decode the extracted URL (basic: handle %XX)
            std::string decoded;
            for (size_t i = 0; i < actualUrl.size(); i++) {
                if (actualUrl[i] == '%' && i + 2 < actualUrl.size()) {
                    std::string hex = actualUrl.substr(i + 1, 2);
                    char ch = static_cast<char>(std::stoi(hex, nullptr, 16));
                    decoded += ch;
                    i += 2;
                } else {
                    decoded += actualUrl[i];
                }
            }
            if (!decoded.empty() && decoded.find("http") == 0) {
                article.url = decoded;
                article.id = NewsArticle::generateId(article.url);
            }
        }
    }

    // Clean up the title - Google Alerts sometimes prepends source name
    // Format: "Article Title - Source Name"
    // We keep the full title as-is since source info is useful

    // Trim excessive whitespace in content
    std::string& content = article.content;
    // Collapse multiple spaces into one
    auto new_end = std::unique(content.begin(), content.end(),
        [](char a, char b) { return a == ' ' && b == ' '; });
    content.erase(new_end, content.end());
}
