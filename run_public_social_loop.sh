#!/usr/bin/env bash
set -euo pipefail

cd ~/Desktop/"INTEGRATED STOCK PROJECT"/Project/Working_Code

INTERVAL_SECONDS="${SOCIAL_LOOP_INTERVAL_SECONDS:-60}"

echo "Starting FinViz top-gainers-only social loop every ${INTERVAL_SECONDS}s"

while true; do
  echo ""
  echo "[$(date)] Running top-gainer-only social collectors..."

  MONGODB_URI="${MONGODB_URI:-mongodb://localhost:27017/feedflash}" \
  MONGODB_DB="${MONGODB_DB:-feedflash}" \
  SOCIAL_TOP_GAINERS_LIMIT="${SOCIAL_TOP_GAINERS_LIMIT:-10}" \
  python3 5_Social/pipeline/run_finviz_top_gainer_socials.py || true

  docker compose exec -T mongo mongosh feedflash < scripts/prune_socials_to_finviz_top_gainers.js || true

  sleep "${INTERVAL_SECONDS}"
done
