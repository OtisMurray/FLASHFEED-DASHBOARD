#include "utils/HttpClient.h"
#include "utils/Logger.h"

size_t HttpClient::WriteCallback(void* contents, size_t size, size_t nmemb, void* userp) {
    size_t totalSize = size * nmemb;
    std::string* response = static_cast<std::string*>(userp);
    response->append(static_cast<char*>(contents), totalSize);
    return totalSize;
}

HttpClient::HttpClient() : curl(nullptr), timeout(30), userAgent("FeedFlash/1.0") {
    curl = curl_easy_init();
    if (!curl) {
        LOG_ERROR("Failed to initialize CURL");
    }
}

HttpClient::~HttpClient() {
    if (curl) {
        curl_easy_cleanup(curl);
        curl = nullptr;
    }
}

std::string HttpClient::get(const std::string& url) {
    if (!curl) {
        lastError = "CURL not initialized";
        LOG_ERROR(lastError);
        return "";
    }

    std::string response;

    curl_easy_reset(curl);
    curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, WriteCallback);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &response);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, timeout);
    curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT, 10L);
    curl_easy_setopt(curl, CURLOPT_USERAGENT, userAgent.c_str());
    curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, 1L);
    curl_easy_setopt(curl, CURLOPT_MAXREDIRS, 5L);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYPEER, 1L);
    curl_easy_setopt(curl, CURLOPT_ACCEPT_ENCODING, "");  // Accept all encodings

    CURLcode res = curl_easy_perform(curl);
    if (res != CURLE_OK) {
        lastError = "CURL error: " + std::string(curl_easy_strerror(res));
        LOG_ERROR("HTTP GET failed for " + url + ": " + lastError);
        return "";
    }

    long httpCode = 0;
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &httpCode);
    if (httpCode != 200) {
        lastError = "HTTP " + std::to_string(httpCode);
        LOG_WARNING("HTTP GET returned " + std::to_string(httpCode) + " for " + url);
        if (httpCode >= 400) {
            return "";
        }
    }

    LOG_DEBUG("Fetched " + std::to_string(response.size()) + " bytes from " + url);
    return response;
}

std::string HttpClient::post(const std::string& url,
                              const std::string& body,
                              const std::vector<std::string>& headers) {
    if (!curl) {
        lastError = "CURL not initialized";
        return "";
    }

    std::string response;

    curl_easy_reset(curl);
    curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
    curl_easy_setopt(curl, CURLOPT_POST, 1L);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, body.c_str());
    curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, (long)body.size());
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, WriteCallback);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &response);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, timeout);
    curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT, 10L);
    curl_easy_setopt(curl, CURLOPT_USERAGENT, userAgent.c_str());
    curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, 1L);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYPEER, 1L);

    struct curl_slist* curlHeaders = nullptr;
    for (const auto& h : headers) {
        curlHeaders = curl_slist_append(curlHeaders, h.c_str());
    }
    if (curlHeaders) {
        curl_easy_setopt(curl, CURLOPT_HTTPHEADER, curlHeaders);
    }

    CURLcode res = curl_easy_perform(curl);
    if (curlHeaders) curl_slist_free_all(curlHeaders);

    if (res != CURLE_OK) {
        lastError = "CURL POST error: " + std::string(curl_easy_strerror(res));
        LOG_ERROR("HTTP POST failed for " + url + ": " + lastError);
        return "";
    }

    long httpCode = 0;
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &httpCode);
    if (httpCode >= 400) {
        lastError = "HTTP " + std::to_string(httpCode);
        LOG_WARNING("HTTP POST returned " + std::to_string(httpCode) + " for " + url);
        return "";
    }

    return response;
}

void HttpClient::setTimeout(long seconds) {
    timeout = seconds;
}

void HttpClient::setUserAgent(const std::string& ua) {
    userAgent = ua;
}

std::string HttpClient::getLastError() const {
    return lastError;
}
