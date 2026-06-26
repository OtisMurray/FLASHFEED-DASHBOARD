#!/bin/sh
set -eu

BACKEND_URL="${BACKEND_URL:-http://backend:3001}"
MODE="${AUTO_REFRESH_MODE:-fast}"
INTERVAL="${AUTO_REFRESH_INTERVAL_SECONDS:-60}"
TIMEOUT="${AUTO_REFRESH_TIMEOUT_SECONDS:-55}"
ENABLED="${AUTO_REFRESH_ENABLED:-true}"
ADMIN_TOKEN="${ADMIN_TOKEN:-}"
API_TOKEN="${API_TOKEN:-}"

case "$INTERVAL" in
  ''|*[!0-9]*) INTERVAL=60 ;;
esac

# Safety clamp: never run more often than once per minute.
if [ "$INTERVAL" -lt 60 ]; then
  INTERVAL=60
fi

echo "[auto-refresh] starting"
echo "[auto-refresh] backend=$BACKEND_URL mode=$MODE interval=${INTERVAL}s enabled=$ENABLED"

while true; do
  ENABLED_LC="$(printf '%s' "$ENABLED" | tr '[:upper:]' '[:lower:]')"

  if [ "$ENABLED_LC" != "1" ] && [ "$ENABLED_LC" != "true" ] && [ "$ENABLED_LC" != "yes" ]; then
    echo "[auto-refresh] disabled; sleeping ${INTERVAL}s"
    sleep "$INTERVAL"
    continue
  fi

  if curl -fsS --max-time 5 "$BACKEND_URL/api/health" >/dev/null 2>&1; then
    START="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
    OUT="/tmp/flashfeed-auto-refresh-response.json"

    echo "[auto-refresh] $START POST /api/fetch?mode=$MODE"

    if [ -n "$ADMIN_TOKEN" ]; then
      HTTP_CODE="$(curl -sS --max-time "$TIMEOUT" -o "$OUT" -w "%{http_code}" \
        -H "X-Admin-Token: $ADMIN_TOKEN" \
        -X POST "$BACKEND_URL/api/fetch?mode=$MODE" || true)"
    elif [ -n "$API_TOKEN" ]; then
      HTTP_CODE="$(curl -sS --max-time "$TIMEOUT" -o "$OUT" -w "%{http_code}" \
        -H "X-API-Token: $API_TOKEN" \
        -X POST "$BACKEND_URL/api/fetch?mode=$MODE" || true)"
    else
      HTTP_CODE="$(curl -sS --max-time "$TIMEOUT" -o "$OUT" -w "%{http_code}" \
        -X POST "$BACKEND_URL/api/fetch?mode=$MODE" || true)"
    fi

    SUMMARY="$(head -c 500 "$OUT" 2>/dev/null || true)"
    echo "[auto-refresh] status=$HTTP_CODE response=$SUMMARY"
  else
    echo "[auto-refresh] backend not healthy; skipping this cycle"
    sleep 5
    continue
  fi

  sleep "$INTERVAL"
done
