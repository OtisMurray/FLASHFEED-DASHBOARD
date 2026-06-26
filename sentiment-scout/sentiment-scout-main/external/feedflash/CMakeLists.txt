cmake_minimum_required(VERSION 3.14)
project(FeedFlash VERSION 1.1 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# Find required packages
find_package(CURL REQUIRED)
find_package(SQLite3 REQUIRED)
find_package(Threads REQUIRED)

# Find pugixml - try cmake config first, then pkg-config
find_package(pugixml QUIET)
if(NOT pugixml_FOUND)
    find_package(PkgConfig QUIET)
    if(PkgConfig_FOUND)
        pkg_check_modules(PUGIXML REQUIRED pugixml)
    endif()
endif()

# Include project headers
include_directories(${CMAKE_SOURCE_DIR}/include)

# Source files
set(SOURCES
    src/main.cpp
    src/models/NewsArticle.cpp
    src/storage/Database.cpp
    src/sources/RSSSource.cpp
    src/sources/GoogleAlertsSource.cpp
    src/sources/IBKRSource.cpp
    src/sources/SchwabSource.cpp
    src/sources/FinvizSource.cpp
    src/utils/Logger.cpp
    src/utils/HttpClient.cpp
    src/utils/CurlImpersonate.cpp
    src/utils/KeywordFilter.cpp
    src/utils/SentimentClassifier.cpp
    src/sources/TradingViewSource.cpp
)

# Link filesystem library (required for std::filesystem on some compilers)
set(FILESYSTEM_LIB "")
if(CMAKE_CXX_COMPILER_ID STREQUAL "GNU" AND CMAKE_CXX_COMPILER_VERSION VERSION_LESS "9.0")
    set(FILESYSTEM_LIB stdc++fs)
endif()

# Create executable
add_executable(feedflash ${SOURCES})

# Include directories
target_include_directories(feedflash PRIVATE
    ${CMAKE_SOURCE_DIR}/include
    ${CURL_INCLUDE_DIRS}
    ${SQLite3_INCLUDE_DIRS}
)

# Handle pugixml includes
if(pugixml_FOUND)
    target_link_libraries(feedflash pugixml::pugixml)
elseif(PUGIXML_FOUND)
    target_include_directories(feedflash PRIVATE ${PUGIXML_INCLUDE_DIRS})
    target_link_libraries(feedflash ${PUGIXML_LIBRARIES})
endif()

# Link libraries
target_link_libraries(feedflash
    CURL::libcurl
    SQLite::SQLite3
    Threads::Threads
    ${FILESYSTEM_LIB}
)

# Compiler warnings
if(MSVC)
    target_compile_options(feedflash PRIVATE /W4)
else()
    target_compile_options(feedflash PRIVATE -Wall -Wextra -Wpedantic)
endif()

# Install targets
install(TARGETS feedflash DESTINATION bin)
install(FILES config.json DESTINATION share/feedflash)
