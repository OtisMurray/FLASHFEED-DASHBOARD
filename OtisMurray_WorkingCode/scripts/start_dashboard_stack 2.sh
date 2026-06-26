#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

docker compose up -d \
  mongo \
  redis \
  zookeeper \
  kafka \
  kafka-init \
  kafka-consumer \
  backend

docker compose ps
