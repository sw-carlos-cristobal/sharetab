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

PGDATA="${PGDATA:-/var/lib/postgresql/data}"
DB_USER="${DB_USER:-sharetab}"
DB_PASSWORD="${DB_PASSWORD:-sharetab}"
DB_NAME="${DB_NAME:-sharetab}"

# ── Start PostgreSQL ────────────────────────────────────────

# Ensure data directory exists and is owned by postgres (needed for host bind-mounts)
mkdir -p "$PGDATA"
chown postgres:postgres "$PGDATA"
chmod 700 "$PGDATA"

# Ensure uploads directory exists and is writable by the app user (needed for host bind-mounts)
UPLOAD_DIR="${UPLOAD_DIR:-/app/uploads}"
mkdir -p "$UPLOAD_DIR/receipts"
chown -R nextjs:nodejs "$UPLOAD_DIR"

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
# Remove stale PID file left behind by unclean container restarts
rm -f "$PGDATA/postmaster.pid"
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
NODE_PATH=/prisma-cli/node_modules node /prisma-cli/node_modules/prisma/build/index.js db push || \
echo "Warning: Could not apply schema"

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
echo "  Database:       ${DATABASE_URL%@*}@***"
echo "  DB User:        ${DB_USER:-sharetab}"
echo "  DB Name:        ${DB_NAME:-sharetab}"
echo "  Auth URL:       ${NEXTAUTH_URL:-not set}"
echo "  Auth Trust:     ${AUTH_TRUST_HOST:-false}"
AI_PROVIDER_PRIORITY="${AI_PROVIDER_PRIORITY:-openai,ocr}"
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
  echo "  AI Model:       ${ANTHROPIC_MODEL:-claude-sonnet-4-6}"
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
      echo "  Claude Login:   missing (run 'claude login')"
    fi
    ;;
  esac
  ;;
esac

case ",${AI_PROVIDER_PRIORITY}," in
  *,openai-codex,*)
  echo "  OpenAI Codex Model: ${OPENAI_CODEX_MODEL:-gpt-5.4}"
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
if [ -n "$GOOGLE_CLIENT_ID" ]; then
  echo "  Google OAuth:   enabled"
else
  echo "  Google OAuth:   disabled"
fi
echo "  Log Level:      ${LOG_LEVEL:-info}"
echo "============================================"
echo ""

# ── Start App ───────────────────────────────────────────────

echo "Starting ShareTab..."
export HOME=/home/nextjs
exec su-exec nextjs node server.js
