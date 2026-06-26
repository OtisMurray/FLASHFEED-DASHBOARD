#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

echo "=== Environment files that should NOT be committed ==="
find . \
  -path "./node_modules" -prune -o \
  -path "./app/node_modules" -prune -o \
  -path "./.venv" -prune -o \
  -path "./.git" -prune -o \
  -type f \( -name ".env" -o -name ".env.local" -o -name ".env.*.local" \) \
  -print

echo ""
echo "=== Git status for env files ==="
git status --short 2>/dev/null | grep -E "\.env($|\.| )" || true

echo ""
echo "=== Reminder ==="
echo "Do not commit .env files, real API keys, broker credentials, or tokens."
echo "Ryan's uploaded zip included .env files, so be careful when merging partner code."
