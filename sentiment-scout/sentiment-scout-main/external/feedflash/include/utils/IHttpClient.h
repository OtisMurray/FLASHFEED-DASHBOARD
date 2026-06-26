#pragma once
#include <string>
#include <vector>
#include <memory>

class IHttpClient {
public:
    virtual ~IHttpClient() = default;

    virtual std::string get(const std::string& url) = 0;

    // POST with an arbitrary body; headers is a list of "Name: Value" strings
    virtual std::string post(const std::string& url,
                             const std::string& body,
                             const std::vector<std::string>& headers = {}) = 0;

    virtual void setTimeout(long seconds) = 0;
    virtual void setUserAgent(const std::string& ua) = 0;
    virtual std::string getLastError() const = 0;
};
