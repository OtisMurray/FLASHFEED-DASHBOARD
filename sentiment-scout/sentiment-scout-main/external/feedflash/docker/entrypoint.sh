#!/bin/sh
# FeedFlash entrypoint
# 1. Symlink persistent data
# 2. Start sentiment service in background (failure is non-fatal)
# 3. Start Bun web server in foreground

DATA_DIR="${FLASHFEED_DATA:-/data}"

# ── Persistent data symlinks ──────────────────────────────────────────────────
mkdir -p "${DATA_DIR}"

[ ! -f "${DATA_DIR}/feedflash.db" ] && touch "${DATA_DIR}/feedflash.db"
ln -sf "${DATA_DIR}/feedflash.db"  /app/feedflash.db

touch "${DATA_DIR}/feedflash.log"
ln -sf "${DATA_DIR}/feedflash.log" /app/feedflash.log

[ -f "${DATA_DIR}/config.json" ] && ln -sf "${DATA_DIR}/config.json" /app/config.json

# ── Sentiment service (non-fatal — web server starts regardless) ───────────────
SENTIMENT_PORT="${SENTIMENT_PORT:-5001}"
echo "[entrypoint] Starting sentiment service on port ${SENTIMENT_PORT}..."

PORT="${SENTIMENT_PORT}" python3 /app/sentiment_service/service.py \
  >> "${DATA_DIR}/sentiment.log" 2>&1 &

echo "[entrypoint] Sentiment PID: $!"

# ── Bun web server ────────────────────────────────────────────────────────────
echo "[entrypoint] Starting Bun web server on PORT=${PORT:-3000}..."
exec /usr/local/bun/bin/bun run /app/flashfeed-web/index.ts
