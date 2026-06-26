#!/bin/bash
# FlashFeed one-click startup script
# Starts Docker, MongoDB, backend, and frontend

set -e

echo "🚀 Starting FlashFeed..."

# Check if Docker is running
if ! docker info >/dev/null 2>&1; then
    echo "❌ Docker is not running. Please start Docker Desktop first."
    exit 1
fi

echo "✓ Docker is running"

# Start MongoDB if not already running
if ! docker ps | grep -q feedflash-mongo; then
    echo "📦 Starting MongoDB..."
    docker-compose up -d mongo
    sleep 3
else
    echo "✓ MongoDB already running"
fi

# Start backend + Kafka if not already running
if ! docker ps | grep -q feedflash-backend; then
    echo "🔧 Starting backend (with Kafka, Redis, Zookeeper)..."
    docker-compose up -d mongo redis zookeeper kafka backend
    sleep 8
else
    echo "✓ Backend already running"
fi

# Start frontend (local, not Docker)
echo "⚛️  Starting frontend..."
cd app
npm run dev &
FRONTEND_PID=$!

echo ""
echo "✅ FlashFeed is running!"
echo "   Frontend: http://localhost:5173"
echo "   Backend:  http://localhost:3001"
echo "   MongoDB:  mongodb://localhost:27017"
echo ""
echo "Press Ctrl+C to stop all services"
echo ""

# Wait for Ctrl+C
trap "kill $FRONTEND_PID 2>/dev/null; echo ''; echo '🛑 Stopping FlashFeed...'; exit 0" INT

wait