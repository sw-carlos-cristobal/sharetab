#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PGDATA="$SCRIPT_DIR/.pgdata"

# Find pg_ctl
find_pg_bin() {
  if command -v "$1" &>/dev/null; then command -v "$1"; return; fi
  for ver in 16 15 14 13; do
    [ -x "/usr/lib/postgresql/$ver/bin/$1" ] && echo "/usr/lib/postgresql/$ver/bin/$1" && return
  done
  echo ""
}

PG_CTL=$(find_pg_bin pg_ctl)

if [ -z "$PG_CTL" ]; then
  echo "pg_ctl not found — PostgreSQL may not be installed."
  exit 1
fi

if "$PG_CTL" -D "$PGDATA" status > /dev/null 2>&1; then
  echo "Stopping PostgreSQL..."
  "$PG_CTL" -D "$PGDATA" stop
  echo "PostgreSQL stopped."
else
  echo "PostgreSQL is not running."
fi
