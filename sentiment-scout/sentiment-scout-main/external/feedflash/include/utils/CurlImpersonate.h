#pragma once
#include "utils/IHttpClient.h"
#include <string>
#include <vector>
#include <mutex>
#include <random>
#include <chrono>
#include <functional>

struct BrowserProfile {
    std::string name;         // e.g. "chrome120", "firefox121"
    std::string binaryName;   // e.g. "curl_chrome120", "curl_ff121"
    std::string userAgent;
    std::string tlsVersion;   // For logging
    int weight;               // Selection weight for rotation
};

struct ImpersonateResponse {
    std::string body;
    long httpCode;
    std::string effectiveUrl;
    std::string tlsVersion;
    std::string tlsCipher;
    std::string error;
    bool success;
};

struct ImpersonateConfig {
    std::string preferredBrowser;   // "chrome", "firefox", "safari", or "rotate"
    int maxRetries;
    double backoffBaseMs;
    double backoffMaxMs;
    long timeoutSeconds;
    long connectTimeoutSeconds;
    bool followRedirects;
    long maxRedirects;
    bool verbose;                   // Log TLS handshake details
    std::string cookieJarPath;      // Persistent cookie storage
    std::string curlImpersonatePath; // Path to curl-impersonate binaries

    ImpersonateConfig()
        : preferredBrowser("rotate")
        , maxRetries(3)
        , backoffBaseMs(500.0)
        , backoffMaxMs(30000.0)
        , timeoutSeconds(30)
        , connectTimeoutSeconds(10)
        , followRedirects(true)
        , maxRedirects(5)
        , verbose(false)
        , cookieJarPath("")
        , curlImpersonatePath("")
    {}
};

class CurlImpersonate : public IHttpClient {
private:
    ImpersonateConfig config_;
    std::vector<BrowserProfile> profiles_;
    mutable std::mutex mutex_;
    std::mt19937 rng_;
    std::string lastError_;
    std::string customUserAgent_;

    // Initialize built-in browser profiles
    void initProfiles();

    // Select a profile based on config
    const BrowserProfile& selectProfile();

    // Execute request via curl-impersonate binary
    ImpersonateResponse execCurlBinary(const std::string& url,
                                        const BrowserProfile& profile);

    // Build command-line arguments for curl-impersonate
    std::vector<std::string> buildArgs(const std::string& url,
                                       const BrowserProfile& profile);

    // Execute a shell command and capture output
    static std::string execCommand(const std::string& cmd, int& exitCode);

    // Shell-escape a string
    static std::string shellEscape(const std::string& s);

    // Calculate backoff delay for retry attempt
    double calculateBackoff(int attempt) const;

    // Find curl-impersonate binary path
    std::string findBinary(const std::string& binaryName);

    // Log TLS details from verbose output
    void logTlsDetails(const std::string& verboseOutput, const std::string& url);

public:
    explicit CurlImpersonate(const ImpersonateConfig& config = ImpersonateConfig());
    ~CurlImpersonate() override = default;

    // Non-copyable
    CurlImpersonate(const CurlImpersonate&) = delete;
    CurlImpersonate& operator=(const CurlImpersonate&) = delete;

    // IHttpClient interface
    std::string get(const std::string& url) override;
    std::string post(const std::string& url,
                     const std::string& body,
                     const std::vector<std::string>& headers = {}) override;
    void setTimeout(long seconds) override;
    void setUserAgent(const std::string& ua) override;
    std::string getLastError() const override;

    // Extended API
    ImpersonateResponse getDetailed(const std::string& url);
    void setConfig(const ImpersonateConfig& config);
    ImpersonateConfig getConfig() const;

    // Profile management
    void addProfile(const BrowserProfile& profile);
    std::vector<std::string> listProfiles() const;
    void setPreferredBrowser(const std::string& browser);

    // Check if curl-impersonate is available on the system
    bool isAvailable() const;
};
