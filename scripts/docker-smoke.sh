#!/usr/bin/env bash
# Smoke test for the production Docker image.
#
# Boots the image the way a new install does (empty data volume, bundled
# PostgreSQL, docker/entrypoint.sh), restarts it the way every existing
# install does on upgrade, and checks what the Test workflow's
# `npm run start` never exercises: the entrypoint, the pre-push SQL
# migrations, and the packages the Dockerfile adds beside the standalone
# build (Meridian and what it loads at runtime). Then it runs the image
# against PostgreSQL in its own container (DATABASE_URL set, the bundled
# server off), over TLS with a self-signed certificate.
#
# CI runs it on every pull request and before publishing an image. Run it
# before pushing a Docker, entrypoint, or dependency change:
#
#   scripts/docker-smoke.sh --build                              # local Docker
#   DOCKER_HOST=ssh://user@host scripts/docker-smoke.sh --build  # remote Docker
#
# Access to a Docker daemon is root-equivalent on its host; point DOCKER_HOST
# only at a host where that is acceptable. The container gets a unique name
# and publishes no ports, so it can run on a host that already runs ShareTab.
# Everything it creates is labeled sharetab-smoke and removed on exit; if a
# run is killed (SIGKILL skips the cleanup), remove the leftovers with:
#   docker rm -f -v $(docker ps -aq --filter label=sharetab-smoke)
#   docker volume rm $(docker volume ls -q --filter label=sharetab-smoke)
#
# Options:
#   --build           build docker/Dockerfile from this checkout first
#   --image <tag>     image to test (default: sharetab:smoke)
#   --meridian-auth <absolute-host-path-or-volume>
#                     local runs only: extract a receipt through Meridian with
#                     a Claude Max/Pro login, via the admin "Test Receipt
#                     Extraction" endpoint. The login directory (a path on the
#                     Docker host, or a volume) is copied into a scratch
#                     volume on the host that is removed afterwards, so the
#                     original is never written and the credentials never
#                     reach this machine. The access token must be valid for
#                     30+ more minutes, checked on the copy before anything
#                     starts (Meridian and the app refresh an expired token
#                     as soon as they start): a refresh would rotate the
#                     refresh token and sign out the install the directory
#                     belongs to. The script fails if one happened anyway.
#   --keep            leave the container running afterwards (not with
#                     --meridian-auth). It holds a smoke-test admin account
#                     (credentials printed on exit) that other containers on
#                     its Docker network can reach; remove it when done.
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
# The external-database checks: a network, a PostgreSQL container, ShareTab
# on it, a container for the starts expected to fail, and a data volume
EXT_NET="$CONTAINER-net"
EXT_PG="$CONTAINER-pg"
EXT_APP="$CONTAINER-ext"
EXT_ONESHOT="$CONTAINER-oneshot"
EXT_PGDATA="$CONTAINER-pgdata"
TLS_DIR=""
AUTH_VOLUME=""
AUTH_TOKEN_HASH=""
FAILED=true
ADMIN_EMAIL="smoke-admin@example.com"
ADMIN_PASSWORD=$(openssl rand -hex 16)

# ── Output ─────────────────────────────────────────────────────

GROUP_OPEN=false
section() {
  if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
    [[ "$GROUP_OPEN" == true ]] && echo "::endgroup::"
    echo "::group::$1"
    GROUP_OPEN=true
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

if [[ -n "$MERIDIAN_AUTH" && -n "${GITHUB_ACTIONS:-}" ]]; then
  fail "--meridian-auth is for local runs; CI logs are public."
fi
if [[ -n "$MERIDIAN_AUTH" && "$KEEP" == true ]]; then
  fail "--keep would leave a copy of the Claude login on the Docker host; drop one of them."
fi

cleanup() {
  if [[ "$GROUP_OPEN" == true ]]; then
    echo "::endgroup::"
    GROUP_OPEN=false
  fi
  if { [[ "$FAILED" == true ]] || [[ -n "${GITHUB_ACTIONS:-}" ]]; } &&
    docker inspect "$CONTAINER" >/dev/null 2>&1; then
    printf '\n== Container logs (last 200 lines)\n'
    docker logs --tail 200 "$CONTAINER" 2>&1 || true
  fi
  if [[ "$FAILED" == true ]] && docker inspect "$EXT_APP" >/dev/null 2>&1; then
    printf '\n== External-database container logs (last 100 lines)\n'
    docker logs --tail 100 "$EXT_APP" 2>&1 || true
  fi
  # --keep keeps only the main container
  docker rm -f -v "$EXT_APP" "$EXT_ONESHOT" "$EXT_PG" >/dev/null 2>&1 || true
  docker volume rm "$EXT_PGDATA" >/dev/null 2>&1 || true
  docker network rm "$EXT_NET" >/dev/null 2>&1 || true
  if [[ -n "$TLS_DIR" ]]; then
    rm -rf "$TLS_DIR"
  fi
  if [[ "$KEEP" == true ]]; then
    echo "Kept container $CONTAINER (admin: $ADMIN_EMAIL / $ADMIN_PASSWORD)"
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
# container exits. Usage: wait_healthy <label> [container]
wait_healthy() {
  local label="$1" container="${2:-$CONTAINER}"
  for _ in $(seq 1 90); do
    if [[ "$(docker inspect -f '{{.State.Running}}' "$container")" != "true" ]]; then
      fail "The container exited during startup ($label)."
    fi
    if docker exec "$container" wget -qO- http://127.0.0.1:3000/api/health 2>/dev/null; then
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

# Copy the Claude login in $MERIDIAN_AUTH into a scratch volume owned by the
# app user, set AUTH_VOLUME, and check the copy before the app ever sees it
# (setting AUTH_TOKEN_HASH). A host path must be absolute and must exist
# (docker run fails otherwise); a volume name must exist (docker would
# otherwise create an empty one).
copy_meridian_auth() {
  local source
  if [[ "$MERIDIAN_AUTH" == /* ]]; then
    source="type=bind,src=$MERIDIAN_AUTH,dst=/src,readonly"
  elif [[ "$MERIDIAN_AUTH" == */* ]]; then
    fail "--meridian-auth needs an absolute path on the Docker host or a volume name."
  else
    docker volume inspect "$MERIDIAN_AUTH" >/dev/null 2>&1 ||
      fail "No volume named $MERIDIAN_AUTH on the Docker host."
    source="type=volume,src=$MERIDIAN_AUTH,dst=/src,readonly"
  fi
  AUTH_VOLUME="$CONTAINER-claude"
  docker volume create --label sharetab-smoke "$AUTH_VOLUME" >/dev/null
  # uid 1001 is the image's nextjs user (docker/Dockerfile), which reads it.
  docker run --rm --entrypoint /bin/sh --mount "$source" \
    --mount "type=volume,src=$AUTH_VOLUME,dst=/dst" "$IMAGE" \
    -c 'cp -a /src/. /dst/ && chown -R 1001:1001 /dst' ||
    fail "Could not copy the Claude login from $MERIDIAN_AUTH."

  # Check expiry here, not in the running container. Meridian's proxy
  # refreshes a token that has expired or expires within 5 minutes as soon
  # as it starts (startProxyServer schedules the refresh), and so do the
  # app's startup (refreshIfNeeded) and its auth poller (within 15 minutes).
  # Checked later, an expired login already looks fresh and the original
  # install's refresh token is already rotated.
  local minutes_left reading
  reading=$(docker run --rm --entrypoint node \
    --mount "type=volume,src=$AUTH_VOLUME,dst=/dst,readonly" "$IMAGE" -e "
      const creds = JSON.parse(require('fs').readFileSync('/dst/.credentials.json', 'utf8'));
      const oauth = creds.claudeAiOauth ?? {};
      const minutes = Math.floor(((oauth.expiresAt ?? 0) - Date.now()) / 60000);
      const token = oauth.refreshToken;
      const hash = token ? require('crypto').createHash('sha256').update(token).digest('hex') : 'none';
      console.log(minutes + ' ' + hash);
    ") || fail "No readable .credentials.json in $MERIDIAN_AUTH."
  read -r minutes_left AUTH_TOKEN_HASH <<<"$reading"
  if [[ "$AUTH_TOKEN_HASH" == none ]]; then
    fail "The Claude login in $MERIDIAN_AUTH has no refresh token; sign in again from that install's admin page first."
  fi
  if ((minutes_left < 30)); then
    fail "The Claude access token expires in ${minutes_left} min (negative: already expired); sign in again from the admin page of the install $MERIDIAN_AUTH came from first."
  fi
  echo "Access token valid for ${minutes_left} more minutes."
}

# Prints a hash of the refresh token in the container's copy of the login, or
# "none" when it has none.
refresh_token_hash() {
  docker exec "$CONTAINER" node -e "
    const creds = JSON.parse(require('fs').readFileSync('/app/claude/.credentials.json', 'utf8'));
    const token = creds.claudeAiOauth?.refreshToken;
    console.log(token ? require('crypto').createHash('sha256').update(token).digest('hex') : 'none');
  "
}

# Fails if the container's copy of the login no longer holds the refresh
# token it was copied with. A new token means a refresh rotated it, which
# signs out the install $MERIDIAN_AUTH came from; none means Claude Code
# cleared the copy after a refresh failed.
check_login_unchanged() {
  local now
  now=$(refresh_token_hash)
  if [[ "$now" == none ]]; then
    fail "Claude Code cleared its copy of the login after a refresh failed, so the refresh token is probably invalid on the install $MERIDIAN_AUTH came from too; check its admin page."
  elif [[ "$now" != "$AUTH_TOKEN_HASH" ]]; then
    fail "The Claude login was refreshed during the run, which rotates its refresh token; sign in again on the install $MERIDIAN_AUTH came from."
  fi
}

# Runs scripts/docker-smoke-meridian.mjs in the container: signs in as an
# admin and runs the admin "Test Receipt Extraction" endpoint with the
# meridian provider, the path the app takes. Without a Claude login it
# expects Meridian's own authentication error (from 1.83 on, Meridian reports
# no login as unhealthy, so the app skips the provider and the script checks
# Meridian's answers directly); with --meridian-auth, the receipt's total.
check_meridian_via_app() {
  docker cp e2e/test-receipt.png "$CONTAINER:/tmp/smoke-receipt.png"
  docker cp scripts/docker-smoke-meridian.mjs "$CONTAINER:/tmp/smoke-meridian.mjs"
  docker exec -u nextjs -e LIVE="${MERIDIAN_AUTH:+1}" -e ADMIN_EMAIL="$ADMIN_EMAIL" \
    -e ADMIN_PASSWORD="$ADMIN_PASSWORD" -e RECEIPT=/tmp/smoke-receipt.png "$CONTAINER" \
    timeout 300 node /tmp/smoke-meridian.mjs
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
  copy_meridian_auth
  auth_mount=(--mount "type=volume,src=$AUTH_VOLUME,dst=/app/claude")
fi
secret=$(openssl rand -base64 32)
# ${auth_mount[@]+...} keeps an empty array from tripping set -u in bash < 4.4.
docker run -d --name "$CONTAINER" --label sharetab-smoke \
  -e NEXTAUTH_SECRET="$secret" -e AUTH_SECRET="$secret" \
  -e AUTH_TRUST_HOST=true -e ADMIN_EMAIL="$ADMIN_EMAIL" \
  ${auth_mount[@]+"${auth_mount[@]}"} "$IMAGE" >/dev/null
wait_healthy "first start"
# The tables exist, not just a reachable database (psql fails if either is
# missing).
db -c 'SELECT count(*) FROM "User"' -c 'SELECT count(*) FROM "GuestSplit"'

section "Meridian proxy starts"
# `claude --version` checks the Claude Code binary runs. Starting the proxy on
# a spare port, as the app user, checks Meridian and everything it loads at
# runtime (libsql's native package) are present and /etc/machine-id exists.
docker exec "$CONTAINER" /usr/local/bin/claude --version || fail "The Claude Code binary did not run."
# startProxyServer resolves before the server listens, so poll /health.
docker exec -u nextjs -e HOME=/home/nextjs -w /app "$CONTAINER" node -e "
  import('@rynfar/meridian')
    .then(async (m) => {
      await m.startProxyServer({ port: 3499, host: '127.0.0.1', silent: true });
      for (let i = 0; i < 40; i++) {
        try {
          const res = await fetch('http://127.0.0.1:3499/health');
          console.log('health:', res.status, await res.text());
          process.exit(0);
        } catch {
          await new Promise((r) => setTimeout(r, 250));
        }
      }
      console.error('the proxy never answered /health');
      process.exit(1);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
" || fail "The Meridian proxy did not start."

if [[ -n "$MERIDIAN_AUTH" ]]; then
  section "Meridian extracts a receipt through the app (live)"
  # Report a changed login even when the extraction failed.
  live_status=0
  check_meridian_via_app || live_status=$?
  check_login_unchanged
  ((live_status == 0)) || fail "Meridian did not extract the receipt through the app."
else
  section "Meridian runs through the app"
  check_meridian_via_app || fail "The app's Meridian provider did not run."
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
# Not `docker logs | grep -q`: grep -q exits at the first match, docker logs
# then dies of SIGPIPE writing the rest, and pipefail fails the pipeline, so
# the check failed at random.
startup_log=$(docker logs "$CONTAINER" 2>&1)
if ! grep -qF "more than one account uses each of these addresses in different letter cases: dup@example.com" <<<"$startup_log"; then
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

if [[ -n "$MERIDIAN_AUTH" ]]; then
  # The restarts above ran with the login mounted too.
  check_login_unchanged
fi

# ── External database ──────────────────────────────────────────

# SQL against the external database over its Unix socket; output as db().
ext_db() {
  docker exec "$EXT_PG" psql -U sharetab -d sharetab -v ON_ERROR_STOP=1 -tA "$@"
}

# Start ShareTab on the external database's network, with DATABASE_URL set
# unless <url> is empty. Usage: run_external <name> <url> [docker run args...]
run_external() {
  local name="$1" url="$2"
  shift 2
  local env=(-e NEXTAUTH_SECRET="$secret" -e AUTH_SECRET="$secret" -e AUTH_TRUST_HOST=true)
  if [[ -n "$url" ]]; then
    env+=(-e DATABASE_URL="$url")
  fi
  docker rm -f -v "$name" >/dev/null 2>&1 || true
  docker run -d --name "$name" --label sharetab-smoke --network "$EXT_NET" \
    "${env[@]}" "$@" "$IMAGE" >/dev/null
}

# Wait up to <seconds> for a container to exit, then print its exit code;
# returns 1 if it's still running. (Not fail(): it's called in $(...), where
# fail's ::error:: line would be captured instead of shown.)
# Usage: wait_exited <container> <seconds>
wait_exited() {
  local container="$1" seconds="$2"
  for _ in $(seq 1 "$seconds"); do
    if [[ "$(docker inspect -f '{{.State.Running}}' "$container")" != "true" ]]; then
      docker inspect -f '{{.State.ExitCode}}' "$container"
      return 0
    fi
    sleep 1
  done
  return 1
}

# Start ShareTab with <url> and expect it to stop at once, with a non-zero
# exit and <text> in its log.
# Usage: expect_refused <label> <url> <text> [docker run args...]
expect_refused() {
  local label="$1" url="$2" text="$3" code log
  shift 3
  run_external "$EXT_ONESHOT" "$url" "$@"
  code=$(wait_exited "$EXT_ONESHOT" 30) || fail "$label: still running after 30s."
  log=$(docker logs "$EXT_ONESHOT" 2>&1)
  [[ "$code" != 0 ]] || fail "$label: the container exited 0."
  grep -qF "$text" <<<"$log" || fail "$label: no \"$text\" in its log."
  grep -E '^ERROR' <<<"$log" | head -2
}

section "External database: start beside PostgreSQL, TLS only"
# A self-signed certificate, as on most home servers, and a server that
# accepts TLS connections only, so db.mjs, the image's Prisma CLI and the app
# all have to use TLS with the one DATABASE_URL (sslmode=no-verify).
TLS_DIR=$(mktemp -d)
openssl req -new -x509 -days 1 -nodes -subj "/CN=$EXT_PG" \
  -keyout "$TLS_DIR/server.key" -out "$TLS_DIR/server.crt" 2>/dev/null
printf 'local all all trust\nhostssl all all all scram-sha-256\n' >"$TLS_DIR/pg_hba.conf"
docker network create --label sharetab-smoke "$EXT_NET" >/dev/null
# postgres:16-alpine has no openssl, so the files are copied in before it
# starts, and moved where the server user can own them.
docker create --name "$EXT_PG" --label sharetab-smoke --network "$EXT_NET" \
  -e POSTGRES_USER=sharetab -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=sharetab \
  --entrypoint sh postgres:16-alpine -c '
    install -o postgres -g postgres -m 600 /tls/server.key /tls/server.crt /tls/pg_hba.conf /var/lib/postgresql/ &&
    exec docker-entrypoint.sh postgres -c ssl=on \
      -c ssl_cert_file=/var/lib/postgresql/server.crt \
      -c ssl_key_file=/var/lib/postgresql/server.key \
      -c hba_file=/var/lib/postgresql/pg_hba.conf' >/dev/null
docker cp "$TLS_DIR/." "$EXT_PG:/tls"
# A data folder that looks like it holds a bundled database, for the warning
docker volume create --label sharetab-smoke "$EXT_PGDATA" >/dev/null
docker run --rm --entrypoint sh -v "$EXT_PGDATA:/d" "$IMAGE" -c 'echo 16 > /d/PG_VERSION'
# Started together, as Compose and Kubernetes do, so ShareTab has to wait
docker start "$EXT_PG" >/dev/null
EXT_URL="postgresql://sharetab:pw@$EXT_PG:5432/sharetab?sslmode=no-verify"
run_external "$EXT_APP" "$EXT_URL" -v "$EXT_PGDATA:/var/lib/postgresql/data"
wait_healthy "external database, first start" "$EXT_APP"

section "External database: the bundled server stays off"
ext_log=$(docker logs "$EXT_APP" 2>&1)
if grep -qE 'Initializing PostgreSQL|Starting PostgreSQL' <<<"$ext_log"; then
  fail "The bundled PostgreSQL was started although DATABASE_URL is set."
fi
docker exec "$EXT_APP" sh -c '! pg_isready -h localhost -q' ||
  fail "Something answers on localhost:5432 inside the container."
grep -qE '^  Database: +external, postgresql://\*\*\*:\*\*\*@' <<<"$ext_log" ||
  fail "The startup summary doesn't say the database is external."
grep -qF 'WARNING: DATABASE_URL points to an external database' <<<"$ext_log" ||
  fail "No warning that the bundled database in the data folder isn't used."
docker exec "$EXT_APP" test -f /var/lib/postgresql/data/.sharetab-external-database ||
  fail "The external-database marker wasn't written."

section "External database: schema, SQL phases and email index"
ext_db -c 'SELECT count(*) FROM "User"' -c 'SELECT count(*) FROM "GuestSplit"' >/dev/null
[[ "$(ext_db -c "SELECT count(*) FROM pg_type WHERE typname = 'GuestSplitStatus'")" == 1 ]] ||
  fail "The GuestSplitStatus enum from prisma/migrations is missing."
[[ "$(ext_db -c "SELECT to_regclass('\"User_email_lower_key\"') IS NOT NULL")" == t ]] ||
  fail "The email index from prisma/after-push is missing."

section "External database: a connection without TLS is refused"
# So the app working at all shows its connections used TLS.
if no_tls=$(docker exec -e DATABASE_URL="postgresql://sharetab:pw@$EXT_PG:5432/sharetab?sslmode=disable" \
  "$EXT_APP" node /app/db.mjs wait 2>&1); then
  fail "A connection without TLS was accepted."
fi
grep -qF 'pg_hba.conf' <<<"$no_tls" || fail "Unexpected answer to a connection without TLS: $no_tls"
echo "$no_tls"

section "External database: restart keeps the email index"
before=$(ext_db -c "SELECT '\"User_email_lower_key\"'::regclass::oid")
docker restart "$EXT_APP" >/dev/null
wait_healthy "external database, restart" "$EXT_APP"
after=$(ext_db -c "SELECT '\"User_email_lower_key\"'::regclass::oid")
[[ "$before" == "$after" ]] || fail "prisma db push dropped User_email_lower_key (oid $before -> $after)."

section "External database: docker stop"
docker stop "$EXT_APP" >/dev/null
[[ "$(docker inspect -f '{{.State.ExitCode}}' "$EXT_APP")" == 0 ]] || fail "ShareTab exited non-zero on docker stop."
if grep -qF 'Stopping PostgreSQL' <<<"$(docker logs --tail 20 "$EXT_APP" 2>&1)"; then
  fail "docker stop tried to stop a bundled PostgreSQL that wasn't running."
fi

section "External database: a start without DATABASE_URL refuses"
# As after a Compose upgrade run without the overlay file
expect_refused "bundled start on an external install's data folder" "" \
  "last started with an external database" -v "$EXT_PGDATA:/var/lib/postgresql/data"
docker run --rm --entrypoint sh -v "$EXT_PGDATA:/d" "$IMAGE" -c 'test ! -e /d/base' ||
  fail "The bundled database was initialized in the external install's data folder."

section "External database: errors waiting won't fix stop startup at once"
expect_refused "wrong password" "postgresql://sharetab:wrong@$EXT_PG:5432/sharetab?sslmode=no-verify" \
  "password authentication failed"
expect_refused "sslmode=require with a self-signed certificate" \
  "postgresql://sharetab:pw@$EXT_PG:5432/sharetab?sslmode=require" "sslmode=require verifies the certificate"

section "External database: docker stop during the wait"
run_external "$EXT_ONESHOT" "postgresql://sharetab:pw@sharetab-smoke-nowhere.invalid:5432/sharetab" \
  -e DB_WAIT_SECONDS=300
for _ in $(seq 1 30); do
  if grep -qF 'Waiting for the database' <<<"$(docker logs "$EXT_ONESHOT" 2>&1)"; then
    break
  fi
  sleep 1
done
grep -qF 'Waiting for the database' <<<"$(docker logs "$EXT_ONESHOT" 2>&1)" ||
  fail "ShareTab never started waiting for the unresolvable database."
stop_start=$SECONDS
docker stop -t 30 "$EXT_ONESHOT" >/dev/null
((SECONDS - stop_start < 10)) || fail "docker stop took $((SECONDS - stop_start))s during the wait."
[[ "$(docker inspect -f '{{.State.ExitCode}}' "$EXT_ONESHOT")" == 0 ]] ||
  fail "ShareTab exited non-zero on docker stop during the wait."
echo "Stopped in $((SECONDS - stop_start))s."

FAILED=false
section "Done"
echo "All smoke checks passed for $IMAGE."
