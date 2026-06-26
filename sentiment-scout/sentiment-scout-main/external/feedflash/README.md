# FeedFlash - RSS News Aggregator

A C++17 command-line news aggregation system that fetches, parses, and stores articles from RSS/Atom feeds in a local SQLite database. Includes **curl-impersonate** integration for bypassing Cloudflare and bot detection via browser TLS fingerprinting.

---

## Docker (Recommended)

The Docker image bundles everything: the C++ RSS aggregator, Bun web server (dashboard + REST API), and the Python sentiment service — no local build required.

### Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (Mac/Windows) or Docker Engine + Docker Compose (Linux)

### Quick start

```bash
# Clone the repo
git clone https://github.com/your-username/FeedFlash.git
cd FeedFlash

# Build and start (first run takes a few minutes — downloads FinBERT model ~1.5 GB)
docker compose up --build

# Open the dashboard
open http://localhost:3000
```

The dashboard auto-loads. Articles are fetched via the web UI; the sentiment service starts automatically on port 5001.

### Common commands

```bash
# Start in the background (detached)
docker compose up --build -d

# View live logs
docker compose logs -f

# Stop the container
docker compose down

# Rebuild after code changes
docker compose up --build

# Open a shell inside the running container
docker compose exec app sh
```

### Ports

| Port | Service |
|------|---------|
| `3000` | Web dashboard + REST API |
| `5001` | Python sentiment microservice |

### Persistent data

Article database, logs, and config are stored in a named Docker volume (`flashfeed-data`) so they survive container restarts.

```bash
# See where Docker stores the volume
docker volume inspect feedflash_flashfeed-data

# Wipe all data and start fresh
docker compose down -v
```

### Custom config

Mount your own `config.json` by placing it at `/data/config.json` inside the container, or override at startup:

```bash
APP_PORT=8080 docker compose up -d        # Use port 8080 instead of 3000
```

| Variable | Default | Description |
|----------|---------|-------------|
| `APP_PORT` | `3000` | Host port for the web dashboard |
| `SENTIMENT_PORT` | `5001` | Host port for the sentiment service |
| `FLASHFEED_DATA` | `/data` | Data directory inside the container |

### Build without Compose (advanced)

```bash
# Build the image manually
docker build -t feedflash .

# Run it
docker run -d \
  -p 3000:3000 \
  -p 5001:5001 \
  -v feedflash-data:/data \
  --name feedflash \
  feedflash
```

---

## Features

- Fetches RSS 2.0 and Atom feed formats
- Google Alerts RSS feed support with URL unwrapping
- **curl-impersonate integration** — impersonate Chrome/Firefox/Safari TLS fingerprints
- **Browser profile rotation** with weighted random selection
- **Retry with exponential backoff** on bot detection (403/429)
- SQLite storage with automatic deduplication (by URL)
- Watch mode with auto-polling
- CLI for fetching, listing, filtering, and statistics
- JSON-based configuration
- Thread-safe HTTP clients
- File and console logging

## Dependencies

| Dependency | Purpose | Required |
|------------|---------|----------|
| libcurl | HTTP fetching | Yes |
| SQLite3 | Article storage | Yes |
| pugixml | XML/RSS parsing | Yes |
| nlohmann/json | JSON configuration (header-only) | Yes |
| CMake 3.14+ | Build system | Yes |
| C++17 compiler | GCC 7+, Clang 5+ | Yes |
| curl-impersonate | Browser TLS fingerprinting | Optional |

### Install build dependencies

**Ubuntu/Debian:**
```bash
sudo apt install cmake libcurl4-openssl-dev libsqlite3-dev libpugixml-dev nlohmann-json3-dev
```

**macOS:**
```bash
brew install cmake sqlite3 curl pugixml nlohmann-json
```

**Conda:**
```bash
conda create -n feedflash cmake sqlite libcurl pugixml nlohmann_json pkg-config gcc_linux-64 gxx_linux-64 -c conda-forge
conda activate feedflash
```

### Install curl-impersonate (optional)

curl-impersonate provides modified curl binaries that produce browser-identical TLS fingerprints. Without it, FeedFlash falls back to standard libcurl (which gets blocked by Cloudflare).

**Ubuntu/Debian (x86_64):**
```bash
# Chrome variant (recommended — best Cloudflare bypass rate)
curl -Lo /tmp/curl-impersonate.deb \
  https://github.com/lwthiker/curl-impersonate/releases/download/v0.6.1/curl-impersonate-chrome-0.6.1.x86_64-linux-gnu.deb
sudo dpkg -i /tmp/curl-impersonate.deb

# Firefox variant (optional — adds more profile diversity)
curl -Lo /tmp/curl-impersonate-ff.deb \
  https://github.com/lwthiker/curl-impersonate/releases/download/v0.6.1/curl-impersonate-ff-0.6.1.x86_64-linux-gnu.deb
sudo dpkg -i /tmp/curl-impersonate-ff.deb
```

**Verify installation:**
```bash
which curl_chrome120    # should print /usr/local/bin/curl_chrome120
curl_chrome120 -V       # should show curl version with BoringSSL
```

See the [curl-impersonate releases page](https://github.com/lwthiker/curl-impersonate/releases) for other platforms.

## Build

```bash
mkdir build && cd build

# Standard build:
cmake ..

# If using conda:
cmake .. -DCMAKE_PREFIX_PATH=$CONDA_PREFIX

make -j$(nproc)
```

## Configuration

Edit `config.json`:

```json
{
  "database": {
    "path": "./feedflash.db"
  },
  "sources": {
    "google_alerts": [
      {
        "name": "BBC Tech",
        "url": "https://feeds.bbci.co.uk/news/technology/rss.xml",
        "category": "technology"
      }
    ]
  },
  "impersonation": {
    "enabled": false,
    "preferred_browser": "rotate",
    "max_retries": 3,
    "backoff_base_ms": 500,
    "backoff_max_ms": 30000,
    "timeout_seconds": 30,
    "connect_timeout_seconds": 10,
    "follow_redirects": true,
    "max_redirects": 5,
    "verbose": false,
    "cookie_jar": "",
    "curl_impersonate_path": ""
  },
  "logging": {
    "level": "info",
    "file": "./feedflash.log"
  }
}
```

### Impersonation config reference

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | bool | `false` | Enable curl-impersonate for all fetches |
| `preferred_browser` | string | `"rotate"` | `"chrome"`, `"firefox"`, `"safari"`, or `"rotate"` |
| `max_retries` | int | `3` | Retry count on failure/bot detection |
| `backoff_base_ms` | double | `500` | Base delay for exponential backoff (ms) |
| `backoff_max_ms` | double | `30000` | Maximum backoff delay cap (ms) |
| `timeout_seconds` | long | `30` | Request timeout |
| `connect_timeout_seconds` | long | `10` | TCP connection timeout |
| `follow_redirects` | bool | `true` | Follow HTTP 3xx redirects |
| `max_redirects` | long | `5` | Maximum redirect chain length |
| `verbose` | bool | `false` | Log TLS handshake details (debug) |
| `cookie_jar` | string | `""` | Path to cookie file for persistent sessions |
| `curl_impersonate_path` | string | `""` | Custom path to curl-impersonate binaries |

## Usage

```bash
# Fetch all configured feeds
./feedflash --fetch

# List 20 most recent articles
./feedflash --list

# List 10 most recent articles
./feedflash --list 10

# Filter by source name
./feedflash --source "BBC Tech" 5

# Filter by category
./feedflash --category technology 10

# Watch mode — auto-fetch every 60s
./feedflash --watch

# Show database statistics
./feedflash --stats

# Delete articles older than 30 days
./feedflash --cleanup 30

# Test curl-impersonate against a URL
./feedflash --impersonate-test https://www.tradingview.com chrome

# Use custom config file
./feedflash --config /path/to/config.json --fetch

# Show help
./feedflash --help
```

---

## Standard curl vs curl-impersonate

### How they differ

| | Standard curl (`HttpClient`) | curl-impersonate (`CurlImpersonate`) |
|---|---|---|
| **How it runs** | In-process via libcurl C API (`curl_easy_perform`) | Spawns external binary via `popen()` (`curl_chrome116`, `curl_ff117`, etc.) |
| **TLS library** | System OpenSSL/GnuTLS | BoringSSL (Chrome), NSS (Firefox), LibreSSL (Safari) |
| **TLS fingerprint** | Generic curl fingerprint — easily identified by bot detection | Identical to a real browser — passes JA3/JA4 fingerprint checks |
| **HTTP headers** | Minimal: just `User-Agent` and `Accept-Encoding` | Full browser header set: `sec-ch-ua`, `Sec-Fetch-*`, `Upgrade-Insecure-Requests`, etc. |
| **User-Agent** | `"FeedFlash/1.0"` (or custom string) | Real browser UA matching the profile (e.g. Chrome 116 on Windows 10) |
| **HTTP/2 behavior** | Standard libcurl HTTP/2 | Browser-identical HTTP/2 settings (header order, window size, priority frames) |
| **Speed** | Fast — single function call, no process spawn | Slower — forks a subprocess per request |
| **Memory** | Low — single CURL handle reused | Higher — new process per request |
| **Thread safety** | One CURL handle per instance (non-copyable) | Mutex-serialized; for parallelism create multiple instances |
| **Dependencies** | libcurl (always installed) | curl-impersonate binaries (optional, ~7MB) |
| **Retry logic** | None — single attempt, returns empty on failure | Exponential backoff with jitter, rotates browser profiles between retries |
| **Cookie handling** | None | Optional persistent cookie jar via `-b`/`-c` flags |
| **Cloudflare bypass** | No — blocked with 403 | Yes — passes as real browser |

### When to use which

**Use standard curl (`"enabled": false`)** when:
- Fetching RSS/Atom feeds from cooperative sources (BBC, HN, ArsTechnica)
- The source doesn't use Cloudflare or bot detection
- Speed matters — in-process libcurl is ~10x faster per request
- You don't want the curl-impersonate dependency

**Use curl-impersonate (`"enabled": true`)** when:
- Sources block standard curl with 403/503 (Cloudflare, Akamai, etc.)
- You need to scrape sites like TradingView that aggressively fingerprint TLS
- You need to look like a real browser at the network level
- You're willing to trade speed for access

### Pros and cons

#### Standard curl (`HttpClient`)

**Pros:**
- Fast (~300ms per feed vs ~500ms+ with impersonate)
- No extra dependencies — libcurl ships with every Linux distro
- Low resource usage — single in-process handle, no fork/exec
- Simple and reliable for 90% of RSS feeds
- No shell execution — no injection risk surface

**Cons:**
- Trivially detected by bot protection (JA3 fingerprint = "curl")
- `User-Agent: FeedFlash/1.0` screams "scraper"
- No retry logic — one failure and it returns empty
- No cookie persistence across requests
- Cloudflare, Akamai, Imperva will block it instantly

#### curl-impersonate (`CurlImpersonate`)

**Pros:**
- Bypasses Cloudflare, Akamai, and most TLS-based bot detection
- 14 browser profiles (Chrome, Firefox, Edge, Safari) with weighted rotation
- Each retry uses a different profile — harder to pattern-match
- Exponential backoff with jitter prevents rate limiting
- Full browser headers (sec-ch-ua, Sec-Fetch-*, etc.) included automatically
- Cookie jar support for session persistence
- TLS debug logging for troubleshooting

**Cons:**
- Slower — spawns a new process per request (~200ms overhead)
- Requires curl-impersonate binaries installed (~7MB on disk)
- Shell execution via `popen()` — URLs are escaped but it's an additional attack surface
- Mutex serializes requests within a single instance (create multiple for parallelism)
- Wrapper scripts are frozen in time — browser versions don't auto-update
- Won't bypass JavaScript challenges (Cloudflare "checking your browser" page) — only TLS fingerprinting
- Safari profiles use TLSv1.2, which some modern sites may not prefer

### Real-world performance comparison

Tested against the same 3 feeds (BBC Tech, Hacker News, ArsTechnica):

```
Standard curl:    1,114ms total (3 feeds, ~370ms avg per feed)
curl-impersonate: ~1,600ms total (3 feeds, ~530ms avg per feed)
```

Against Cloudflare-protected TradingView:

```
Standard curl:    403 Forbidden (blocked)
curl-impersonate: 200 OK, 977KB in ~1.2s (success)
```

The ~40% speed penalty is irrelevant when the alternative is a 403.

### Try it yourself

You can reproduce the difference with two commands:

**Standard curl (gets blocked):**
```bash
curl -s -o /dev/null -w "Standard curl: HTTP %{http_code}, %{size_download} bytes\n" \
  -A "FeedFlash/1.0" https://www.ssense.com/en-us
```

**curl-impersonate (bypasses Cloudflare):**
```bash
./build/feedflash --impersonate-test https://www.ssense.com/en-us chrome
```

Expected output:
```
# Standard curl:
Standard curl: HTTP 403, 6994 bytes        ← Cloudflare "Just a moment..." block page

# curl-impersonate:
Result:
  Success:       YES
  HTTP Code:     200                        ← Real page content
  Body size:     521492 bytes
```

The 403 response from standard curl contains Cloudflare's challenge page (`<title>Just a moment...</title>`). curl-impersonate gets the actual site (`<title>Luxury fashion & independent designers | SSENSE</title>`).

---

## curl-impersonate: In-Depth Technical Guide

### Why standard curl gets blocked

When curl connects to a Cloudflare-protected site, the TLS ClientHello message reveals it's not a browser:

```
Standard curl TLS ClientHello:
  - Cipher suites: 30+ ciphers in generic order
  - TLS extensions: minimal set
  - ALPN: h2, http/1.1
  - Signature algorithms: generic list
  → Cloudflare JA3 fingerprint: "curl/libcurl" → BLOCKED (403)

Chrome 120 TLS ClientHello:
  - Cipher suites: 15 specific ciphers in Chrome's exact order
  - TLS extensions: 16 extensions matching Chrome exactly
  - ALPN: h2, http/1.1 (with Chrome's GREASE values)
  - Signature algorithms: Chrome's specific list
  → Cloudflare JA3 fingerprint: "Chrome/120" → ALLOWED (200)
```

curl-impersonate solves this by providing modified curl binaries compiled against the same TLS libraries browsers use (BoringSSL for Chrome, NSS for Firefox). The TLS handshake becomes indistinguishable from a real browser.

### Architecture

```
                        config.json
                            |
                    "impersonation.enabled"
                            |
                   createHttpClient(config)         ← src/main.cpp:76
                       /           \
                 enabled=true    enabled=false
                      |               |
              CurlImpersonate     HttpClient
                      |               |
             both implement IHttpClient
                      |               |
                      \______   ______/
                             | |
                    shared_ptr<IHttpClient>
                             |
                  GoogleAlertsSource / RSSSource
                             |
                     httpClient->get(url)
```

#### The interface — `IHttpClient`

**File:** `include/utils/IHttpClient.h`

```cpp
class IHttpClient {
public:
    virtual ~IHttpClient() = default;
    virtual std::string get(const std::string& url) = 0;
    virtual void setTimeout(long seconds) = 0;
    virtual void setUserAgent(const std::string& ua) = 0;
    virtual std::string getLastError() const = 0;
};
```

This is the polymorphic base. Both `HttpClient` (standard libcurl) and `CurlImpersonate` implement it. All news source classes (`RSSSource`, `GoogleAlertsSource`) hold a `shared_ptr<IHttpClient>` and are unaware of which implementation they're using.

#### Constructor injection

**File:** `include/sources/RSSSource.h`

```cpp
class RSSSource : public NewsSource {
protected:
    std::shared_ptr<IHttpClient> httpClient;

public:
    // Default: creates standard HttpClient internally
    RSSSource(const std::string& name, const std::string& url,
              const std::string& category = "general");

    // Injection: caller provides the HTTP client
    RSSSource(const std::string& name, const std::string& url,
              std::shared_ptr<IHttpClient> client,
              const std::string& category = "general");
};
```

When `impersonation.enabled = true`, `main.cpp` creates a `CurlImpersonate` instance and injects it into every source via the second constructor. When disabled, sources create their own `HttpClient` internally via the first constructor.

#### Factory function

**File:** `src/main.cpp:76`

```cpp
std::shared_ptr<IHttpClient> createHttpClient(const Config& config) {
    if (config.impersonationEnabled) {
        auto client = std::make_shared<CurlImpersonate>(config.impersonateConfig);
        if (client->isAvailable()) {
            return client;                    // Use curl-impersonate
        }
        LOG_WARNING("curl-impersonate not available, falling back");
    }
    return std::make_shared<HttpClient>();    // Standard libcurl
}
```

This checks:
1. Is impersonation enabled in config?
2. Are curl-impersonate binaries actually installed?
3. Falls back gracefully to standard curl if not.

### CurlImpersonate class deep dive

**Files:** `include/utils/CurlImpersonate.h`, `src/utils/CurlImpersonate.cpp`

#### Data structures

```cpp
struct BrowserProfile {
    std::string name;         // "chrome120", "firefox121", "safari17"
    std::string binaryName;   // "curl_chrome120" — the actual binary on disk
    std::string userAgent;    // Full browser User-Agent string
    std::string tlsVersion;   // "TLSv1.3" or "TLSv1.2" — for logging
    int weight;               // Selection probability weight
};
```

Each profile maps to a specific curl-impersonate binary. The `weight` controls how often it's selected during rotation — higher weight = more likely.

```cpp
struct ImpersonateResponse {
    std::string body;          // Response body
    long httpCode;             // HTTP status code (200, 403, etc.)
    std::string effectiveUrl;  // Final URL after redirects
    std::string tlsVersion;    // Negotiated TLS version
    std::string tlsCipher;     // Negotiated cipher suite
    std::string error;         // Error message if failed
    bool success;              // true if HTTP 2xx/3xx and no errors
};
```

Extended response type returned by `getDetailed()`. The simple `get()` from `IHttpClient` only returns the body string.

```cpp
struct ImpersonateConfig {
    std::string preferredBrowser;    // "chrome", "firefox", "safari", "rotate"
    int maxRetries;                  // Number of retry attempts
    double backoffBaseMs;            // Base delay: 500ms
    double backoffMaxMs;             // Max delay cap: 30000ms
    long timeoutSeconds;             // Per-request timeout
    long connectTimeoutSeconds;      // TCP connect timeout
    bool followRedirects;            // Follow 3xx redirects
    long maxRedirects;               // Max redirect chain
    bool verbose;                    // Log TLS handshake details
    std::string cookieJarPath;       // Cookie file path
    std::string curlImpersonatePath; // Custom binary search path
};
```

All runtime-configurable parameters, loaded from `config.json`.

#### Class internals

```cpp
class CurlImpersonate : public IHttpClient {
private:
    ImpersonateConfig config_;               // Runtime configuration
    std::vector<BrowserProfile> profiles_;   // 9 built-in browser profiles
    mutable std::mutex mutex_;               // Thread safety
    std::mt19937 rng_;                       // Random number generator for rotation
    std::string lastError_;                  // Last error message
    std::string customUserAgent_;            // Custom UA override
    // ...
};
```

Key design decisions:
- **`mutable std::mutex`** — allows `getLastError()` (const method) to lock
- **`std::mt19937`** — Mersenne Twister PRNG seeded from `steady_clock` for profile rotation
- **Non-copyable** — deleted copy constructor/assignment (holds mutex + RNG state)

#### Built-in profiles

**`initProfiles()`** — called in constructor, sets up 9 profiles:

| Profile | Binary | TLS Library | TLS Version | Weight |
|---------|--------|-------------|-------------|--------|
| `chrome120` | `curl_chrome120` | BoringSSL | TLSv1.3 | 30 |
| `chrome116` | `curl_chrome116` | BoringSSL | TLSv1.3 | 20 |
| `chrome110` | `curl_chrome110` | BoringSSL | TLSv1.3 | 15 |
| `chrome99` | `curl_chrome99` | BoringSSL | TLSv1.3 | 10 |
| `firefox121` | `curl_ff121` | NSS | TLSv1.3 | 25 |
| `firefox117` | `curl_ff117` | NSS | TLSv1.3 | 15 |
| `firefox109` | `curl_ff109` | NSS | TLSv1.3 | 10 |
| `safari17` | `curl_safari17_0` | LibreSSL | TLSv1.3 | 15 |
| `safari15_5` | `curl_safari15_5` | LibreSSL | TLSv1.2 | 10 |

Total weight = 150. chrome120 has 30/150 = 20% selection probability, firefox121 has 25/150 = ~17%, etc.

#### Profile selection — `selectProfile()`

```cpp
const BrowserProfile& CurlImpersonate::selectProfile() {
    // 1. Filter candidates by preferred_browser
    //    "rotate" → all profiles
    //    "chrome" → only profiles whose name starts with "chrome"
    //    "firefox" → only profiles whose name starts with "firefox"

    // 2. Weighted random selection
    //    Sum all candidate weights, roll random number, pick profile
    //    where cumulative weight exceeds the roll
}
```

When `preferred_browser = "chrome"`, only chrome120/116/110/99 are candidates. When `"rotate"`, all 9 profiles are used, giving each request a different TLS fingerprint — making pattern detection harder.

#### Binary discovery — `findBinary()`

Searches for curl-impersonate binaries in this order:

1. **`curl_impersonate_path`** from config (if set)
2. `/usr/local/bin` (default .deb install location)
3. `/usr/bin`
4. `/opt/curl-impersonate/bin`
5. `~/.local/bin`
6. System `$PATH` via `which` command

Uses `std::filesystem::exists()` for fast checks before falling back to `which`.

#### Command building — `buildArgs()`

Constructs the shell command that gets executed. For a request to `https://example.com`:

```bash
'/usr/local/bin/curl_chrome120' \
  --max-time 30 \
  --connect-timeout 10 \
  -L --max-redirs 5 \
  --compressed \
  -s -S \
  -w '\n__CURL_EXIT__%{http_code}|%{ssl_version}|%{url_effective}' \
  'https://example.com' \
  2>/dev/null
```

Key flags:
- `-s -S` — silent mode (no progress bar) but still show errors
- `--compressed` — accept gzip/brotli responses
- `-w '\n__CURL_EXIT__...'` — append metadata after the body using curl's write-out format
- `-L` — follow redirects
- `-b`/`-c` — cookie read/write (if `cookie_jar` is configured)
- `-v` — verbose TLS output (if `verbose: true`)

#### Output parsing — `execCurlBinary()`

The raw output from popen looks like:

```
<html>...page content...</html>
__CURL_EXIT__200|TLSv1.3|https://example.com/final-url
```

Parsing:
1. Find `\n__CURL_EXIT__` marker using `rfind()` (search from end — body might contain the text)
2. Everything before marker → `resp.body`
3. Everything after → split by `|` into `httpCode`, `tlsVersion`, `effectiveUrl`
4. Set `resp.success = (exitCode == 0 && httpCode >= 200 && httpCode < 400)`

#### Retry logic — `getDetailed()`

```
Attempt 0: selectProfile() → chrome120, execute
  → HTTP 403 (Cloudflare blocked)

  calculateBackoff(0) → 500ms * 2^0 * jitter = ~450ms
  sleep(450ms)

Attempt 1: selectProfile() → firefox121, execute  ← different fingerprint!
  → HTTP 403 (still blocked)

  calculateBackoff(1) → 500ms * 2^1 * jitter = ~920ms
  sleep(920ms)

Attempt 2: selectProfile() → safari17, execute
  → HTTP 200 ✓ return body

  (if still failed → attempt 3 with ~1800ms backoff, then give up)
```

Retry rules:
- **Always retry:** 403 (Forbidden), 429 (Rate Limited), 5xx (Server Error), connection failures
- **Never retry:** 400, 401, 404, 405, etc. (client errors that won't change with a different profile)
- **Backoff formula:** `min(base_ms * 2^attempt, max_ms) * random(0.75, 1.25)`

#### Thread safety

Every public method acquires `mutex_` via `std::lock_guard`:

```cpp
std::string CurlImpersonate::get(const std::string& url) {
    // getDetailed() locks internally
    auto resp = getDetailed(url);
    return resp.body;
}

ImpersonateResponse CurlImpersonate::getDetailed(const std::string& url) {
    std::lock_guard<std::mutex> lock(mutex_);  // ← locked for entire request + retries
    // ...
}

void CurlImpersonate::setTimeout(long seconds) {
    std::lock_guard<std::mutex> lock(mutex_);  // ← locked for config mutation
    config_.timeoutSeconds = seconds;
}
```

This means a single `CurlImpersonate` instance serializes requests. For true parallelism, create multiple instances (one per thread/source).

#### TLS debug logging — `logTlsDetails()`

When `verbose: true`, captures curl's `-v` stderr output and filters for TLS-relevant lines:

```
TLS handshake details for https://example.com:
  * Connected to example.com (93.184.216.34) port 443
  * SSL connection using TLSv1.3 / TLS_AES_256_GCM_SHA384
  * ALPN: server accepted h2
  * server certificate: *.example.com
  *  issuer: DigiCert Inc
```

Useful for verifying that the correct TLS fingerprint is being sent.

#### Shell escaping — `shellEscape()`

All user-provided strings (URLs, paths) are single-quote escaped before passing to popen:

```cpp
static std::string shellEscape(const std::string& s) {
    // Wraps in single quotes, escapes embedded single quotes
    // "it's a url" → "'it'\''s a url'"
}
```

This prevents shell injection through malicious URLs.

### Integration with news sources

The integration is transparent to `RSSSource` and `GoogleAlertsSource`:

```
fetchCommand(config)
    │
    ├─ createHttpClient(config)           → shared_ptr<IHttpClient>
    │
    └─ doFetch(db, config, verbose, httpClient)
         │
         └─ for each feed:
              │
              ├─ httpClient provided?
              │    YES → GoogleAlertsSource(name, url, httpClient, category)
              │    NO  → GoogleAlertsSource(name, url, category)  // creates own HttpClient
              │
              └─ source->fetch()
                   │
                   └─ RSSSource::fetch()
                        │
                        └─ httpClient->get(feedUrl)  ← polymorphic dispatch
                             │
                             ├─ HttpClient::get()          → libcurl in-process
                             └─ CurlImpersonate::get()     → curl-impersonate binary
```

### `--impersonate-test` command

Built-in diagnostic tool. Forces `verbose: true` regardless of config:

```bash
./feedflash --impersonate-test https://www.tradingview.com chrome
```

Output:
```
Testing curl-impersonate against: https://www.tradingview.com
Browser: chrome
Available profiles: chrome120, chrome116, chrome110, chrome99, firefox121, ...
------------------------------------------------------------
[DEBUG] Using profile: chrome120 for https://www.tradingview.com
[DEBUG] TLS handshake details for https://www.tradingview.com:
  * SSL connection using TLSv1.3 / TLS_AES_256_GCM_SHA384
  * ALPN: server accepted h2
------------------------------------------------------------
Result:
  Success:       YES
  HTTP Code:     200
  TLS Version:   TLSv1.3
  Effective URL: https://www.tradingview.com/
  Body size:     152847 bytes

Body preview (first 500 chars):
----------------------------------------
<!DOCTYPE html><html lang="en">...
```

## Project Structure

```
feedflash/
├── CMakeLists.txt
├── config.json
├── README.md
├── include/
│   ├── models/
│   │   └── NewsArticle.h           # Article data model
│   ├── storage/
│   │   └── Database.h              # SQLite storage layer
│   ├── sources/
│   │   ├── NewsSource.h            # Abstract source interface
│   │   ├── RSSSource.h             # RSS 2.0 / Atom parser
│   │   └── GoogleAlertsSource.h    # Google Alerts specialization
│   └── utils/
│       ├── IHttpClient.h           # HTTP client interface (polymorphic base)
│       ├── HttpClient.h            # Standard libcurl implementation
│       ├── CurlImpersonate.h       # curl-impersonate wrapper
│       └── Logger.h                # Logging utility
└── src/
    ├── main.cpp                    # CLI entry, config parsing, factory
    ├── models/
    │   └── NewsArticle.cpp
    ├── storage/
    │   └── Database.cpp
    ├── sources/
    │   ├── RSSSource.cpp
    │   └── GoogleAlertsSource.cpp
    └── utils/
        ├── HttpClient.cpp
        ├── CurlImpersonate.cpp     # ~300 lines, core impersonation logic
        └── Logger.cpp
```

## Troubleshooting

- **"curl-impersonate is NOT installed"**: Run the install commands in the curl-impersonate section above, then verify with `which curl_chrome120`
- **Still getting 403 with impersonation**: Try a different browser (`--impersonate-test <url> firefox`), some sites fingerprint beyond TLS (HTTP/2 frame ordering, etc.)
- **"Cannot open config file"**: Provide the full path with `--config /path/to/config.json`
- **"CURL error: Could not resolve hostname"**: Check your internet connection and feed URL
- **Empty fetch results**: Verify the feed URL returns valid RSS/Atom XML
- **Build errors with pugixml**: Ensure pugixml development headers are installed
- **Build errors with `<filesystem>`**: GCC < 9 requires linking `stdc++fs` (handled automatically by CMakeLists.txt)
- **Slow fetches with impersonation**: curl-impersonate spawns a subprocess per request; this is slower than in-process libcurl. For non-Cloudflare feeds, keep `impersonation.enabled = false`
