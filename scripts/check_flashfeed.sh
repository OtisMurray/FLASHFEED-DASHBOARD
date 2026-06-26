#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

echo "=== Docker services ==="
docker compose ps

echo ""
echo "=== Backend /api/health ==="
curl -s "http://localhost:3001/api/health" | python3 -m json.tool || true

echo ""
echo "=== Backend /api/system/health ==="
curl -s "http://localhost:3001/api/system/health" | python3 -m json.tool || true

echo ""
echo "=== Mongo counts ==="
docker compose exec -T mongo mongosh feedflash --quiet --eval '
printjson({
  articles: db.articles.countDocuments(),
  socials: db.socials.countDocuments(),
  screeners: db.screeners.countDocuments(),
  events: db.events.countDocuments()
})
' || true

echo ""
echo "=== Redis memory ==="
docker compose exec -T redis redis-cli INFO memory | grep -E "used_memory_human|maxmemory_human|maxmemory_policy" || true

echo ""
echo "=== Kafka topics ==="
docker compose exec -T kafka kafka-topics --bootstrap-server kafka:29092 --list || true

echo ""
echo "=== Redis cache header test ==="
curl -s -D /tmp/ff_headers_1.txt -o /dev/null "http://localhost:3001/api/screener" || true
curl -s -D /tmp/ff_headers_2.txt -o /dev/null "http://localhost:3001/api/screener" || true
echo "First call:"
grep -i "x-cache" /tmp/ff_headers_1.txt || true
echo "Second call:"
grep -i "x-cache" /tmp/ff_headers_2.txt || true

echo ""
echo "=== Auto-refresh logs ==="
docker compose logs --tail=30 auto-refresh-worker || true
