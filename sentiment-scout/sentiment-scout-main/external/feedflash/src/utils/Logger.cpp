#include "utils/Logger.h"
#include <iostream>
#include <ctime>
#include <algorithm>

Logger* Logger::instance = nullptr;

Logger::Logger() : currentLevel(LogLevel::INFO), quietMode(false) {}

Logger::~Logger() {
    if (logFile.is_open()) {
        logFile.close();
    }
}

Logger* Logger::getInstance() {
    if (instance == nullptr) {
        instance = new Logger();
    }
    return instance;
}

void Logger::setLogLevel(LogLevel level) {
    currentLevel = level;
}

void Logger::setLogFile(const std::string& filename) {
    std::lock_guard<std::mutex> lock(logMutex);
    if (logFile.is_open()) {
        logFile.close();
    }
    logFile.open(filename, std::ios::app);
    if (!logFile.is_open()) {
        std::cerr << "Warning: Could not open log file: " << filename << std::endl;
    }
}

std::string Logger::levelToString(LogLevel level) {
    switch (level) {
        case LogLevel::DEBUG:   return "DEBUG";
        case LogLevel::INFO:    return "INFO";
        case LogLevel::WARNING: return "WARN";
        case LogLevel::ERROR:   return "ERROR";
        default:                return "UNKNOWN";
    }
}

std::string Logger::getCurrentTimestamp() {
    time_t now = time(nullptr);
    struct tm* tm_info = localtime(&now);
    char buf[32];
    strftime(buf, sizeof(buf), "%Y-%m-%d %H:%M:%S", tm_info);
    return std::string(buf);
}

void Logger::log(LogLevel level, const std::string& message) {
    if (level < currentLevel) return;

    std::lock_guard<std::mutex> lock(logMutex);
    std::string timestamp = getCurrentTimestamp();
    std::string lvl = levelToString(level);
    std::string formatted = "[" + timestamp + "] [" + lvl + "] " + message;

    // Write to console (unless in quiet mode)
    if (!quietMode) {
        if (level >= LogLevel::WARNING) {
            std::cerr << formatted << std::endl;
        } else {
            std::cout << formatted << std::endl;
        }
    }

    // Write to file if open
    if (logFile.is_open()) {
        logFile << formatted << std::endl;
        logFile.flush();
    }
}

void Logger::setQuiet(bool quiet) {
    quietMode = quiet;
}

void Logger::debug(const std::string& message) { log(LogLevel::DEBUG, message); }
void Logger::info(const std::string& message) { log(LogLevel::INFO, message); }
void Logger::warning(const std::string& message) { log(LogLevel::WARNING, message); }
void Logger::error(const std::string& message) { log(LogLevel::ERROR, message); }

LogLevel Logger::parseLevel(const std::string& level) {
    std::string lower = level;
    std::transform(lower.begin(), lower.end(), lower.begin(), ::tolower);
    if (lower == "debug") return LogLevel::DEBUG;
    if (lower == "info") return LogLevel::INFO;
    if (lower == "warning" || lower == "warn") return LogLevel::WARNING;
    if (lower == "error") return LogLevel::ERROR;
    return LogLevel::INFO;
}
