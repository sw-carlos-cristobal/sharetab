#!/bin/sh
set -e

# ── Validate required secrets ──────────────────────────────────
if [ -z "$NEXTAUTH_SECRET" ] || [ "$NEXTAUTH_SECRET" = "change-me-in-production" ]; then
  echo "ERROR: NEXTAUTH_SECRET must be set. Generate with: openssl rand -base64 32"
  exit 1
fi
if [ -z "$AUTH_SECRET" ] || [ "$AUTH_SECRET" = "change-me-in-production" ]; then
  echo "ERROR: AUTH_SECRET must be set. Generate with: openssl rand -base64 32"
  exit 1
fi

# ── Machine ID ─────────────────────────────────────────────────
# The Meridian proxy won't start without /etc/machine-id (it keys its
# session locks on it) and Alpine doesn't ship one. Generate one for this
# container unless one exists or was bind-mounted.
if [ ! -s /etc/machine-id ]; then
  if ! tr -d '-' < /proc/sys/kernel/random/uuid > /etc/machine-id 2>/dev/null; then
    echo "WARNING: could not write /etc/machine-id; the meridian AI provider will not start."
  fi
fi

PGDATA="${PGDATA:-/var/lib/postgresql/data}"
DB_USER="${DB_USER:-sharetab}"
DB_PASSWORD="${DB_PASSWORD:-sharetab}"
DB_NAME="${DB_NAME:-sharetab}"

# A DATABASE_URL means an external PostgreSQL server: the bundled one isn't
# initialized or started, and DB_USER/DB_PASSWORD/DB_NAME are ignored.
if [ -n "$DATABASE_URL" ]; then
  DB_MODE=external
else
  DB_MODE=bundled
fi

# Written into the bundled database's folder while an external one is in use,
# so a start that loses DATABASE_URL (a Compose upgrade without the overlay
# file, a cleared Unraid field) refuses instead of running on an empty or
# stale bundled database.
MODE_MARKER="$PGDATA/.sharetab-external-database"

# ── Signals ─────────────────────────────────────────────────
# Set before anything slow, so 'docker stop' is handled during startup too.
# 'docker stop' must reach Postgres: otherwise it gets SIGKILLed when the
# grace period expires and is forced into crash recovery on every restart
# (the stale postmaster.pid this script used to clean up).

CHILD_PID=""

# Stops the bundled server if it's running; safe to call more than once.
stop_postgres() {
  [ "$DB_MODE" = bundled ] || return 0
  [ -s "$PGDATA/PG_VERSION" ] || return 0
  su-exec postgres pg_ctl -D "$PGDATA" status >/dev/null 2>&1 || return 0
  echo "Stopping PostgreSQL..."
  su-exec postgres pg_ctl -D "$PGDATA" -m fast -w stop || true
}

shutdown() {
  echo "Received stop signal, shutting down..."
  if [ -n "$CHILD_PID" ]; then
    kill -TERM "$CHILD_PID" 2>/dev/null || true
    wait "$CHILD_PID" 2>/dev/null || true
  fi
  stop_postgres
  exit 0
}
trap shutdown TERM INT
# A failing startup step (set -e) and Node exiting leave through here too
trap stop_postgres EXIT

# Runs a step in the background and waits for it, so a stop signal is handled
# at once instead of when the step finishes.
run_step() {
  "$@" &
  CHILD_PID=$!
  step_status=0
  wait "$CHILD_PID" || step_status=$?
  CHILD_PID=""
  return "$step_status"
}

# Ensure uploads directory exists and is writable by the app user (needed for host bind-mounts)
UPLOAD_DIR="${UPLOAD_DIR:-/app/uploads}"
mkdir -p "$UPLOAD_DIR/receipts"
chown -R nextjs:nodejs "$UPLOAD_DIR"

# ── Start PostgreSQL (bundled mode) ─────────────────────────

start_bundled_postgres() {
# Ensure data directory exists and is owned by postgres (needed for host bind-mounts)
mkdir -p "$PGDATA"
chown postgres:postgres "$PGDATA"
chmod 700 "$PGDATA"

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

  # Use psql variable quoting (:"ident" / :'literal') so credentials containing
  # quotes can't break or inject into the bootstrap SQL
  su-exec postgres psql -h /run/postgresql -v ON_ERROR_STOP=1 \
    -v db_user="$DB_USER" -v db_password="$DB_PASSWORD" -v db_name="$DB_NAME" <<'EOSQL'
CREATE USER :"db_user" WITH PASSWORD :'db_password';
CREATE DATABASE :"db_name" OWNER :"db_user";
GRANT ALL PRIVILEGES ON DATABASE :"db_name" TO :"db_user";
EOSQL

  su-exec postgres pg_ctl -D "$PGDATA" -w stop
  echo "PostgreSQL initialized."
fi

echo "Starting PostgreSQL..."
# Remove stale PID file left behind by unclean container restarts
rm -f "$PGDATA/postmaster.pid"
su-exec postgres pg_ctl -D "$PGDATA" -w start -o "-k /run/postgresql"

# Wait for PostgreSQL to be ready
until su-exec postgres pg_isready -h localhost -q; do
  echo "Waiting for PostgreSQL..."
  sleep 1
done
echo "PostgreSQL is ready."

export DATABASE_URL="postgresql://$DB_USER:$DB_PASSWORD@localhost:5432/$DB_NAME"
}

if [ "$DB_MODE" = bundled ]; then
  if [ -f "$MODE_MARKER" ]; then
    echo "ERROR: This install was last started with an external database (DATABASE_URL),"
    echo "ERROR: so its data is there, not in the bundled database. Set DATABASE_URL again."
    echo "ERROR: To use the bundled database instead, delete $MODE_MARKER"
    echo "ERROR: (in the folder or volume mounted at $PGDATA) and restart."
    exit 1
  fi
  start_bundled_postgres
else
  if [ -s "$PGDATA/PG_VERSION" ]; then
    # Switching to an external server doesn't move the data. Say so, or an
    # install pointed at a new, empty database just looks like it lost everything.
    echo "WARNING: DATABASE_URL points to an external database, so the bundled database in"
    echo "WARNING: $PGDATA is not used. Its data was not copied; see the README's"
    echo "WARNING: \"Moving to an external database\"."
  fi
  if [ ! -f "$MODE_MARKER" ] &&
    ! { mkdir -p "$PGDATA" &&
      echo "ShareTab uses an external database (DATABASE_URL). While this file exists, it won't start the bundled one." >"$MODE_MARKER"; } 2>/dev/null; then
    echo "WARNING: could not write $MODE_MARKER; a start without DATABASE_URL won't be stopped."
  fi
fi

# Both modes. For an external server, waits for it to come up; for the bundled
# one, checks the URL the app will use signs in (pg_isready above doesn't).
run_step su-exec nextjs node /app/db.mjs wait

# ── Run Migrations ──────────────────────────────────────────

# Run manual SQL migrations (for changes prisma db push can't handle, e.g. enum conversions).
# They run before `prisma db push` on every start, including a fresh install's
# first, so each file must be idempotent and a no-op on an empty database.
# docker/db.mjs runs them rather than psql, which reads DATABASE_URL
# differently from the app (see the top of db.mjs).
for sqlfile in /app/prisma/migrations/*.sql; do
  [ -f "$sqlfile" ] || continue
  run_step su-exec nextjs node /app/db.mjs run migration "$sqlfile"
done

echo "Running database migrations..."
run_step env NODE_PATH=/prisma-cli/node_modules node /prisma-cli/node_modules/prisma/build/index.js db push

# Run SQL that needs the schema to exist and that prisma db push can't express
# (e.g. an index on lower(email)). Each file must be idempotent; any failure
# stops startup, so files log a warning instead for anything optional.
for sqlfile in /app/prisma/after-push/*.sql; do
  [ -f "$sqlfile" ] || continue
  run_step su-exec nextjs node /app/db.mjs run "post-schema SQL" "$sqlfile"
done

# ── Claude credentials: persistent shared dir for meridian provider ──
export CLAUDE_DIR="${CLAUDE_DIR:-/app/claude}"
mkdir -p "$CLAUDE_DIR"
chown nextjs:nodejs "$CLAUDE_DIR"
rm -rf /home/nextjs/.claude
ln -sfn "$CLAUDE_DIR" /home/nextjs/.claude
chown -h nextjs:nodejs /home/nextjs/.claude

# ── ChatGPT OAuth credentials: persistent shared dir for openai-codex provider ──
OPENAI_CODEX_DIR="${OPENAI_CODEX_DIR:-/app/chatgpt}"
mkdir -p "$OPENAI_CODEX_DIR"
chown nextjs:nodejs "$OPENAI_CODEX_DIR"

# ── Print config summary ────────────────────────────────────

echo ""
echo "============================================"
echo "  ShareTab Configuration"
echo "============================================"
echo "  Version:        $(node -e "console.log(require('./package.json').version)" 2>/dev/null || echo 'unknown')"
echo "  Commit:         $(cat .commit-sha 2>/dev/null || echo 'unknown')"
echo "  Database:       $DB_MODE, $(echo "$DATABASE_URL" | sed -E 's#//[^@]+@#//***:***@#; s#\?.*##')"
if [ "$DB_MODE" = bundled ]; then
  echo "  DB User:        ${DB_USER:-sharetab}"
  echo "  DB Name:        ${DB_NAME:-sharetab}"
fi
echo "  Auth URL:       ${NEXTAUTH_URL:-not set}"
echo "  Auth Trust:     ${AUTH_TRUST_HOST:-false}"
AI_PROVIDER_PRIORITY="${AI_PROVIDER_PRIORITY:-openai}"
echo "  AI Providers:   ${AI_PROVIDER_PRIORITY}"
case ",${AI_PROVIDER_PRIORITY}," in
  *,openai,*)
  echo "  OpenAI Model:   ${OPENAI_MODEL:-gpt-4o}"
  if [ -n "$OPENAI_API_KEY" ]; then
    echo "  OpenAI Auth:    configured"
  else
    echo "  OpenAI Auth:    missing"
  fi
  ;;
esac

case ",${AI_PROVIDER_PRIORITY}," in
  *,claude,*|*,meridian,*)
  echo "  AI Model:       ${ANTHROPIC_MODEL:-claude-sonnet-5}"
  case ",${AI_PROVIDER_PRIORITY}," in
    *,claude,*)
    if [ -n "$ANTHROPIC_API_KEY" ]; then
      echo "  Claude Auth:    configured"
    else
      echo "  Claude Auth:    missing"
    fi
    ;;
  esac
  case ",${AI_PROVIDER_PRIORITY}," in
    *,meridian,*)
    echo "  Meridian Port:  ${MERIDIAN_PORT:-3457}"
    echo "  Claude Data:    ${CLAUDE_DIR:-/app/claude}"
    if [ -f "${CLAUDE_DIR:-/app/claude}/.credentials.json" ]; then
      echo "  Claude Login:   detected"
    else
      echo "  Claude Login:   missing (complete OAuth from /admin)"
    fi
    ;;
  esac
  ;;
esac

case ",${AI_PROVIDER_PRIORITY}," in
  *,openai-codex,*)
  echo "  OpenAI Codex Model: ${OPENAI_CODEX_MODEL:-gpt-5.5}"
  echo "  ChatGPT Data:   ${OPENAI_CODEX_DIR:-/app/chatgpt}"
  if [ -f "${OPENAI_CODEX_DIR:-/app/chatgpt}/auth.json" ]; then
    echo "  ChatGPT Login:  detected"
  else
    echo "  ChatGPT Login:  missing (complete OAuth from /admin)"
  fi
  ;;
esac

case ",${AI_PROVIDER_PRIORITY}," in
  *,ollama,*)
  echo "  Ollama URL:     ${OLLAMA_BASE_URL:-not set}"
  echo "  Ollama Model:   ${OLLAMA_MODEL:-llava}"
  ;;
esac
echo "  Admin Email:    ${ADMIN_EMAIL:-not set}"
echo "  Upload Dir:     ${UPLOAD_DIR:-/app/uploads}"
echo "  Max Upload MB:  ${MAX_UPLOAD_SIZE_MB:-10}"
echo "  Auth RL Max:    ${AUTH_RATE_LIMIT_MAX:-5}"
echo "  Register RL:    ${REGISTER_RATE_LIMIT_MAX:-10}"
if [ -n "$EMAIL_SERVER_HOST" ]; then
  echo "  Magic Link:     enabled"
  echo "  Email Host:     ${EMAIL_SERVER_HOST}"
  echo "  Email Port:     ${EMAIL_SERVER_PORT:-587}"
  echo "  Email From:     ${EMAIL_FROM:-not set}"
else
  echo "  Magic Link:     disabled"
fi
if [ -n "$GOOGLE_CLIENT_ID" ] && [ -n "$GOOGLE_CLIENT_SECRET" ]; then
  echo "  Google OAuth:   enabled"
else
  echo "  Google OAuth:   disabled"
fi
if [ -n "$OIDC_ISSUER" ] && [ -n "$OIDC_CLIENT_ID" ] && [ -n "$OIDC_CLIENT_SECRET" ]; then
  echo "  OIDC SSO:       configured (${OIDC_ISSUER})"
else
  echo "  OIDC SSO:       disabled"
fi
case "$(echo "${DISABLE_PASSWORD_LOGIN:-false}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | tr '[:upper:]' '[:lower:]')" in
  true|1|yes|on) echo "  Password Login: disabled (ignored if no OIDC/magic link — see app log)" ;;
  *)             echo "  Password Login: enabled" ;;
esac
case "$(echo "${DISABLE_GUEST_UPLOADS:-false}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | tr '[:upper:]' '[:lower:]')" in
  true|1|yes|on) echo "  Guest Uploads:  locked off (DISABLE_GUEST_UPLOADS)" ;;
  *)             echo "  Guest Uploads:  admin toggle" ;;
esac
echo "  Log Level:      ${LOG_LEVEL:-info}"
echo "============================================"
echo ""

# ── Start App ───────────────────────────────────────────────

echo "Starting ShareTab..."
export HOME=/home/nextjs

# Run Node in the background so this script (PID 1) can forward signals
# (see Signals above). The EXIT trap stops the bundled server after Node exits.
su-exec nextjs node server.js &
CHILD_PID=$!
APP_EXIT=0
wait "$CHILD_PID" || APP_EXIT=$?
exit "$APP_EXIT"
