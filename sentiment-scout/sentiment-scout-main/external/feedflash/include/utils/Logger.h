#pragma once
#include <string>
#include <fstream>
#include <mutex>

enum class LogLevel {
    DEBUG,
    INFO,
    WARNING,
    ERROR
};

class Logger {
private:
    static Logger* instance;
    std::ofstream logFile;
    LogLevel currentLevel;
    bool quietMode;
    std::mutex logMutex;

    Logger();
    std::string levelToString(LogLevel level);
    std::string getCurrentTimestamp();

public:
    ~Logger();

    static Logger* getInstance();

    void setLogLevel(LogLevel level);
    void setLogFile(const std::string& filename);

    void log(LogLevel level, const std::string& message);
    void debug(const std::string& message);
    void info(const std::string& message);
    void warning(const std::string& message);
    void error(const std::string& message);

    // Mute/unmute console output (file logging continues)
    void setQuiet(bool quiet);

    // Parse log level from string
    static LogLevel parseLevel(const std::string& level);
};

#define LOG_DEBUG(msg) Logger::getInstance()->debug(msg)
#define LOG_INFO(msg) Logger::getInstance()->info(msg)
#define LOG_WARNING(msg) Logger::getInstance()->warning(msg)
#define LOG_ERROR(msg) Logger::getInstance()->error(msg)
