#!/bin/sh
set -u

while true; do
  mongosh "mongodb://mongo:27017/feedflash" --quiet /scripts/news_source_guard_runtime.js || true
  sleep "${NEWS_SOURCE_GUARD_INTERVAL_SEC:-120}"
done
