#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PGDATA="$SCRIPT_DIR/.pgdata"
DB_USER="sharetab"
DB_PASSWORD="sharetab"
DB_NAME="sharetab"
PG_PORT="5432"

# ── Helpers ────────────────────────────────────────────────

find_pg_bin() {
  if command -v "$1" &>/dev/null; then command -v "$1"; return; fi
  for ver in 16 15 14 13; do
    [ -x "/usr/lib/postgresql/$ver/bin/$1" ] && echo "/usr/lib/postgresql/$ver/bin/$1" && return
  done
  echo ""
}

PG_CTL=$(find_pg_bin pg_ctl)
INITDB=$(find_pg_bin initdb)
PSQL=$(find_pg_bin psql)
PG_ISREADY=$(find_pg_bin pg_isready)

if [ -z "$PG_CTL" ] || [ -z "$INITDB" ] || [ -z "$PSQL" ] || [ -z "$PG_ISREADY" ]; then
  echo "❌ PostgreSQL tools not found. Install with:"
  echo "   sudo apt-get install -y postgresql-16"
  exit 1
fi

# ── Initialize cluster if needed ───────────────────────────

if [ ! -s "$PGDATA/PG_VERSION" ]; then
  echo "Initializing PostgreSQL cluster at $PGDATA..."
  "$INITDB" -D "$PGDATA" --auth=trust -U postgres --no-instructions

  # Allow TCP connections from localhost
  echo "host all all 127.0.0.1/32 trust" >> "$PGDATA/pg_hba.conf"
  echo "host all all ::1/128 trust"       >> "$PGDATA/pg_hba.conf"

  # Set port
  sed -i "s/#port = 5432/port = $PG_PORT/" "$PGDATA/postgresql.conf"

  echo "PostgreSQL cluster initialized."
fi

# ── Start Postgres ──────────────────────────────────────────

if ! "$PG_CTL" -D "$PGDATA" status > /dev/null 2>&1; then
  echo "Starting PostgreSQL..."
  "$PG_CTL" -D "$PGDATA" -l "$PGDATA/logfile" start
fi

cleanup() {
  echo ""
  echo "Stopping PostgreSQL..."
  "$PG_CTL" -D "$PGDATA" stop
  echo "Done."
}
trap cleanup EXIT

PG_WAIT=0
until "$PG_ISREADY" -h 127.0.0.1 -p "$PG_PORT" -U postgres -q; do
  if [ "$PG_WAIT" -ge 30 ]; then
    echo "❌ PostgreSQL did not become ready after 30 seconds. Check $PGDATA/logfile"
    exit 1
  fi
  echo "Waiting for PostgreSQL..."
  sleep 1
  PG_WAIT=$((PG_WAIT + 1))
done
echo "PostgreSQL is ready."

# ── Create user and database ────────────────────────────────

if ! "$PSQL" -h 127.0.0.1 -p "$PG_PORT" -U postgres -tAc \
    "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'" | grep -q 1; then
  echo "Creating database user '$DB_USER'..."
  "$PSQL" -h 127.0.0.1 -p "$PG_PORT" -U postgres \
    -c "CREATE USER $DB_USER WITH PASSWORD '$DB_PASSWORD';"
fi

if ! "$PSQL" -h 127.0.0.1 -p "$PG_PORT" -U postgres -tAc \
    "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -q 1; then
  echo "Creating database '$DB_NAME'..."
  "$PSQL" -h 127.0.0.1 -p "$PG_PORT" -U postgres \
    -c "CREATE DATABASE $DB_NAME OWNER $DB_USER;"
  "$PSQL" -h 127.0.0.1 -p "$PG_PORT" -U postgres \
    -c "GRANT ALL PRIVILEGES ON DATABASE $DB_NAME TO $DB_USER;"
fi

# ── Setup .env ──────────────────────────────────────────────

cd "$SCRIPT_DIR"

if [ ! -f ".env" ]; then
  echo "Creating .env from .env.example..."
  cp .env.example .env
fi

# ── Run migrations ──────────────────────────────────────────

echo "Pushing Prisma schema..."
npx prisma db push --skip-generate || echo "Warning: Could not push schema"

# ── Start dev server ────────────────────────────────────────

echo ""
echo "Starting ShareTab at http://localhost:3000"
echo "Press Ctrl-C to stop."
echo ""
npm run dev
