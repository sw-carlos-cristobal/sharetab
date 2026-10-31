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
# server off), over TLS with a self-signed certificate. Backups are restored
# the README's way, in maintenance mode (SHARETAB_MAINTENANCE).
#
# CI runs it on every pull request and before publishing an image. Run it
# before pushing a Docker, entrypoint, or dependency change:
#
#   scripts/docker-smoke.sh --build                              # local Docker
#   DOCKER_HOST=ssh://user@host scripts/docker-smoke.sh --build  # remote Docker
#
# Access to a Docker daemon is root-equivalent on its host; point DOCKER_HOST
# only at a host where that is acceptable. Its containers, volumes and network
# get unique names and publish no ports, so it can run on a host that already
# runs ShareTab.
# Everything it creates is labeled sharetab-smoke and removed on exit; if a
# run is killed (SIGKILL skips the cleanup), remove the leftovers with:
#   docker rm -f -v $(docker ps -aq --filter label=sharetab-smoke)
#   docker volume rm $(docker volume ls -q --filter label=sharetab-smoke)
#   docker network rm $(docker network ls -q --filter label=sharetab-smoke)
# and the Compose project of the overlay check, which Compose labels its own
# way: docker compose ls -a | grep sharetab-smoke, then
#   docker compose -p <name> down -v
# (or, without Compose, docker ps -a / docker volume ls / docker network ls
# --filter label=com.docker.compose.project=<name>)
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
# In CI, name the line of a command that stops the script outside fail()
if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
  set -E
  trap 'echo "::error::docker-smoke.sh line $LINENO: $BASH_COMMAND"' ERR
fi

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
EXT_PGDATA_NEW="$CONTAINER-pgdata-new"
# A data folder that still holds a bundled database, for the empty-database refusal
EXT_PGDATA_OLD="$CONTAINER-pgdata-old"
# A fresh bundled install, for the first-start checks
BOOT="$CONTAINER-boot"
# ShareTab on the overlay's database
OVERLAY_APP="$CONTAINER-overlay"
# Maintenance mode for a restore, and a fresh install a backup is restored into
MAINT="$CONTAINER-maint"
FRESH="$CONTAINER-fresh"
# Temporary files and folders made on this machine, removed on exit
TEMP_PATHS=()
# The overlay's Compose project
COMPOSE_PROJECT="$CONTAINER-compose"
# Distinctive, so the logs can be searched for it
EXT_PW="smoke-pw-7f3a"
# The external server's image (SMOKE_PG_IMAGE=postgres:18-alpine, say, to try
# a newer major); the Compose overlay always uses its own
EXT_PG_IMAGE="${SMOKE_PG_IMAGE:-postgres:16-alpine}"
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
  if [[ "$FAILED" == true ]]; then
    for c in "$EXT_APP" "$EXT_ONESHOT" "$EXT_PG" "$BOOT" "$OVERLAY_APP" "$MAINT" "$FRESH"; do
      if docker inspect "$c" >/dev/null 2>&1; then
        printf '\n== %s logs (last 200 lines)\n' "$c"
        docker logs --tail 200 "$c" 2>&1 || true
      fi
    done
  fi
  # --keep keeps only the main container
  # $FRESH before $MAINT, whose volumes it uses
  docker rm -f "$FRESH" >/dev/null 2>&1 || true
  docker rm -f -v "$EXT_APP" "$EXT_ONESHOT" "$EXT_PG" "$BOOT" "$OVERLAY_APP" "$MAINT" >/dev/null 2>&1 || true
  if ((${#TEMP_PATHS[@]})); then
    rm -rf "${TEMP_PATHS[@]}"
  fi
  if docker compose version >/dev/null 2>&1; then
    if [[ "$FAILED" == true ]]; then
      docker compose -p "$COMPOSE_PROJECT" logs --tail 100 2>&1 || true
    fi
    docker compose -p "$COMPOSE_PROJECT" down -v >/dev/null 2>&1 || true
  fi
  # What Compose left, or made before it went missing, by its project label
  local compose_label="label=com.docker.compose.project=$COMPOSE_PROJECT"
  docker ps -aq --filter "$compose_label" | xargs -r docker rm -f -v >/dev/null 2>&1 || true
  docker volume ls -q --filter "$compose_label" | xargs -r docker volume rm >/dev/null 2>&1 || true
  docker network ls -q --filter "$compose_label" | xargs -r docker network rm >/dev/null 2>&1 || true
  docker volume rm "$EXT_PGDATA" "$EXT_PGDATA_NEW" "$EXT_PGDATA_OLD" >/dev/null 2>&1 || true
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

# Prints a digest of the bundled database's public schema: each table's name
# and rows (in a fixed order), and every index. Equal digests mean the same
# tables, rows and indexes. Usage: db_digest [container]
db_digest() {
  docker exec "${1:-$CONTAINER}" su-exec postgres psql -h /run/postgresql -d sharetab \
    -v ON_ERROR_STOP=1 -tA -c "
    SELECT md5(coalesce(string_agg(c.relname || ':' || (xpath('/row/h/text()', query_to_xml(
      format('SELECT md5(coalesce(string_agg(t::text, %L ORDER BY t::text), %L)) AS h FROM %I t',
        '|', '', c.relname), false, true, '')))[1]::text, ',' ORDER BY c.relname), ''))
      || ' ' || (SELECT md5(coalesce(string_agg(indexdef, ';' ORDER BY indexname), ''))
                 FROM pg_indexes WHERE schemaname = 'public')
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'"
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
grep -qxF '  Database:       bundled, localhost:5432/sharetab' <<<"$(docker logs "$CONTAINER" 2>&1)" ||
  fail "The startup summary doesn't show the bundled database."

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

# Wait up to <seconds> for <text> to appear in a container's log, after its
# first <skip> lines (default 0).
# Usage: wait_for_log <container> <text> <seconds> [skip]
wait_for_log() {
  local container="$1" text="$2" seconds="$3" skip="${4:-0}"
  for _ in $(seq 1 "$seconds"); do
    if grep -qF "$text" <<<"$(docker logs "$container" 2>&1 | tail -n +"$((skip + 1))")"; then
      return 0
    fi
    if [[ "$(docker inspect -f '{{.State.Running}}' "$container")" != "true" ]]; then
      # It may have printed the text just before exiting
      grep -qF "$text" <<<"$(docker logs "$container" 2>&1 | tail -n +"$((skip + 1))")" && return 0
      fail "$container exited before \"$text\" appeared in its log."
    fi
    sleep 1
  done
  fail "No \"$text\" in $container's log after ${seconds}s."
}

section "docker stop shuts the bundled PostgreSQL down cleanly"
# The entrypoint's traps must stop Postgres before the grace period ends;
# otherwise it is killed and every start begins with crash recovery.
lines_before=$(docker logs "$CONTAINER" 2>&1 | wc -l)
docker stop -t 30 "$CONTAINER" >/dev/null
[[ "$(docker inspect -f '{{.State.ExitCode}}' "$CONTAINER")" == 0 ]] ||
  fail "ShareTab exited non-zero on docker stop."
stop_log=$(docker logs "$CONTAINER" 2>&1 | tail -n +"$((lines_before + 1))")
grep -qF 'Stopping PostgreSQL' <<<"$stop_log" || fail "docker stop didn't stop the bundled PostgreSQL."
lines_before=$(docker logs "$CONTAINER" 2>&1 | wc -l)
docker start "$CONTAINER" >/dev/null
wait_healthy "start after docker stop"
restart_log=$(docker logs "$CONTAINER" 2>&1 | tail -n +"$((lines_before + 1))")
if grep -E 'not properly shut down|automatic recovery' <<<"$restart_log"; then
  fail "PostgreSQL recovered from a crash after a clean docker stop."
fi
# PostgreSQL's own record of a clean stop: the check above can't pass by
# not seeing the server's log
grep -qF 'database system was shut down at' <<<"$restart_log" ||
  fail "No clean-shutdown record from PostgreSQL after docker stop."

section "docker stop during the first start, and during pg_ctl start"
# Wrappers make both windows wide and the stop land inside them every run:
# initdb and pg_ctl start each sleep 8s first. During the first start the
# entrypoint must hold the stop until the cluster has ShareTab's user and
# database; during pg_ctl start it must still stop the server. The password
# makes the entrypoint percent-encode the bundled URL.
wrap_dir=$(mktemp -d)
TEMP_PATHS+=("$wrap_dir")
printf '#!/bin/sh\nsleep 8\nexec /usr/bin/initdb "$@"\n' >"$wrap_dir/initdb"
printf '#!/bin/sh\ncase " $* " in *" start "*) sleep 8 ;; esac\nexec /usr/bin/pg_ctl "$@"\n' >"$wrap_dir/pg_ctl"
chmod 755 "$wrap_dir/initdb" "$wrap_dir/pg_ctl"
docker create --name "$BOOT" --label sharetab-smoke \
  -e NEXTAUTH_SECRET="$secret" -e AUTH_SECRET="$secret" -e AUTH_TRUST_HOST=true \
  -e DB_PASSWORD='p/w#1@%x' "$IMAGE" >/dev/null
docker cp "$wrap_dir/initdb" "$BOOT:/usr/local/bin/initdb"
docker cp "$wrap_dir/pg_ctl" "$BOOT:/usr/local/bin/pg_ctl"
docker start "$BOOT" >/dev/null
wait_for_log "$BOOT" "Initializing PostgreSQL" 60
# -t 60: the hold plus the wrappers' sleeps must fit in the grace period
docker stop -t 60 "$BOOT" >/dev/null
[[ "$(docker inspect -f '{{.State.ExitCode}}' "$BOOT")" == 0 ]] || fail "ShareTab exited non-zero on a docker stop during its first start."
boot_log=$(docker logs "$BOOT" 2>&1)
# The first line holding <text>, or nothing (awk, unlike grep, doesn't fail then)
line_of() { awk -v text="$1" 'index($0, text) { print NR; exit }' <<<"$boot_log"; }
initialized=$(line_of 'PostgreSQL initialized.')
stopping=$(line_of 'Received stop signal')
started=$(line_of 'Starting PostgreSQL')
[[ -n "$initialized" && -n "$stopping" && "$initialized" -lt "$stopping" ]] ||
  fail "The stop during the first start wasn't held until the cluster was complete."
[[ -z "$started" || "$started" -gt "$stopping" ]] ||
  fail "The first start went on to start the server after a stop."
docker start "$BOOT" >/dev/null
wait_healthy "start after a stop during the first start" "$BOOT"

docker stop -t 60 "$BOOT" >/dev/null
lines_before=$(docker logs "$BOOT" 2>&1 | wc -l)
docker start "$BOOT" >/dev/null
wait_for_log "$BOOT" "Starting PostgreSQL" 60 "$lines_before"
docker stop -t 60 "$BOOT" >/dev/null
[[ "$(docker inspect -f '{{.State.ExitCode}}' "$BOOT")" == 0 ]] ||
  fail "ShareTab exited non-zero on a docker stop during pg_ctl start."
stop_log=$(docker logs "$BOOT" 2>&1 | tail -n +"$((lines_before + 1))")
grep -qF 'Received stop signal' <<<"$stop_log" || fail "The entrypoint didn't handle the stop during pg_ctl start."
grep -qF 'Stopping PostgreSQL' <<<"$stop_log" || fail "A docker stop during pg_ctl start left the server running."
# The stop landed inside pg_ctl start, not after the server was up
if grep -qF 'Database is ready' <<<"$stop_log"; then
  fail "The stop came after pg_ctl start, so it wasn't exercised during it."
fi
lines_before=$(docker logs "$BOOT" 2>&1 | wc -l)
docker start "$BOOT" >/dev/null
wait_healthy "start after a stop during pg_ctl start" "$BOOT"
restart_log=$(docker logs "$BOOT" 2>&1 | tail -n +"$((lines_before + 1))")
if grep -E 'not properly shut down|automatic recovery' <<<"$restart_log"; then
  fail "PostgreSQL recovered from a crash after a stop during pg_ctl start."
fi
grep -qF 'database system was shut down at' <<<"$restart_log" ||
  fail "No clean-shutdown record from PostgreSQL after a stop during pg_ctl start."
boot_log=$(docker logs "$BOOT" 2>&1)
if grep -qF 'p/w#1@%x' <<<"$boot_log" || grep -qF 'p%2Fw%231%40%25x' <<<"$boot_log"; then
  fail "The log shows the bundled database's password."
fi
docker rm -f -v "$BOOT" >/dev/null

if [[ -n "$MERIDIAN_AUTH" ]]; then
  # The restarts above ran with the login mounted too.
  check_login_unchanged
fi

section "A bundled step that fails stops the server cleanly"
# A migration that fails after the server is up: the EXIT trap must stop the
# server, so the next start (with the file fixed) needs no crash recovery.
step_sql=$(mktemp)
TEMP_PATHS+=("$step_sql")
printf 'SELECT no_such_function();\n' >"$step_sql"
chmod 644 "$step_sql"
docker create --name "$BOOT" --label sharetab-smoke \
  -e NEXTAUTH_SECRET="$secret" -e AUTH_SECRET="$secret" -e AUTH_TRUST_HOST=true "$IMAGE" >/dev/null
docker cp "$step_sql" "$BOOT:/app/prisma/migrations/zz_smoke.sql"
docker start "$BOOT" >/dev/null
code=$(wait_exited "$BOOT" 120) || fail "A failing migration didn't stop startup within 120s."
[[ "$code" != 0 ]] || fail "A failing migration let startup finish."
boot_log=$(docker logs "$BOOT" 2>&1)
grep -qF 'ERROR: migrations/zz_smoke.sql' <<<"$boot_log" || fail "Startup stopped, but not at the failing migration."
grep -qF 'Stopping PostgreSQL' <<<"$boot_log" || fail "A failing step left the bundled server running."
printf 'SELECT 1;\n' >"$step_sql"
docker cp "$step_sql" "$BOOT:/app/prisma/migrations/zz_smoke.sql"
rm -f "$step_sql"
lines_before=$(docker logs "$BOOT" 2>&1 | wc -l)
docker start "$BOOT" >/dev/null
wait_healthy "start after a failed step" "$BOOT"
restart_log=$(docker logs "$BOOT" 2>&1 | tail -n +"$((lines_before + 1))")
if grep -E 'not properly shut down|automatic recovery' <<<"$restart_log"; then
  fail "PostgreSQL recovered from a crash after a failed step."
fi
grep -qF 'database system was shut down at' <<<"$restart_log" ||
  fail "No clean-shutdown record from PostgreSQL after a failed step."
docker rm -f -v "$BOOT" >/dev/null

# ── Backups ────────────────────────────────────────────────────

# Wait until a container prints its maintenance-mode banner, and check that
# nothing past it ran. Usage: wait_maintenance <container> <seconds>
wait_maintenance() {
  wait_for_log "$1" "ShareTab maintenance mode" "$2"
  local log
  log=$(docker logs "$1" 2>&1)
  if grep -qF 'Running database migrations' <<<"$log" || grep -qF 'Starting ShareTab...' <<<"$log"; then
    fail "$1 ran the schema step or started ShareTab in maintenance mode."
  fi
  if docker exec "$1" wget -qO- http://127.0.0.1:3000/api/health >/dev/null 2>&1; then
    fail "ShareTab answers in maintenance mode ($1)."
  fi
}

# The README's restore, in a container in maintenance mode: replace the
# database with an empty one, load the dump (sharetab.dump with pg_restore, or
# with "sql" the plain-SQL backup.sql, as older backups are, with psql), and
# replace the uploads with the backup's (docker cp, as docker compose cp does).
# Usage: restore_backup <container> <backup dir> [sql]
restore_backup() {
  docker exec "$1" su-exec postgres psql -v ON_ERROR_STOP=1 \
    -c 'DROP DATABASE sharetab WITH (FORCE)' -c 'CREATE DATABASE sharetab OWNER sharetab' >/dev/null
  if [[ "${3:-}" == sql ]]; then
    docker exec -i "$1" su-exec postgres psql -U sharetab -d sharetab -1 -v ON_ERROR_STOP=1 -q \
      <"$2/backup.sql" >/dev/null
  else
    docker exec -i "$1" su-exec postgres pg_restore -U sharetab -d sharetab \
      --no-owner --no-privileges --single-transaction <"$2/sharetab.dump"
  fi
  docker exec "$1" sh -c 'rm -rf /app/uploads/*'
  docker cp "$2/uploads/." "$1:/app/uploads/"
}

# Fails unless the uploads in <container> are the backup's: the file from
# before the backup and not the one from after it.
check_uploads_restored() {
  docker exec "$1" test -f /app/uploads/receipts/smoke-before.txt ||
    fail "The restore didn't bring back the backup's uploads ($1)."
  if docker exec "$1" test -e /app/uploads/receipts/smoke-after.txt; then
    fail "An upload from after the backup survived the restore ($1)."
  fi
}

section "Backup and restore an existing install, in maintenance mode"
# Backed up the README's way (pg_dump -Fc and a copy of the uploads), then
# changed the way a later build or later use would: a user deleted and one
# added, a new table with a row (pg_restore --clean would keep it, and the
# schema step would then refuse to drop it), and a new upload.
backup_dir=$(mktemp -d)
TEMP_PATHS+=("$backup_dir")
add_user bk-1 'before-backup@example.com'
docker exec "$CONTAINER" sh -c 'echo before > /app/uploads/receipts/smoke-before.txt'
digest_at_backup=$(db_digest)
docker exec "$CONTAINER" su-exec postgres pg_dump -U sharetab -Fc sharetab >"$backup_dir/sharetab.dump"
# The plain-SQL dump the README documented before -Fc, restored below too
docker exec "$CONTAINER" su-exec postgres pg_dump -U sharetab sharetab >"$backup_dir/backup.sql"
docker cp "$CONTAINER:/app/uploads" "$backup_dir/uploads"
db -c "DELETE FROM \"User\" WHERE id = 'bk-1'" \
  -c 'CREATE TABLE "SmokeNewer" (id int)' -c 'INSERT INTO "SmokeNewer" VALUES (1)'
add_user bk-2 'after-backup@example.com'
docker exec "$CONTAINER" sh -c 'echo after > /app/uploads/receipts/smoke-after.txt'
[[ "$(db_digest)" != "$digest_at_backup" ]] || fail "The changes after the backup didn't change the digest."

# The same data folders, with SHARETAB_MAINTENANCE set (as a Compose or
# Unraid restart with the variable set does)
docker stop -t 30 "$CONTAINER" >/dev/null
docker run -d --name "$MAINT" --label sharetab-smoke --volumes-from "$CONTAINER" \
  -e NEXTAUTH_SECRET="$secret" -e AUTH_SECRET="$secret" -e SHARETAB_MAINTENANCE=true "$IMAGE" >/dev/null
wait_maintenance "$MAINT" 60
restore_backup "$MAINT" "$backup_dir"
[[ "$(db_digest "$MAINT")" == "$digest_at_backup" ]] || fail "The restored database isn't the backup's."
check_uploads_restored "$MAINT"
stop_start=$SECONDS
docker stop -t 30 "$MAINT" >/dev/null
((SECONDS - stop_start < 10)) || fail "docker stop took $((SECONDS - stop_start))s in maintenance mode."
[[ "$(docker inspect -f '{{.State.ExitCode}}' "$MAINT")" == 0 ]] ||
  fail "Maintenance mode exited non-zero on docker stop."
grep -qF 'Stopping PostgreSQL' <<<"$(docker logs --tail 20 "$MAINT" 2>&1)" ||
  fail "docker stop in maintenance mode didn't stop PostgreSQL."
# Not -v: its volumes are the main container's
docker rm "$MAINT" >/dev/null

# Back to normal, on the restored data: the schema step must accept it
lines_before=$(docker logs "$CONTAINER" 2>&1 | wc -l)
docker start "$CONTAINER" >/dev/null
wait_healthy "start after a restore"
restart_log=$(docker logs "$CONTAINER" 2>&1 | tail -n +"$((lines_before + 1))")
if grep -E 'not properly shut down|automatic recovery' <<<"$restart_log"; then
  fail "PostgreSQL recovered from a crash after a stop in maintenance mode."
fi
[[ "$(db_digest)" == "$digest_at_backup" ]] || fail "After the restart, the database isn't the backup's."
check_uploads_restored "$CONTAINER"

section "Restore an older plain-SQL backup into a fresh install"
# Maintenance mode on empty data folders creates the empty database first
docker run -d --name "$MAINT" --label sharetab-smoke \
  -e NEXTAUTH_SECRET="$secret" -e AUTH_SECRET="$secret" -e SHARETAB_MAINTENANCE=true "$IMAGE" >/dev/null
wait_maintenance "$MAINT" 90
grep -qF 'PostgreSQL initialized.' <<<"$(docker logs "$MAINT" 2>&1)" ||
  fail "Maintenance mode on an empty folder didn't initialize the database."
restore_backup "$MAINT" "$backup_dir" sql
docker stop -t 30 "$MAINT" >/dev/null
docker run -d --name "$FRESH" --label sharetab-smoke --volumes-from "$MAINT" \
  -e NEXTAUTH_SECRET="$secret" -e AUTH_SECRET="$secret" -e AUTH_TRUST_HOST=true "$IMAGE" >/dev/null
wait_healthy "fresh install after a restore" "$FRESH"
[[ "$(db_digest "$FRESH")" == "$digest_at_backup" ]] || fail "The fresh install's database isn't the backup's."
check_uploads_restored "$FRESH"
docker rm -f "$FRESH" >/dev/null
docker rm -f -v "$MAINT" >/dev/null

if [[ -n "$MERIDIAN_AUTH" ]]; then
  # The restore ran with the login mounted (maintenance mode shares it).
  check_login_unchanged
fi

# ── External database ──────────────────────────────────────────

# SQL against the external database over its Unix socket, as its superuser;
# output as db(). Usage: ext_db [-d <database>] -c '<sql>' ...
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

# Start ShareTab with <url> and expect it to stop within REFUSE_SECONDS
# (default 30; more for a refusal after prisma db push), with a non-zero
# exit and <text> in its log, which is left in REFUSED_LOG.
# Usage: [REFUSE_SECONDS=<n>] expect_refused <label> <url> <text> [docker run args...]
REFUSED_LOG=""
expect_refused() {
  local label="$1" url="$2" text="$3" seconds="${REFUSE_SECONDS:-30}" code log
  shift 3
  run_external "$EXT_ONESHOT" "$url" "$@"
  code=$(wait_exited "$EXT_ONESHOT" "$seconds") || {
    docker logs --tail 30 "$EXT_ONESHOT" 2>&1 || true
    fail "$label: still running after ${seconds}s."
  }
  log=$(docker logs "$EXT_ONESHOT" 2>&1)
  REFUSED_LOG=$log
  if [[ "$code" == 0 ]] || ! grep -qF "$text" <<<"$log"; then
    echo "$log" | tail -30
    fail "$label: expected a non-zero exit with \"$text\" in the log (exit $code)."
  fi
  if grep -qF "$EXT_PW" <<<"$log"; then
    fail "$label: the log shows the database password."
  fi
  grep -E '^ERROR' <<<"$log" | head -2 || true
}

# Prints "yes" when a volume holds the external-database marker, else "no".
has_marker() {
  docker run --rm --entrypoint sh -v "$1:/d" "$IMAGE" -c \
    'if [ -f /d/.sharetab-external-database ]; then echo yes; else echo no; fi'
}

section "External database: the Compose overlay"
# A Docker Hub hiccup shouldn't fail the run (it gates publishing the image)
for pg_image in postgres:16-alpine "$EXT_PG_IMAGE"; do
  for attempt in 1 2 3; do
    docker pull -q "$pg_image" >/dev/null && break
    [[ "$attempt" == 3 ]] && fail "Could not pull $pg_image."
    sleep 10
  done
done
if docker compose version >/dev/null 2>&1; then
  # --env-file /dev/null: a docker/.env on this machine must not change the result
  compose_overlay() {
    DB_USER=smoke DB_PASSWORD=smokepw DB_NAME=smokedb docker compose -p "$COMPOSE_PROJECT" --env-file /dev/null \
      -f docker/docker-compose.yml -f docker/docker-compose.external-db.yml "$@"
  }
  overlay_config=$(compose_overlay config)
  grep -qF 'DATABASE_URL: postgresql://smoke:smokepw@postgres:5432/smokedb' <<<"$overlay_config" ||
    fail "The overlay doesn't set DATABASE_URL for the sharetab service."
  # As the README sets it up: COMPOSE_FILE in docker/.env, plain docker compose
  compose_dir=$(mktemp -d)
  TEMP_PATHS+=("$compose_dir")
  mkdir "$compose_dir/docker"
  cp docker/docker-compose.yml docker/docker-compose.external-db.yml "$compose_dir/docker/"
  printf 'COMPOSE_FILE=docker-compose.yml:docker-compose.external-db.yml\nDB_PASSWORD=smokepw\nALLOW_EMPTY_EXTERNAL_DB=true\n' \
    >"$compose_dir/docker/.env"
  env_config=$(cd "$compose_dir/docker" &&
    env -u COMPOSE_FILE -u DB_USER -u DB_PASSWORD -u DB_NAME -u ALLOW_EMPTY_EXTERNAL_DB docker compose config) ||
    fail "docker compose config failed with COMPOSE_FILE in docker/.env."
  grep -qF 'DATABASE_URL: postgresql://sharetab:smokepw@postgres:5432/sharetab' <<<"$env_config" ||
    fail "COMPOSE_FILE in docker/.env doesn't bring in the overlay."
  # The refusal of an empty database names it, so a docker/.env value must arrive
  grep -qE 'ALLOW_EMPTY_EXTERNAL_DB: "?true"?$' <<<"$env_config" ||
    fail "ALLOW_EMPTY_EXTERNAL_DB in docker/.env doesn't reach the container."
  # Without the overlay, a DATABASE_URL in docker/.env (as .env.example has)
  # must not reach the container: it would switch it to external mode
  printf 'DATABASE_URL=postgresql://u:p@db:5432/x\n' >"$compose_dir/docker/.env"
  base_config=$(cd "$compose_dir/docker" && env -u COMPOSE_FILE -u DATABASE_URL docker compose config) ||
    fail "docker compose config failed on docker-compose.yml alone."
  grep -qF 'image: sharetab:latest' <<<"$base_config" || fail "Unexpected docker compose config output."
  if grep -qF 'DATABASE_URL' <<<"$base_config"; then
    fail "docker-compose.yml passes a DATABASE_URL from docker/.env to the container."
  fi
  grep -qF 'condition: service_healthy' <<<"$overlay_config" ||
    fail "The overlay doesn't make ShareTab wait for a healthy database."
  # Its database starts, passes its own health check, and takes the
  # credentials the URL carries (only the postgres service: ShareTab's image
  # and ports are left alone). Over the service's network name, as ShareTab
  # connects: the image trusts 127.0.0.1 without a password.
  compose_overlay up -d --wait --quiet-pull postgres
  [[ "$(compose_overlay exec -T postgres psql 'postgresql://smoke:smokepw@postgres:5432/smokedb' -tAc 'SELECT 1')" == 1 ]] ||
    fail "The overlay's database doesn't take the credentials in its DATABASE_URL."
  if compose_overlay exec -T postgres psql 'postgresql://smoke:wrong@postgres:5432/smokedb' -tAc 'SELECT 1' >/dev/null 2>&1; then
    fail "The overlay's database took a wrong password, so the check above proves nothing."
  fi
  # ShareTab itself, on the overlay's network and URL
  docker run -d --name "$OVERLAY_APP" --label sharetab-smoke --network "${COMPOSE_PROJECT}_default" \
    -e NEXTAUTH_SECRET="$secret" -e AUTH_SECRET="$secret" -e AUTH_TRUST_HOST=true \
    -e DATABASE_URL='postgresql://smoke:smokepw@postgres:5432/smokedb' "$IMAGE" >/dev/null
  wait_healthy "ShareTab on the overlay's database" "$OVERLAY_APP"
  if grep -qF 'smokepw' <<<"$(docker logs "$OVERLAY_APP" 2>&1)"; then
    fail "The log shows the overlay's database password."
  fi
  # The README's backup and restore for the overlay's database, with ShareTab
  # stopped: a user added after the backup must be gone afterwards
  overlay_dump=$(mktemp)
  TEMP_PATHS+=("$overlay_dump")
  compose_overlay exec -T postgres pg_dump -U smoke -Fc smokedb >"$overlay_dump"
  overlay_users=$(compose_overlay exec -T postgres psql -U smoke -d smokedb -tAc 'SELECT count(*) FROM "User"')
  compose_overlay exec -T postgres psql -U smoke -d smokedb -v ON_ERROR_STOP=1 -qc \
    "INSERT INTO \"User\" (id, email, \"updatedAt\") VALUES ('ov-1', 'overlay@example.com', now())"
  docker stop -t 30 "$OVERLAY_APP" >/dev/null
  compose_overlay exec -T postgres psql -U smoke -d postgres -v ON_ERROR_STOP=1 \
    -c 'DROP DATABASE smokedb WITH (FORCE)' -c 'CREATE DATABASE smokedb' >/dev/null
  compose_overlay exec -T postgres pg_restore -U smoke -d smokedb \
    --no-owner --no-privileges --single-transaction <"$overlay_dump"
  docker start "$OVERLAY_APP" >/dev/null
  wait_healthy "ShareTab on the overlay's database, after a restore" "$OVERLAY_APP"
  [[ "$(compose_overlay exec -T postgres psql -U smoke -d smokedb -tAc 'SELECT count(*) FROM "User"')" == "$overlay_users" ]] ||
    fail "The restore of the overlay's database didn't bring back the backed-up users."
  docker rm -f -v "$OVERLAY_APP" >/dev/null
  compose_overlay down -v >/dev/null 2>&1 || true
  echo "ShareTab runs on the overlay's database, which takes its URL's credentials and not others."
elif [[ -n "${GITHUB_ACTIONS:-}" ]]; then
  fail "docker compose isn't available on this runner, so the overlay can't be checked."
else
  echo "docker compose isn't available here; skipped."
fi

section "External database: start beside PostgreSQL, TLS only"
# A self-signed certificate, as on most home servers, and a server that
# accepts TLS connections only, so db.mjs and the app have to use TLS with
# the one DATABASE_URL (sslmode=no-verify).
TLS_DIR=$(mktemp -d)
openssl req -new -x509 -days 1 -nodes -subj "/CN=$EXT_PG" -addext "subjectAltName=DNS:$EXT_PG" \
  -keyout "$TLS_DIR/server.key" -out "$TLS_DIR/server.crt" 2>/dev/null
chmod 644 "$TLS_DIR/server.crt"
printf 'local all all trust\nhostssl all all all scram-sha-256\n' >"$TLS_DIR/pg_hba.conf"
docker network create --label sharetab-smoke "$EXT_NET" >/dev/null
# postgres:16-alpine has no openssl, so the files are copied in before it
# starts, and moved where the server user can own them.
docker create --name "$EXT_PG" --label sharetab-smoke --network "$EXT_NET" \
  -e POSTGRES_USER=sharetab -e POSTGRES_PASSWORD="$EXT_PW" -e POSTGRES_DB=sharetab \
  --entrypoint sh "$EXT_PG_IMAGE" -c '
    install -o postgres -g postgres -m 600 /tls/server.key /tls/server.crt /tls/pg_hba.conf /var/lib/postgresql/ &&
    exec docker-entrypoint.sh postgres -c ssl=on \
      -c ssl_cert_file=/var/lib/postgresql/server.crt \
      -c ssl_key_file=/var/lib/postgresql/server.key \
      -c hba_file=/var/lib/postgresql/pg_hba.conf' >/dev/null
docker cp "$TLS_DIR/." "$EXT_PG:/tls"
# A data folder that looks like it holds a bundled database, for the warning
docker volume create --label sharetab-smoke "$EXT_PGDATA" >/dev/null
docker run --rm --entrypoint sh -v "$EXT_PGDATA:/d" "$IMAGE" -c 'echo 16 > /d/PG_VERSION'
# ShareTab first, PostgreSQL only once it's waiting, so the wait is exercised
EXT_URL="postgresql://sharetab:$EXT_PW@$EXT_PG:5432/sharetab?sslmode=no-verify"
# A longer wait than the default: PostgreSQL creates its database first. The
# data folder looks bundled, so an empty database is refused without
# ALLOW_EMPTY_EXTERNAL_DB (checked below).
run_external "$EXT_APP" "$EXT_URL" -v "$EXT_PGDATA:/var/lib/postgresql/data" -e DB_WAIT_SECONDS=180 \
  -e ALLOW_EMPTY_EXTERNAL_DB=true
wait_for_log "$EXT_APP" "Waiting for the database" 60
docker start "$EXT_PG" >/dev/null
wait_healthy "external database, first start" "$EXT_APP"

section "External database: the bundled server stays off"
ext_log=$(docker logs "$EXT_APP" 2>&1)
grep -qF 'Starting ShareTab...' <<<"$ext_log" || fail "No \"Starting ShareTab...\" in the log, so the checks below see nothing."
if grep -qE 'Initializing PostgreSQL|Starting PostgreSQL' <<<"$ext_log"; then
  fail "The bundled PostgreSQL was started although DATABASE_URL is set."
fi
ready=0
docker exec "$EXT_APP" pg_isready -h localhost -q || ready=$?
# 2: no response (0 would be a server, 127 a missing pg_isready)
[[ "$ready" == 2 ]] || fail "pg_isready on localhost inside the container returned $ready, not 2 (no server)."
grep -qxF "  Database:       external, $EXT_PG:5432/sharetab" <<<"$ext_log" ||
  fail "The startup summary doesn't show the external database's host and name."
if grep -qF "$EXT_PW" <<<"$ext_log"; then
  fail "The startup log shows the database password."
fi
grep -qF 'WARNING: DATABASE_URL points to an external database' <<<"$ext_log" ||
  fail "No warning that the bundled database in the data folder isn't used."
[[ "$(has_marker "$EXT_PGDATA")" == yes ]] || fail "The external-database marker wasn't written."

section "External database: schema, SQL phases and email index"
for sqlfile in prisma/migrations/*.sql prisma/after-push/*.sql; do
  phase="Running $(basename "$(dirname "$sqlfile")")/$(basename "$sqlfile")..."
  grep -qF "$phase" <<<"$ext_log" || fail "No \"$phase\" in the startup log."
done
[[ "$(ext_db -c "SELECT count(*) FROM pg_type WHERE typname = 'GuestSplitStatus'")" == 1 ]] ||
  fail "The GuestSplitStatus enum is missing."
ext_db -c 'SELECT count(*) FROM "User"' -c 'SELECT count(*) FROM "GuestSplit"' >/dev/null
[[ "$(ext_db -c "SELECT to_regclass('\"User_email_lower_key\"') IS NOT NULL")" == t ]] ||
  fail "The email index from prisma/after-push is missing."

section "External database: a connection without TLS is refused"
# So the app working at all shows its connections used TLS.
no_tls_start=$SECONDS
if no_tls=$(docker exec -e DATABASE_URL="postgresql://sharetab:$EXT_PW@$EXT_PG:5432/sharetab?sslmode=disable" \
  "$EXT_APP" node /app/db.mjs wait 2>&1); then
  fail "A connection without TLS was accepted."
fi
grep -qF 'no encryption' <<<"$no_tls" || fail "Unexpected answer to a connection without TLS: $no_tls"
if grep -qF "$EXT_PW" <<<"$no_tls"; then
  fail "The refusal shows the database password."
fi
((SECONDS - no_tls_start < 15)) || fail "A pg_hba.conf rejection was retried instead of failing at once."
echo "$no_tls"

section "External database: TLS with the certificate checked (verify-full)"
# The README's way: the CA in the container, NODE_EXTRA_CA_CERTS, sslmode=verify-full
# and the host name the certificate names. Copied in, not mounted, so a
# remote DOCKER_HOST works; readable by the app's user.
docker rm -f -v "$EXT_ONESHOT" >/dev/null 2>&1 || true
docker create --name "$EXT_ONESHOT" --label sharetab-smoke --network "$EXT_NET" \
  -e NEXTAUTH_SECRET="$secret" -e AUTH_SECRET="$secret" -e AUTH_TRUST_HOST=true \
  -e NODE_EXTRA_CA_CERTS=/etc/sharetab-smoke-ca.crt \
  -e DATABASE_URL="postgresql://sharetab:$EXT_PW@$EXT_PG:5432/sharetab?sslmode=verify-full" "$IMAGE" >/dev/null
docker cp "$TLS_DIR/server.crt" "$EXT_ONESHOT:/etc/sharetab-smoke-ca.crt"
docker start "$EXT_ONESHOT" >/dev/null
wait_healthy "external database, verify-full" "$EXT_ONESHOT"
docker rm -f -v "$EXT_ONESHOT" >/dev/null

section "External database: restart keeps the email index"
before=$(ext_db -c "SELECT '\"User_email_lower_key\"'::regclass::oid")
lines_before=$(docker logs "$EXT_APP" 2>&1 | wc -l)
docker restart -t 30 "$EXT_APP" >/dev/null
wait_healthy "external database, restart" "$EXT_APP"
after=$(ext_db -c "SELECT '\"User_email_lower_key\"'::regclass::oid")
[[ "$before" == "$after" ]] || fail "prisma db push dropped User_email_lower_key (oid $before -> $after)."
# Captured first: grep -q exiting early would SIGPIPE the pipeline (see above)
restart_log=$(docker logs "$EXT_APP" 2>&1 | tail -n +"$((lines_before + 1))")
grep -qF 'Starting ShareTab...' <<<"$restart_log" || fail "No \"Starting ShareTab...\" after the restart, so the checks below see nothing."
if grep -qF 'WARNING: DATABASE_URL points to an external database' <<<"$restart_log"; then
  fail "The unused-bundled-database warning repeats once the marker is written."
fi
if grep -qF "$EXT_PW" <<<"$restart_log"; then
  fail "The restart log shows the database password."
fi

section "External database: docker stop"
docker stop -t 30 "$EXT_APP" >/dev/null
[[ "$(docker inspect -f '{{.State.ExitCode}}' "$EXT_APP")" == 0 ]] || fail "ShareTab exited non-zero on docker stop."
grep -qF 'Received stop signal' <<<"$(docker logs --tail 20 "$EXT_APP" 2>&1)" ||
  fail "The entrypoint didn't handle docker stop."
if grep -qF "$EXT_PW" <<<"$(docker logs "$EXT_APP" 2>&1)"; then
  fail "ShareTab's log shows the database password."
fi
if grep -qF 'Stopping PostgreSQL' <<<"$(docker logs --tail 20 "$EXT_APP" 2>&1)"; then
  fail "docker stop tried to stop a bundled PostgreSQL that wasn't running."
fi

section "External database: maintenance mode starts nothing"
run_external "$EXT_ONESHOT" "$EXT_URL" -e SHARETAB_MAINTENANCE=true
wait_maintenance "$EXT_ONESHOT" 30
if grep -qF 'Waiting for the database' <<<"$(docker logs "$EXT_ONESHOT" 2>&1)"; then
  fail "Maintenance mode connected to the external database."
fi
stop_start=$SECONDS
docker stop -t 30 "$EXT_ONESHOT" >/dev/null
((SECONDS - stop_start < 10)) || fail "docker stop took $((SECONDS - stop_start))s in external maintenance mode."
[[ "$(docker inspect -f '{{.State.ExitCode}}' "$EXT_ONESHOT")" == 0 ]] ||
  fail "External maintenance mode exited non-zero on docker stop."
docker rm -f -v "$EXT_ONESHOT" >/dev/null

section "External database: a start without DATABASE_URL refuses"
# As after a Compose upgrade run without the overlay file. Without
# PG_VERSION, as in an install that was external from the start, a bundled
# start would otherwise create a new, empty database here.
docker run --rm --entrypoint sh -v "$EXT_PGDATA:/d" "$IMAGE" -c 'rm -f /d/PG_VERSION'
# DATABASE_URL set but empty, as a cleared Unraid field sends it
expect_refused "bundled start on an external install's data folder" "" \
  "has run on an external database" -v "$EXT_PGDATA:/var/lib/postgresql/data" -e DATABASE_URL=
docker run --rm --entrypoint sh -v "$EXT_PGDATA:/d" "$IMAGE" -c \
  'test ! -e /d/base && test ! -e /d/postgresql.conf' ||
  fail "The bundled database was initialized in the external install's data folder."

section "External database: an empty database is refused while the container has bundled data"
# A wrong DATABASE_URL, or data not moved yet, would otherwise start a new,
# empty ShareTab beside the old data
docker volume create --label sharetab-smoke "$EXT_PGDATA_OLD" >/dev/null
docker run --rm --entrypoint sh -v "$EXT_PGDATA_OLD:/d" "$IMAGE" -c 'echo 16 > /d/PG_VERSION'
ext_db -c 'CREATE DATABASE emptydb OWNER sharetab' >/dev/null
expect_refused "an empty database beside bundled data" \
  "postgresql://sharetab:$EXT_PW@$EXT_PG:5432/emptydb?sslmode=no-verify" "ALLOW_EMPTY_EXTERNAL_DB=true" \
  -v "$EXT_PGDATA_OLD:/var/lib/postgresql/data"
[[ "$(has_marker "$EXT_PGDATA_OLD")" == no ]] || fail "The refused start wrote the marker."
[[ "$(docker exec "$EXT_PG" psql -U sharetab -d emptydb -tAc "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")" == 0 ]] ||
  fail "The refused start created tables."

section "External database: moving the bundled data, as the README does"
# The main container's bundled database, dumped and loaded the README's way,
# then started beside the old data folder without ALLOW_EMPTY_EXTERNAL_DB
ext_db -c 'CREATE DATABASE moved OWNER sharetab' >/dev/null
users_before=$(db -c 'SELECT count(*) FROM "User"')
docker exec "$CONTAINER" su-exec postgres pg_dump -U sharetab --no-owner --no-privileges sharetab |
  docker exec -i "$EXT_PG" psql -U sharetab -d moved -1 -v ON_ERROR_STOP=1 -q >/dev/null
run_external "$EXT_ONESHOT" "postgresql://sharetab:$EXT_PW@$EXT_PG:5432/moved?sslmode=no-verify" \
  -v "$EXT_PGDATA_OLD:/var/lib/postgresql/data"
wait_healthy "external database, moved data" "$EXT_ONESHOT"
[[ "$(docker exec "$EXT_PG" psql -U sharetab -d moved -tAc 'SELECT count(*) FROM "User"')" == "$users_before" ]] ||
  fail "The moved database lost users."
[[ "$(has_marker "$EXT_PGDATA_OLD")" == yes ]] || fail "The start on the moved data didn't write the marker."
docker rm -f -v "$EXT_ONESHOT" >/dev/null

section "External database: a failed external start leaves no marker"
# Otherwise a mistyped URL would lock the bundled database out. A new data
# folder: the first already holds the marker from the start above. Failing
# at the wait, and later, in the SQL phase: a user without CREATE on the
# public schema (PostgreSQL 15 and newer) gets past the wait and the schema
# check, and fails at the migration's CREATE TYPE.
docker volume create --label sharetab-smoke "$EXT_PGDATA_NEW" >/dev/null
expect_refused "wrong password" "postgresql://sharetab:wrong@$EXT_PG:5432/sharetab?sslmode=no-verify" \
  "password authentication failed" -v "$EXT_PGDATA_NEW:/var/lib/postgresql/data"
[[ "$(has_marker "$EXT_PGDATA_NEW")" == no ]] || fail "A start that failed at the wait wrote the marker."
ext_db -c "CREATE ROLE limited LOGIN PASSWORD '$EXT_PW'" -c 'CREATE DATABASE limiteddb' >/dev/null
expect_refused "a user that can't create in the public schema" \
  "postgresql://limited:$EXT_PW@$EXT_PG:5432/limiteddb?sslmode=no-verify" "permission denied" \
  -v "$EXT_PGDATA_NEW:/var/lib/postgresql/data"
[[ "$(has_marker "$EXT_PGDATA_NEW")" == no ]] || fail "A start that failed in the SQL phase wrote the marker."
# A ShareTab-named table with the wrong columns and a row: the schema check and
# the migrations pass, and prisma db push refuses
ext_db -c 'CREATE DATABASE pushfail OWNER sharetab' >/dev/null
docker exec "$EXT_PG" psql -U sharetab -d pushfail -v ON_ERROR_STOP=1 -q \
  -c 'CREATE TABLE "Settlement" (x int)' -c 'INSERT INTO "Settlement" VALUES (1)'
REFUSE_SECONDS=120 expect_refused "a failing schema step" \
  "postgresql://sharetab:$EXT_PW@$EXT_PG:5432/pushfail?sslmode=no-verify" \
  "Running database migrations..." -v "$EXT_PGDATA_NEW:/var/lib/postgresql/data"
if grep -qF 'Running after-push/' <<<"$REFUSED_LOG"; then
  fail "Startup went on past a failed prisma db push."
fi
[[ "$(has_marker "$EXT_PGDATA_NEW")" == no ]] || fail "A start that failed at the schema step wrote the marker."
# Everything succeeds but the marker can't be written: startup stops
REFUSE_SECONDS=120 expect_refused "a data folder it can't write" "$EXT_URL" "could not write" \
  -v "$EXT_PGDATA_NEW:/var/lib/postgresql/data:ro"
# ...nor written through a symlink, which could point anywhere
docker run --rm --entrypoint sh -v "$EXT_PGDATA_NEW:/d" "$IMAGE" -c 'ln -s /nonexistent /d/.sharetab-external-database'
REFUSE_SECONDS=120 expect_refused "a marker that is a symlink" "$EXT_URL" "it is a symlink" \
  -v "$EXT_PGDATA_NEW:/var/lib/postgresql/data"
docker run --rm --entrypoint sh -v "$EXT_PGDATA_NEW:/d" "$IMAGE" -c 'rm /d/.sharetab-external-database'

section "External database: errors waiting won't fix stop startup at once"
expect_refused "sslmode=require with a self-signed certificate" \
  "postgresql://sharetab:$EXT_PW@$EXT_PG:5432/sharetab?sslmode=require" "sslmode=require checks the certificate"
expect_refused "a password needing percent-encoding" \
  "postgresql://sharetab:ab/cd@$EXT_PG:5432/sharetab?sslmode=no-verify" "percent-encode"
# Another app's database: prisma db push would drop its tables
ext_db -c 'CREATE DATABASE otherapp OWNER sharetab' >/dev/null
docker exec "$EXT_PG" psql -U sharetab -d otherapp -v ON_ERROR_STOP=1 -qc 'CREATE TABLE notes (id int)'
expect_refused "a database holding another app's tables" \
  "postgresql://sharetab:$EXT_PW@$EXT_PG:5432/otherapp?sslmode=no-verify" "tables ShareTab doesn't have (notes)" \
  -v "$EXT_PGDATA_NEW:/var/lib/postgresql/data"
[[ "$(has_marker "$EXT_PGDATA_NEW")" == no ]] || fail "A start refused by the schema check wrote the marker."
[[ "$(docker exec "$EXT_PG" psql -U sharetab -d otherapp -tAc "SELECT to_regclass('notes') IS NOT NULL")" == t ]] ||
  fail "The other app's table was dropped."
# A table an extension owns, as PostGIS's spatial_ref_sys: prisma db push
# would try to drop it and fail, so the schema check refuses it up front
ext_db -c 'CREATE DATABASE extdb OWNER sharetab' >/dev/null
docker exec "$EXT_PG" psql -U sharetab -d extdb -v ON_ERROR_STOP=1 -q \
  -c 'CREATE TABLE smoke_ext_owned (id int)' -c 'ALTER EXTENSION plpgsql ADD TABLE smoke_ext_owned'
expect_refused "a database with an extension's table" \
  "postgresql://sharetab:$EXT_PW@$EXT_PG:5432/extdb?sslmode=no-verify" "tables ShareTab doesn't have (smoke_ext_owned)"

section "External database: a percent-encoded password works end to end"
# db.mjs, Prisma's schema step and the app each decode it
ext_db -c "CREATE ROLE enc LOGIN PASSWORD 'p/w#1@%x'" -c 'CREATE DATABASE encdb OWNER enc' >/dev/null
run_external "$EXT_ONESHOT" "postgresql://enc:p%2Fw%231%40%25x@$EXT_PG:5432/encdb?sslmode=no-verify"
wait_healthy "external database, a percent-encoded password" "$EXT_ONESHOT"
enc_log=$(docker logs "$EXT_ONESHOT" 2>&1)
if grep -qF 'p/w#1@%x' <<<"$enc_log" || grep -qF 'p%2Fw%231%40%25x' <<<"$enc_log"; then
  fail "The log shows the percent-encoded database password."
fi
docker rm -f -v "$EXT_ONESHOT" >/dev/null

section "External database: docker stop during the wait"
run_external "$EXT_ONESHOT" "postgresql://sharetab:$EXT_PW@sharetab-smoke-nowhere.invalid:5432/sharetab" \
  -e DB_WAIT_SECONDS=300
wait_for_log "$EXT_ONESHOT" "Waiting for the database" 30
stop_start=$SECONDS
docker stop -t 30 "$EXT_ONESHOT" >/dev/null
((SECONDS - stop_start < 10)) || fail "docker stop took $((SECONDS - stop_start))s during the wait."
[[ "$(docker inspect -f '{{.State.ExitCode}}' "$EXT_ONESHOT")" == 0 ]] ||
  fail "ShareTab exited non-zero on docker stop during the wait."
if grep -qF "$EXT_PW" <<<"$(docker logs "$EXT_ONESHOT" 2>&1)"; then
  fail "The wait's log shows the database password."
fi
echo "Stopped in $((SECONDS - stop_start))s."

FAILED=false
section "Done"
echo "All smoke checks passed for $IMAGE."
