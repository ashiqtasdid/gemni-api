#!/bin/bash

echo "🛑 Stopping containers..."
docker-compose down

echo "🔄 Rebuilding images..."
docker-compose build --no-cache

echo "🚀 Starting containers..."
docker-compose up -d

echo "✅ Rebuild complete!"
echo "📋 Container logs:"
docker-compose logs -f