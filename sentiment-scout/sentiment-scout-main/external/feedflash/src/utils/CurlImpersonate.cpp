#include "utils/CurlImpersonate.h"
#include "utils/Logger.h"
#include <curl/curl.h>
#include <array>
#include <cstdio>
#include <cstdlib>
#include <cmath>
#include <sstream>
#include <algorithm>
#include <thread>
#include <fstream>
#include <filesystem>

namespace fs = std::filesystem;

CurlImpersonate::CurlImpersonate(const ImpersonateConfig& config)
    : config_(config)
    , rng_(static_cast<unsigned>(
          std::chrono::steady_clock::now().time_since_epoch().count()))
{
    initProfiles();

    if (isAvailable()) {
        LOG_INFO("CurlImpersonate initialized with " +
                 std::to_string(profiles_.size()) + " browser profiles");
    } else {
        LOG_WARNING("curl-impersonate binaries not found. "
                    "Install from: https://github.com/lwthiker/curl-impersonate");
    }
}

void CurlImpersonate::initProfiles() {
    profiles_ = {
        // Chrome profiles (v0.6.1 binaries)
        {"chrome116", "curl_chrome116",
         "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
         "(KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36",
         "TLSv1.3", 30},

        {"chrome110", "curl_chrome110",
         "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
         "(KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36",
         "TLSv1.3", 25},

        {"chrome107", "curl_chrome107",
         "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
         "(KHTML, like Gecko) Chrome/107.0.0.0 Safari/537.36",
         "TLSv1.3", 15},

        {"chrome104", "curl_chrome104",
         "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
         "(KHTML, like Gecko) Chrome/104.0.0.0 Safari/537.36",
         "TLSv1.3", 10},

        {"chrome101", "curl_chrome101",
         "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
         "(KHTML, like Gecko) Chrome/101.0.0.0 Safari/537.36",
         "TLSv1.3", 10},

        {"chrome100", "curl_chrome100",
         "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
         "(KHTML, like Gecko) Chrome/100.0.0.0 Safari/537.36",
         "TLSv1.3", 5},

        {"chrome99", "curl_chrome99",
         "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
         "(KHTML, like Gecko) Chrome/99.0.4844.51 Safari/537.36",
         "TLSv1.3", 5},

        // Edge profiles
        {"edge101", "curl_edge101",
         "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
         "(KHTML, like Gecko) Chrome/101.0.4951.67 Safari/537.36 Edg/101.0.1210.47",
         "TLSv1.3", 10},

        // Firefox profiles
        {"firefox117", "curl_ff117",
         "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:117.0) "
         "Gecko/20100101 Firefox/117.0",
         "TLSv1.3", 25},

        {"firefox109", "curl_ff109",
         "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) "
         "Gecko/20100101 Firefox/109.0",
         "TLSv1.3", 15},

        {"firefox102", "curl_ff102",
         "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:102.0) "
         "Gecko/20100101 Firefox/102.0",
         "TLSv1.3", 10},

        {"firefox100", "curl_ff100",
         "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:100.0) "
         "Gecko/20100101 Firefox/100.0",
         "TLSv1.3", 5},

        // Safari profiles
        {"safari15_5", "curl_safari15_5",
         "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 "
         "(KHTML, like Gecko) Version/15.5 Safari/605.1.15",
         "TLSv1.2", 10},

        {"safari15_3", "curl_safari15_3",
         "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 "
         "(KHTML, like Gecko) Version/15.3 Safari/605.1.15",
         "TLSv1.2", 5},
    };
}

const BrowserProfile& CurlImpersonate::selectProfile() {
    // Filter by preferred browser if not "rotate"
    std::vector<size_t> candidates;

    for (size_t i = 0; i < profiles_.size(); ++i) {
        if (config_.preferredBrowser == "rotate") {
            candidates.push_back(i);
        } else if (profiles_[i].name.find(config_.preferredBrowser) == 0) {
            candidates.push_back(i);
        }
    }

    if (candidates.empty()) {
        // Fallback: use all profiles
        for (size_t i = 0; i < profiles_.size(); ++i) {
            candidates.push_back(i);
        }
    }

    // Weighted random selection
    int totalWeight = 0;
    for (size_t idx : candidates) {
        totalWeight += profiles_[idx].weight;
    }

    std::uniform_int_distribution<int> dist(1, totalWeight);
    int roll = dist(rng_);

    int cumulative = 0;
    for (size_t idx : candidates) {
        cumulative += profiles_[idx].weight;
        if (roll <= cumulative) {
            return profiles_[idx];
        }
    }

    return profiles_[candidates.back()];
}

std::string CurlImpersonate::findBinary(const std::string& binaryName) {
    // Check configured path first
    if (!config_.curlImpersonatePath.empty()) {
        fs::path fullPath = fs::path(config_.curlImpersonatePath) / binaryName;
        if (fs::exists(fullPath)) {
            return fullPath.string();
        }
    }

    // Check common installation paths
    const std::vector<std::string> searchPaths = {
        "/usr/local/bin",
        "/usr/bin",
        "/opt/curl-impersonate/bin",
        std::string(std::getenv("HOME") ? std::getenv("HOME") : "") +
            "/.local/bin",
    };

    for (const auto& dir : searchPaths) {
        if (dir.empty()) continue;
        fs::path fullPath = fs::path(dir) / binaryName;
        if (fs::exists(fullPath)) {
            return fullPath.string();
        }
    }

    // Try PATH via `which`
    int exitCode = 0;
    std::string result = execCommand("which " + shellEscape(binaryName) +
                                     " 2>/dev/null", exitCode);
    if (exitCode == 0 && !result.empty()) {
        // Remove trailing newline
        while (!result.empty() && (result.back() == '\n' || result.back() == '\r')) {
            result.pop_back();
        }
        return result;
    }

    return "";
}

std::string CurlImpersonate::shellEscape(const std::string& s) {
    std::string escaped = "'";
    for (char c : s) {
        if (c == '\'') {
            escaped += "'\\''";
        } else {
            escaped += c;
        }
    }
    escaped += "'";
    return escaped;
}

std::vector<std::string> CurlImpersonate::buildArgs(
    const std::string& url, const BrowserProfile& /*profile*/) {

    std::vector<std::string> args;

    // Timeout
    args.push_back("--max-time");
    args.push_back(std::to_string(config_.timeoutSeconds));

    args.push_back("--connect-timeout");
    args.push_back(std::to_string(config_.connectTimeoutSeconds));

    // Redirects
    if (config_.followRedirects) {
        args.push_back("-L");
        args.push_back("--max-redirs");
        args.push_back(std::to_string(config_.maxRedirects));
    }

    // Cookies
    if (!config_.cookieJarPath.empty()) {
        args.push_back("-b");
        args.push_back(config_.cookieJarPath);
        args.push_back("-c");
        args.push_back(config_.cookieJarPath);
    }

    // Compressed responses
    args.push_back("--compressed");

    // Silent mode (no progress bar) but show errors
    args.push_back("-s");
    args.push_back("-S");

    // Include response metadata in output for status code extraction
    args.push_back("-w");
    args.push_back(shellEscape("\n__CURL_EXIT__%{http_code}|%{ssl_version}|%{url_effective}"));

    // Verbose output for TLS debugging
    if (config_.verbose) {
        args.push_back("-v");
    }

    // URL
    args.push_back(shellEscape(url));

    return args;
}

std::string CurlImpersonate::execCommand(const std::string& cmd, int& exitCode) {
    std::string output;
    std::array<char, 8192> buffer;

    FILE* pipe = popen(cmd.c_str(), "r");
    if (!pipe) {
        exitCode = -1;
        return "";
    }

    while (fgets(buffer.data(), static_cast<int>(buffer.size()), pipe) != nullptr) {
        output += buffer.data();
    }

    int status = pclose(pipe);
    exitCode = WEXITSTATUS(status);
    return output;
}

ImpersonateResponse CurlImpersonate::execCurlBinary(
    const std::string& url, const BrowserProfile& profile) {

    ImpersonateResponse resp;
    resp.success = false;
    resp.httpCode = 0;

    std::string binaryPath = findBinary(profile.binaryName);
    if (binaryPath.empty()) {
        resp.error = "Binary not found: " + profile.binaryName;
        LOG_ERROR(resp.error);
        return resp;
    }

    // Build command
    std::ostringstream cmd;
    cmd << shellEscape(binaryPath);

    auto args = buildArgs(url, profile);
    for (const auto& arg : args) {
        cmd << " " << arg;
    }

    // Capture stderr to temp file for TLS logging, keep stdout clean
    std::string stderrFile;
    if (config_.verbose) {
        stderrFile = "/tmp/feedflash_curl_stderr_" +
                     std::to_string(std::chrono::steady_clock::now()
                         .time_since_epoch().count());
        cmd << " 2>" << shellEscape(stderrFile);
    } else {
        cmd << " 2>/dev/null";
    }

    LOG_DEBUG("Executing: " + profile.binaryName + " for " + url);

    int exitCode = 0;
    std::string rawOutput = execCommand(cmd.str(), exitCode);

    // Read and log stderr (TLS details) if verbose
    if (config_.verbose && !stderrFile.empty()) {
        std::ifstream stderrStream(stderrFile);
        if (stderrStream.is_open()) {
            std::string stderrContent((std::istreambuf_iterator<char>(stderrStream)),
                                       std::istreambuf_iterator<char>());
            stderrStream.close();
            fs::remove(stderrFile);
            if (!stderrContent.empty()) {
                logTlsDetails(stderrContent, url);
            }
        }
    }

    if (exitCode != 0 && rawOutput.empty()) {
        resp.error = "curl-impersonate exited with code " + std::to_string(exitCode);
        LOG_ERROR(resp.error + " for " + url);
        return resp;
    }

    // Parse the output: body is everything before __CURL_EXIT__ marker
    std::string marker = "\n__CURL_EXIT__";
    size_t markerPos = rawOutput.rfind(marker);

    if (markerPos != std::string::npos) {
        resp.body = rawOutput.substr(0, markerPos);
        std::string meta = rawOutput.substr(markerPos + marker.size());

        // Parse: http_code|ssl_version|url_effective
        std::istringstream metaStream(meta);
        std::string httpCodeStr, sslVer, effectiveUrl;
        std::getline(metaStream, httpCodeStr, '|');
        std::getline(metaStream, sslVer, '|');
        std::getline(metaStream, effectiveUrl);

        // Remove trailing newlines
        while (!effectiveUrl.empty() &&
               (effectiveUrl.back() == '\n' || effectiveUrl.back() == '\r')) {
            effectiveUrl.pop_back();
        }

        resp.httpCode = std::stol(httpCodeStr.empty() ? "0" : httpCodeStr);
        resp.tlsVersion = sslVer;
        resp.effectiveUrl = effectiveUrl;
    } else {
        // No marker found — raw output is the body
        resp.body = rawOutput;
    }

    if (exitCode != 0) {
        resp.error = "curl-impersonate exited with code " + std::to_string(exitCode);
        LOG_WARNING(resp.error + " for " + url + " (got " +
                    std::to_string(resp.body.size()) + " bytes)");
    }

    resp.success = (exitCode == 0 && resp.httpCode >= 200 && resp.httpCode < 400);

    LOG_DEBUG("Response: HTTP " + std::to_string(resp.httpCode) +
              ", TLS " + resp.tlsVersion +
              ", " + std::to_string(resp.body.size()) + " bytes" +
              " [profile: " + profile.name + "]");

    return resp;
}

void CurlImpersonate::logTlsDetails(const std::string& verboseOutput,
                                     const std::string& url) {
    // Extract TLS-related lines from verbose output
    std::istringstream stream(verboseOutput);
    std::string line;
    std::ostringstream tlsLog;
    tlsLog << "TLS handshake details for " << url << ":\n";
    bool hasTlsInfo = false;

    while (std::getline(stream, line)) {
        if (line.find("* SSL") != std::string::npos ||
            line.find("* TLS") != std::string::npos ||
            line.find("* ALPN") != std::string::npos ||
            line.find("* server certificate") != std::string::npos ||
            line.find("*  subject:") != std::string::npos ||
            line.find("*  issuer:") != std::string::npos ||
            line.find("* Connected") != std::string::npos ||
            line.find("* Using") != std::string::npos) {
            tlsLog << "  " << line << "\n";
            hasTlsInfo = true;
        }
    }

    if (hasTlsInfo) {
        LOG_DEBUG(tlsLog.str());
    }
}

double CurlImpersonate::calculateBackoff(int attempt) const {
    // Exponential backoff with jitter
    double delay = config_.backoffBaseMs * std::pow(2.0, attempt);
    delay = std::min(delay, config_.backoffMaxMs);

    // Add jitter: +/- 25%
    std::uniform_real_distribution<double> jitter(0.75, 1.25);
    std::mt19937 localRng(static_cast<unsigned>(
        std::chrono::steady_clock::now().time_since_epoch().count()));
    delay *= jitter(localRng);

    return delay;
}

// --- IHttpClient interface ---

std::string CurlImpersonate::get(const std::string& url) {
    auto resp = getDetailed(url);
    return resp.body;
}

// CurlImpersonate is designed for browser impersonation of GET requests.
// For POST (e.g. OAuth2 token refresh), fall back to a plain libcurl POST.
std::string CurlImpersonate::post(const std::string& url,
                                   const std::string& body,
                                   const std::vector<std::string>& headers) {
    CURL* curl = curl_easy_init();
    if (!curl) {
        lastError_ = "Failed to init curl for POST";
        return "";
    }

    std::string response;
    auto writeCallback = [](void* data, size_t sz, size_t nmemb, void* userp) -> size_t {
        static_cast<std::string*>(userp)->append(static_cast<char*>(data), sz * nmemb);
        return sz * nmemb;
    };

    curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
    curl_easy_setopt(curl, CURLOPT_POST, 1L);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, body.c_str());
    curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, (long)body.size());
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, +writeCallback);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &response);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, config_.timeoutSeconds);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYPEER, 1L);

    struct curl_slist* curlHeaders = nullptr;
    for (const auto& h : headers) {
        curlHeaders = curl_slist_append(curlHeaders, h.c_str());
    }
    if (curlHeaders) curl_easy_setopt(curl, CURLOPT_HTTPHEADER, curlHeaders);

    CURLcode res = curl_easy_perform(curl);
    if (curlHeaders) curl_slist_free_all(curlHeaders);
    curl_easy_cleanup(curl);

    if (res != CURLE_OK) {
        lastError_ = curl_easy_strerror(res);
        return "";
    }
    return response;
}

ImpersonateResponse CurlImpersonate::getDetailed(const std::string& url) {
    std::lock_guard<std::mutex> lock(mutex_);

    ImpersonateResponse lastResp;
    lastResp.success = false;

    for (int attempt = 0; attempt <= config_.maxRetries; ++attempt) {
        if (attempt > 0) {
            double delayMs = calculateBackoff(attempt - 1);
            LOG_INFO("Retry " + std::to_string(attempt) + "/" +
                     std::to_string(config_.maxRetries) +
                     " for " + url + " (backoff: " +
                     std::to_string(static_cast<int>(delayMs)) + "ms)");
            std::this_thread::sleep_for(
                std::chrono::milliseconds(static_cast<int>(delayMs)));
        }

        const BrowserProfile& profile = selectProfile();
        LOG_DEBUG("Using profile: " + profile.name + " for " + url);

        lastResp = execCurlBinary(url, profile);

        if (lastResp.success) {
            lastError_.clear();
            return lastResp;
        }

        // Don't retry on 4xx client errors (except 403/429 which may be bot detection)
        if (lastResp.httpCode >= 400 && lastResp.httpCode < 500 &&
            lastResp.httpCode != 403 && lastResp.httpCode != 429) {
            LOG_WARNING("HTTP " + std::to_string(lastResp.httpCode) +
                        " — not retrying for " + url);
            break;
        }
    }

    lastError_ = lastResp.error.empty()
        ? ("HTTP " + std::to_string(lastResp.httpCode))
        : lastResp.error;
    LOG_ERROR("All retries exhausted for " + url + ": " + lastError_);
    return lastResp;
}

void CurlImpersonate::setTimeout(long seconds) {
    std::lock_guard<std::mutex> lock(mutex_);
    config_.timeoutSeconds = seconds;
}

void CurlImpersonate::setUserAgent(const std::string& ua) {
    std::lock_guard<std::mutex> lock(mutex_);
    customUserAgent_ = ua;
}

std::string CurlImpersonate::getLastError() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return lastError_;
}

// --- Extended API ---

void CurlImpersonate::setConfig(const ImpersonateConfig& config) {
    std::lock_guard<std::mutex> lock(mutex_);
    config_ = config;
}

ImpersonateConfig CurlImpersonate::getConfig() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return config_;
}

void CurlImpersonate::addProfile(const BrowserProfile& profile) {
    std::lock_guard<std::mutex> lock(mutex_);
    profiles_.push_back(profile);
    LOG_DEBUG("Added browser profile: " + profile.name);
}

std::vector<std::string> CurlImpersonate::listProfiles() const {
    std::lock_guard<std::mutex> lock(mutex_);
    std::vector<std::string> names;
    names.reserve(profiles_.size());
    for (const auto& p : profiles_) {
        names.push_back(p.name);
    }
    return names;
}

void CurlImpersonate::setPreferredBrowser(const std::string& browser) {
    std::lock_guard<std::mutex> lock(mutex_);
    config_.preferredBrowser = browser;
    LOG_INFO("Preferred browser set to: " + browser);
}

bool CurlImpersonate::isAvailable() const {
    // Check if at least one curl-impersonate binary exists
    auto self = const_cast<CurlImpersonate*>(this);
    for (const auto& profile : profiles_) {
        if (!self->findBinary(profile.binaryName).empty()) {
            return true;
        }
    }
    return false;
}
