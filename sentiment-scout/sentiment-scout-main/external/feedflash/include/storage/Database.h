#pragma once
#include <string>
#include <vector>
#include <sqlite3.h>
#include "models/NewsArticle.h"

class Database {
private:
    sqlite3* db;
    std::string dbPath;

    // Prepared statements for performance
    sqlite3_stmt* insertStmt;
    sqlite3_stmt* checkExistsStmt;

    bool executeSQL(const std::string& sql);
    void prepareStatements();
    void finalizeStatements();

    // Helper to build an article from a SELECT row
    static NewsArticle articleFromRow(sqlite3_stmt* stmt);

public:
    Database(const std::string& path);
    ~Database();

    // Non-copyable
    Database(const Database&) = delete;
    Database& operator=(const Database&) = delete;

    // Initialize database schema
    bool initialize();

    // Article operations
    bool insertArticle(const NewsArticle& article);
    bool articleExists(const std::string& url);
    bool articleExistsById(const std::string& id);

    // Query operations
    std::vector<NewsArticle> getRecentArticles(int limit = 50);
    std::vector<NewsArticle> getArticlesBySource(const std::string& source, int limit = 50);
    std::vector<NewsArticle> getArticlesByCategory(const std::string& category, int limit = 50);

    // Statistics
    int getTotalArticleCount();
    int getArticleCountBySource(const std::string& source);

    // Cleanup
    bool deleteOldArticles(int daysOld);
};
