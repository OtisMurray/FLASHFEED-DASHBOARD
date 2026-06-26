#pragma once
#include "utils/IHttpClient.h"
#include <string>
#include <curl/curl.h>

class HttpClient : public IHttpClient {
private:
    CURL* curl;
    long timeout;
    std::string userAgent;
    std::string lastError;

    static size_t WriteCallback(void* contents, size_t size, size_t nmemb, void* userp);

public:
    HttpClient();
    ~HttpClient() override;

    // Non-copyable
    HttpClient(const HttpClient&) = delete;
    HttpClient& operator=(const HttpClient&) = delete;

    // Fetch URL content
    std::string get(const std::string& url) override;
    std::string post(const std::string& url,
                     const std::string& body,
                     const std::vector<std::string>& headers = {}) override;

    // Configuration
    void setTimeout(long seconds) override;
    void setUserAgent(const std::string& ua) override;

    // Error handling
    std::string getLastError() const override;
};
