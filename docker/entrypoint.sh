#!/bin/sh
set -e

echo "Running database migrations..."
npx prisma migrate deploy 2>/dev/null || echo "Note: prisma migrate deploy not available, using db push"

echo "Starting Splitit..."
exec node server.js
