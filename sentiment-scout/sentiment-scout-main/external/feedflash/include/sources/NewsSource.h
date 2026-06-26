#pragma once
#include <vector>
#include <string>
#include "models/NewsArticle.h"

class NewsSource {
protected:
    std::string name;
    std::string category;

public:
    NewsSource(const std::string& name, const std::string& category = "general")
        : name(name), category(category) {}

    virtual ~NewsSource() = default;

    virtual std::vector<NewsArticle> fetch() = 0;

    virtual std::string getName() const { return name; }
    virtual std::string getCategory() const { return category; }
};
