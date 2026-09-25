#!/usr/bin/env bash
# Smoke test for the production Docker image.
#
# Boots the image the way a new install does (empty data volume, bundled
# PostgreSQL, docker/entrypoint.sh), restarts it the way every existing
# install does on upgrade, and checks what the Test workflow's
# `npm run start` never exercises: the entrypoint, the hand-written SQL, and
# the packages the Dockerfile adds beside the standalone build (Meridian).
#
# CI runs it on every pull request and before publishing an image. Run it
# before pushing a Docker, entrypoint, or dependency change:
#
#   scripts/docker-smoke.sh --build                              # local Docker
#   DOCKER_HOST=ssh://user@host scripts/docker-smoke.sh --build  # remote Docker
#
# The container gets a unique name and publishes no ports, so it can run on
# a host that already runs ShareTab.
#
# Options:
#   --build           build docker/Dockerfile from this checkout first
#   --image <tag>     image to test (default: sharetab:smoke)
#   --meridian-auth <host-dir-or-volume>
#                     also extract a receipt through the Meridian proxy with
#                     a Claude Max/Pro login. The login directory (a path on
#                     the Docker host, or a volume) is copied into a scratch
#                     volume on the host, so the original is never written
#                     and the credentials never reach this machine. The
#                     access token must be valid for 30+ more minutes:
#                     refreshing it would rotate the refresh token and sign
#                     out the install the directory belongs to.
#   --keep            leave the container running afterwards
set -euo pipefail

IMAGE="sharetab:smoke"
BUILD=false
KEEP=false
MERIDIAN_AUTH=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --build) BUILD=true ;;
    --image) IMAGE="$2"; shift ;;
    --meridian-auth) MERIDIAN_AUTH="$2"; shift ;;
    --keep) KEEP=true ;;
    -h | --help) sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

cd "$(dirname "$0")/.."

CONTAINER="sharetab-smoke-$$-$RANDOM"
AUTH_VOLUME=""
FAILED=true

# ── Output ─────────────────────────────────────────────────────

section() {
  if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
    echo "::endgroup::"
    echo "::group::$1"
  else
    printf '\n== %s\n' "$1"
  fi
}

fail() {
  if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
    echo "::error::$*"
  else
    echo "FAIL: $*" >&2
  fi
  exit 1
}

cleanup() {
  [[ -n "${GITHUB_ACTIONS:-}" ]] && echo "::endgroup::"
  if [[ "$FAILED" == true ]] && docker inspect "$CONTAINER" >/dev/null 2>&1; then
    printf '\n== Container logs (last 200 lines)\n'
    docker logs --tail 200 "$CONTAINER" 2>&1 || true
  fi
  if [[ "$KEEP" == true ]]; then
    echo "Kept container $CONTAINER"
    return
  fi
  docker rm -f -v "$CONTAINER" >/dev/null 2>&1 || true
  if [[ -n "$AUTH_VOLUME" ]]; then
    docker volume rm "$AUTH_VOLUME" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# ── Helpers ────────────────────────────────────────────────────

# Wait until /api/health answers inside the container, failing fast if the
# container exits. Usage: wait_healthy <label>
wait_healthy() {
  local label="$1"
  for _ in $(seq 1 90); do
    if [[ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER")" != "true" ]]; then
      fail "The container exited during startup ($label)."
    fi
    if docker exec "$CONTAINER" wget -qO- http://127.0.0.1:3000/api/health 2>/dev/null; then
      echo
      return 0
    fi
    sleep 2
  done
  fail "Timed out waiting for /api/health ($label)."
}

# Run SQL against the bundled database as the postgres superuser; prints
# unaligned, tuples-only output and fails on the first error.
# Usage: db -c '<sql>' [-c '<sql>' ...]
db() {
  docker exec "$CONTAINER" su-exec postgres psql -h /run/postgresql -d sharetab \
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

# ── Build ──────────────────────────────────────────────────────

if [[ "$BUILD" == true ]]; then
  section "Build $IMAGE"
  docker build -f docker/Dockerfile -t "$IMAGE" \
    --build-arg COMMIT_SHA="$(git rev-parse HEAD 2>/dev/null || echo unknown)" .
fi

# ── Checks ─────────────────────────────────────────────────────

section "Start on an empty database"
auth_mount=()
if [[ -n "$MERIDIAN_AUTH" ]]; then
  AUTH_VOLUME="$CONTAINER-claude"
  docker volume create "$AUTH_VOLUME" >/dev/null
  docker run --rm --entrypoint /bin/sh \
    -v "$MERIDIAN_AUTH:/src:ro" -v "$AUTH_VOLUME:/dst" "$IMAGE" \
    -c 'cp -a /src/. /dst/'
  auth_mount=(-v "$AUTH_VOLUME:/app/claude")
fi
secret=$(openssl rand -base64 32)
docker run -d --name "$CONTAINER" \
  -e NEXTAUTH_SECRET="$secret" -e AUTH_SECRET="$secret" \
  "${auth_mount[@]}" "$IMAGE" >/dev/null
wait_healthy "first start"
# The tables exist, not just a reachable database (psql fails if either is
# missing).
db -c 'SELECT count(*) FROM "User"' -c 'SELECT count(*) FROM "GuestSplit"'

section "Meridian proxy starts"
# The standalone trace misses Meridian (a dynamic import) and the native
# packages it loads, so the Dockerfile stages them. Starting the proxy on a
# spare port fails unless the module and its dependencies load,
# /etc/machine-id exists, and the Claude Code binary resolves. No Claude
# login is needed to start it.
docker exec "$CONTAINER" /usr/local/bin/claude --version || fail "The Claude Code binary did not run."
docker exec -w /app "$CONTAINER" node -e "
  import('@rynfar/meridian')
    .then(async (m) => {
      await m.startProxyServer({ port: 3499, host: '127.0.0.1', silent: true });
      const res = await fetch('http://127.0.0.1:3499/health');
      console.log('health:', res.status, await res.text());
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
" || fail "The Meridian proxy did not start."

if [[ -n "$MERIDIAN_AUTH" ]]; then
  section "Meridian extracts a receipt (live)"
  # Refuse to run close to expiry: a refresh here would rotate the refresh
  # token the original install still holds.
  minutes_left=$(docker exec "$CONTAINER" node -e "
    const creds = JSON.parse(require('fs').readFileSync('/app/claude/.credentials.json', 'utf8'));
    const expiresAt = creds.claudeAiOauth?.expiresAt ?? 0;
    console.log(Math.floor((expiresAt - Date.now()) / 60000));
  ") || fail "No readable .credentials.json in $MERIDIAN_AUTH."
  if (( minutes_left < 30 )); then
    fail "The Claude access token expires in ${minutes_left} min; sign in again from the admin page first."
  fi
  echo "Access token valid for ${minutes_left} more minutes."
  docker cp e2e/test-receipt.png "$CONTAINER:/tmp/smoke-receipt.png"
  # Runs as the app user with the app's environment, like the provider.
  docker exec -u nextjs -e HOME=/home/nextjs -e CLAUDE_DIR=/app/claude -w /app "$CONTAINER" \
    timeout 240 node -e "
      const fs = require('fs');
      import('@rynfar/meridian').then(async (m) => {
        await m.startProxyServer({ port: 3498, host: '127.0.0.1', silent: true });
        const res = await fetch('http://127.0.0.1:3498/v1/messages', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': 'x', 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({
            model: process.env.ANTHROPIC_MODEL || 'claude-opus-4-6',
            max_tokens: 200,
            messages: [{ role: 'user', content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/png',
                data: fs.readFileSync('/tmp/smoke-receipt.png').toString('base64') } },
              { type: 'text', text: 'What is the TOTAL on this receipt? Reply with only the number.' },
            ] }],
          }),
        });
        const body = await res.text();
        console.log('status:', res.status);
        console.log('body:', body.slice(0, 1000));
        process.exit(res.ok && body.includes('376.68') ? 0 : 1);
      }).catch((err) => { console.error(err); process.exit(1); });
    " || fail "Meridian did not extract the receipt total (expected 376.68)."
fi

section "Emails are unique ignoring case"
add_user ci-1 'CI@Example.com'
if add_user ci-2 'ci@example.com'; then
  fail "A case variant of an existing email was accepted."
fi
add_user ci-3 'other@example.com'
db -c "DELETE FROM \"User\" WHERE id LIKE 'ci-%'"

section "Restart, and prisma db push keeps the email index"
# The after-push SQL would recreate a dropped index before we look, so
# compare the index's identity instead of just its existence.
before=$(db -c "SELECT '\"User_email_lower_key\"'::regclass::oid")
docker restart "$CONTAINER" >/dev/null
wait_healthy "restart"
after=$(db -c "SELECT '\"User_email_lower_key\"'::regclass::oid")
if [[ "$before" != "$after" ]]; then
  fail "prisma db push dropped User_email_lower_key (oid $before -> $after)."
fi

section "Existing case-variant duplicates don't block startup"
# An install from before the index, with case-variant duplicates.
db -c 'DROP INDEX "User_email_lower_key"'
add_user dup-1 'Dup@Example.com'
add_user dup-2 'dup@example.com'
docker restart "$CONTAINER" >/dev/null
wait_healthy "restart with duplicates"
if ! docker logs "$CONTAINER" 2>&1 | grep -q "more than one account uses each of these addresses in different letter cases: dup@example.com"; then
  fail "No warning about the duplicate emails in the startup log."
fi
if [[ "$(has_email_index)" != "f" ]]; then
  fail "The email index exists although duplicates do."
fi
# Once the duplicate is gone, the next start creates the index.
db -c "DELETE FROM \"User\" WHERE id = 'dup-2'"
docker restart "$CONTAINER" >/dev/null
wait_healthy "restart after removing the duplicate"
if [[ "$(has_email_index)" != "t" ]]; then
  fail "The email index wasn't created after the duplicate was removed."
fi

FAILED=false
section "Done"
echo "All smoke checks passed for $IMAGE."
