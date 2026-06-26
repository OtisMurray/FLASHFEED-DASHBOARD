#include <iostream>
#include <fstream>
#include <vector>
#include <string>
#include <cstring>
#include <atomic>
#include <thread>
#include <chrono>
#include <csignal>
#include <nlohmann/json.hpp>
#include "storage/Database.h"
#include "sources/GoogleAlertsSource.h"
#include "sources/RSSSource.h"
#include "sources/NewsSource.h"
#include "sources/IBKRSource.h"
#include "sources/SchwabSource.h"
#include "sources/FinvizSource.h"
#include "utils/Logger.h"
#include "utils/IHttpClient.h"
#include "utils/HttpClient.h"
#include "utils/CurlImpersonate.h"
#include "utils/KeywordFilter.h"
#include "utils/SentimentClassifier.h"
#include "sources/TradingViewSource.h"

using json = nlohmann::json;

// Global flag for clean shutdown on Ctrl+C
static std::atomic<bool> g_running{true};

static void signalHandler(int) {
    g_running = false;
}

// --- Spinner for visual loading feedback ---
class Spinner {
    std::atomic<bool> running{false};
    std::thread worker;
    std::string message;

public:
    void start(const std::string& msg) {
        message = msg;
        running = true;
        worker = std::thread([this]() {
            const char frames[] = {'|', '/', '-', '\\'};
            int i = 0;
            while (running) {
                std::cerr << "\r\033[36m" << frames[i % 4] << "\033[0m " << message << "  " << std::flush;
                i++;
                std::this_thread::sleep_for(std::chrono::milliseconds(80));
            }
            // Clear the spinner line
            std::cerr << "\r" << std::string(message.size() + 6, ' ') << "\r" << std::flush;
        });
    }

    void stop() {
        running = false;
        if (worker.joinable()) worker.join();
    }

    ~Spinner() { stop(); }
};

struct FeedConfig {
    std::string name;
    std::string url;
    std::string category;
};

struct Config {
    std::string databasePath;
    std::vector<FeedConfig> rssFeeds;
    std::string logFile;
    std::string logLevel;
    bool impersonationEnabled;
    ImpersonateConfig impersonateConfig;

    // Optional API-based sources
    IBKRConfig   ibkr;
    bool         ibkrEnabled   = false;
    SchwabConfig schwab;
    bool         schwabEnabled = false;
    FinvizConfig      finviz;
    bool              finvizEnabled      = false;
    TradingViewConfig tradingView;
    bool              tradingViewEnabled = false;
    int               finvizWatchIntervalSec = 10;  // elite streaming cadence

    // Keyword filter
    KeywordFilter keywordFilter;

    Config() : impersonationEnabled(false) {}
};

std::shared_ptr<IHttpClient> createHttpClient(const Config& config) {
    if (config.impersonationEnabled) {
        auto client = std::make_shared<CurlImpersonate>(config.impersonateConfig);
        if (client->isAvailable()) {
            LOG_INFO("Using curl-impersonate HTTP client (browser: " +
                     config.impersonateConfig.preferredBrowser + ")");
            return client;
        }
        LOG_WARNING("curl-impersonate not available, falling back to standard HTTP client");
    }
    return std::make_shared<HttpClient>();
}

Config loadConfig(const std::string& configPath) {
    Config config;
    config.databasePath = "./feedflash.db";
    config.logFile = "./feedflash.log";
    config.logLevel = "info";

    std::ifstream file(configPath);
    if (!file.is_open()) {
        LOG_ERROR("Cannot open config file: " + configPath);
        return config;
    }

    try {
        json j = json::parse(file);

        if (j.contains("database") && j["database"].contains("path")) {
            config.databasePath = j["database"]["path"].get<std::string>();
        }

        if (j.contains("logging")) {
            auto& logging = j["logging"];
            if (logging.contains("file")) {
                config.logFile = logging["file"].get<std::string>();
            }
            if (logging.contains("level")) {
                config.logLevel = logging["level"].get<std::string>();
            }
        }

        // Support both new "rss_feeds" key and legacy "google_alerts" key
        auto loadFeeds = [&](const std::string& key) {
            if (j.contains("sources") && j["sources"].contains(key)) {
                for (const auto& feed : j["sources"][key]) {
                    FeedConfig fc;
                    fc.name = feed.value("name", "Unnamed Feed");
                    fc.url = feed.value("url", "");
                    fc.category = feed.value("category", "general");
                    if (!fc.url.empty()) {
                        config.rssFeeds.push_back(fc);
                    }
                }
            }
        };
        loadFeeds("rss_feeds");
        loadFeeds("google_alerts");  // backward compat

        if (j.contains("ibkr")) {
            auto& ib = j["ibkr"];
            config.ibkrEnabled             = ib.value("enabled", false);
            config.ibkr.gatewayUrl         = ib.value("gateway_url", "https://localhost:5000");
            config.ibkr.newsFilters        = ib.value("news_filters", "");
            config.ibkr.fetchLimit         = ib.value("fetch_limit", 50);
            config.ibkr.fetchBody          = ib.value("fetch_body", false);
        }

        if (j.contains("schwab")) {
            auto& sw = j["schwab"];
            config.schwabEnabled           = sw.value("enabled", false);
            config.schwab.clientId         = sw.value("client_id", "");
            config.schwab.clientSecret     = sw.value("client_secret", "");
            config.schwab.refreshToken     = sw.value("refresh_token", "");
            config.schwab.newsEndpoint     = sw.value("news_endpoint", "");
            config.schwab.fetchLimit       = sw.value("fetch_limit", 50);
        }

        if (j.contains("finviz")) {
            auto& fv = j["finviz"];
            config.finvizEnabled                = fv.value("enabled", false);
            config.finviz.elite                 = fv.value("elite", false);
            config.finviz.email                 = fv.value("email", "");
            config.finviz.password              = fv.value("password", "");
            config.finvizWatchIntervalSec       = fv.value("watch_interval_sec", 10);
        }

        if (j.contains("tradingview")) {
            auto& tv = j["tradingview"];
            config.tradingViewEnabled           = tv.value("enabled", false);
            config.tradingView.symbol           = tv.value("symbol", "");
            config.tradingView.fetchLimit       = tv.value("fetch_limit", 50);
        }

        if (j.contains("impersonation")) {
            auto& imp = j["impersonation"];
            config.impersonationEnabled = imp.value("enabled", false);

            auto& ic = config.impersonateConfig;
            ic.preferredBrowser = imp.value("preferred_browser", "rotate");
            ic.maxRetries = imp.value("max_retries", 3);
            ic.backoffBaseMs = imp.value("backoff_base_ms", 500.0);
            ic.backoffMaxMs = imp.value("backoff_max_ms", 30000.0);
            ic.timeoutSeconds = imp.value("timeout_seconds", 30L);
            ic.connectTimeoutSeconds = imp.value("connect_timeout_seconds", 10L);
            ic.followRedirects = imp.value("follow_redirects", true);
            ic.maxRedirects = imp.value("max_redirects", 5L);
            ic.verbose = imp.value("verbose", false);
            ic.cookieJarPath = imp.value("cookie_jar", "");
            ic.curlImpersonatePath = imp.value("curl_impersonate_path", "");
        }

        if (j.contains("keyword_filter")) {
            auto& kf = j["keyword_filter"];
            if (kf.value("enabled", false) && kf.contains("keywords")) {
                std::vector<std::string> kws;
                for (const auto& kw : kf["keywords"]) {
                    kws.push_back(kw.get<std::string>());
                }
                config.keywordFilter.setKeywords(kws);

                std::string mode = kf.value("mode", "headline");
                if (mode == "headline_content") {
                    config.keywordFilter.setMode(KeywordFilter::Mode::HEADLINE_CONTENT);
                }

                LOG_INFO("Keyword filter: " + std::to_string(config.keywordFilter.size()) +
                         " keywords loaded (mode: " + mode + ")");
            }
        }
    } catch (const json::exception& e) {
        LOG_ERROR("JSON parse error in config: " + std::string(e.what()));
    }

    return config;
}

void printUsage(const char* programName) {
    std::cout << "FeedFlash - RSS News Aggregator v1.1\n\n"
              << "Usage: " << programName << " [OPTIONS]\n\n"
              << "Options:\n"
              << "  --fetch              Fetch all configured RSS feeds\n"
              << "  --list [N]           List N most recent articles (default: 20)\n"
              << "  --source <name> [N]  List articles from a specific source\n"
              << "  --category <name> [N] List articles in a category\n"
              << "  --stats              Show database statistics\n"
              << "  --watch              Watch mode — auto-fetch every 60s (Ctrl+C to stop)\n"
              << "  --cleanup <days>     Delete articles older than N days\n"
              << "  --impersonate-test <url> [browser]  Test curl-impersonate against a URL\n"
              << "  --config <path>      Use custom config file (default: config.json)\n"
              << "  --help               Show this help message\n"
              << std::endl;
}

struct FetchResult {
    int newArticles = 0;
    int duplicates = 0;
    int filtered = 0;
    int errors = 0;
    long long elapsedMs = 0;
};

// Core fetch logic reused by --fetch and --watch
FetchResult doFetch(Database& db, const Config& config, bool verbose,
                    const std::shared_ptr<IHttpClient>& httpClient = nullptr) {
    FetchResult result;
    Spinner spinner;
    auto totalStart = std::chrono::steady_clock::now();

    if (verbose) {
        std::cout << "Fetching " << config.rssFeeds.size() << " feeds...\n";
    }

    for (size_t idx = 0; idx < config.rssFeeds.size(); idx++) {
        const auto& feed = config.rssFeeds[idx];
        if (verbose) {
            spinner.start("Fetching [" + std::to_string(idx + 1) + "/" +
                           std::to_string(config.rssFeeds.size()) + "] " + feed.name + "...");
        }
        auto feedStart = std::chrono::steady_clock::now();
        try {
            std::unique_ptr<RSSSource> sourcePtr;
            if (httpClient) {
                sourcePtr = std::make_unique<RSSSource>(
                    feed.name, feed.url, httpClient, feed.category);
            } else {
                sourcePtr = std::make_unique<RSSSource>(
                    feed.name, feed.url, feed.category);
            }
            std::vector<NewsArticle> articles = sourcePtr->fetch();
            if (verbose) spinner.stop();

            int newCount = 0;
            int filteredCount = 0;
            for (auto article : articles) {
                if (!config.keywordFilter.passes(article.title, article.content)) {
                    filteredCount++;
                    continue;
                }
                article.sentiment = SentimentClassifier::toString(
                    SentimentClassifier::classify(article.title, article.content));
                if (db.insertArticle(article)) {
                    newCount++;
                } else {
                    result.duplicates++;
                }
            }

            auto feedMs = std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::steady_clock::now() - feedStart).count();

            result.newArticles += newCount;
            result.filtered += filteredCount;
            if (verbose) {
                int dupes = static_cast<int>(articles.size()) - newCount - filteredCount;
                std::cout << "  \033[32m+\033[0m " << feed.name << ": "
                          << newCount << " new, " << dupes << " duplicates";
                if (filteredCount > 0) {
                    std::cout << ", \033[90m" << filteredCount << " filtered\033[0m";
                }
                std::cout << " \033[90m(" << feedMs << "ms)\033[0m\n";
            }
        } catch (const std::exception& e) {
            if (verbose) spinner.stop();
            auto feedMs = std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::steady_clock::now() - feedStart).count();
            result.errors++;
            if (verbose) {
                std::cerr << "  \033[31mx\033[0m " << feed.name << ": " << e.what()
                          << " \033[90m(" << feedMs << "ms)\033[0m\n";
            }
            LOG_ERROR("Error fetching feed '" + feed.name + "': " + e.what());
        }
    }

    // ── IBKR Client Portal Gateway ───────────────────────────────────────────
    if (config.ibkrEnabled) {
        if (verbose) spinner.start("Fetching IBKR news...");
        auto feedStart = std::chrono::steady_clock::now();
        try {
            IBKRSource ibkrSrc(config.ibkr,
                               config.ibkr.gatewayUrl.empty() ? "markets" : "markets");
            auto articles = ibkrSrc.fetch();
            if (verbose) spinner.stop();
            int newCount = 0, filteredCount = 0;
            for (auto a : articles) {
                if (!config.keywordFilter.passes(a.title, a.content)) { filteredCount++; continue; }
                a.sentiment = SentimentClassifier::toString(
                    SentimentClassifier::classify(a.title, a.content));
                if (db.insertArticle(a)) newCount++;
                else result.duplicates++;
            }
            auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::steady_clock::now() - feedStart).count();
            result.newArticles += newCount;
            result.filtered += filteredCount;
            if (verbose) {
                std::cout << "  \033[32m+\033[0m IBKR: "
                          << newCount << " new, "
                          << (static_cast<int>(articles.size()) - newCount - filteredCount) << " duplicates";
                if (filteredCount > 0) std::cout << ", \033[90m" << filteredCount << " filtered\033[0m";
                std::cout << " \033[90m(" << ms << "ms)\033[0m\n";
            }
        } catch (const std::exception& e) {
            if (verbose) spinner.stop();
            result.errors++;
            LOG_ERROR("IBKR fetch error: " + std::string(e.what()));
            if (verbose) std::cerr << "  \033[31mx\033[0m IBKR: " << e.what() << "\n";
        }
    }

    // ── Schwab API ───────────────────────────────────────────────────────────
    if (config.schwabEnabled) {
        if (verbose) spinner.start("Fetching Schwab news...");
        auto feedStart = std::chrono::steady_clock::now();
        try {
            SchwabSource schwabSrc(config.schwab, httpClient ? httpClient
                                                             : std::make_shared<HttpClient>());
            auto articles = schwabSrc.fetch();
            if (verbose) spinner.stop();
            int newCount = 0, filteredCount = 0;
            for (auto a : articles) {
                if (!config.keywordFilter.passes(a.title, a.content)) { filteredCount++; continue; }
                a.sentiment = SentimentClassifier::toString(
                    SentimentClassifier::classify(a.title, a.content));
                if (db.insertArticle(a)) newCount++;
                else result.duplicates++;
            }
            auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::steady_clock::now() - feedStart).count();
            result.newArticles += newCount;
            result.filtered += filteredCount;
            if (verbose) {
                std::cout << "  \033[32m+\033[0m Schwab: "
                          << newCount << " new, "
                          << (static_cast<int>(articles.size()) - newCount - filteredCount) << " duplicates";
                if (filteredCount > 0) std::cout << ", \033[90m" << filteredCount << " filtered\033[0m";
                std::cout << " \033[90m(" << ms << "ms)\033[0m\n";
            }
        } catch (const std::exception& e) {
            if (verbose) spinner.stop();
            result.errors++;
            LOG_ERROR("Schwab fetch error: " + std::string(e.what()));
            if (verbose) std::cerr << "  \033[31mx\033[0m Schwab: " << e.what() << "\n";
        }
    }

    // ── TradingView ───────────────────────────────────────────────────────────
    if (config.tradingViewEnabled) {
        if (verbose) spinner.start("Fetching TradingView news...");
        auto feedStart = std::chrono::steady_clock::now();
        try {
            auto tvClient = httpClient ? httpClient : std::make_shared<HttpClient>();
            TradingViewSource tvSrc(config.tradingView, tvClient);
            auto articles = tvSrc.fetch();
            if (verbose) spinner.stop();
            int newCount = 0, filteredCount = 0;
            for (auto a : articles) {
                if (!config.keywordFilter.passes(a.title, a.content)) { filteredCount++; continue; }
                a.sentiment = SentimentClassifier::toString(
                    SentimentClassifier::classify(a.title, a.content));
                if (db.insertArticle(a)) newCount++;
                else result.duplicates++;
            }
            auto feedMs = std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::steady_clock::now() - feedStart).count();
            result.newArticles += newCount;
            result.filtered    += filteredCount;
            if (verbose) {
                std::cout << "  \033[32m+\033[0m TradingView: "
                          << newCount << " new, "
                          << (static_cast<int>(articles.size()) - newCount - filteredCount) << " duplicates";
                if (filteredCount > 0) std::cout << ", \033[90m" << filteredCount << " filtered\033[0m";
                std::cout << " \033[90m(" << feedMs << "ms)\033[0m\n";
            }
        } catch (const std::exception& e) {
            if (verbose) spinner.stop();
            result.errors++;
            LOG_ERROR("TradingView fetch error: " + std::string(e.what()));
            if (verbose) std::cerr << "  \033[31mx\033[0m TradingView: " << e.what() << "\n";
        }
    }

    // ── Finviz ───────────────────────────────────────────────────────────────
    if (config.finvizEnabled) {
        if (verbose) spinner.start("Fetching Finviz news...");
        auto feedStart = std::chrono::steady_clock::now();
        try {
            // Finviz needs Curl Impersonate to bypass Cloudflare
            auto fvClient = httpClient ? httpClient : std::make_shared<HttpClient>();
            FinvizSource finvizSrc(config.finviz, fvClient);
            auto articles = finvizSrc.fetch();
            if (verbose) spinner.stop();
            int newCount = 0, filteredCount = 0;
            for (const auto& a : articles) {
                if (!config.keywordFilter.passes(a.title, a.content)) { filteredCount++; continue; }
                if (db.insertArticle(a)) newCount++;
                else result.duplicates++;
            }
            auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::steady_clock::now() - feedStart).count();
            result.newArticles += newCount;
            result.filtered += filteredCount;
            if (verbose) {
                std::cout << "  \033[32m+\033[0m Finviz: "
                          << newCount << " new, "
                          << (static_cast<int>(articles.size()) - newCount - filteredCount) << " duplicates";
                if (filteredCount > 0) std::cout << ", \033[90m" << filteredCount << " filtered\033[0m";
                std::cout << " \033[90m(" << ms << "ms)\033[0m\n";
            }
        } catch (const std::exception& e) {
            if (verbose) spinner.stop();
            result.errors++;
            LOG_ERROR("Finviz fetch error: " + std::string(e.what()));
            if (verbose) std::cerr << "  \033[31mx\033[0m Finviz: " << e.what() << "\n";
        }
    }

    result.elapsedMs = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now() - totalStart).count();
    return result;
}

void fetchCommand(const Config& config) {
    Database db(config.databasePath);
    if (!db.initialize()) {
        LOG_ERROR("Failed to initialize database");
        return;
    }

    auto httpClient = createHttpClient(config);
    FetchResult r = doFetch(db, config, true, httpClient);

    std::cout << "\nFetch Summary:\n"
              << "  New articles: " << r.newArticles << "\n"
              << "  Duplicates:   " << r.duplicates << "\n"
              << "  Filtered out: " << r.filtered << "\n"
              << "  Errors:       " << r.errors << "\n"
              << "  Total in DB:  " << db.getTotalArticleCount() << "\n"
              << "  Completed in: " << r.elapsedMs << "ms\n"
              << std::endl;
}

void watchCommand(const Config& config, int intervalSec) {
    Database db(config.databasePath);
    if (!db.initialize()) {
        LOG_ERROR("Failed to initialize database");
        return;
    }

    std::signal(SIGINT, signalHandler);
    std::signal(SIGTERM, signalHandler);

    auto httpClient = createHttpClient(config);

    // ── Finviz elite background thread (10s cadence, independent of main loop) ──
    std::thread finvizThread;
    if (config.finvizEnabled) {
        int fvInterval = config.finvizWatchIntervalSec;
        finvizThread = std::thread([&config, &db, &httpClient, fvInterval]() {
            LOG_INFO("Finviz background poller started (" +
                     std::to_string(fvInterval) + "s interval)");
            while (g_running) {
                try {
                    auto fvClient = httpClient ? httpClient : std::make_shared<HttpClient>();
                    FinvizSource fvSrc(config.finviz, fvClient);
                    auto articles = fvSrc.fetch();
                    int added = 0;
                    for (auto a : articles) {
                        if (!config.keywordFilter.passes(a.title, a.content)) continue;
                        a.sentiment = SentimentClassifier::toString(
                            SentimentClassifier::classify(a.title, a.content));
                        if (db.insertArticle(a)) added++;
                    }
                    if (added > 0) {
                        LOG_INFO("Finviz poller: " + std::to_string(added) + " new articles");
                    }
                } catch (const std::exception& e) {
                    LOG_ERROR("Finviz poller error: " + std::string(e.what()));
                }
                for (int s = 0; s < fvInterval && g_running; s++) {
                    std::this_thread::sleep_for(std::chrono::seconds(1));
                }
            }
            LOG_INFO("Finviz background poller stopped");
        });
    }

    std::cout << "\033[1mFeedFlash Watch Mode\033[0m — polling every "
              << intervalSec << "s (Ctrl+C to stop)";
    if (config.finvizEnabled) {
        std::cout << " | Finviz background: every "
                  << config.finvizWatchIntervalSec << "s";
    }
    std::cout << "\n" << std::string(50, '-') << "\n\n";

    int cycle = 0;
    while (g_running) {
        cycle++;

        // Get current time for display
        time_t now = time(nullptr);
        struct tm* t = localtime(&now);
        char timeBuf[32];
        strftime(timeBuf, sizeof(timeBuf), "%H:%M:%S", t);

        std::cout << "\033[36m[" << timeBuf << "]\033[0m Cycle #" << cycle << " — ";
        std::cout.flush();

        FetchResult r = doFetch(db, config, false, httpClient);

        if (r.newArticles > 0) {
            std::cout << "\033[32m" << r.newArticles << " new article"
                      << (r.newArticles == 1 ? "" : "s") << "\033[0m";
        } else {
            std::cout << "no new articles";
        }
        std::cout << ", " << r.duplicates << " dupes";
        if (r.errors > 0) {
            std::cout << ", \033[31m" << r.errors << " error"
                      << (r.errors == 1 ? "" : "s") << "\033[0m";
        }
        std::cout << " \033[90m(" << r.elapsedMs << "ms)\033[0m";

        // Show new article titles inline
        if (r.newArticles > 0) {
            auto recent = db.getRecentArticles(r.newArticles);
            for (const auto& a : recent) {
                std::cout << "\n    \033[33m>\033[0m " << a.title
                          << " \033[90m[" << a.source << "]\033[0m";
            }
        }
        std::cout << "\n";

        // Wait for the interval, checking g_running every second for responsiveness
        for (int s = 0; s < intervalSec && g_running; s++) {
            std::this_thread::sleep_for(std::chrono::seconds(1));
        }
    }

    if (finvizThread.joinable()) finvizThread.join();

    std::cout << "\n\033[1mWatch stopped.\033[0m Total in DB: "
              << db.getTotalArticleCount() << "\n";
}

void listCommand(const Config& config, int limit) {
    Database db(config.databasePath);
    if (!db.initialize()) {
        LOG_ERROR("Failed to initialize database");
        return;
    }

    Spinner spinner;
    spinner.start("Loading articles...");
    auto queryStart = std::chrono::steady_clock::now();
    auto articles = db.getRecentArticles(limit);
    auto queryMs = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now() - queryStart).count();
    spinner.stop();

    if (articles.empty()) {
        std::cout << "No articles found. Run --fetch first.\n";
        return;
    }

    std::cout << "Recent Articles (" << articles.size()
              << ") \033[90m[" << queryMs << "ms]\033[0m:\n"
              << std::string(60, '-') << "\n";

    for (size_t i = 0; i < articles.size(); i++) {
        std::cout << (i + 1) << ". " << articles[i].toString() << "\n"
                  << std::string(60, '-') << "\n";
    }
}

void listBySourceCommand(const Config& config, const std::string& source, int limit) {
    Database db(config.databasePath);
    if (!db.initialize()) {
        LOG_ERROR("Failed to initialize database");
        return;
    }

    Spinner spinner;
    spinner.start("Loading articles from " + source + "...");
    auto queryStart = std::chrono::steady_clock::now();
    auto articles = db.getArticlesBySource(source, limit);
    auto queryMs = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now() - queryStart).count();
    spinner.stop();

    if (articles.empty()) {
        std::cout << "No articles found for source: " << source << "\n";
        return;
    }

    std::cout << "Articles from '" << source << "' (" << articles.size()
              << ") \033[90m[" << queryMs << "ms]\033[0m:\n"
              << std::string(60, '-') << "\n";

    for (size_t i = 0; i < articles.size(); i++) {
        std::cout << (i + 1) << ". " << articles[i].toString() << "\n"
                  << std::string(60, '-') << "\n";
    }
}

void listByCategoryCommand(const Config& config, const std::string& category, int limit) {
    Database db(config.databasePath);
    if (!db.initialize()) {
        LOG_ERROR("Failed to initialize database");
        return;
    }

    Spinner spinner;
    spinner.start("Loading " + category + " articles...");
    auto queryStart = std::chrono::steady_clock::now();
    auto articles = db.getArticlesByCategory(category, limit);
    auto queryMs = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now() - queryStart).count();
    spinner.stop();

    if (articles.empty()) {
        std::cout << "No articles found for category: " << category << "\n";
        return;
    }

    std::cout << "Articles in category '" << category << "' (" << articles.size()
              << ") \033[90m[" << queryMs << "ms]\033[0m:\n"
              << std::string(60, '-') << "\n";

    for (size_t i = 0; i < articles.size(); i++) {
        std::cout << (i + 1) << ". " << articles[i].toString() << "\n"
                  << std::string(60, '-') << "\n";
    }
}

void statsCommand(const Config& config) {
    Database db(config.databasePath);
    if (!db.initialize()) {
        LOG_ERROR("Failed to initialize database");
        return;
    }

    Spinner spinner;
    spinner.start("Crunching stats...");
    auto queryStart = std::chrono::steady_clock::now();
    int total = db.getTotalArticleCount();

    std::vector<std::pair<std::string, int>> sourceCounts;
    if (total > 0) {
        for (const auto& feed : config.rssFeeds) {
            sourceCounts.emplace_back(feed.name, db.getArticleCountBySource(feed.name));
        }
    }
    auto queryMs = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now() - queryStart).count();
    spinner.stop();

    std::cout << "FeedFlash Database Statistics \033[90m[" << queryMs << "ms]\033[0m\n"
              << std::string(40, '=') << "\n"
              << "Total articles: " << total << "\n\n";

    if (total > 0) {
        std::cout << "Articles by source:\n";
        for (const auto& sc : sourceCounts) {
            std::cout << "  " << sc.first << ": " << sc.second << "\n";
        }
    }

    std::cout << std::endl;
}

void impersonateTestCommand(const Config& config, const std::string& url,
                            const std::string& browser) {
    ImpersonateConfig ic = config.impersonateConfig;
    ic.verbose = true;  // Always verbose for test
    if (!browser.empty()) {
        ic.preferredBrowser = browser;
    }

    CurlImpersonate client(ic);

    if (!client.isAvailable()) {
        std::cerr << "curl-impersonate is NOT installed.\n\n"
                  << "Install it from: https://github.com/lwthiker/curl-impersonate\n\n"
                  << "Quick install (Ubuntu/Debian):\n"
                  << "  # Chrome variant:\n"
                  << "  curl -Lo /tmp/curl-impersonate.deb \\\n"
                  << "    https://github.com/lwthiker/curl-impersonate/releases/download/"
                  << "v0.6.1/curl-impersonate-chrome-0.6.1.x86_64-linux-gnu.deb\n"
                  << "  sudo dpkg -i /tmp/curl-impersonate.deb\n\n"
                  << "  # Firefox variant:\n"
                  << "  curl -Lo /tmp/curl-impersonate-ff.deb \\\n"
                  << "    https://github.com/lwthiker/curl-impersonate/releases/download/"
                  << "v0.6.1/curl-impersonate-ff-0.6.1.x86_64-linux-gnu.deb\n"
                  << "  sudo dpkg -i /tmp/curl-impersonate-ff.deb\n";
        return;
    }

    std::cout << "Testing curl-impersonate against: " << url << "\n"
              << "Browser: " << ic.preferredBrowser << "\n"
              << "Available profiles: ";
    auto profiles = client.listProfiles();
    for (size_t i = 0; i < profiles.size(); ++i) {
        if (i > 0) std::cout << ", ";
        std::cout << profiles[i];
    }
    std::cout << "\n" << std::string(60, '-') << "\n";

    // Enable console logging temporarily for verbose output
    Logger::getInstance()->setQuiet(false);

    auto resp = client.getDetailed(url);

    Logger::getInstance()->setQuiet(true);

    std::cout << "\n" << std::string(60, '-') << "\n"
              << "Result:\n"
              << "  Success:       " << (resp.success ? "YES" : "NO") << "\n"
              << "  HTTP Code:     " << resp.httpCode << "\n"
              << "  TLS Version:   " << resp.tlsVersion << "\n"
              << "  Effective URL: " << resp.effectiveUrl << "\n"
              << "  Body size:     " << resp.body.size() << " bytes\n";

    if (!resp.error.empty()) {
        std::cout << "  Error:         " << resp.error << "\n";
    }

    // Show first 500 chars of body
    if (!resp.body.empty()) {
        std::cout << "\nBody preview (first 500 chars):\n"
                  << std::string(40, '-') << "\n"
                  << resp.body.substr(0, 500) << "\n";
        if (resp.body.size() > 500) {
            std::cout << "... (" << (resp.body.size() - 500) << " more bytes)\n";
        }
    }
}

void cleanupCommand(const Config& config, int days) {
    Database db(config.databasePath);
    if (!db.initialize()) {
        LOG_ERROR("Failed to initialize database");
        return;
    }

    auto start = std::chrono::steady_clock::now();
    db.deleteOldArticles(days);
    auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now() - start).count();
    std::cout << "Cleanup complete. Remaining articles: "
              << db.getTotalArticleCount()
              << " \033[90m(" << ms << "ms)\033[0m\n";
}

int main(int argc, char* argv[]) {
    if (argc < 2) {
        printUsage(argv[0]);
        return 1;
    }

    std::string configPath = "config.json";

    // Pre-scan for --config flag
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--config") == 0 && i + 1 < argc) {
            configPath = argv[i + 1];
            break;
        }
    }

    // Initialize logger before loading config (basic setup)
    Logger::getInstance()->setLogLevel(LogLevel::INFO);

    Config config = loadConfig(configPath);

    // Apply config to logger
    Logger::getInstance()->setLogLevel(Logger::parseLevel(config.logLevel));
    if (!config.logFile.empty()) {
        Logger::getInstance()->setLogFile(config.logFile);
    }
    // Suppress console log noise; logs still go to file
    Logger::getInstance()->setQuiet(true);

    // Parse and execute command
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--help") == 0 || strcmp(argv[i], "-h") == 0) {
            printUsage(argv[0]);
            return 0;
        }
        else if (strcmp(argv[i], "--fetch") == 0) {
            if (config.rssFeeds.empty()) {
                std::cerr << "No feeds configured. Edit config.json to add RSS feed URLs.\n";
                return 1;
            }
            fetchCommand(config);
            return 0;
        }
        else if (strcmp(argv[i], "--list") == 0) {
            int limit = 20;
            if (i + 1 < argc && argv[i + 1][0] != '-') {
                try {
                    limit = std::stoi(argv[i + 1]);
                } catch (...) {
                    // Keep default
                }
            }
            listCommand(config, limit);
            return 0;
        }
        else if (strcmp(argv[i], "--source") == 0) {
            if (i + 1 >= argc) {
                std::cerr << "Error: --source requires a source name\n";
                return 1;
            }
            std::string source = argv[i + 1];
            int limit = 20;
            if (i + 2 < argc && argv[i + 2][0] != '-') {
                try {
                    limit = std::stoi(argv[i + 2]);
                } catch (...) {}
            }
            listBySourceCommand(config, source, limit);
            return 0;
        }
        else if (strcmp(argv[i], "--category") == 0) {
            if (i + 1 >= argc) {
                std::cerr << "Error: --category requires a category name\n";
                return 1;
            }
            std::string cat = argv[i + 1];
            int limit = 20;
            if (i + 2 < argc && argv[i + 2][0] != '-') {
                try {
                    limit = std::stoi(argv[i + 2]);
                } catch (...) {}
            }
            listByCategoryCommand(config, cat, limit);
            return 0;
        }
        else if (strcmp(argv[i], "--watch") == 0) {
            if (config.rssFeeds.empty()) {
                std::cerr << "No feeds configured. Edit config.json to add RSS feed URLs.\n";
                return 1;
            }
            int interval = 60;
            if (i + 1 < argc) {
                char* end;
                long v = std::strtol(argv[i + 1], &end, 10);
                if (end != argv[i + 1] && v > 0) {
                    interval = static_cast<int>(v);
                    i++;
                }
            }
            watchCommand(config, interval);
            return 0;
        }
        else if (strcmp(argv[i], "--stats") == 0) {
            statsCommand(config);
            return 0;
        }
        else if (strcmp(argv[i], "--cleanup") == 0) {
            if (i + 1 >= argc) {
                std::cerr << "Error: --cleanup requires number of days\n";
                return 1;
            }
            int days = 30;
            try {
                days = std::stoi(argv[i + 1]);
            } catch (...) {
                std::cerr << "Invalid number of days\n";
                return 1;
            }
            cleanupCommand(config, days);
            return 0;
        }
        else if (strcmp(argv[i], "--impersonate-test") == 0) {
            if (i + 1 >= argc) {
                std::cerr << "Error: --impersonate-test requires a URL\n";
                return 1;
            }
            std::string url = argv[i + 1];
            std::string browser;
            if (i + 2 < argc && argv[i + 2][0] != '-') {
                browser = argv[i + 2];
            }
            impersonateTestCommand(config, url, browser);
            return 0;
        }
        else if (strcmp(argv[i], "--config") == 0) {
            i++;  // Skip config path, already handled
            continue;
        }
        else {
            std::cerr << "Unknown option: " << argv[i] << "\n\n";
            printUsage(argv[0]);
            return 1;
        }
    }

    return 0;
}
