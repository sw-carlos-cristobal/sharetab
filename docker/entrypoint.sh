#!/bin/sh
set -e

PGDATA="${PGDATA:-/var/lib/postgresql/data}"
DB_USER="${DB_USER:-splitit}"
DB_PASSWORD="${DB_PASSWORD:-splitit}"
DB_NAME="${DB_NAME:-splitit}"

# ── Start PostgreSQL ────────────────────────────────────────

# Initialize database if needed
if [ ! -s "$PGDATA/PG_VERSION" ]; then
  echo "Initializing PostgreSQL database..."
  su-exec postgres initdb -D "$PGDATA" --auth-local=trust --auth-host=md5

  # Allow local connections
  echo "host all all 127.0.0.1/32 md5" >> "$PGDATA/pg_hba.conf"
  echo "host all all ::1/128 md5" >> "$PGDATA/pg_hba.conf"

  # Listen only on localhost (internal use only)
  sed -i "s/#listen_addresses = 'localhost'/listen_addresses = 'localhost'/" "$PGDATA/postgresql.conf"

  # Start temporarily to create user and database
  su-exec postgres pg_ctl -D "$PGDATA" -w start -o "-k /run/postgresql"

  su-exec postgres psql -h /run/postgresql -c "CREATE USER $DB_USER WITH PASSWORD '$DB_PASSWORD';"
  su-exec postgres psql -h /run/postgresql -c "CREATE DATABASE $DB_NAME OWNER $DB_USER;"
  su-exec postgres psql -h /run/postgresql -c "GRANT ALL PRIVILEGES ON DATABASE $DB_NAME TO $DB_USER;"

  su-exec postgres pg_ctl -D "$PGDATA" -w stop
  echo "PostgreSQL initialized."
fi

echo "Starting PostgreSQL..."
su-exec postgres pg_ctl -D "$PGDATA" -w start -o "-k /run/postgresql"

# Wait for PostgreSQL to be ready
until su-exec postgres pg_isready -h localhost -q; do
  echo "Waiting for PostgreSQL..."
  sleep 1
done
echo "PostgreSQL is ready."

# ── Set DATABASE_URL if not already pointing externally ─────

export DATABASE_URL="${DATABASE_URL:-postgresql://$DB_USER:$DB_PASSWORD@localhost:5432/$DB_NAME}"

# ── Run Migrations ──────────────────────────────────────────

echo "Running database migrations..."
npx prisma migrate deploy 2>/dev/null || npx prisma db push --skip-generate 2>/dev/null || echo "Warning: Could not run migrations"

# ── Start App ───────────────────────────────────────────────

echo "Starting Splitit..."
exec su-exec nextjs node server.js
