#!/usr/bin/env bash
# Helpers for .github/workflows/docker-fresh-install.yml, sourced by its steps.
# The container under test is named "sharetab" and publishes port 3000.

# Wait until /api/health answers, failing fast if the container exits.
# Usage: wait_healthy <label>
wait_healthy() {
  local label="$1"
  for _ in $(seq 1 90); do
    if [ "$(docker inspect -f '{{.State.Running}}' sharetab)" != "true" ]; then
      echo "::error::The container exited during startup ($label)."
      return 1
    fi
    if curl -fsS http://localhost:3000/api/health; then
      echo
      return 0
    fi
    sleep 2
  done
  echo "::error::Timed out waiting for /api/health ($label)."
  return 1
}

# Run SQL against the bundled database as the postgres superuser; prints
# unaligned, tuples-only output and fails on the first error.
# Usage: db -c '<sql>' [-c '<sql>' ...]
db() {
  docker exec sharetab su-exec postgres psql -h /run/postgresql -d sharetab \
    -v ON_ERROR_STOP=1 -tA "$@"
}

# Insert a minimal user row. Usage: add_user <id> <email>
add_user() {
  db -c "INSERT INTO \"User\" (id, email, \"updatedAt\") VALUES ('$1', '$2', now())"
}

# Prints "t" when the case-insensitive email index exists, "f" otherwise.
has_email_index() {
  db -c "SELECT to_regclass('\"User_email_lower_key\"') IS NOT NULL"
}
