#include "storage/Database.h"
#include "utils/Logger.h"
#include <sstream>

Database::Database(const std::string& path)
    : db(nullptr), dbPath(path), insertStmt(nullptr), checkExistsStmt(nullptr) {}

Database::~Database() {
    finalizeStatements();
    if (db) {
        sqlite3_close(db);
        db = nullptr;
    }
}

bool Database::executeSQL(const std::string& sql) {
    char* errMsg = nullptr;
    int rc = sqlite3_exec(db, sql.c_str(), nullptr, nullptr, &errMsg);
    if (rc != SQLITE_OK) {
        std::string err = errMsg ? errMsg : "unknown error";
        LOG_ERROR("SQL error: " + err);
        if (errMsg) sqlite3_free(errMsg);
        return false;
    }
    return true;
}

void Database::prepareStatements() {
    const char* insertSQL =
        "INSERT OR IGNORE INTO articles "
        "(id, title, content, url, source, category, publish_date, fetched_date, ticker, sentiment, sentiment_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

    int rc = sqlite3_prepare_v2(db, insertSQL, -1, &insertStmt, nullptr);
    if (rc != SQLITE_OK) {
        LOG_ERROR("Failed to prepare insert statement: " +
                  std::string(sqlite3_errmsg(db)));
    }

    const char* checkSQL = "SELECT 1 FROM articles WHERE url = ? LIMIT 1";
    rc = sqlite3_prepare_v2(db, checkSQL, -1, &checkExistsStmt, nullptr);
    if (rc != SQLITE_OK) {
        LOG_ERROR("Failed to prepare check-exists statement: " +
                  std::string(sqlite3_errmsg(db)));
    }
}

void Database::finalizeStatements() {
    if (insertStmt) {
        sqlite3_finalize(insertStmt);
        insertStmt = nullptr;
    }
    if (checkExistsStmt) {
        sqlite3_finalize(checkExistsStmt);
        checkExistsStmt = nullptr;
    }
}

bool Database::initialize() {
    int rc = sqlite3_open(dbPath.c_str(), &db);
    if (rc != SQLITE_OK) {
        LOG_ERROR("Cannot open database: " + std::string(sqlite3_errmsg(db)));
        return false;
    }

    // Enable WAL mode for better concurrency
    executeSQL("PRAGMA journal_mode=WAL");

    const std::string schema = R"(
        CREATE TABLE IF NOT EXISTS articles (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            content TEXT,
            url TEXT UNIQUE NOT NULL,
            source TEXT NOT NULL,
            category TEXT,
            publish_date INTEGER,
            fetched_date INTEGER NOT NULL,
            ticker TEXT NOT NULL DEFAULT ''
        );

        CREATE INDEX IF NOT EXISTS idx_source ON articles(source);
        CREATE INDEX IF NOT EXISTS idx_category ON articles(category);
        CREATE INDEX IF NOT EXISTS idx_publish_date ON articles(publish_date DESC);
        CREATE INDEX IF NOT EXISTS idx_fetched_date ON articles(fetched_date DESC);
        CREATE INDEX IF NOT EXISTS idx_ticker ON articles(ticker);
    )";

    if (!executeSQL(schema)) {
        LOG_ERROR("Failed to create database schema");
        return false;
    }

    // Migrate existing databases that don't have the ticker column yet
    sqlite3_exec(db,
        "ALTER TABLE articles ADD COLUMN ticker TEXT NOT NULL DEFAULT ''",
        nullptr, nullptr, nullptr);  // silently fails if column already exists

    // Migrate: add sentiment columns (silently fail if already exist)
    sqlite3_exec(db,
        "ALTER TABLE articles ADD COLUMN sentiment TEXT DEFAULT NULL",
        nullptr, nullptr, nullptr);
    sqlite3_exec(db,
        "ALTER TABLE articles ADD COLUMN sentiment_at INTEGER DEFAULT NULL",
        nullptr, nullptr, nullptr);
    sqlite3_exec(db,
        "ALTER TABLE articles ADD COLUMN ml_confidence REAL DEFAULT NULL",
        nullptr, nullptr, nullptr);

    // Create asset_reports table for ticker/asset-level daily reports
    const std::string reportsSchema = R"(
        CREATE TABLE IF NOT EXISTS asset_reports (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            asset      TEXT    NOT NULL,
            date       TEXT    NOT NULL,
            sentiment  TEXT    NOT NULL,
            report     TEXT,
            created_at INTEGER NOT NULL,
            UNIQUE(asset, date)
        );
        CREATE INDEX IF NOT EXISTS idx_asset_reports_asset ON asset_reports(asset);
        CREATE INDEX IF NOT EXISTS idx_asset_reports_date  ON asset_reports(date DESC);
    )";
    if (!executeSQL(reportsSchema)) {
        LOG_ERROR("Failed to create asset_reports schema");
    }

    prepareStatements();
    LOG_INFO("Database initialized: " + dbPath);
    return true;
}

bool Database::insertArticle(const NewsArticle& article) {
    if (!insertStmt) {
        LOG_ERROR("Insert statement not prepared");
        return false;
    }

    sqlite3_reset(insertStmt);
    sqlite3_clear_bindings(insertStmt);

    sqlite3_bind_text(insertStmt, 1, article.id.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(insertStmt, 2, article.title.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(insertStmt, 3, article.content.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(insertStmt, 4, article.url.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(insertStmt, 5, article.source.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(insertStmt, 6, article.category.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_int64(insertStmt, 7, static_cast<sqlite3_int64>(article.publish_date));
    sqlite3_bind_int64(insertStmt, 8, static_cast<sqlite3_int64>(article.fetched_date));
    sqlite3_bind_text(insertStmt, 9, article.ticker.c_str(), -1, SQLITE_TRANSIENT);

    if (!article.sentiment.empty()) {
        sqlite3_bind_text(insertStmt, 10, article.sentiment.c_str(), -1, SQLITE_TRANSIENT);
        sqlite3_bind_int64(insertStmt, 11, static_cast<sqlite3_int64>(article.fetched_date));
    } else {
        sqlite3_bind_null(insertStmt, 10);
        sqlite3_bind_null(insertStmt, 11);
    }

    int rc = sqlite3_step(insertStmt);
    if (rc != SQLITE_DONE) {
        LOG_ERROR("Failed to insert article '" + article.title + "': " +
                  std::string(sqlite3_errmsg(db)));
        return false;
    }

    // Check if the row was actually inserted (not ignored due to duplicate)
    return sqlite3_changes(db) > 0;
}

bool Database::articleExists(const std::string& url) {
    if (!checkExistsStmt) {
        LOG_ERROR("Check-exists statement not prepared");
        return false;
    }

    sqlite3_reset(checkExistsStmt);
    sqlite3_clear_bindings(checkExistsStmt);
    sqlite3_bind_text(checkExistsStmt, 1, url.c_str(), -1, SQLITE_TRANSIENT);

    int rc = sqlite3_step(checkExistsStmt);
    return rc == SQLITE_ROW;
}

bool Database::articleExistsById(const std::string& id) {
    sqlite3_stmt* stmt = nullptr;
    const char* sql = "SELECT 1 FROM articles WHERE id = ? LIMIT 1";
    int rc = sqlite3_prepare_v2(db, sql, -1, &stmt, nullptr);
    if (rc != SQLITE_OK) return false;

    sqlite3_bind_text(stmt, 1, id.c_str(), -1, SQLITE_TRANSIENT);
    bool exists = (sqlite3_step(stmt) == SQLITE_ROW);
    sqlite3_finalize(stmt);
    return exists;
}

NewsArticle Database::articleFromRow(sqlite3_stmt* stmt) {
    NewsArticle article;
    auto getText = [&](int col) -> std::string {
        const char* text = reinterpret_cast<const char*>(sqlite3_column_text(stmt, col));
        return text ? text : "";
    };

    article.id = getText(0);
    article.title = getText(1);
    article.content = getText(2);
    article.url = getText(3);
    article.source = getText(4);
    article.category = getText(5);
    article.publish_date = static_cast<time_t>(sqlite3_column_int64(stmt, 6));
    article.fetched_date = static_cast<time_t>(sqlite3_column_int64(stmt, 7));
    article.ticker = getText(8);
    return article;
}

std::vector<NewsArticle> Database::getRecentArticles(int limit) {
    std::vector<NewsArticle> articles;
    sqlite3_stmt* stmt = nullptr;
    const char* sql =
        "SELECT id, title, content, url, source, category, publish_date, fetched_date, ticker "
        "FROM articles ORDER BY fetched_date DESC LIMIT ?";

    if (sqlite3_prepare_v2(db, sql, -1, &stmt, nullptr) != SQLITE_OK) {
        LOG_ERROR("Failed to prepare getRecentArticles: " +
                  std::string(sqlite3_errmsg(db)));
        return articles;
    }

    sqlite3_bind_int(stmt, 1, limit);
    while (sqlite3_step(stmt) == SQLITE_ROW) {
        articles.push_back(articleFromRow(stmt));
    }
    sqlite3_finalize(stmt);
    return articles;
}

std::vector<NewsArticle> Database::getArticlesBySource(const std::string& source, int limit) {
    std::vector<NewsArticle> articles;
    sqlite3_stmt* stmt = nullptr;
    const char* sql =
        "SELECT id, title, content, url, source, category, publish_date, fetched_date, ticker "
        "FROM articles WHERE source = ? ORDER BY fetched_date DESC LIMIT ?";

    if (sqlite3_prepare_v2(db, sql, -1, &stmt, nullptr) != SQLITE_OK) {
        LOG_ERROR("Failed to prepare getArticlesBySource: " +
                  std::string(sqlite3_errmsg(db)));
        return articles;
    }

    sqlite3_bind_text(stmt, 1, source.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_int(stmt, 2, limit);
    while (sqlite3_step(stmt) == SQLITE_ROW) {
        articles.push_back(articleFromRow(stmt));
    }
    sqlite3_finalize(stmt);
    return articles;
}

std::vector<NewsArticle> Database::getArticlesByCategory(const std::string& category, int limit) {
    std::vector<NewsArticle> articles;
    sqlite3_stmt* stmt = nullptr;
    const char* sql =
        "SELECT id, title, content, url, source, category, publish_date, fetched_date, ticker "
        "FROM articles WHERE category = ? ORDER BY fetched_date DESC LIMIT ?";

    if (sqlite3_prepare_v2(db, sql, -1, &stmt, nullptr) != SQLITE_OK) {
        LOG_ERROR("Failed to prepare getArticlesByCategory: " +
                  std::string(sqlite3_errmsg(db)));
        return articles;
    }

    sqlite3_bind_text(stmt, 1, category.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_int(stmt, 2, limit);
    while (sqlite3_step(stmt) == SQLITE_ROW) {
        articles.push_back(articleFromRow(stmt));
    }
    sqlite3_finalize(stmt);
    return articles;
}

int Database::getTotalArticleCount() {
    sqlite3_stmt* stmt = nullptr;
    const char* sql = "SELECT COUNT(*) FROM articles";
    if (sqlite3_prepare_v2(db, sql, -1, &stmt, nullptr) != SQLITE_OK) return -1;

    int count = 0;
    if (sqlite3_step(stmt) == SQLITE_ROW) {
        count = sqlite3_column_int(stmt, 0);
    }
    sqlite3_finalize(stmt);
    return count;
}

int Database::getArticleCountBySource(const std::string& source) {
    sqlite3_stmt* stmt = nullptr;
    const char* sql = "SELECT COUNT(*) FROM articles WHERE source = ?";
    if (sqlite3_prepare_v2(db, sql, -1, &stmt, nullptr) != SQLITE_OK) return -1;

    sqlite3_bind_text(stmt, 1, source.c_str(), -1, SQLITE_TRANSIENT);
    int count = 0;
    if (sqlite3_step(stmt) == SQLITE_ROW) {
        count = sqlite3_column_int(stmt, 0);
    }
    sqlite3_finalize(stmt);
    return count;
}

bool Database::deleteOldArticles(int daysOld) {
    time_t cutoff = time(nullptr) - (daysOld * 86400);
    std::string sql = "DELETE FROM articles WHERE fetched_date < " + std::to_string(cutoff);
    if (executeSQL(sql)) {
        int deleted = sqlite3_changes(db);
        LOG_INFO("Deleted " + std::to_string(deleted) + " articles older than " +
                 std::to_string(daysOld) + " days");
        return true;
    }
    return false;
}
